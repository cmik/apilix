'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { InputError, prepareCollectionRun, executePreparedCollectionRun } = require('../src/collection-runner');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePayload(overrides = {}) {
  return {
    collection: {
      info: { name: 'Test' },
      item: [
        { id: 'r1', name: 'Request 1', request: { method: 'GET', url: 'http://localhost/test' } },
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

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((res, rej) => server.listen(0, '127.0.0.1', err => err ? rej(err) : res()));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); }
  finally { await new Promise((res, rej) => server.close(err => err ? rej(err) : res())); }
}

// ─── InputError ───────────────────────────────────────────────────────────────

test('InputError is an Error subclass with name "InputError"', () => {
  const err = new InputError('test message');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof InputError);
  assert.equal(err.name, 'InputError');
  assert.equal(err.message, 'test message');
});

// ─── prepareCollectionRun ─────────────────────────────────────────────────────

test('prepareCollectionRun - throws InputError when payload is null', () => {
  assert.throws(
    () => prepareCollectionRun(null),
    (e) => e instanceof InputError && /missing collection/i.test(e.message),
  );
});

test('prepareCollectionRun - throws when collection.item is missing', () => {
  assert.throws(
    () => prepareCollectionRun({ collection: { info: {} } }),
    (e) => e instanceof InputError,
  );
});

test('prepareCollectionRun - returns runId, requests and dataRows for valid payload', () => {
  const result = prepareCollectionRun(makePayload());
  assert.ok(typeof result.runId === 'string' && result.runId.length > 0);
  assert.ok(Array.isArray(result.requests));
  assert.ok(Array.isArray(result.dataRows));
  assert.equal(result.dataRows.length, 1);
});

test('prepareCollectionRun - uses caller-provided runId when given', () => {
  const result = prepareCollectionRun(makePayload(), { runId: 'fixed-run-id' });
  assert.equal(result.runId, 'fixed-run-id');
});

test('prepareCollectionRun - generates unique runId on successive calls', () => {
  const a = prepareCollectionRun(makePayload());
  const b = prepareCollectionRun(makePayload());
  assert.notEqual(a.runId, b.runId);
});

// ─── parseRunDataRows via prepareCollectionRun ────────────────────────────────

test('parseRunDataRows - default is a single empty-object row', () => {
  const result = prepareCollectionRun(makePayload());
  assert.deepEqual(result.dataRows, [{}]);
});

test('parseRunDataRows - iteration count from payload (capped at 100)', () => {
  const result = prepareCollectionRun(makePayload({ iterations: 5 }), { csvText: null });
  assert.equal(result.dataRows.length, 5);
});

test('parseRunDataRows - iteration count clamped to max 100', () => {
  const result = prepareCollectionRun(makePayload({ iterations: 9999 }), { csvText: null });
  assert.equal(result.dataRows.length, 100);
});

test('parseRunDataRows - iteration count clamped to min 1', () => {
  const result = prepareCollectionRun(makePayload({ iterations: 0 }), { csvText: null });
  assert.equal(result.dataRows.length, 1);
});

test('parseRunDataRows - parses CSV rows with correct column mapping', () => {
  const csv = 'city,country\nParis,France\nBerlin,Germany\n';
  const result = prepareCollectionRun(makePayload(), { csvText: csv });
  assert.equal(result.dataRows.length, 2);
  assert.equal(result.dataRows[0].city, 'Paris');
  assert.equal(result.dataRows[0].country, 'France');
  assert.equal(result.dataRows[1].city, 'Berlin');
});

test('parseRunDataRows - throws InputError for malformed CSV', () => {
  const badCsv = 'col\n"unclosed';
  assert.throws(
    () => prepareCollectionRun(makePayload(), { csvText: badCsv }),
    (e) => e instanceof InputError && /invalid csv/i.test(e.message),
  );
});

test('parseRunDataRows - jsonRows overrides csvText', () => {
  const csv = 'name\nAlice\n';
  const result = prepareCollectionRun(makePayload(), {
    jsonRows: [{ name: 'Bob' }],
    csvText: csv,
  });
  assert.equal(result.dataRows.length, 1);
  assert.equal(result.dataRows[0].name, 'Bob');
});

