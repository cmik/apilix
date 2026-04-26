'use strict';

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const vm = require('vm');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const {
  executeRequest, setExecutorConfig,
  prepareCollectionRun, executePreparedCollectionRun, InputError,
  refreshOAuth2Token, exchangeAuthorizationCodeForToken,
} = require('@apilix/core');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Mutable server config (updated via POST /api/settings) ──────────────────────────────
const serverConfig = {
  proxyEnabled: false,
  httpProxy: '',
  httpsProxy: '',
  noProxy: '',
  corsAllowedOrigins: '',
  requestTimeout: 30000,
  followRedirects: true,
  sslVerification: false,
};

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Only allow localhost origins (all ports) by default.
// Set ALLOWED_ORIGINS to a comma-separated list to customise (e.g. for reverse
// proxies or non-standard ports).
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : null; // null → localhost-only heuristic

// ─── Runner pause/resume/stop state ──────────────────────────────────────────

/** @type {Map<string, { paused: boolean, stopped: boolean }>} */
const runStates = new Map();

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (Electron renderer via file://, curl, Postman, …)
    if (!origin) return callback(null, true);
    // Allow explicitly configured origins (env var takes priority)
    if (ALLOWED_ORIGINS && ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    // Allow dynamically configured origins from settings
    if (serverConfig.corsAllowedOrigins) {
      const dynamic = serverConfig.corsAllowedOrigins.split(',').map(o => o.trim()).filter(Boolean);
      if (dynamic.includes(origin)) return callback(null, true);
    }
    // Allow any localhost origin (http or https, any port) when no explicit list is set
    if (!ALLOWED_ORIGINS && /^https?:\/\/localhost(:\d+)?$/.test(origin)) return callback(null, true);
    callback(Object.assign(new Error(`CORS: origin '${origin}' not allowed`), { status: 403 }));
  },
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * Validate that a URL is a safe http/https URL to use as an OAuth token endpoint.
 * Rejects non-http(s) protocols to prevent SSRF via dangerous schemes.
 */
function validateTokenUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// ─── Health check ──────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// ─── WSDL proxy ────────────────────────────────────────────────────────────────

app.get('/api/wsdl', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl || typeof rawUrl !== 'string') {
    return res.status(400).json({ error: 'Missing url query parameter' });
  }
  let parsed;
  try { parsed = new URL(rawUrl); } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).json({ error: 'URL must use http or https scheme' });
  }
  try {
    const response = await axios.get(rawUrl, { responseType: 'text', timeout: 10000 });
    res.set('Content-Type', 'application/xml').send(response.data);
  } catch (err) {
    const status = err.response?.status ?? 502;
    res.status(status).json({ error: err.message ?? 'Failed to fetch WSDL' });
  }
});

// ─── App settings ──────────────────────────────────────────────────────────────

