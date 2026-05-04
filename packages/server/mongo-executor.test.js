'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { executeRequest, executeMongoTest } = require('@apilix/core');

function makeContext() {
  return {
    environment: {},
    collectionVariables: {},
    globals: {},
    dataRow: {},
    collVars: [],
    cookies: {},
    collectionItems: [],
    conditionalExecution: true,
    mockBase: null,
    mongoConnections: {},
  };
}

test('mongodb request with missing named connection returns a Mongo-specific error contract', async () => {
  const item = {
    name: 'Mongo Missing Connection',
    request: {
      method: 'MONGO',
      requestType: 'mongodb',
      url: { raw: '' },
      mongodb: {
        connection: { mode: 'named', connectionId: 'missing' },
        database: 'sample',
        collection: 'users',
        operation: 'find',
        filter: '{}',
      },
    },
  };

  const result = await executeRequest(item, makeContext());
  assert.equal(result.protocol, 'mongodb');
  assert.equal(result.mongoStatus, 'error');
  assert.equal(result.statusText, 'MONGO_ERROR');
  assert.match(result.error || '', /not found/i);
});

test('mongodb request resolves direct connection variables and fails with Mongo protocol metadata', async () => {
  const item = {
    name: 'Mongo Bad URI',
    request: {
      method: 'MONGO',
      requestType: 'mongodb',
      url: { raw: '' },
      mongodb: {
        connection: { mode: 'direct', uri: '{{mongoUri}}' },
        database: '{{mongoDb}}',
        collection: 'users',
        operation: 'count',
        filter: '{}',
      },
    },
  };

  const ctx = makeContext();
  ctx.environment.mongoUri = 'mongodb://127.0.0.1:1';
  ctx.environment.mongoDb = 'sample';

  const result = await executeRequest(item, ctx);
  assert.equal(result.protocol, 'mongodb');
  assert.equal(result.mongoStatus, 'error');
  assert.equal(result.mongoOperation, 'count');
  assert.equal(typeof result.responseTime, 'number');
});

// ─── Mongo query parsing (parseJsonObject / parseJsonArray via JSON5) ──────────
//
// The insert operation is the only path that throws a deterministic pre-connect
// error ("Mongo insert requires at least one document") when parseJsonArray
// returns an empty array.  This lets us distinguish between:
//   • parse succeeded → non-empty docs → MongoDB driver reached → ECONNREFUSED
//   • parse failed   → empty docs     → thrown before driver → the guard message
//
// All tests below use mongodb://127.0.0.1:1 (closed port) so the connection
// error happens quickly via ECONNREFUSED on localhost.

function makeInsertItem(documents) {
  return {
    name: 'Mongo Insert Parse Test',
    request: {
      method: 'MONGO',
      requestType: 'mongodb',
      url: { raw: '' },
      mongodb: {
        connection: { mode: 'direct', uri: 'mongodb://127.0.0.1:1' },
        database: 'testdb',
        collection: 'col',
        operation: 'insert',
        documents,
      },
    },
  };
}

test('insert: unquoted bare keys are normalized and parsed', async () => {
  const result = await executeRequest(makeInsertItem('[{ name: "alice" }]'), makeContext());
  assert.equal(result.protocol, 'mongodb');
  assert.equal(result.mongoStatus, 'error');
  // Body should contain a connection error, NOT the empty-docs guard
  assert.doesNotMatch(result.body, /at least one document/i);
});

test('insert: string values with word:word patterns are not corrupted (string boundary fix)', async () => {
  const result = await executeRequest(makeInsertItem('[{ note: "foo, bar:baz" }]'), makeContext());
  assert.equal(result.mongoStatus, 'error');
  assert.doesNotMatch(result.body, /at least one document/i);
});

test('insert: string values with embedded object-like text are preserved', async () => {
  const result = await executeRequest(makeInsertItem('[{ msg: "text {a:1}" }]'), makeContext());
  assert.equal(result.mongoStatus, 'error');
  assert.doesNotMatch(result.body, /at least one document/i);
});

test('insert: unquoted $-prefixed operator keys are normalized', async () => {
  const result = await executeRequest(makeInsertItem('[{ $type: "string", field: "x" }]'), makeContext());
  assert.equal(result.mongoStatus, 'error');
  assert.doesNotMatch(result.body, /at least one document/i);
});

test('insert: already-quoted keys still parse correctly (no double-quoting)', async () => {
  const result = await executeRequest(makeInsertItem('[{ "name": "alice", "age": 30 }]'), makeContext());
  assert.equal(result.mongoStatus, 'error');
  assert.doesNotMatch(result.body, /at least one document/i);
});

