'use strict';

const express = require('express');
const cors = require('cors');
const multer = require('multer');
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
    const { item, environment, collectionVariables, globals, dataRow, collVars, cookies } = req.body;
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
    const { collection, environment, collectionVariables, globals, delay, cookies } = payload;

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
      let currentCookies = { ...(cookies || {}) };

      sendEvent('iteration-start', { iteration: i + 1, dataRow });

      for (const item of requests) {
        // Check pause/stop before each request
        if ((await waitForResume(runId)) === 'stopped') { stopped = true; break outer; }

        const result = await executeRequest(item, {
          environment: currentEnv,
          collectionVariables: currentCollVars,
          globals: globals || {},
          dataRow,
          collVars: collection.variable || [],
          cookies: currentCookies,
        });

        // Propagate environment/variable/cookie changes to next request in same iteration
        if (result.updatedEnvironment) currentEnv = result.updatedEnvironment;
        if (result.updatedCollectionVariables) currentCollVars = result.updatedCollectionVariables;
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
          error: result.error,
        };

        sendEvent('result', resultData);

        if (delayMs > 0) {
          if ((await awaitDelay(runId, delayMs)) === 'stopped') { stopped = true; break outer; }
        }
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

/** In-memory mock routes: array of { id, enabled, method, path, statusCode, responseHeaders, responseBody, delay } */
let mockRoutes = [];

/** The running mock HTTP server, or null. */
let mockServerInstance = null;
let mockServerPort = 3002;

function generateMockId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
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

/**
 * Simple template substitution: {{param.x}}, {{query.x}}, {{body.x}}.
 */
function interpolate(template, ctx) {
  return template.replace(/\{\{(\w+)\.(\w+)\}\}/g, (_, ns, key) => {
    const src = ctx[ns];
    if (src && Object.prototype.hasOwnProperty.call(src, key)) return src[key];
    return `{{${ns}.${key}}}`;
  });
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

    // Find matching route (first enabled match)
    let matched = null;
    let pathParams = {};
    for (const route of mockRoutes) {
      if (!route.enabled) continue;
      if (route.method !== '*' && route.method.toUpperCase() !== method) continue;
      const params = matchPath(route.path, pathname);
      if (params !== null) {
        matched = route;
        pathParams = params;
        break;
      }
    }

    if (!matched) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No matching mock route', method, path: pathname }));
      return;
    }

    // Collect body for POST/PUT/PATCH
    let bodyChunks = [];
    req.on('data', chunk => bodyChunks.push(chunk));
    req.on('end', () => {
      let bodyObj = {};
      try {
        const raw = Buffer.concat(bodyChunks).toString('utf-8');
        if (raw) bodyObj = JSON.parse(raw);
      } catch { /* non-JSON body */ }

      const ctx = { param: pathParams, query, body: bodyObj };
      const responseBody = interpolate(matched.responseBody, ctx);

      // Merge headers
      const headers = { 'Access-Control-Allow-Origin': '*' };
      (matched.responseHeaders || []).forEach(h => {
        if (h.key) headers[h.key] = interpolate(h.value, ctx);
      });
      if (!headers['Content-Type']) {
        // Auto-detect JSON
        try { JSON.parse(responseBody); headers['Content-Type'] = 'application/json'; }
        catch { headers['Content-Type'] = 'text/plain'; }
      }

      const send = () => {
        res.writeHead(matched.statusCode || 200, headers);
        res.end(responseBody);
      };

      const delay = Math.min(parseInt(matched.delay, 10) || 0, 30000);
      if (delay > 0) setTimeout(send, delay);
      else send();
    });
  };
}

function startMockServer(port, routes) {
  return new Promise((resolve, reject) => {
    if (mockServerInstance) {
      mockServerInstance.close(() => { mockServerInstance = null; });
    }
    mockRoutes = routes || [];
    mockServerPort = port;

    const server = http.createServer(buildMockHandler());
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

// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  APILIX server running on http://localhost:${PORT}\n`);
});
