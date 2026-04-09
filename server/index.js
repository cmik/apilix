'use strict';

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const vm = require('vm');
const { parse: parseCsv } = require('csv-parse/sync');
const { executeRequest, flattenItems } = require('./executor');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Runner pause/resume/stop state ──────────────────────────────────────────

/** @type {Map<string, { paused: boolean, stopped: boolean }>} */
const runStates = new Map();

function generateRunId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/** Waits while the run is paused. Returns 'stopped' or 'running'. */
async function waitForResume(runId) {
  while (true) {
    const state = runStates.get(runId);
    if (!state || state.stopped) return 'stopped';
    if (!state.paused) return 'running';
    await new Promise(r => setTimeout(r, 100));
  }
}

/** Waits delayMs, honouring pause/stop. Returns 'stopped' or 'running'. */
async function awaitDelay(runId, delayMs) {
  const end = Date.now() + delayMs;
  while (Date.now() < end) {
    const check = await waitForResume(runId);
    if (check === 'stopped') return 'stopped';
    await new Promise(r => setTimeout(r, Math.min(50, Math.max(0, end - Date.now()))));
  }
  return 'running';
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── Health check ──────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// ─── Execute a single request ──────────────────────────────────────────────────

app.post('/api/execute', async (req, res) => {
  try {
    const { item, environment, collectionVariables, globals, dataRow, collVars, cookies, collectionItems, mockBase } = req.body;
    if (!item || !item.request) {
      return res.status(400).json({ error: 'Missing item.request in body' });
    }
    const result = await executeRequest(item, {
      environment: environment || {},
      collectionVariables: collectionVariables || {},
      globals: globals || {},
      dataRow: dataRow || {},
      collVars: collVars || [],
      cookies: cookies || {},
      collectionItems: collectionItems || [],
      mockBase: mockBase || null,
    });
    return res.json(result);
  } catch (err) {
    console.error('Execute error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Run control endpoints ─────────────────────────────────────────────────────

app.post('/api/run/:runId/pause', (req, res) => {
  const state = runStates.get(req.params.runId);
  if (state) state.paused = true;
  res.json({ ok: true });
});

app.post('/api/run/:runId/resume', (req, res) => {
  const state = runStates.get(req.params.runId);
  if (state) state.paused = false;
  res.json({ ok: true });
});

app.post('/api/run/:runId/stop', (req, res) => {
  const state = runStates.get(req.params.runId);
  if (state) state.stopped = true;
  res.json({ ok: true });
});

// ─── Run an entire collection (optionally with CSV) — SSE streaming ───────────

app.post('/api/run', upload.single('csvFile'), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.data || '{}');
    const { collection, environment, collectionVariables, globals, delay, cookies, executeChildRequests, conditionalExecution, allCollectionItems, mockBase } = payload;

    if (!collection || !collection.item) {
      return res.status(400).json({ error: 'Missing collection in body' });
    }

    // Parse CSV rows, defaulting to a single empty iteration (or N empty rows for plain iterations)
    let dataRows = [{}];
    if (req.file) {
      const csvText = req.file.buffer.toString('utf-8');
      try {
        dataRows = parseCsv(csvText, { columns: true, skip_empty_lines: true, trim: true });
      } catch (csvErr) {
        return res.status(400).json({ error: `Invalid CSV: ${csvErr.message}` });
      }
    } else {
      const iterCount = Math.max(1, Math.min(100, parseInt(payload.iterations, 10) || 1));
      if (iterCount > 1) dataRows = Array.from({ length: iterCount }, () => ({}));
    }

    const requests = flattenItems(collection.item);
    if (requests.length === 0) {
      return res.json({ results: [] });
    }

    // Switch to SSE streaming
    const runId = generateRunId();
    runStates.set(runId, { paused: false, stopped: false });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Stop the run if client disconnects from the response stream
    res.on('close', () => {
      const state = runStates.get(runId);
      if (state) state.stopped = true;
    });

    const sendEvent = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent('run-id', { runId });

    const delayMs = Math.min(parseInt(delay, 10) || 0, 5000);

    let stopped = false;
    outer: for (let i = 0; i < dataRows.length; i++) {
      const dataRow = dataRows[i];
      let currentEnv = { ...(environment || {}) };
      let currentCollVars = { ...(collectionVariables || {}) };
      let currentGlobals = { ...(globals || {}) };
      let currentCookies = { ...(cookies || {}) };

      sendEvent('iteration-start', { iteration: i + 1, dataRow });

      let reqIdx = 0;
      // Per-request execution counter — detects cycles early.
      // Any single request running more than (n+1) times signals a loop.
      const perRequestCount = new Array(requests.length).fill(0);
      const maxPerRequest = requests.length + 1;
      while (reqIdx < requests.length) {
        perRequestCount[reqIdx]++;
        if (perRequestCount[reqIdx] > maxPerRequest) {
          const loopName = requests[reqIdx].name;
          sendEvent('error', { error: `Iteration ${i + 1} aborted: "${loopName}" was reached ${perRequestCount[reqIdx]} times — circular setNextRequest() detected.` });
          break;
        }
        const item = requests[reqIdx];
        // Check pause/stop before each request
        if ((await waitForResume(runId)) === 'stopped') { stopped = true; break outer; }

        const result = await executeRequest(item, {
          environment: currentEnv,
          collectionVariables: currentCollVars,
          globals: currentGlobals,
          dataRow,
          collVars: collection.variable || [],
          cookies: currentCookies,
          collectionItems: executeChildRequests ? (allCollectionItems || collection.item || []) : [],
          conditionalExecution: conditionalExecution !== false,
          mockBase: mockBase || null,
        });

        // Propagate environment/variable/cookie changes to next request in same iteration
        if (result.updatedEnvironment) currentEnv = result.updatedEnvironment;
        if (result.updatedCollectionVariables) currentCollVars = result.updatedCollectionVariables;
        if (result.updatedGlobals) currentGlobals = result.updatedGlobals;
        if (result.updatedCookies) currentCookies = result.updatedCookies;

        const resultData = {
          iteration: i + 1,
          name: item.name,
          method: item.request?.method || 'GET',
          url: typeof item.request?.url === 'string'
            ? item.request.url
            : item.request?.url?.raw || '',
          resolvedUrl: result.resolvedUrl,
          requestHeaders: result.requestHeaders,
          requestBody: result.requestBody,
          status: result.status,
          statusText: result.statusText,
          responseTime: result.responseTime,
          headers: result.headers,
          body: result.body,
          size: result.size,
          testResults: result.testResults,
          scriptLogs: result.scriptLogs,
          preChildRequests: result.preChildRequests || [],
          testChildRequests: result.testChildRequests || [],
          skipped: result.skipped || false,
          error: result.error,
        };

        sendEvent('result', resultData);

        // When conditional execution is enabled, setNextRequest() takes priority
        // over sequential order — it drives which request runs next.
        if (conditionalExecution !== false && result.nextRequest !== undefined) {
          if (result.nextRequest !== null) {
            // Prefer a forward match to stay within the current chain segment.
            // Fall back to the first occurrence only if nothing is found ahead.
            const forwardIdx = requests.findIndex((r, i) => i > reqIdx && r.name === result.nextRequest);
            const targetIdx = forwardIdx >= 0
              ? forwardIdx
              : requests.findIndex(r => r.name === result.nextRequest);
            if (targetIdx >= 0) {
              sendEvent('next-request', { from: item.name, to: result.nextRequest });
              if (delayMs > 0) {
                if ((await awaitDelay(runId, delayMs)) === 'stopped') { stopped = true; break outer; }
              }
              reqIdx = targetIdx;
              continue;
            } else {
              // Unknown request name — stop iteration (Postman behaviour)
              break;
            }
          } else {
            // setNextRequest(null) stops iteration immediately
            break;
          }
        }

        if (delayMs > 0) {
          if ((await awaitDelay(runId, delayMs)) === 'stopped') { stopped = true; break outer; }
        }

        reqIdx++;
      }

      sendEvent('iteration-end', { iteration: i + 1 });
    }

    if (stopped) {
      sendEvent('stopped', {});
    } else {
      sendEvent('done', {});
    }
    runStates.delete(runId);
    res.end();
  } catch (err) {
    console.error('Run error:', err);
    // If headers already sent, send error as SSE event
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    } else {
      return res.status(500).json({ error: err.message });
    }
  }
});

// ─── Mock Server ───────────────────────────────────────────────────────────────

const http = require('http');
const { WebSocketServer } = require('ws');

/** In-memory mock routes: array of { id, enabled, type, method, path, statusCode, responseHeaders, responseBody, delay } */
let mockRoutes = [];

/** The running mock HTTP server, or null. */
let mockServerInstance = null;
let mockServerPort = 3002;

/** Active WebSocketServer (noServer mode), or null. */
let mockWss = null;

/** Tracks all live WS client entries { ws, clientId } for clean teardown. */
const mockWsClients = new Set();
let wsClientCounter = 0;

/** Traffic log — up to MAX_LOG_ENTRIES most recent requests (newest first). */
const MAX_LOG_ENTRIES = 200;
let mockRequestLog = [];

function generateMockId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function addLogEntry(entry) {
  mockRequestLog.unshift(entry);
  if (mockRequestLog.length > MAX_LOG_ENTRIES) mockRequestLog.length = MAX_LOG_ENTRIES;
}

/**
 * Attempt to match a path against a route pattern that may contain :params.
 * Returns param map if matched, null otherwise.
 */
function matchPath(pattern, incoming) {
  const patParts = pattern.replace(/\/+$/, '').split('/');
  const incParts = incoming.replace(/\?.*$/, '').replace(/\/+$/, '').split('/');
  if (patParts.length !== incParts.length) return null;
  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(':')) {
      params[patParts[i].slice(1)] = decodeURIComponent(incParts[i]);
    } else if (patParts[i] !== incParts[i]) {
      return null;
    }
  }
  return params;
}

