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

test('mongodb script operation resolves variables in script source', async (t) => {
  t.mock.method(MongoClient.prototype, 'connect', async function connectMock() {
    return this;
  });
  t.mock.method(MongoClient.prototype, 'close', async function closeMock() {
    return undefined;
  });
  t.mock.method(MongoClient.prototype, 'db', function dbMock() {
    return {
      collection() {
        return {
          find() {
            return {
              toArray: async () => [],
            };
          },
        };
      },
    };
  });

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
});