app.post('/api/settings', (req, res) => {
  const { proxy, cors: corsConfig, requests } = req.body ?? {};
  if (proxy && typeof proxy === 'object') {
    serverConfig.proxyEnabled = proxy.enabled === true;
    serverConfig.httpProxy = typeof proxy.httpProxy === 'string' ? proxy.httpProxy : '';
    serverConfig.httpsProxy = typeof proxy.httpsProxy === 'string' ? proxy.httpsProxy : '';
    serverConfig.noProxy = typeof proxy.noProxy === 'string' ? proxy.noProxy : '';
  }
  if (corsConfig && typeof corsConfig === 'object') {
    serverConfig.corsAllowedOrigins = typeof corsConfig.allowedOrigins === 'string' ? corsConfig.allowedOrigins : '';
  }
  if (requests && typeof requests === 'object') {
    if (typeof requests.timeout === 'number' && requests.timeout >= 0) {
      serverConfig.requestTimeout = requests.timeout;
    }
    if (typeof requests.followRedirects === 'boolean') {
      serverConfig.followRedirects = requests.followRedirects;
    }
    if (typeof requests.sslVerification === 'boolean') {
      serverConfig.sslVerification = requests.sslVerification;
    }
  }
  setExecutorConfig(serverConfig);
  res.json({ ok: true });
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

// ─── OAuth 2.0 endpoints ───────────────────────────────────────────────────────

app.post('/api/oauth/refresh', async (req, res) => {
  try {
    const { oauth2Config, environment } = req.body;
    if (!oauth2Config) {
      return res.status(400).json({ error: 'Missing oauth2Config in body' });
    }

    if (!validateTokenUrl(oauth2Config.tokenUrl)) {
      return res.status(400).json({ error: 'Invalid or disallowed tokenUrl' });
    }

    const vars = environment || {};
    const refreshResult = await refreshOAuth2Token(oauth2Config, vars);

    return res.json({
      success: true,
      accessToken: refreshResult.accessToken,
      refreshToken: refreshResult.refreshToken,
      expiresAt: refreshResult.expiresAt,
    });
  } catch (err) {
    console.error('OAuth refresh error:', err);
    return res.status(400).json({ error: err.message });
  }
});

app.post('/api/oauth/exchange-code', async (req, res) => {
  try {
    const { oauth2Config, authorizationCode, codeVerifier, environment } = req.body;
    if (!oauth2Config || !authorizationCode) {
      return res.status(400).json({ error: 'Missing oauth2Config or authorizationCode in body' });
    }

    if (!validateTokenUrl(oauth2Config.tokenUrl)) {
      return res.status(400).json({ error: 'Invalid or disallowed tokenUrl' });
    }

    const resolvedCodeVerifier = codeVerifier || oauth2Config.codeVerifier;
    const vars = environment || {};
    const tokenResult = await exchangeAuthorizationCodeForToken(oauth2Config, authorizationCode, resolvedCodeVerifier, vars);

    return res.json({
      success: true,
      accessToken: tokenResult.accessToken,
      refreshToken: tokenResult.refreshToken,
      expiresAt: tokenResult.expiresAt,
    });
  } catch (err) {
    console.error('Authorization code exchange error:', err);
    return res.status(400).json({ error: err.message });
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
  let runId = null;
  try {
    const payload = JSON.parse(req.body.data || '{}');
    let csvText = null;
    let jsonRows = null;
    if (req.file) {
      const content = req.file.buffer.toString('utf-8').trim();
      if (content.startsWith('[')) {
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed))
          return res.status(400).json({ error: 'JSON data file must be an array' });
        jsonRows = parsed;
      } else {
        csvText = content;
      }
    }
    const prepared = prepareCollectionRun(payload, { csvText, jsonRows });

    if (prepared.requests.length === 0) {
      return res.json({ results: [] });
    }

    runId = prepared.runId;
    const runState = { paused: false, stopped: false };
    runStates.set(runId, runState);

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

    await executePreparedCollectionRun(prepared, {
      runState,
      onEvent: sendEvent,
      collectIterations: false,
      collectResults: false,
    });

    res.end();
  } catch (err) {
    console.error('Run error:', err);
    // If headers already sent, send error as SSE event
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    } else if (err instanceof InputError) {
      return res.status(400).json({ error: err.message });
    } else {
      return res.status(500).json({ error: err.message });
    }
  } finally {
    if (runId !== null) runStates.delete(runId);
  }
});

// ─── Mock Server ───────────────────────────────────────────────────────────────

const http = require('http');
const { WebSocketServer } = require('ws');

/** In-memory mock routes: array of { id, enabled, type, method, path, statusCode, responseHeaders, responseBody, delay } */
let mockRoutes = [];

// Two-tier route index rebuilt on every mockRoutes update.
// Static routes (no :param segments) are stored in a Map for O(1) lookup.
// Parametric routes remain in an ordered array for sequential scan.
// Disabled routes are excluded at build time.
let _staticHttp = new Map(); // key: "METHOD:/path" or "*:/path"
let _paramHttp  = [];         // [{ route, originalIndex }]
let _staticWs   = new Map(); // key: "/path"
let _paramWs    = [];         // [{ route, originalIndex }]

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

const _mockLogFile = () => process.env.APILIX_DATA_DIR
  ? path.join(process.env.APILIX_DATA_DIR, 'mock-traffic-log.json')
  : null;

function _loadMockLog() {
  const file = _mockLogFile();
  if (!file) return;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(data)) mockRequestLog = data.slice(0, MAX_LOG_ENTRIES);
  } catch {}
}

let _saveMockLogTimer = null;
function _saveMockLogDebounced() {
  const file = _mockLogFile();
  if (!file) return;
  if (_saveMockLogTimer) clearTimeout(_saveMockLogTimer);
  _saveMockLogTimer = setTimeout(() => {
    try { fs.writeFileSync(file, JSON.stringify(mockRequestLog), 'utf8'); } catch {}
    _saveMockLogTimer = null;
  }, 2000);
}

function _clearMockLogFile() {
  const file = _mockLogFile();
  if (!file) return;
  try { fs.unlinkSync(file); } catch {}
}

_loadMockLog();

function generateMockId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function addLogEntry(entry) {
  mockRequestLog.push(entry);
  if (mockRequestLog.length > MAX_LOG_ENTRIES) mockRequestLog.shift();
  _saveMockLogDebounced();
}