/** Per-route hit counters: routeId → number of requests handled. */
const routeHitCounts = new Map();

/**
 * Resolve a dot-notation path (e.g. "user.address.city") against an object.
 * Supports numeric array indices ("items.0.id").
 */
function resolveDotPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Template substitution supporting:
 *   {{param.x}}               — URL path param
 *   {{query.x}}               — query string param
 *   {{body.x}} / {{body.x.y}} — request body field (dot-notation, array indices)
 *   {{header.x}}              — request header (lowercase key)
 *   {{method}}                — HTTP method
 *   {{url}}                   — path + query string
 *   {{$uuid}}                 — random UUID v4
 *   {{$timestamp}}            — current Unix timestamp (ms)
 *   {{$isoDate}}              — current ISO 8601 date-time
 *   {{$randomInt}}            — random integer 0–9999
 *   {{$randomInt(min,max)}}   — random integer in [min, max]
 *   {{$randomFloat(min,max)}} — random float in [min, max], 2 dp
 *   {{$randomItem(a,b,c)}}    — random pick from comma-separated list
 *   {{$requestCount}}         — total hits for this route (since server start)
 */
function interpolate(template, ctx) {
  // Built-ins with arguments: {{$randomInt(min,max)}}, {{$randomFloat(min,max)}}, {{$randomItem(a,b,c)}}
  let result = template.replace(/\{\{\$(\w+)\(([^)]*)\)\}\}/g, (match, fn, args) => {
    const parts = args.split(',').map(s => s.trim());
    if (fn === 'randomInt') {
      const min = parseInt(parts[0], 10) || 0;
      const max = parseInt(parts[1], 10) || 9999;
      return String(Math.floor(Math.random() * (max - min + 1)) + min);
    }
    if (fn === 'randomFloat') {
      const min = parseFloat(parts[0]) || 0;
      const max = parseFloat(parts[1]) || 1;
      return (Math.random() * (max - min) + min).toFixed(2);
    }
    if (fn === 'randomItem') {
      return parts[Math.floor(Math.random() * parts.length)] ?? '';
    }
    return match;
  });

  // No-argument built-ins: {{$uuid}}, {{$timestamp}}, {{$isoDate}}, {{$randomInt}}, {{$requestCount}}
  result = result.replace(/\{\{\$(\w+)\}\}/g, (match, fn) => {
    const now = new Date();
    if (fn === 'uuid') {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }
    if (fn === 'timestamp') return String(now.getTime());
    if (fn === 'isoDate') return now.toISOString();
    if (fn === 'randomInt') return String(Math.floor(Math.random() * 10000));
    if (fn === 'requestCount') return String(ctx._requestCount ?? 0);
    return match;
  });

  // Bare scalars: {{method}}, {{url}}
  result = result.replace(/\{\{(method|url)\}\}/g, (match, key) => {
    return ctx[key] != null ? String(ctx[key]) : match;
  });

  // Namespace variables: {{ns.path.to.value}} — supports dot-notation for body
  result = result.replace(/\{\{(\w+)\.([\w.]+)\}\}/g, (match, ns, path) => {
    const src = ctx[ns];
    if (src == null) return match;
    // For body allow deep dot-notation; for others only top-level key
    if (ns === 'body') {
      const val = resolveDotPath(src, path);
      return val != null ? String(val) : match;
    }
    // header, param, query — top-level only (first segment)
    const key = path.split('.')[0];
    const val = Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined;
    return val != null ? String(val) : match;
  });

  return result;
}

