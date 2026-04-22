'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { InputError, prepareCollectionRun, executePreparedCollectionRun } = require('./collectionRunner');

// ─── Minimal valid collection fixture ─────────────────────────────────────────

function makeValidPayload(overrides = {}) {
  return {
    collection: {
      info: { name: 'Test Collection' },
      item: [
        {
          id: 'req-1',
          name: 'Ping',
          request: { method: 'GET', url: 'http://localhost/ping' },
        },
      ],
    },
    environment: {},
    collectionVariables: {},
    globals: {},
    cookies: {},
    delay: 0,
    iterations: 1,
    ...overrides,
  };
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', err => {
      if (err) reject(err);
      else resolve();
    });
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close(err => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

// ─── InputError ───────────────────────────────────────────────────────────────

describe('InputError', () => {
  it('is an instance of Error', () => {
    const err = new InputError('boom');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof InputError);
  });

  it('has name "InputError"', () => {
    const err = new InputError('boom');
    assert.equal(err.name, 'InputError');
  });

  it('carries the message', () => {
    const err = new InputError('missing collection');
    assert.equal(err.message, 'missing collection');
  });
});

// ─── prepareCollectionRun — validation ───────────────────────────────────────

describe('prepareCollectionRun — input validation', () => {
  it('throws InputError when payload is null', () => {
    assert.throws(
      () => prepareCollectionRun(null),
      (err) => err instanceof InputError && /missing collection/i.test(err.message),
    );
  });

  it('throws InputError when payload has no collection key', () => {
    assert.throws(
      () => prepareCollectionRun({}),
      (err) => err instanceof InputError,
    );
  });

  it('throws InputError when collection has no item array', () => {
    assert.throws(
      () => prepareCollectionRun({ collection: { info: { name: 'X' } } }),
      (err) => err instanceof InputError,
    );
  });

  it('does NOT throw for a valid collection', () => {
    const result = prepareCollectionRun(makeValidPayload());
    assert.ok(result.runId);
    assert.ok(Array.isArray(result.requests));
    assert.ok(Array.isArray(result.dataRows));
  });
});

// ─── prepareCollectionRun — CSV handling ─────────────────────────────────────

describe('prepareCollectionRun — CSV handling', () => {
  it('produces a single empty-object row when no csvText is provided', () => {
    const result = prepareCollectionRun(makeValidPayload());
    assert.deepEqual(result.dataRows, [{}]);
  });

  it('produces empty dataRows when csvText is an empty string (header-only treated as no data)', () => {
    // Empty CSV string is now parsed (not silently ignored).
    // csv-parse with an empty string returns an empty array (no rows).
    const result = prepareCollectionRun(makeValidPayload(), { csvText: '' });
    assert.ok(Array.isArray(result.dataRows));
    assert.equal(result.dataRows.length, 0);
  });

  it('parses rows when csvText is a valid CSV string', () => {
    const csv = 'name,age\nAlice,30\nBob,25\n';
    const result = prepareCollectionRun(makeValidPayload(), { csvText: csv });
    assert.equal(result.dataRows.length, 2);
    assert.equal(result.dataRows[0].name, 'Alice');
    assert.equal(result.dataRows[1].name, 'Bob');
  });

  it('uses iteration count from payload when csvText is null', () => {
    const result = prepareCollectionRun(makeValidPayload({ iterations: 3 }), { csvText: null });
    assert.equal(result.dataRows.length, 3);
  });

  it('throws InputError for a malformed CSV', () => {
    // Use a CSV with mismatched quoting to trigger a parse error.
    const badCsv = 'name\n"unclosed';
    assert.throws(
      () => prepareCollectionRun(makeValidPayload(), { csvText: badCsv }),
      (err) => err instanceof InputError && /invalid csv/i.test(err.message),
    );
  });

  it('does NOT throw InputError for malformed CSV — thrown error is InputError, not generic Error', () => {
    // Verify the error class specifically so the route can safely use instanceof InputError → 400.
    const badCsv = 'name\n"unclosed';
    let thrown = null;
    try {
      prepareCollectionRun(makeValidPayload(), { csvText: badCsv });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown !== null, 'should have thrown');
    assert.ok(thrown instanceof InputError, 'should be InputError, not a generic Error');
  });
});

// ─── prepareCollectionRun — runId ─────────────────────────────────────────────

describe('prepareCollectionRun — runId', () => {
  it('generates a unique runId when none is provided', () => {
    const r1 = prepareCollectionRun(makeValidPayload());
    const r2 = prepareCollectionRun(makeValidPayload());
    assert.ok(r1.runId);
    assert.notEqual(r1.runId, r2.runId);
  });

  it('uses a provided runId', () => {
    const result = prepareCollectionRun(makeValidPayload(), { runId: 'my-fixed-id' });
    assert.equal(result.runId, 'my-fixed-id');
  });
});