function safeDecode(str) {
  try { return decodeURIComponent(str); } catch { return str; }
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
      params[patParts[i].slice(1)] = safeDecode(incParts[i]);
    } else if (patParts[i] !== incParts[i]) {
      return null;
    }
  }
  return params;
}

/** Per-route hit counters: routeId → number of requests handled. */
const routeHitCounts = new Map();

/** Shared in-memory state for persistent mock data across routes. */
let mockDb = Object.create(null);

function cloneJson(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function ensureDbArray(key) {
  if (!Array.isArray(mockDb[key])) mockDb[key] = [];
  return mockDb[key];
}

function createMockDbApi() {
  return {
    get(key, fallback = null) {
      return hasOwn(mockDb, key) ? cloneJson(mockDb[key]) : fallback;
    },
    set(key, value) {
      mockDb[key] = cloneJson(value);
      return cloneJson(mockDb[key]);
    },
    has(key) {
      return hasOwn(mockDb, key);
    },
    delete(key) {
      if (!hasOwn(mockDb, key)) return false;
      delete mockDb[key];
      return true;
    },
    clear() {
      mockDb = Object.create(null);
    },
    keys() {
      return Object.keys(mockDb);
    },
    list(key) {
      return Array.isArray(mockDb[key]) ? cloneJson(mockDb[key]) : [];
    },
    push(key, value) {
      const arr = ensureDbArray(key);
      const next = cloneJson(value);
      arr.push(next);
      return cloneJson(next);
    },
    findById(key, id, idField = 'id') {
      const arr = Array.isArray(mockDb[key]) ? mockDb[key] : [];
      const found = arr.find(item => item && String(item[idField]) === String(id));
      return found ? cloneJson(found) : null;
    },
    upsertById(key, id, patch = {}, idField = 'id') {
      const arr = ensureDbArray(key);
      const idx = arr.findIndex(item => item && String(item[idField]) === String(id));
      const safePatch = (patch && typeof patch === 'object') ? cloneJson(patch) : {};
      if (idx >= 0) {
        arr[idx] = { ...arr[idx], ...safePatch, [idField]: id };
        return cloneJson(arr[idx]);
      }
      const created = { [idField]: id, ...safePatch };
      arr.push(created);
      return cloneJson(created);
    },
    removeById(key, id, idField = 'id') {
      const arr = Array.isArray(mockDb[key]) ? mockDb[key] : [];
      const idx = arr.findIndex(item => item && String(item[idField]) === String(id));
      if (idx < 0) return false;
      arr.splice(idx, 1);
      return true;
    },
  };
}

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

  // Namespace variables: {{ns.path.to.value}} — supports dot-notation for body and db
  result = result.replace(/\{\{(\w+)\.([\w.]+)\}\}/g, (match, ns, path) => {
    const src = ctx[ns];
    if (src == null) return match;
    // For body/db allow deep dot-notation; for others only top-level key
    if (ns === 'body' || ns === 'db') {
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
  const db = createMockDbApi();
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
    db,
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

// ─── Chaos Mode (Feature 9) ───────────────────────────────────────────────────

/**
 * Apply per-route chaos settings to an outgoing HTTP response.
 *
 * @param {object|undefined} chaos  - route.chaos config
 * @param {object} req              - Node.js IncomingMessage
 * @param {object} res              - Node.js ServerResponse
 * @param {number} status           - resolved HTTP status code
 * @param {string} body             - resolved response body string
 * @param {object} headers          - resolved response headers object
 * @param {number} delay            - base route delay in ms (applied before send)
 * @returns {null|{responseDropped:boolean,responseStatus:number,responseBody:string}}
 *   - null → chaos not active; caller should send normally
 *   - object → chaos handled response/send path and includes final logged outcome
 */
function applyChaos(chaos, req, res, status, body, headers, delay) {
  if (!chaos || !chaos.enabled) return null;

  const safeDelay = Math.min(parseInt(delay, 10) || 0, 30000);

  // 1. Connection drop — checked first; if it fires we never send a response
  if (chaos.dropRate > 0 && Math.random() * 100 < chaos.dropRate) {
    const doDestroy = () => {
      try { req.socket && req.socket.destroy(); } catch (_) { /* ignore */ }
    };
    if (safeDelay > 0) setTimeout(doDestroy, safeDelay);
    else doDestroy();
    return {
      responseDropped: true,
      responseStatus: 0,
      responseBody: '[chaos] connection dropped',
    };
  }

  // 2. Error injection — override status + body but still send a response
  let finalStatus = status;
  let finalBody = typeof body === 'string' ? body : String(body ?? '');
  let finalHeaders = { ...headers };
  if (chaos.errorRate > 0 && Math.random() * 100 < chaos.errorRate) {
    finalStatus = 500;
    finalBody = JSON.stringify({ error: 'Chaos: injected error' });
    finalHeaders = { ...finalHeaders, 'Content-Type': 'application/json' };
  }

  // 3. Send — with optional bandwidth throttling applied after delay
  const doSend = () => {
    const kbps = parseFloat(chaos.throttleKbps) || 0;
    const isResponseClosed = () => res.writableEnded || res.destroyed || !res.writable;
    if (kbps > 0 && finalBody.length > 0) {
      // Chunk the body and drip it at ~kbps KB/s (one chunk every 50 ms)
      const bodyBuf = Buffer.from(finalBody, 'utf-8');
      const chunkSize = Math.max(1, Math.floor((kbps * 1024) / 1000 * 50));
      if (isResponseClosed()) return;
      try {
        res.writeHead(finalStatus, finalHeaders);
      } catch (_) {
        return;
      }
      let offset = 0;
      const scheduleNextChunk = () => {
        if (isResponseClosed()) return;
        setTimeout(sendChunk, 50);
      };
      const sendChunk = () => {
        if (isResponseClosed()) return;
        if (offset >= bodyBuf.length) {
          try {
            res.end();
          } catch (_) { /* ignore */ }
          return;
        }
        const slice = bodyBuf.slice(offset, offset + chunkSize);
        offset += chunkSize;
        let canContinue = false;
        try {
          canContinue = res.write(slice);
        } catch (_) {
          return;
        }
        if (canContinue) {
          scheduleNextChunk();
        } else {
          res.once('drain', scheduleNextChunk);
        }
      };
      sendChunk();
    } else {
      if (isResponseClosed()) return;
      try {
        res.writeHead(finalStatus, finalHeaders);
        res.end(finalBody);
      } catch (_) { /* ignore */ }
    }
  };

  if (safeDelay > 0) setTimeout(doSend, safeDelay);
  else doSend();
  return {
    responseDropped: false,
    responseStatus: finalStatus,
    responseBody: finalBody,
  };
}

/**
 * Rebuilds the static + parametric route indexes from the given routes array.
 * Must be called whenever mockRoutes is reassigned.
 */
function buildRouteIndex(routes) {
  const staticHttp = new Map();
  const paramHttp  = new Map(); // Map<segmentCount, Array<{route, originalIndex}>>
  const staticWs   = new Map();
  const paramWs    = new Map(); // Map<segmentCount, Array<{route, originalIndex}>>

  routes.forEach((route, originalIndex) => {
    if (!route.enabled) return;

    const isWs     = route.type === 'websocket';
    const hasParam = route.path.includes(':');
    const normPath = route.path.replace(/\/+$/, '') || '/';

    if (hasParam) {
      const segCount = normPath.split('/').length;
      if (isWs) {
        if (!paramWs.has(segCount)) paramWs.set(segCount, []);
        paramWs.get(segCount).push({ route, originalIndex });
      } else {
        if (!paramHttp.has(segCount)) paramHttp.set(segCount, []);
        paramHttp.get(segCount).push({ route, originalIndex });
      }
    } else {
      if (isWs) {
        // WS routes are not method-specific — key by path only
        if (!staticWs.has(normPath)) staticWs.set(normPath, { route, originalIndex });
      } else {
        const key = `${route.method.toUpperCase()}:${normPath}`;
        if (!staticHttp.has(key)) staticHttp.set(key, { route, originalIndex });
      }
    }
  });

  _staticHttp = staticHttp;
  _paramHttp  = paramHttp;
  _staticWs   = staticWs;
  _paramWs    = paramWs;
}

function buildMockHandler() {
  return function (req, res) {
    const method = req.method.toUpperCase();
    const url = req.url || '/';

    // Handle CORS preflight — respond with permissive headers so browser-based
    // frontends can call the mock server from any origin.
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    // Parse query string into object
    const qIdx = url.indexOf('?');
    const pathname = qIdx >= 0 ? url.slice(0, qIdx) : url;
    const query = {};
    if (qIdx >= 0) {
      const qs = url.slice(qIdx + 1);
      qs.split('&').forEach(pair => {
        const [k, v] = pair.split('=');
        if (k) query[safeDecode(k)] = safeDecode(v ?? '');
      });
    }

    // Find matching route — two-tier indexed lookup (O(1) for static, O(p) for parametric)
    let matched = null;
    let pathParams = {};
    {
      const normPath    = pathname.replace(/\/+$/, '') || '/';
      const specificKey = `${method}:${normPath}`;
      const wildcardKey = `*:${normPath}`;

      const staticSpecific = _staticHttp.get(specificKey) ?? null;
      const staticWildcard = _staticHttp.get(wildcardKey) ?? null;

      // Pick the static candidate with the lower original index (preserves list order)
      let staticCandidate = null;
      if (staticSpecific && staticWildcard) {
        staticCandidate = staticSpecific.originalIndex < staticWildcard.originalIndex
          ? staticSpecific : staticWildcard;
      } else {
        staticCandidate = staticSpecific ?? staticWildcard ?? null;
      }

      // Scan only the parametric subset — indexed by segment count for O(1) bucket lookup
      const incomingSegCount = pathname.replace(/\/+$/, '').split('/').length;
      let paramCandidate = null;
      for (const entry of (_paramHttp.get(incomingSegCount) ?? [])) {
        const { route } = entry;
        if (route.method !== '*' && route.method.toUpperCase() !== method) continue;
        const params = matchPath(route.path, pathname);
        if (params !== null) { paramCandidate = { ...entry, params }; break; }
      }

      // Use whichever candidate appeared first in the original list
      if (staticCandidate && (!paramCandidate || staticCandidate.originalIndex < paramCandidate.originalIndex)) {
        matched    = staticCandidate.route;
        pathParams = {};
      } else if (paramCandidate) {
        matched    = paramCandidate.route;
        pathParams = paramCandidate.params;
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
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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
        db: cloneJson(mockDb),
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

      const send = () => {
        res.writeHead(finalStatus, headers);
        res.end(responseBody);
      };

      const delay = Math.min(parseInt(matched.delay, 10) || 0, 30000);
      const chaosResult = applyChaos(matched.chaos, req, res, finalStatus, responseBody, headers, delay);
      const responseDropped = chaosResult ? chaosResult.responseDropped : false;
      const loggedStatus = chaosResult ? chaosResult.responseStatus : finalStatus;
      const loggedBody = chaosResult ? chaosResult.responseBody : responseBody;
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
        responseStatus: loggedStatus,
        responseBody: loggedBody,
        responseDropped,
      });
      if (chaosResult === null) {
        if (delay > 0) setTimeout(send, delay);
        else send();
      }
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

  // Find first enabled WebSocket route — two-tier indexed lookup
  let matched = null;
  let pathParams = {};
  {
    const normWsPath = pathname.replace(/\/+$/, '') || '/';
    const staticWsEntry = _staticWs.get(normWsPath) ?? null;

    const wsSegCount = pathname.replace(/\/+$/, '').split('/').length;
    let paramWsCandidate = null;
    for (const entry of (_paramWs.get(wsSegCount) ?? [])) {
      const params = matchPath(entry.route.path, pathname);
      if (params !== null) { paramWsCandidate = { ...entry, params }; break; }
    }

    if (staticWsEntry && (!paramWsCandidate || staticWsEntry.originalIndex < paramWsCandidate.originalIndex)) {
      matched    = staticWsEntry.route;
      pathParams = {};
    } else if (paramWsCandidate) {
      matched    = paramWsCandidate.route;
      pathParams = paramWsCandidate.params;
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
    buildRouteIndex(mockRoutes);
    mockServerPort = port;
    mockRequestLog = [];
    _clearMockLogFile();
    mockDb = Object.create(null);
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
  buildRouteIndex(mockRoutes);
  res.json({ ok: true, count: mockRoutes.length });
});

// GET /api/mock-log — return traffic log (newest first)
app.get('/api/mock-log', (_req, res) => {
  res.json({ entries: [...mockRequestLog].reverse() });
});

// DELETE /api/mock-log — clear traffic log
app.delete('/api/mock-log', (_req, res) => {
  mockRequestLog = [];
  _clearMockLogFile();
  res.json({ ok: true });
});

// GET /api/mock-db — inspect persistent mock state
app.get('/api/mock-db', (_req, res) => {
  res.json({ data: cloneJson(mockDb), keys: Object.keys(mockDb) });
});

// DELETE /api/mock-db — clear persistent mock state
app.delete('/api/mock-db', (_req, res) => {
  mockDb = Object.create(null);
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
    const branch = config.branch || 'main';
    const git = await ensureRepo(repoDir, config);
    // Build authenticated remote URL once — reused for fetch and push.
    let remote = config.remote;
    if (config.token && config.username) {
      const remoteUrl = new URL(remote);
      remoteUrl.username = encodeURIComponent(config.username);
      remoteUrl.password = encodeURIComponent(config.token);
      remote = remoteUrl.toString();
    }
    if (expectedVersion) {
      await git.fetch(remote, branch);
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
    // Sync local history with remote before committing so the push is always a
    // fast-forward. This fixes non-fast-forward rejections on a fresh local repo
    // whose history doesn't include the remote's existing commits.
    // Skip this fetch when expectedVersion was already verified above.
    if (!expectedVersion) {
      try {
        await git.fetch(remote, branch);
        try {
          await git.checkout(branch);
        } catch {
          await git.checkoutBranch(branch, 'FETCH_HEAD');
        }
        await git.reset(['--hard', 'FETCH_HEAD']);
      } catch (fetchErr) {
        const msg = String(fetchErr?.message || fetchErr);
        const branchMissing =
          msg.includes("couldn't find remote ref") ||
          msg.includes('not found in upstream') ||
          msg.includes('Remote branch');
        if (!branchMissing) throw fetchErr;
        // Remote branch doesn't exist yet — first push will create it, which is fine.
      }
    }
    const filePath = path.join(repoDir, 'workspace.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    await git.add('.');
    const status = await git.status();
    if (status.files.length === 0) {
      return res.json({ ok: true, message: 'Nothing to commit' });
    }
    await git.commit(`chore: sync workspace ${workspaceId} at ${new Date().toISOString()}`);
    await git.push(remote, branch, ['--set-upstream']);
    res.json({ ok: true });
  } catch (err) {
    const stderr = err?.git?.all ?? '';
    res.status(500).json({ error: err.message, ...(stderr && { stderr }) });
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
    // Checkout the branch — on a fresh repo the local branch is unborn so a plain
    // `git checkout main` fails with "pathspec 'main' did not match any file(s)".
    // In that case, create the branch pointing directly at FETCH_HEAD instead.
    try {
      await git.checkout(branch);
    } catch {
      await git.checkoutBranch(branch, 'FETCH_HEAD');
    }
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
    const stderr = err?.git?.all ?? '';
    res.status(500).json({ error: err.message, ...(stderr && { stderr }) });
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
    // Shallow fetch (depth=1) — only the tip commit, no full history download.
    // Read from FETCH_HEAD to avoid mutating any persistent local ref.
    const branch = config.branch || 'main';
    await git.fetch([remote, branch, '--depth=1']);
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

// POST /api/sync/git/test-connection
app.post('/api/sync/git/test-connection', async (req, res) => {
  if (!assertGitAvailable(res)) return;
  const { config } = req.body;
  if (!config?.remote || typeof config.remote !== 'string') {
    return res.status(400).json({ error: 'config.remote is required' });
  }

  // Reject non-network schemes (file://, local paths) to prevent SSRF against the
  // server's own filesystem or private network resources.
  if (!/^(https?:\/\/|ssh:\/\/|git@)/i.test(config.remote)) {
    return res.json({ ok: false, message: 'Remote URL must use https, http, ssh, or git@' });
  }

  // Keep the original (credential-free) URL for safe error messages.
  const safeRemote = config.remote;
  let remote = config.remote;

  if (config.token && config.username) {
    try {
      const remoteUrl = new URL(remote);
      remoteUrl.username = encodeURIComponent(config.username);
      remoteUrl.password = encodeURIComponent(config.token);
      remote = remoteUrl.toString();
    } catch {
      return res.json({ ok: false, message: 'Remote URL is not a valid URL' });
    }
  }
  try {
    // git ls-remote authenticates and lists refs without cloning or writing anything.
    const git = simpleGit();
    await git.listRemote(['--heads', remote]);
    return res.json({ ok: true, message: 'Connected — remote is reachable and credentials are valid' });
  } catch (err) {
    // Scrub any credential-embedded URL that simple-git may include in its error
    // message before returning it to the client.
    const raw = String(err?.message || err);
    const msg = remote !== safeRemote ? raw.replaceAll(remote, safeRemote) : raw;
    if (/authentication failed|could not read username|invalid credentials|bad credentials/i.test(msg)) {
      return res.json({ ok: false, message: 'Authentication failed — check Username and Token' });
    }
    if (/repository.*not found|does not exist|not found/i.test(msg)) {
      return res.json({ ok: false, message: 'Repository not found — check Remote URL' });
    }
    if (/could not resolve host|unable to connect|network|connection refused/i.test(msg)) {
      return res.json({ ok: false, message: 'Network error — could not reach remote host' });
    }
    return res.json({ ok: false, message: msg });
  }
});

// ─── Error handler ─────────────────────────────────────────────────────────────
// Catches errors forwarded by next(err), including CORS rejections.
// Returns a plain JSON error without leaking internal stack traces.
// eslint-disable-next-line no-unused-vars
// Register this at the very end of the file, just before app.listen(...).
// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) console.error('Server error:', err);
  res.status(status).json({ error: err.message || 'Internal server error' });
}
// ─── CDP Browser Capture ──────────────────────────────────────────────────────

/**
 * Middleware that restricts access to loopback clients only (127.0.0.1 / ::1).
 * CDP endpoints expose sensitive network data so they must not be reachable from
 * external interfaces.
 */
function _cdpLoopbackOnly(req, res, next) {
  const addr = req.socket.remoteAddress;
  if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') {
    return next();
  }
  return res.status(403).json({ ok: false, error: 'Forbidden: loopback only' });
}

const WebSocket = require('ws');

let _cdpWs = null;
/** @type {Set<import('express').Response>} */
const _cdpSseClients = new Set();
/** @type {Map<string, object>} */
const _cdpRequestMap = new Map();
let _cdpMsgId = 1;
let _cdpEntryId = 1;
/** @type {Map<number, { resolve: Function, reject: Function }>} */
const _cdpPending = new Map();

function _cdpBroadcast(event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of _cdpSseClients) {
    if (res.writableEnded || res.destroyed) {
      _cdpSseClients.delete(res);
      continue;
    }
    try {
      res.write(line);
    } catch (_) {
      _cdpSseClients.delete(res);
    }
  }
}

function _cdpGetHeaderValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return Array.isArray(value) ? value.join('\n') : String(value ?? '');
    }
  }
  return '';
}

function _cdpParseCookieHeader(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/;\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf('=');
      return {
        name: idx === -1 ? part : part.slice(0, idx),
        value: idx === -1 ? '' : part.slice(idx + 1),
        raw: part,
      };
    });
}

function _cdpParseSetCookieHeader(raw) {
  if (!raw) return [];
  const lines = Array.isArray(raw)
    ? raw.flatMap((value) => String(value).split(/\r?\n/))
    : String(raw).split(/\r?\n/);

  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(';').map((part) => part.trim()).filter(Boolean);
      const firstPart = parts[0] || '';
      const idx = firstPart.indexOf('=');
      const attributes = parts.slice(1).map((part) => {
        const attrIdx = part.indexOf('=');
        return {
          key: attrIdx === -1 ? part : part.slice(0, attrIdx),
          value: attrIdx === -1 ? null : part.slice(attrIdx + 1),
        };
      });
      const getAttr = (name) => {
        const found = attributes.find((attr) => attr.key.toLowerCase() === name);
        return found ? found.value : undefined;
      };
      const hasFlag = (name) => attributes.some((attr) => attr.key.toLowerCase() === name);
      return {
        name: idx === -1 ? firstPart : firstPart.slice(0, idx),
        value: idx === -1 ? '' : firstPart.slice(idx + 1),
        raw: line,
        attributes,
        domain: getAttr('domain'),
        path: getAttr('path'),
        expires: getAttr('expires'),
        maxAge: getAttr('max-age'),
        sameSite: getAttr('samesite'),
        secure: hasFlag('secure'),
        httpOnly: hasFlag('httponly'),
        partitioned: hasFlag('partitioned'),
      };
    });
}

