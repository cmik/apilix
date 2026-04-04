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

// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  APILIX server running on http://localhost:${PORT}\n`);
});