test('parseRunDataRows - throws InputError for empty jsonRows array', () => {
  assert.throws(
    () => prepareCollectionRun(makePayload(), { jsonRows: [] }),
    (e) => e instanceof InputError && /non-empty/i.test(e.message),
  );
});

test('parseRunDataRows - throws InputError when jsonRows is not an array', () => {
  assert.throws(
    () => prepareCollectionRun(makePayload(), { jsonRows: { name: 'x' } }),
    (e) => e instanceof InputError,
  );
});

// ─── executePreparedCollectionRun — basic execution ──────────────────────────

test('executePreparedCollectionRun - executes a single GET request and records result', async (t) => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    const payload = makePayload({
      collection: {
        info: { name: 'Exec Test' },
        item: [{ id: 'r1', name: 'Get', request: { method: 'GET', url: `${baseUrl}/` } }],
      },
    });
    const prepared = prepareCollectionRun(payload);
    const run = await executePreparedCollectionRun(prepared);

    assert.equal(run.errors.length, 0);
    assert.equal(run.stopped, false);
    assert.equal(run.iterations.length, 1);
    const res = run.iterations[0].results[0];
    assert.equal(res.status, 200);
    assert.equal(res.name, 'Get');
  });
});

test('executePreparedCollectionRun - resolves :path params from request.url.variable entries', async () => {
  let seenPath = '';
  await withServer((req, res) => {
    seenPath = req.url || '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    const payload = makePayload({
      collection: {
        info: { name: 'Path Params Test' },
        item: [{
          id: 'r1',
          name: 'Get User',
          request: {
            method: 'GET',
            url: {
              raw: `${baseUrl}/users/:id`,
              variable: [{ key: 'id', value: '{{userId}}' }],
            },
          },
        }],
      },
      environment: { userId: '123' },
    });

    const prepared = prepareCollectionRun(payload);
    const run = await executePreparedCollectionRun(prepared);

    assert.equal(run.errors.length, 0);
    assert.equal(run.iterations[0].results[0].status, 200);
    assert.equal(seenPath, '/users/123');
    assert.equal(run.iterations[0].results[0].resolvedUrl, `${baseUrl}/users/123`);
  });
});

test('executePreparedCollectionRun - resolves :path params for URL objects without raw', async () => {
  let seenPath = '';
  await withServer((req, res) => {
    seenPath = req.url || '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    const payload = makePayload({
      collection: {
        info: { name: 'Path Params Non-Raw Test' },
        item: [{
          id: 'r1',
          name: 'Get User',
          request: {
            method: 'GET',
            url: {
              protocol: 'https',
              host: ['api', 'example', 'com'],
              path: ['users', ':id'],
              variable: [{ key: 'id', value: '{{userId}}' }],
            },
          },
        }],
      },
      environment: { userId: '123' },
      mockBase: baseUrl,
    });

    const prepared = prepareCollectionRun(payload);
    const run = await executePreparedCollectionRun(prepared);

    assert.equal(run.errors.length, 0);
    assert.equal(run.iterations[0].results[0].status, 200);
    assert.equal(seenPath, '/users/123');
    assert.equal(run.iterations[0].results[0].resolvedUrl, `${baseUrl}/users/123`);
  });
});

test('executePreparedCollectionRun - leaves :path param untouched when URL variable is disabled', async () => {
  let seenPath = '';
  await withServer((req, res) => {
    seenPath = req.url || '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    const payload = makePayload({
      collection: {
        info: { name: 'Path Params Disabled Test' },
        item: [{
          id: 'r1',
          name: 'Get User',
          request: {
            method: 'GET',
            url: {
              raw: `${baseUrl}/users/:id`,
              variable: [{ key: 'id', value: '123', disabled: true }],
            },
          },
        }],
      },
    });

    const prepared = prepareCollectionRun(payload);
    const run = await executePreparedCollectionRun(prepared);

    assert.equal(run.errors.length, 0);
    assert.equal(run.iterations[0].results[0].status, 200);
    assert.equal(seenPath, '/users/:id');
    assert.equal(run.iterations[0].results[0].resolvedUrl, `${baseUrl}/users/:id`);
  });
});