function _cdpNormalizeMethod(method) {
  return String(method || 'GET').trim().toUpperCase();
}

function _cdpSendCommand(method, params) {
  return new Promise((resolve, reject) => {
    if (!_cdpWs || _cdpWs.readyState !== WebSocket.OPEN) {
      return reject(new Error('CDP WebSocket not connected'));
    }
    const id = _cdpMsgId++;
    _cdpPending.set(id, { resolve, reject });
    _cdpWs.send(JSON.stringify({ id, method, params }));
    // Timeout individual commands after 5s
    setTimeout(() => {
      if (_cdpPending.has(id)) {
        _cdpPending.delete(id);
        reject(new Error(`CDP command ${method} timed out`));
      }
    }, 5000);
  });
}

function _cdpDisconnect() {
  if (_cdpWs) {
    try { _cdpWs.close(); } catch (_) {}
    _cdpWs = null;
  }
  _cdpRequestMap.clear();
  _cdpPending.clear();
  _cdpBroadcast('stopped', {});
}

async function _cdpConnect(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try {
          const targets = JSON.parse(body);
          const target = targets.find(t => t.type === 'page');
          if (!target || !target.webSocketDebuggerUrl) {
            return reject(new Error('No debuggable page target found. Make sure a tab is open in Chrome.'));
          }
          resolve(target.webSocketDebuggerUrl);
        } catch (e) {
          reject(new Error('Failed to parse Chrome target list: ' + e.message));
        }
      });
    });
    req.on('error', (e) => reject(new Error(`Chrome not reachable on port ${port}: ${e.message}`)));
    req.setTimeout(3000, () => { req.destroy(); reject(new Error(`Connection to Chrome on port ${port} timed out`)); });
  });
}