// ─── Rules Engine (Feature 2) ──────────────────────────────────────────────────

function getRuleValue(source, field, ctx) {
  switch (source) {
    case 'header': return ctx.header[field.toLowerCase()];
    case 'query':  return ctx.query[field];
    case 'body':   return String(resolveDotPath(ctx.body, field) ?? '');
    case 'param':  return ctx.param[field];
    default:       return undefined;
  }
}

function evaluateRule(rule, ctx) {
  const actual = getRuleValue(rule.source, rule.field, ctx);
  const expected = rule.value ?? '';
  switch (rule.operator) {
    case 'exists':      return actual !== undefined && actual !== null && actual !== '';
    case 'not-exists':  return actual === undefined || actual === null || actual === '';
    case 'equals':      return String(actual ?? '') === expected;
    case 'not-equals':  return String(actual ?? '') !== expected;
    case 'contains':    return String(actual ?? '').includes(expected);
    case 'starts-with': return String(actual ?? '').startsWith(expected);
    default:            return false;
  }
}

function findMatchingRule(rules, ctx) {
  for (const rule of (rules || [])) {
    if (evaluateRule(rule, ctx)) return rule;
  }
  return null;
}

// ─── Response Scripting (Feature 3) ───────────────────────────────────────────

/**
 * Run a user-supplied JS snippet in a sandboxed vm context.
 * Returns { status, body, headers } if respond() was called, otherwise null.
 */