test('executePreparedCollectionRun - emits run-id event with correct runId', async () => {
  await withServer((req, res) => {
    res.writeHead(200); res.end();
  }, async (baseUrl) => {
    const payload = makePayload({
      collection: {
        info: { name: 'Events Test' },
        item: [{ id: 'r1', name: 'Get', request: { method: 'GET', url: `${baseUrl}/` } }],
      },
    });
    const prepared = prepareCollectionRun(payload, { runId: 'evt-run-1' });
    const events = [];
    await executePreparedCollectionRun(prepared, {
      onEvent(event, data) { events.push({ event, data }); },
    });

    const runIdEvent = events.find(e => e.event === 'run-id');
    assert.ok(runIdEvent, 'should emit run-id event');
    assert.equal(runIdEvent.data.runId, 'evt-run-1');
  });
});

test('executePreparedCollectionRun - emits done event on success', async () => {
  await withServer((req, res) => {
    res.writeHead(200); res.end();
  }, async (baseUrl) => {
    const payload = makePayload({
      collection: {
        info: { name: 'Done Test' },
        item: [{ id: 'r1', name: 'Get', request: { method: 'GET', url: `${baseUrl}/` } }],
      },
    });
    const prepared = prepareCollectionRun(payload);
    const events = [];
    await executePreparedCollectionRun(prepared, {
      onEvent(event, data) { events.push({ event, data }); },
    });
    assert.ok(events.some(e => e.event === 'done'), 'should emit done event');
  });
});

test('executePreparedCollectionRun - runs multiple iterations with CSV data', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  }, async (baseUrl) => {
    const csv = 'label\nFirst\nSecond\nThird\n';
    const payload = makePayload({
      collection: {
        info: { name: 'CSV Iter' },
        item: [{ id: 'r1', name: 'Get', request: { method: 'GET', url: `${baseUrl}/` } }],
      },
    });
    const prepared = prepareCollectionRun(payload, { csvText: csv });
    const run = await executePreparedCollectionRun(prepared);
    assert.equal(run.iterations.length, 3);
    assert.equal(run.iterations[0].dataRow.label, 'First');
    assert.equal(run.iterations[1].dataRow.label, 'Second');
    assert.equal(run.iterations[2].dataRow.label, 'Third');
  });
});

// ─── environment mutation propagation ─────────────────────────────────────────

test('executePreparedCollectionRun - env mutation from test script propagates to next request', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ token: 'abc123' }));
  }, async (baseUrl) => {
    const payload = makePayload({
      collection: {
        info: { name: 'Env Propagation' },
        item: [
          {
            id: 'r1',
            name: 'Set Token',
            request: { method: 'GET', url: `${baseUrl}/` },
            event: [{
              listen: 'test',
              script: { exec: [
                "const body = JSON.parse(apx.response.text());",
                "apx.environment.set('token', body.token);",
              ] },
            }],
          },
          {
            id: 'r2',
            name: 'Use Token',
            request: {
              method: 'GET',
              url: `${baseUrl}/`,
              header: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
            },
            event: [{
              listen: 'test',
              script: { exec: [
                "apx.test('token is set', () => {",
                "  apx.expect(apx.environment.get('token')).to.equal('abc123');",
                "});",
              ] },
            }],
          },
        ],
      },
    });
    const prepared = prepareCollectionRun(payload);
    const run = await executePreparedCollectionRun(prepared);
    assert.equal(run.iterations[0].results[1].testResults[0].passed, true);
  });
});

// ─── bail option ──────────────────────────────────────────────────────────────

test('executePreparedCollectionRun - bail stops run when first test fails', async () => {
  let callCount = 0;
  await withServer((req, res) => {
    callCount++;
    res.writeHead(200); res.end('{}');
  }, async (baseUrl) => {
    const payload = makePayload({
      bail: true,
      collection: {
        info: { name: 'Bail Test' },
        item: [
          {
            id: 'r1',
            name: 'Fail',
            request: { method: 'GET', url: `${baseUrl}/` },
            event: [{ listen: 'test', script: { exec: [
              "apx.test('fail', () => { apx.expect(1).to.equal(2); });",
            ] } }],
          },
          { id: 'r2', name: 'Skip', request: { method: 'GET', url: `${baseUrl}/skip` } },
        ],
      },
    });
    const prepared = prepareCollectionRun(payload);
    const run = await executePreparedCollectionRun(prepared);
    assert.equal(callCount, 1, 'should stop after first request');
    assert.equal(run.stopped, true);
  });
});