describe('executePreparedCollectionRun — result retention', () => {
  it('collects full per-request result history by default', async () => {
    await withServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, async (baseUrl) => {
      const payload = makeValidPayload({
        collection: {
          info: { name: 'Test Collection' },
          item: [
            {
              id: 'req-1',
              name: 'Ping',
              request: { method: 'GET', url: `${baseUrl}/ping` },
            },
          ],
        },
      });

      const prepared = prepareCollectionRun(payload);
      const run = await executePreparedCollectionRun(prepared);

      assert.equal(run.iterations.length, 1);
      assert.equal(run.iterations[0].results.length, 1);
      assert.equal(run.iterations[0].results[0].name, 'Ping');
      assert.equal(run.iterations[0].results[0].status, 200);
    });
  });

  it('can skip in-memory result retention while still executing requests', async () => {
    await withServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, async (baseUrl) => {
      const payload = makeValidPayload({
        collection: {
          info: { name: 'Test Collection' },
          item: [
            {
              id: 'req-1',
              name: 'Ping',
              request: { method: 'GET', url: `${baseUrl}/ping` },
            },
          ],
        },
      });

      let resultEvents = 0;
      const prepared = prepareCollectionRun(payload);
      const run = await executePreparedCollectionRun(prepared, {
        collectResults: false,
        onEvent(event) {
          if (event === 'result') resultEvents++;
        },
      });

      assert.equal(resultEvents, 1);
      assert.equal(run.iterations.length, 1);
      assert.equal(run.iterations[0].results.length, 0);
    });
  });

  it('can skip iteration history entirely while still streaming result events', async () => {
    await withServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, async (baseUrl) => {
      const payload = makeValidPayload({
        collection: {
          info: { name: 'Test Collection' },
          item: [
            {
              id: 'req-1',
              name: 'Ping',
              request: { method: 'GET', url: `${baseUrl}/ping` },
            },
          ],
        },
      });

      let resultEvents = 0;
      const prepared = prepareCollectionRun(payload);
      const run = await executePreparedCollectionRun(prepared, {
        collectIterations: false,
        collectResults: false,
        onEvent(event) {
          if (event === 'result') resultEvents++;
        },
      });

      assert.equal(resultEvents, 1);
      assert.equal(run.iterations.length, 0);
    });
  });

  it('emits next-request by id without storing iterations when collectIterations is false', async () => {
    await withServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, async (baseUrl) => {
      const payload = makeValidPayload({
        collection: {
          info: { name: 'Test Collection' },
          item: [
            {
              id: 'req-1',
              name: 'First',
              request: { method: 'GET', url: `${baseUrl}/first` },
              event: [{
                listen: 'test',
                script: { exec: ["apx.execution.setNextRequestById('req-2');"] },
              }],
            },
            {
              id: 'req-2',
              name: 'Second',
              request: { method: 'GET', url: `${baseUrl}/second` },
            },
          ],
        },
      });

      const events = [];
      const prepared = prepareCollectionRun(payload);
      const run = await executePreparedCollectionRun(prepared, {
        collectIterations: false,
        collectResults: false,
        onEvent(event, data) {
          events.push({ event, data });
        },
      });

      const byIdJump = events.find(e => e.event === 'next-request' && e.data && e.data.via === 'id');
      assert.ok(byIdJump, 'expected next-request event via id');
      assert.equal(run.iterations.length, 0);
    });
  });

  it('emits conditional-flow target-not-found by id without storing iterations', async () => {
    await withServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, async (baseUrl) => {
      const payload = makeValidPayload({
        collection: {
          info: { name: 'Test Collection' },
          item: [
            {
              id: 'req-1',
              name: 'First',
              request: { method: 'GET', url: `${baseUrl}/first` },
              event: [{
                listen: 'test',
                script: { exec: ["apx.execution.setNextRequestById('missing-id');"] },
              }],
            },
          ],
        },
      });

      const events = [];
      const prepared = prepareCollectionRun(payload);
      const run = await executePreparedCollectionRun(prepared, {
        collectIterations: false,
        collectResults: false,
        onEvent(event, data) {
          events.push({ event, data });
        },
      });

      const missingFlow = events.find(e => e.event === 'conditional-flow' && e.data && e.data.via === 'id' && e.data.reason === 'target-not-found');
      assert.ok(missingFlow, 'expected conditional-flow event for missing id target');
      assert.equal(run.iterations.length, 0);
    });
  });

  it('emits next-request by name and stopped-by-script by name without storing iterations', async () => {
    await withServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }, async (baseUrl) => {
      const jumpPayload = makeValidPayload({
        collection: {
          info: { name: 'Test Collection' },
          item: [
            {
              id: 'req-1',
              name: 'First',
              request: { method: 'GET', url: `${baseUrl}/first` },
              event: [{
                listen: 'test',
                script: { exec: ["apx.execution.setNextRequest('Second');"] },
              }],
            },
            {
              id: 'req-2',
              name: 'Second',
              request: { method: 'GET', url: `${baseUrl}/second` },
            },
          ],
        },
      });

      const jumpEvents = [];
      const jumpPrepared = prepareCollectionRun(jumpPayload);
      const jumpRun = await executePreparedCollectionRun(jumpPrepared, {
        collectIterations: false,
        collectResults: false,
        onEvent(event, data) {
          jumpEvents.push({ event, data });
        },
      });

      const byNameJump = jumpEvents.find(e => e.event === 'next-request' && e.data && e.data.via === 'name');
      assert.ok(byNameJump, 'expected next-request event via name');
      assert.equal(jumpRun.iterations.length, 0);

      const stopPayload = makeValidPayload({
        collection: {
          info: { name: 'Test Collection' },
          item: [
            {
              id: 'req-1',
              name: 'First',
              request: { method: 'GET', url: `${baseUrl}/first` },
              event: [{
                listen: 'test',
                script: { exec: ['apx.execution.setNextRequest(null);'] },
              }],
            },
          ],
        },
      });

      const stopEvents = [];
      const stopPrepared = prepareCollectionRun(stopPayload);
      const stopRun = await executePreparedCollectionRun(stopPrepared, {
        collectIterations: false,
        collectResults: false,
        onEvent(event, data) {
          stopEvents.push({ event, data });
        },
      });

      const stoppedFlow = stopEvents.find(e => e.event === 'conditional-flow' && e.data && e.data.via === 'name' && e.data.reason === 'stopped-by-script');
      assert.ok(stoppedFlow, 'expected conditional-flow stopped-by-script via name');
      assert.equal(stopRun.iterations.length, 0);
    });
  });
});