function runMockScript(script, ctx) {
  if (!script || !script.trim()) return null;
  let result = null;
  const sandbox = {
    req: {
      method: ctx.method,
      path: ctx._pathname,
      url: ctx.url,
      headers: ctx.header,
      query: ctx.query,
      params: ctx.param,
      body: ctx.body,
      requestCount: ctx._requestCount,
    },
    respond(status, body, headers) {
      result = {
        status: parseInt(status, 10) || 200,
        body: body != null ? (typeof body === 'object' ? JSON.stringify(body) : String(body)) : '',
        headers: Array.isArray(headers) ? headers : [],
      };
    },
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
    JSON,
    Math,
    Date,
  };
  try {
    vm.runInNewContext(script, sandbox, { timeout: 2000 });
  } catch (_) {
    // script errors are silenced — fall through to rules/default
  }
  return result;
}

function buildMockHandler() {
  return function (req, res) {
    const method = req.method.toUpperCase();
    const url = req.url || '/';

    // Parse query string into object
    const qIdx = url.indexOf('?');
    const pathname = qIdx >= 0 ? url.slice(0, qIdx) : url;
    const query = {};
    if (qIdx >= 0) {
      const qs = url.slice(qIdx + 1);
      qs.split('&').forEach(pair => {
        const [k, v] = pair.split('=');
        if (k) query[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
      });
    }

    // Find matching route (first enabled HTTP match — WS routes are handled by the upgrade handler)
    let matched = null;
    let pathParams = {};
    for (const route of mockRoutes) {
      if (!route.enabled) continue;
      if (route.type === 'websocket') continue;
      if (route.method !== '*' && route.method.toUpperCase() !== method) continue;
      const params = matchPath(route.path, pathname);
      if (params !== null) {
        matched = route;
        pathParams = params;
        break;
      }
    }

    if (!matched) {
      const notFoundBody = JSON.stringify({ error: 'No matching mock route', method, path: pathname });
      addLogEntry({
        id: generateMockId(),
        timestamp: new Date().toISOString(),
        method,
        path: pathname,
        query,
        headers: req.headers,
        body: '',
        matchedRouteId: null,
        matchedRouteName: null,
        matchedRoutePath: null,
        responseStatus: 404,
        responseBody: notFoundBody,
      });
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(notFoundBody);
      return;
    }

    // Collect body for POST/PUT/PATCH
    let bodyChunks = [];
    req.on('data', chunk => bodyChunks.push(chunk));
    req.on('end', () => {
      let bodyObj = {};
      const rawBody = Buffer.concat(bodyChunks).toString('utf-8');
      try {
        if (rawBody) bodyObj = JSON.parse(rawBody);
      } catch { /* non-JSON body */ }

      // Increment per-route hit counter
      const hitCount = (routeHitCounts.get(matched.id) ?? 0) + 1;
      routeHitCounts.set(matched.id, hitCount);

      const ctx = {
        param: pathParams,
        query,
        body: bodyObj,
        header: req.headers,
        method,
        url,
        _pathname: pathname,
        _requestCount: hitCount,
      };

      // Priority: Script → Rules → Default response
      const scriptResult = runMockScript(matched.script, ctx);
      const matchedRule = !scriptResult ? findMatchingRule(matched.rules, ctx) : null;

      const finalStatus = scriptResult
        ? scriptResult.status
        : matchedRule
          ? matchedRule.statusCode
          : (matched.statusCode || 200);

      const rawResponseBody = scriptResult
        ? scriptResult.body
        : matchedRule
          ? matchedRule.responseBody
          : matched.responseBody;

      const responseBody = interpolate(rawResponseBody, ctx);

      // Merge headers: base route headers, then rule/script overrides
      const headers = { 'Access-Control-Allow-Origin': '*' };
      (matched.responseHeaders || []).forEach(h => {
        if (h.key) headers[h.key] = interpolate(h.value, ctx);
      });
      if (scriptResult) {
        (scriptResult.headers || []).forEach(h => {
          if (h.key) headers[h.key] = h.value;
        });
      }
      if (!headers['Content-Type']) {
        try { JSON.parse(responseBody); headers['Content-Type'] = 'application/json'; }
        catch { headers['Content-Type'] = 'text/plain'; }
      }

      addLogEntry({
        id: generateMockId(),
        timestamp: new Date().toISOString(),
        method,
        path: pathname,
        query,
        headers: req.headers,
        body: rawBody,
        matchedRouteId: matched.id,
        matchedRouteName: matched.description || matched.path,
        matchedRoutePath: matched.path,
        responseStatus: finalStatus,
        responseBody,
      });

      const send = () => {
        res.writeHead(finalStatus, headers);
        res.end(responseBody);
      };

      const delay = Math.min(parseInt(matched.delay, 10) || 0, 30000);
      if (delay > 0) setTimeout(send, delay);
      else send();
    });
  };
}

// ─── WebSocket Upgrade Handler (Feature 7) ────────────────────────────────────

/**
 * Detect whether a WS message is JSON, XML, or plain string.
 * @returns {'json'|'xml'|'string'}
 */
function detectWsMsgType(text) {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { JSON.parse(t); return 'json'; } catch (_) {}
  }
  if (t.startsWith('<')) return 'xml';
  return 'string';
}

