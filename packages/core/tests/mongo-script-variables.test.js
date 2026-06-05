'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');

const { executeRequest } = require('../src/request-engine');

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

function mockMongoClient(t, collectionApi = {}) {
  const defaultFind = () => ({ toArray: async () => [] });
  const col = { find: collectionApi.find || defaultFind };
  t.mock.method(MongoClient.prototype, 'connect', async function () { return this; });
  t.mock.method(MongoClient.prototype, 'close',   async function () { return undefined; });
  t.mock.method(MongoClient.prototype, 'db',      function () { return { collection() { return col; } }; });
}

test('mongodb script operation resolves variables in script source', async (t) => {
  mockMongoClient(t);

  const item = {
    name: 'Mongo Script Variable Resolution Test',
    request: {
      method: 'MONGO',
      requestType: 'mongodb',
      url: { raw: '' },
      mongodb: {
        connection: { mode: 'direct', uri: 'mongodb://127.0.0.1:27017' },
        database: 'testdb',
        collection: '',
        operation: 'script',
        script: `
          result = {
            who: '{{userName}}',
            count: {{limitValue}}
          };
        `,
      },
    },
  };

  const ctx = makeContext();
  ctx.environment.userName = 'alice';
  ctx.environment.limitValue = '7';

  const result = await executeRequest(item, ctx);
  assert.equal(result.protocol, 'mongodb');
  assert.equal(result.mongoStatus, 'success');
  assert.equal(typeof result.body, 'string');
  assert.deepEqual(JSON.parse(result.body), { who: 'alice', count: 7 });
  // requestBody must reflect the resolved script, not the raw template
  assert.equal(result.requestBody.includes('{{userName}}'), false, 'requestBody should not contain unresolved tokens');
  assert.ok(result.requestBody.includes('alice'), 'requestBody should contain resolved value');
});

test('mongodb script operation: requestBody reflects resolved script text', async (t) => {
  mockMongoClient(t);

  const item = {
    name: 'Mongo Script RequestBody Test',
    request: {
      method: 'MONGO',
      requestType: 'mongodb',
      url: { raw: '' },
      mongodb: {
        connection: { mode: 'direct', uri: 'mongodb://127.0.0.1:27017' },
        database: 'testdb',
        operation: 'script',
        script: 'result = { col: "{{colName}}" };',
      },
    },
  };

  const ctx = makeContext();
  ctx.collectionVariables = { colName: 'orders' };

  const result = await executeRequest(item, ctx);
  assert.equal(result.mongoStatus, 'success');
  assert.ok(result.requestBody.includes('orders'), 'requestBody should contain resolved collection variable');
  assert.equal(result.requestBody.includes('{{colName}}'), false);
});

test('mongodb script operation: variable precedence env > collVars > globals in script', async (t) => {
  mockMongoClient(t);

  const item = {
    name: 'Mongo Script Precedence Test',
    request: {
      method: 'MONGO',
      requestType: 'mongodb',
      url: { raw: '' },
      mongodb: {
        connection: { mode: 'direct', uri: 'mongodb://127.0.0.1:27017' },
        database: 'testdb',
        operation: 'script',
        // env should win over collectionVariables which should win over globals
        script: 'result = { tier: "{{tier}}" };',
      },
    },
  };

  const ctx = makeContext();
  ctx.globals             = { tier: 'global' };
  ctx.collectionVariables = { tier: 'coll' };
  ctx.environment         = { tier: 'env' };

  const result = await executeRequest(item, ctx);
  assert.equal(result.mongoStatus, 'success');
  assert.deepEqual(JSON.parse(result.body), { tier: 'env' });
});

test('mongodb script operation: unknown variable token is left unchanged', async (t) => {
  mockMongoClient(t);

  const item = {
    name: 'Mongo Script Unknown Token Test',
    request: {
      method: 'MONGO',
      requestType: 'mongodb',
      url: { raw: '' },
      mongodb: {
        connection: { mode: 'direct', uri: 'mongodb://127.0.0.1:27017' },
        database: 'testdb',
        operation: 'script',
        script: 'result = "{{undefinedVar}}";',
      },
    },
  };

  const ctx = makeContext();

  const result = await executeRequest(item, ctx);
  assert.equal(result.mongoStatus, 'success');
  assert.equal(JSON.parse(result.body), '{{undefinedVar}}');
  assert.ok(result.requestBody.includes('{{undefinedVar}}'), 'unresolved token should remain in requestBody');
});

test('mongodb script operation: requestBody matches the exact resolved dynamic script value', async (t) => {
  mockMongoClient(t);

  const item = {
    name: 'Mongo Script Dynamic Variable Consistency Test',
    request: {
      method: 'MONGO',
      requestType: 'mongodb',
      url: { raw: '' },
      mongodb: {
        connection: { mode: 'direct', uri: 'mongodb://127.0.0.1:27017' },
        database: 'testdb',
        operation: 'script',
        script: 'result = "{{$guid}}";',
      },
    },
  };

  const ctx = makeContext();
  const result = await executeRequest(item, ctx);

  assert.equal(result.mongoStatus, 'success');
  const executedGuid = JSON.parse(result.body);
  assert.ok(result.requestBody.includes(executedGuid), 'requestBody should contain the same resolved guid that was executed');
});