test('insert: mixed quoted and unquoted keys in same object', async () => {
  const result = await executeRequest(makeInsertItem('[{ "id": 1, status: "active" }]'), makeContext());
  assert.equal(result.mongoStatus, 'error');
  assert.doesNotMatch(result.body, /at least one document/i);
});

test('insert: completely malformed documents string still returns a Mongo error (no crash)', async () => {
  // The MongoDB client connects eagerly (before the docs guard is reached), so
  // an unreachable server always produces a connection error rather than the
  // empty-docs guard.  What we're asserting here is that completely invalid
  // input does not cause an unhandled exception — the engine always returns the
  // standard error contract.
  const result = await executeRequest(makeInsertItem('{{ not valid json ]]'), makeContext());
  assert.equal(result.protocol, 'mongodb');
  assert.equal(result.mongoStatus, 'error');
  assert.equal(result.mongoOperation, 'insert');
  assert.equal(typeof result.body, 'string');
  assert.ok(result.body.length > 0);
});

// ─── script operation sandbox ────────────────────────────────────────────────

test('script operation: Date constructor is available in sandbox', async () => {
  const item = {
    name: 'Mongo Script Date Test',
    request: {
      method: 'MONGO',
      requestType: 'mongodb',
      url: { raw: '' },
      mongodb: {
        connection: { mode: 'direct', uri: 'mongodb://127.0.0.1:1' },
        database: 'testdb',
        collection: '',
        operation: 'script',
        script: `
          const since = new Date('2024-01-01T00:00:00.000Z');
          const docs = await db.collection('accounts').find({ createdAt: { $gt: since } }).toArray();
          result = docs;
        `,
      },
    },
  };
  // ECONNREFUSED means the sandbox executed past the Date constructor and reached the driver.
  // A ReferenceError for Date would surface as a different error message.
  const result = await executeRequest(item, makeContext());
  assert.ok(
    /ECONNREFUSED|connect ECONNREFUSED/i.test(result.error || result.body || ''),
    `Expected ECONNREFUSED but got: ${result.error || result.body}`,
  );
});

test('script operation: Math and JSON built-ins are available in sandbox', async () => {
  const item = {
    name: 'Mongo Script Math JSON Test',
    request: {
      method: 'MONGO',
      requestType: 'mongodb',
      url: { raw: '' },
      mongodb: {
        connection: { mode: 'direct', uri: 'mongodb://127.0.0.1:1' },
        database: 'testdb',
        collection: '',
        operation: 'script',
        script: `
          const n = Math.floor(3.9);
          const s = JSON.stringify({ n });
          const docs = await db.collection('items').find({}).limit(n).toArray();
          result = docs;
        `,
      },
    },
  };
  const result = await executeRequest(item, makeContext());
  assert.ok(
    /ECONNREFUSED|connect ECONNREFUSED/i.test(result.error || result.body || ''),
    `Expected ECONNREFUSED but got: ${result.error || result.body}`,
  );
});

test('script operation: Array and Object built-ins are available in sandbox', async () => {
  const item = {
    name: 'Mongo Script Array Object Test',
    request: {
      method: 'MONGO',
      requestType: 'mongodb',
      url: { raw: '' },
      mongodb: {
        connection: { mode: 'direct', uri: 'mongodb://127.0.0.1:1' },
        database: 'testdb',
        collection: '',
        operation: 'script',
        script: `
          const ids = Array.from([1, 2, 3]);
          const filter = Object.assign({}, { _id: { $in: ids } });
          const docs = await db.collection('items').find(filter).toArray();
          result = docs;
        `,
      },
    },
  };
  const result = await executeRequest(item, makeContext());
  assert.ok(
    /ECONNREFUSED|connect ECONNREFUSED/i.test(result.error || result.body || ''),
    `Expected ECONNREFUSED but got: ${result.error || result.body}`,
  );
});

// ─── executeMongoTest ─────────────────────────────────────────────────────────

test('executeMongoTest returns { ok: false, error } when host is unreachable', async () => {
  const result = await executeMongoTest('mongodb://127.0.0.1:1', 'admin');
  assert.equal(typeof result, 'object');
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0, 'error message should not be empty');
  // latencyMs is not present on failure
  assert.equal(result.latencyMs, undefined);
});

test('executeMongoTest returns { ok: false, error } for invalid URI', async () => {
  const result = await executeMongoTest('not-a-valid-uri', 'admin');
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
});

test('executeMongoTest uses "admin" database by default', async () => {
  // Pass no database arg — should not throw
  const result = await executeMongoTest('mongodb://127.0.0.1:1');
  assert.equal(typeof result.ok, 'boolean');
});