/**
 * Normalise a message for comparison purposes.
 * JSON → canonical re-serialisation (key order preserved, whitespace stripped).
 * XML  → whitespace between tags collapsed, leading/trailing stripped.
 * string → unchanged.
 */
function normaliseWsMsg(text, type) {
  if (type === 'json') {
    try { return JSON.stringify(JSON.parse(text)); } catch (_) { return text; }
  }
  if (type === 'xml') {
    return text.trim().replace(/>\s+</g, '><').replace(/\s+/g, ' ');
  }
  return text;
}

/**
 * True when the incoming WS message matches a handler's pattern,
 * ignoring insignificant whitespace for JSON and XML messages.
 */
function wsMessagesMatch(incoming, pattern) {
  const inType  = detectWsMsgType(incoming);
  const patType = detectWsMsgType(pattern);
  if (inType === 'json' && patType === 'json') {
    return normaliseWsMsg(incoming, 'json') === normaliseWsMsg(pattern, 'json');
  }
  if (inType === 'xml' && patType === 'xml') {
    return normaliseWsMsg(incoming, 'xml') === normaliseWsMsg(pattern, 'xml');
  }
  return incoming === pattern;
}

function handleWsUpgrade(req, socket, head) {
  const url = req.url || '/';
  let parsedUrl;

  try {
    parsedUrl = new URL(url, 'http://localhost');
  } catch (err) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const pathname = parsedUrl.pathname;

  // Parse upgrade-request query string
  const wsQuery = {};
  for (const [k, v] of parsedUrl.searchParams.entries()) {
    wsQuery[k] = v;
  }

  // Find first enabled WebSocket route matching the path
  let matched = null;
  let pathParams = {};
  for (const route of mockRoutes) {
    if (!route.enabled) continue;
    if (route.type !== 'websocket') continue;
    const params = matchPath(route.path, pathname);
    if (params !== null) {
      matched = route;
      pathParams = params;
      break;
    }
  }

  if (!matched || !mockWss) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  mockWss.handleUpgrade(req, socket, head, ws => {
    const clientId = String(++wsClientCounter);
    const clientEntry = { ws, clientId };
    mockWsClients.add(clientEntry);

    // Log connect event
    addLogEntry({
      id: generateMockId(),
      timestamp: new Date().toISOString(),
      method: 'WS',
      path: pathname,
      query: {},
      headers: req.headers,
      body: '',
      matchedRouteId: matched.id,
      matchedRouteName: matched.description || matched.path,
      matchedRoutePath: matched.path,
      responseStatus: 101,
      responseBody: '',
      wsEventType: 'ws_connect',
      wsClientId: clientId,
    });

    // Base interpolation context (no incoming message body yet)
    const baseCtx = {
      param: pathParams,
      query: wsQuery,
      header: req.headers,
      method: 'WS',
      url: req.url || pathname,
      _pathname: pathname,
      _requestCount: 0,
      body: {},
    };

    // Send on-connect events
    for (const event of (matched.wsOnConnect || [])) {
      const delay = Math.min(parseInt(event.delay, 10) || 0, 30000);
      setTimeout(() => {
        if (ws.readyState === ws.OPEN) {
          const outPayload = interpolate(event.payload, baseCtx);
          const outType = detectWsMsgType(outPayload);
          ws.send(outPayload);
          addLogEntry({
            id: generateMockId(),
            timestamp: new Date().toISOString(),
            method: 'WS',
            path: pathname,
            query: {},
            headers: {},
            body: '',
            matchedRouteId: matched.id,
            matchedRouteName: matched.description || matched.path,
            matchedRoutePath: matched.path,
            responseStatus: 101,
            responseBody: outPayload,
            wsEventType: 'ws_message_out',
            wsClientId: clientId,
            wsMessageType: outType,
          });
        }
      }, delay);
    }

    ws.on('message', data => {
      const text = data.toString();
      const msgType = detectWsMsgType(text);

      // Log incoming message
      addLogEntry({
        id: generateMockId(),
        timestamp: new Date().toISOString(),
        method: 'WS',
        path: pathname,
        query: {},
        headers: {},
        body: text,
        matchedRouteId: matched.id,
        matchedRouteName: matched.description || matched.path,
        matchedRoutePath: matched.path,
        responseStatus: 101,
        responseBody: '',
        wsEventType: 'ws_message_in',
        wsClientId: clientId,
        wsMessageType: msgType,
      });

      // Build per-message interpolation context (parse JSON body for {{body.x}} access)
      const hitCount = (routeHitCounts.get(matched.id) ?? 0) + 1;
      routeHitCounts.set(matched.id, hitCount);
      let msgBodyObj = {};
      if (msgType === 'json') {
        try { msgBodyObj = JSON.parse(text); } catch (_) {}
      }
      const msgCtx = {
        param: pathParams,
        query: wsQuery,
        header: req.headers,
        method: 'WS',
        url: req.url || pathname,
        _pathname: pathname,
        _requestCount: hitCount,
        body: msgBodyObj,
      };

      // Find and send matching handler response (JSON/XML matched ignoring whitespace)
      const handler = (matched.wsMessageHandlers || []).find(h => wsMessagesMatch(text, h.matchPattern));
      if (handler && ws.readyState === ws.OPEN) {
        const outResponse = interpolate(handler.response, msgCtx);
        const outType = detectWsMsgType(outResponse);
        ws.send(outResponse);
        addLogEntry({
          id: generateMockId(),
          timestamp: new Date().toISOString(),
          method: 'WS',
          path: pathname,
          query: {},
          headers: {},
          body: '',
          matchedRouteId: matched.id,
          matchedRouteName: matched.description || matched.path,
          matchedRoutePath: matched.path,
          responseStatus: 101,
          responseBody: outResponse,
          wsEventType: 'ws_message_out',
          wsClientId: clientId,
          wsMessageType: outType,
        });
      }
    });

    ws.on('close', () => {
      mockWsClients.delete(clientEntry);
      addLogEntry({
        id: generateMockId(),
        timestamp: new Date().toISOString(),
        method: 'WS',
        path: pathname,
        query: {},
        headers: {},
        body: '',
        matchedRouteId: matched.id,
        matchedRouteName: matched.description || matched.path,
        matchedRoutePath: matched.path,
        responseStatus: 101,
        responseBody: '',
        wsEventType: 'ws_disconnect',
        wsClientId: clientId,
      });
    });

    ws.on('error', () => {
      mockWsClients.delete(clientEntry);
    });
  });
}