// POST /api/cdp/connect — attach CDP to a running Chrome instance
app.post('/api/cdp/connect', _cdpLoopbackOnly, async (req, res) => {
  const port = Number(req.body?.port) || 9222;

  if (_cdpWs && _cdpWs.readyState === WebSocket.OPEN) {
    return res.json({ ok: true, alreadyConnected: true });
  }

  try {
    const wsUrl = await _cdpConnect(port);
    _cdpWs = new WebSocket(wsUrl);

    _cdpWs.on('open', async () => {
      try {
        await _cdpSendCommand('Network.enable', {});
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    _cdpWs.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // Handle command responses
      if (msg.id !== undefined && _cdpPending.has(msg.id)) {
        const p = _cdpPending.get(msg.id);
        _cdpPending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
        return;
      }

      if (!msg.method) return;

      if (msg.method === 'Network.requestWillBeSent') {
        const { requestId, request, timestamp } = msg.params;
        let domain = '';
        try {
          domain = new URL(request.url).hostname;
        } catch (_) {}
        const entry = {
          id: `cap_${_cdpEntryId++}`,
          timestamp: Math.round(timestamp * 1000),
          method: _cdpNormalizeMethod(request.method),
          url: request.url,
          domain,
          requestHeaders: request.headers || {},
          requestCookies: _cdpParseCookieHeader(_cdpGetHeaderValue(request.headers, 'cookie')),
          requestBody: request.postData || null,
          state: 'pending',
        };
        _cdpRequestMap.set(requestId, entry);
        _cdpBroadcast('request', entry);
      }

      if (msg.method === 'Network.responseReceived') {
        const { requestId, response, type } = msg.params;
        const entry = _cdpRequestMap.get(requestId);
        if (entry) {
          entry.status = response.status;
          entry.statusText = response.statusText;
          entry.mimeType = response.mimeType;
          entry.resourceType = type || 'Other';
          entry.responseHeaders = response.headers || {};
          entry.responseCookies = _cdpParseSetCookieHeader(_cdpGetHeaderValue(response.headers, 'set-cookie'));
        }
      }

      if (msg.method === 'Network.loadingFinished') {
        const { requestId, encodedDataLength, timestamp } = msg.params;
        const entry = _cdpRequestMap.get(requestId);
        if (!entry) return;
        entry.size = encodedDataLength;
        if (entry.timestamp) {
          entry.duration = Math.round(timestamp * 1000) - entry.timestamp;
        }
        entry.state = 'complete';
        try {
          const bodyResult = await _cdpSendCommand('Network.getResponseBody', { requestId });
          let body = bodyResult.body || '';
          if (bodyResult.base64Encoded) {
            // Keep as truncated base64 marker — don't bloat SSE with binary
            body = body.length > 512 ? '[binary data]' : body;
          } else if (body.length > 1_000_000) {
            body = body.slice(0, 1_000_000) + '\n[truncated]';
          }
          entry.responseBody = body;
        } catch (_) {
          entry.responseBody = null;
        }
        _cdpBroadcast('response', entry);
        _cdpRequestMap.delete(requestId);
      }

      if (msg.method === 'Network.loadingFailed') {
        const { requestId, errorText } = msg.params;
        const entry = _cdpRequestMap.get(requestId);
        if (entry) {
          entry.state = 'failed';
          entry.errorText = errorText;
          _cdpBroadcast('failed', { id: requestId, errorText });
          _cdpRequestMap.delete(requestId);
        }
      }
    });

    _cdpWs.on('close', () => {
      _cdpWs = null;
      _cdpBroadcast('stopped', {});
    });

    _cdpWs.on('error', (e) => {
      console.error('[CDP] WebSocket error:', e.message);
      if (res.headersSent) {
        _cdpDisconnect();
      } else {
        _cdpWs = null;
        res.status(500).json({ ok: false, error: 'CDP WebSocket error: ' + e.message });
      }
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// GET /api/cdp/stream — SSE stream of CDP events
app.get('/api/cdp/stream', _cdpLoopbackOnly, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  // Send a heartbeat comment every 15s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 15000);
  _cdpSseClients.add(res);
  req.on('close', () => {
    clearInterval(heartbeat);
    _cdpSseClients.delete(res);
  });
});

// POST /api/cdp/disconnect — close CDP connection
app.post('/api/cdp/disconnect', _cdpLoopbackOnly, (_req, res) => {
  _cdpDisconnect();
  res.json({ ok: true });
});

// ─── Error handler ─────────────────────────────────────────────────────────────
// Catches errors forwarded by next(err), including CORS rejections.
// Returns a plain JSON error without leaking internal stack traces.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('Server error:', err);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  APILIX server running on http://localhost:${PORT}\n`);
});
