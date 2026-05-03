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