// ─── collectResults / collectIterations options ───────────────────────────────

test('executePreparedCollectionRun - collectResults=false does not retain results', async () => {
  await withServer((req, res) => {
    res.writeHead(200); res.end('{}');
  }, async (baseUrl) => {
    const payload = makePayload({
      collection: {
        info: { name: 'No Results' },
        item: [{ id: 'r1', name: 'R', request: { method: 'GET', url: `${baseUrl}/` } }],
      },
    });
    const prepared = prepareCollectionRun(payload);
    const events = [];
    const run = await executePreparedCollectionRun(prepared, {
      collectResults: false,
      onEvent(event, data) { events.push({ event, data }); },
    });
    assert.equal(run.iterations[0].results.length, 0);
    assert.ok(events.some(e => e.event === 'result'), 'result events still fire');
  });
});

test('executePreparedCollectionRun - collectIterations=false does not store iteration records', async () => {
  await withServer((req, res) => {
    res.writeHead(200); res.end('{}');
  }, async (baseUrl) => {
    const payload = makePayload({
      collection: {
        info: { name: 'No Iters' },
        item: [{ id: 'r1', name: 'R', request: { method: 'GET', url: `${baseUrl}/` } }],
      },
    });
    const prepared = prepareCollectionRun(payload);
    const run = await executePreparedCollectionRun(prepared, { collectIterations: false });
    assert.equal(run.iterations.length, 0);
  });
});

// ─── setNextRequest (name-based conditional flow) ────────────────────────────

test('executePreparedCollectionRun - setNextRequest jumps to named request', async () => {
  const visited = [];
  await withServer((req, res) => {
    visited.push(req.url);
    res.writeHead(200); res.end('{}');
  }, async (baseUrl) => {
    const payload = makePayload({
      collection: {
        info: { name: 'Jump Test' },
        item: [
          {
            id: 'r1', name: 'First',
            request: { method: 'GET', url: `${baseUrl}/first` },
            event: [{ listen: 'test', script: { exec: ["apx.execution.setNextRequest('Third');"] } }],
          },
          { id: 'r2', name: 'Second', request: { method: 'GET', url: `${baseUrl}/second` } },
          { id: 'r3', name: 'Third', request: { method: 'GET', url: `${baseUrl}/third` } },
        ],
      },
    });
    const prepared = prepareCollectionRun(payload);
    const run = await executePreparedCollectionRun(prepared);
    // First jumps over Second directly to Third
    assert.ok(visited.includes('/first'));
    assert.ok(!visited.includes('/second'), 'second should be skipped');
    assert.ok(visited.includes('/third'));
  });
});

test('executePreparedCollectionRun - setNextRequest(null) stops iteration', async () => {
  const visited = [];
  await withServer((req, res) => {
    visited.push(req.url);
    res.writeHead(200); res.end('{}');
  }, async (baseUrl) => {
    const payload = makePayload({
      collection: {
        info: { name: 'Stop Test' },
        item: [
          {
            id: 'r1', name: 'First',
            request: { method: 'GET', url: `${baseUrl}/first` },
            event: [{ listen: 'test', script: { exec: ['apx.execution.setNextRequest(null);'] } }],
          },
          { id: 'r2', name: 'Second', request: { method: 'GET', url: `${baseUrl}/second` } },
        ],
      },
    });
    const prepared = prepareCollectionRun(payload);
    await executePreparedCollectionRun(prepared);
    assert.ok(visited.includes('/first'));
    assert.ok(!visited.includes('/second'), 'second should be skipped after null');
  });
});

// ─── setNextRequestById ───────────────────────────────────────────────────────