function startMockServer(port, routes) {
  return new Promise((resolve, reject) => {
    if (mockServerInstance) {
      mockServerInstance.close(() => { mockServerInstance = null; });
    }
    mockRoutes = routes || [];
    mockServerPort = port;
    mockRequestLog = [];
    routeHitCounts.clear();
    wsClientCounter = 0;

    const server = http.createServer(buildMockHandler());

    // WebSocket support — noServer mode shares the same port
    mockWss = new WebSocketServer({ noServer: true });
    server.on('upgrade', handleWsUpgrade);

    server.on('error', err => reject(err));
    server.listen(port, () => {
      mockServerInstance = server;
      resolve();
    });
  });
}

function stopMockServer() {
  return new Promise(resolve => {
    if (!mockServerInstance) { resolve(); return; }

    // Terminate all active WS connections
    for (const { ws } of mockWsClients) {
      try { ws.terminate(); } catch (_) {}
    }
    mockWsClients.clear();

    if (mockWss) {
      mockWss.close();
      mockWss = null;
    }

    mockServerInstance.close(() => {
      mockServerInstance = null;
      resolve();
    });
  });
}

// GET /api/mock/status
app.get('/api/mock/status', (_req, res) => {
  res.json({ running: mockServerInstance !== null, port: mockServerPort });
});

