'use strict';

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { parse: parseCsv } = require('csv-parse/sync');
const { executeRequest, flattenItems } = require('./executor');

const app = express();
const PORT = process.env.PORT || 3001;

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
    const { item, environment, collectionVariables, globals, dataRow, collVars } = req.body;
    if (!item || !item.request) {
      return res.status(400).json({ error: 'Missing item.request in body' });
    }
    const result = await executeRequest(item, {
      environment: environment || {},
      collectionVariables: collectionVariables || {},
      globals: globals || {},
      dataRow: dataRow || {},
      collVars: collVars || [],
    });
    return res.json(result);
  } catch (err) {
    console.error('Execute error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Run an entire collection (optionally with CSV) ────────────────────────────

app.post('/api/run', upload.single('csvFile'), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.data || '{}');
    const { collection, environment, collectionVariables, globals, delay } = payload;

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

    const allIterations = [];
    const delayMs = Math.min(parseInt(delay, 10) || 0, 5000);

    for (let i = 0; i < dataRows.length; i++) {
      const dataRow = dataRows[i];
      let currentEnv = { ...(environment || {}) };
      let currentCollVars = { ...(collectionVariables || {}) };
      const iterResults = [];

      for (const item of requests) {
        const result = await executeRequest(item, {
          environment: currentEnv,
          collectionVariables: currentCollVars,
          globals: globals || {},
          dataRow,
          collVars: collection.variable || [],
        });

        // Propagate environment/variable changes to next request in same iteration
        if (result.updatedEnvironment) currentEnv = result.updatedEnvironment;
        if (result.updatedCollectionVariables) currentCollVars = result.updatedCollectionVariables;

        iterResults.push({
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
        });

        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }

      allIterations.push({ iteration: i + 1, dataRow, results: iterResults });
    }

    return res.json({ results: allIterations });
  } catch (err) {
    console.error('Run error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  APILIX server running on http://localhost:${PORT}\n`);
});