test('executePreparedCollectionRun - setNextRequestById jumps to target by id', async () => {
  const visited = [];
  await withServer((req, res) => {
    visited.push(req.url);
    res.writeHead(200); res.end('{}');
  }, async (baseUrl) => {
    const payload = makePayload({
      collection: {
        info: { name: 'ById Test' },
        item: [
          {
            id: 'r1', name: 'First',
            request: { method: 'GET', url: `${baseUrl}/first` },
            event: [{ listen: 'test', script: { exec: ["apx.execution.setNextRequestById('r3');"] } }],
          },
          { id: 'r2', name: 'Second', request: { method: 'GET', url: `${baseUrl}/second` } },
          { id: 'r3', name: 'Third', request: { method: 'GET', url: `${baseUrl}/third` } },
        ],
      },
    });
    const prepared = prepareCollectionRun(payload);
    await executePreparedCollectionRun(prepared);
    assert.ok(visited.includes('/first'));
    assert.ok(!visited.includes('/second'));
    assert.ok(visited.includes('/third'));
  });
});

// ─── retry logic ─────────────────────────────────────────────────────────────

test('executePreparedCollectionRun - retryAttempts is 0 when maxRetries not set', async () => {
  await withServer((req, res) => {
    res.writeHead(200); res.end('{}');
  }, async (baseUrl) => {
    const payload = makePayload({
      collection: {
        info: { name: 'No Retry' },
        item: [{ id: 'r1', name: 'Get', request: { method: 'GET', url: `${baseUrl}/` } }],
      },
    });
    const prepared = prepareCollectionRun(payload);
    const run = await executePreparedCollectionRun(prepared);
    assert.equal(run.iterations[0].results[0].retryAttempts, 0);
  });
});

test('executePreparedCollectionRun - retries up to maxRetries times on test failure', async () => {
  let callCount = 0;
  await withServer((req, res) => {
    callCount++;
    res.writeHead(200); res.end('{}');
  }, async (baseUrl) => {
    const payload = makePayload({
      maxRetries: 3,
      retryOn: 'failures',
      retryDelay: 0,
      collection: {
        info: { name: 'Retry Test' },
        item: [{
          id: 'r1', name: 'AlwaysFail',
          request: { method: 'GET', url: `${baseUrl}/` },
          event: [{ listen: 'test', script: { exec: [
            "apx.test('fails', () => { apx.expect(1).to.equal(999); });",
          ] } }],
        }],
      },
    });
    const prepared = prepareCollectionRun(payload);
    const run = await executePreparedCollectionRun(prepared);
    assert.equal(callCount, 4); // 1 original + 3 retries
    assert.equal(run.iterations[0].results[0].retryAttempts, 3);
  });
});

test('executePreparedCollectionRun - exponential backoff multiplies delay', async () => {
  // We just verify the config parsing doesn't crash; actual timing not asserted
  let callCount = 0;
  await withServer((req, res) => {
    callCount++;
    res.writeHead(200); res.end('{}');
  }, async (baseUrl) => {
    const payload = makePayload({
      maxRetries: 1,
      retryOn: 'failures',
      retryDelay: 0,
      retryBackoff: 'exponential',
      collection: {
        info: { name: 'Exponential' },
        item: [{
          id: 'r1', name: 'Fail',
          request: { method: 'GET', url: `${baseUrl}/` },
          event: [{ listen: 'test', script: { exec: [
            "apx.test('fail', () => { apx.expect(1).to.equal(2); });",
          ] } }],
        }],
      },
    });
    const prepared = prepareCollectionRun(payload);
    const run = await executePreparedCollectionRun(prepared);
    assert.equal(callCount, 2);
    assert.equal(run.iterations[0].results[0].retryAttempts, 1);
  });
});

// ─── loop detection ───────────────────────────────────────────────────────────

test('executePreparedCollectionRun - circular setNextRequest detected and aborts', async () => {
  await withServer((req, res) => {
    res.writeHead(200); res.end('{}');
  }, async (baseUrl) => {
    const payload = makePayload({
      collection: {
        info: { name: 'Loop Test' },
        item: [
          {
            id: 'r1', name: 'Loop',
            request: { method: 'GET', url: `${baseUrl}/` },
            event: [{ listen: 'test', script: { exec: ["apx.execution.setNextRequest('Loop');"] } }],
          },
        ],
      },
    });
    const prepared = prepareCollectionRun(payload);
    const run = await executePreparedCollectionRun(prepared);
    assert.ok(run.errors.length > 0, 'should record a loop error');
    assert.ok(/circular/i.test(run.errors[0]));
  });
});