// POST /api/mock/start  { port, routes }
app.post('/api/mock/start', async (req, res) => {
  const { port, routes } = req.body;
  const p = parseInt(port, 10) || 3002;
  if (p < 1024 || p > 65535) {
    return res.status(400).json({ error: 'Port must be between 1024 and 65535' });
  }
  try {
    await startMockServer(p, routes || []);
    res.json({ ok: true, port: p });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mock/stop
app.post('/api/mock/stop', async (_req, res) => {
  await stopMockServer();
  res.json({ ok: true });
});

// PUT /api/mock/routes — sync all routes while server is running
app.put('/api/mock/routes', (req, res) => {
  mockRoutes = req.body.routes || [];
  res.json({ ok: true, count: mockRoutes.length });
});

// GET /api/mock-log — return traffic log
app.get('/api/mock-log', (_req, res) => {
  res.json({ entries: mockRequestLog });
});

// DELETE /api/mock-log — clear traffic log
app.delete('/api/mock-log', (_req, res) => {
  mockRequestLog = [];
  res.json({ ok: true });
});

// ─── Git Sync Routes ───────────────────────────────────────────────────────────
//
// These routes use `simple-git` to maintain a local git repository per
// workspace inside {userData}/git-sync/workspaces/{workspaceId}/.
// The userData path is supplied by the renderer via the request body
// because the server process may not have direct access to Electron's
// app.getPath('userData') — it receives it once per call.
//
// All three routes share the same validation and git-repo bootstrap logic.

let simpleGit;
try {
  simpleGit = require('simple-git');
} catch {
  // simple-git is optional — git sync routes will return 501 if missing
}

const path = require('path');
const fs = require('fs');

function assertGitAvailable(res) {
  if (!simpleGit) {
    res.status(501).json({ error: 'simple-git package not installed. Run: npm install simple-git in the server directory.' });
    return false;
  }
  return true;
}

/**
 * Bootstrap a local git repo for the given workspace.
 * Returns a simple-git instance pointing at `repoDir`.
 */
async function ensureRepo(repoDir, config) {
  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(repoDir, { recursive: true });
  }
  const git = simpleGit(repoDir);
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) {
    await git.init();
  }

  // Self-heal interrupted git operations from previous failed sync attempts.
  // This prevents errors like:
  // "needs merge" / "resolve your current index first".
  await git.raw(['merge', '--abort']).catch(() => {});
  await git.raw(['rebase', '--abort']).catch(() => {});
  await git.raw(['cherry-pick', '--abort']).catch(() => {});
  const repoStatus = await git.status().catch(() => null);
  if (repoStatus?.conflicted?.length) {
    await git.reset(['--hard']).catch(() => {});
  }

  // Set remote
  const remotes = await git.getRemotes();
  if (!remotes.find(r => r.name === 'origin')) {
    await git.addRemote('origin', config.remote);
  } else {
    await git.remote(['set-url', 'origin', config.remote]);
  }
  // Configure author
  if (config.authorName) await git.addConfig('user.name', config.authorName);
  if (config.authorEmail) await git.addConfig('user.email', config.authorEmail);
  // Always use merge strategy on pull (avoids "divergent branches" error)
  await git.addConfig('pull.rebase', 'false');
  // Ensure the target branch exists locally and is checked out before commit/push.
  const branch = config.branch || 'main';
  const localBranches = await git.branchLocal();
  if (localBranches.all.includes(branch)) {
    await git.checkout(branch);
  } else {
    await git.checkoutLocalBranch(branch);
  }
  return git;
}

// POST /api/sync/git/push
app.post('/api/sync/git/push', async (req, res) => {
  if (!assertGitAvailable(res)) return;
  const { workspaceId, data, config, expectedVersion } = req.body;
  const dataDir = req.body.dataDir || process.env.APILIX_DATA_DIR;
  if (!workspaceId || !data || !config?.remote || !dataDir) {
    return res.status(400).json({ error: 'workspaceId, data, config.remote, and dataDir are required' });
  }
  // Guard path traversal
  const repoBase = path.join(dataDir, 'git-sync', 'workspaces');
  const repoDir = path.resolve(repoBase, workspaceId);
  if (!repoDir.startsWith(path.resolve(repoBase))) {
    return res.status(400).json({ error: 'Invalid workspaceId' });
  }
  try {
    const git = await ensureRepo(repoDir, config);
    if (expectedVersion) {
      let remote = config.remote;
      if (config.token && config.username) {
        const remoteUrl = new URL(remote);
        remoteUrl.username = encodeURIComponent(config.username);
        remoteUrl.password = encodeURIComponent(config.token);
        remote = remoteUrl.toString();
      }
      await git.fetch(remote, config.branch || 'main');
      const fetchedVersion = await git.revparse(['FETCH_HEAD']).catch(() => null);
      if (!fetchedVersion || fetchedVersion !== expectedVersion) {
        return res.status(409).json({
          error: 'Remote changed since merge started',
          code: 'STALE_VERSION',
          expectedVersion,
          currentVersion: fetchedVersion,
        });
      }
    }
    const filePath = path.join(repoDir, 'workspace.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    const branch = config.branch || 'main';
    await git.add('.');
    const status = await git.status();
    if (status.files.length === 0) {
      return res.json({ ok: true, message: 'Nothing to commit' });
    }
    await git.commit(`chore: sync workspace ${workspaceId} at ${new Date().toISOString()}`);
    // Build authenticated remote URL if token provided
    let remote = config.remote;
    if (config.token && config.username) {
      const url = new URL(remote);
      url.username = encodeURIComponent(config.username);
      url.password = encodeURIComponent(config.token);
      remote = url.toString();
    }
    await git.push(remote, branch, ['--set-upstream']);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync/git/pull
app.post('/api/sync/git/pull', async (req, res) => {
  if (!assertGitAvailable(res)) return;
  const { workspaceId, config } = req.body;
  const dataDir = req.body.dataDir || process.env.APILIX_DATA_DIR;
  if (!workspaceId || !config?.remote || !dataDir) {
    return res.status(400).json({ error: 'workspaceId, config.remote, and dataDir are required' });
  }
  const repoBase = path.join(dataDir, 'git-sync', 'workspaces');
  const repoDir = path.resolve(repoBase, workspaceId);
  if (!repoDir.startsWith(path.resolve(repoBase))) {
    return res.status(400).json({ error: 'Invalid workspaceId' });
  }
  try {
    const git = await ensureRepo(repoDir, config);
    const branch = config.branch || 'main';
    let remote = config.remote;
    if (config.token && config.username) {
      const url = new URL(remote);
      url.username = encodeURIComponent(config.username);
      url.password = encodeURIComponent(config.token);
      remote = url.toString();
    }
    // Deterministic pull behavior:
    // fetch remote branch and hard-reset local branch to fetched HEAD.
    // This avoids merge conflicts in the local mirror repo used for sync.
    try {
      await git.fetch(remote, branch);
    } catch (fetchErr) {
      const message = String(fetchErr?.message || fetchErr);
      if (
        message.includes('couldn\'t find remote ref') ||
        message.includes('Remote branch') ||
        message.includes('not found in upstream origin')
      ) {
        return res.status(404).json({ error: `No remote branch ${branch}` });
      }
      throw fetchErr;
    }
    await git.checkout(branch);
    await git.reset(['--hard', 'FETCH_HEAD']);
    const filePath = path.join(repoDir, 'workspace.json');
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'No workspace.json in remote' });
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const log = await git.log(['HEAD', '-1']).catch(() => null);
    const version = await git.revparse(['HEAD']).catch(() => null);
    res.json({
      data,
      timestamp: log?.latest?.date ?? null,
      version,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync/git/timestamp
app.post('/api/sync/git/timestamp', async (req, res) => {
  if (!assertGitAvailable(res)) return;
  const { workspaceId, config } = req.body;
  const dataDir = req.body.dataDir || process.env.APILIX_DATA_DIR;
  if (!workspaceId || !config?.remote || !dataDir) {
    return res.status(400).json({ error: 'workspaceId, config.remote, and dataDir are required' });
  }
  const repoBase = path.join(dataDir, 'git-sync', 'workspaces');
  const repoDir = path.resolve(repoBase, workspaceId);
  if (!repoDir.startsWith(path.resolve(repoBase))) {
    return res.status(400).json({ error: 'Invalid workspaceId' });
  }
  try {
    const git = await ensureRepo(repoDir, config);
    let remote = config.remote;
    if (config.token && config.username) {
      const url = new URL(remote);
      url.username = encodeURIComponent(config.username);
      url.password = encodeURIComponent(config.token);
      remote = url.toString();
    }
    // Fetch only — don't merge
    await git.fetch(remote, config.branch || 'main');
    const version = await git.revparse(['FETCH_HEAD']).catch(() => null);
    const log = await git.log(['FETCH_HEAD', '-1']).catch(() => null);
    if (!log || !log.latest) {
      return res.json({ timestamp: null, version });
    }
    res.json({ timestamp: log.latest.date, version });
  } catch (err) {
    res.json({ timestamp: null, version: null });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  APILIX server running on http://localhost:${PORT}\n`);
});
