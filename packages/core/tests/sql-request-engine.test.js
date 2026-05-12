'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

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
  };
}

test('executeRequest executes SQL request via dbQueryFn and returns table metadata', async () => {
  let calls = 0;
  const ctx = {
    ...makeContext(),
    dbQueryFn: async (connectionId, sql, params) => {
      calls++;
      assert.equal(connectionId, 'db-main');
      assert.equal(sql, 'SELECT 1 AS one');
      assert.deepEqual(params, []);
      return {
        rows: [{ one: 1 }],
        columns: ['one'],
        rowCount: 1,
      };
    },
    databases: [{ _id: 'db-main', type: 'postgres' }],
  };

  const item = {
    name: 'SQL Basic',
    request: {
      method: 'POSTGRESQL',
      requestType: 'sql',
      url: { raw: '' },
      sql: {
        connectionId: 'db-main',
        query: 'SELECT 1 AS one',
        params: '[]',
        resultView: 'table',
      },
    },
  };

  const result = await executeRequest(item, ctx);
  assert.equal(calls, 1);
  assert.equal(result.error, null);
  assert.equal(result.protocol, 'sql');
  assert.equal(result.sqlDialect, 'postgres');
  assert.equal(result.status, 2200);
  assert.equal(result.resultView, 'table');
  assert.deepEqual(result.resultTable?.columns, ['one']);
  assert.equal(result.resultTable?.rowCount, 1);
  assert.equal(result.resultTable?.rows?.[0]?.one, 1);
});

test('executeRequest resolves variables in SQL query and params', async () => {
  let capturedSql = '';
  let capturedParams = [];
  const ctx = {
    ...makeContext(),
    environment: { tableName: 'users', status: 'active', limit: '10' },
    dbQueryFn: async (_connectionId, sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [], columns: [], rowCount: 0 };
    },
  };

  const item = {
    name: 'SQL Vars',
    request: {
      method: 'MYSQL',
      requestType: 'sql',
      url: { raw: '' },
      sql: {
        connectionId: 'db-1',
        query: 'SELECT * FROM {{tableName}} WHERE status = ? LIMIT ?',
        params: '["{{status}}", {{limit}}]',
      },
    },
  };

  const result = await executeRequest(item, ctx);
  assert.equal(result.error, null);
  assert.equal(capturedSql, 'SELECT * FROM users WHERE status = ? LIMIT ?');
  assert.deepEqual(capturedParams, ['active', 10]);
});

test('executeRequest pre-request apx.db.query receives databases and mongoConnections in script context', async () => {
  const calls = [];
  const ctx = {
    ...makeContext(),
    mongoConnections: {
      namedMongo: { uri: 'mongodb://localhost:27017', database: 'app' },
    },
    databases: [{ _id: 'db-main', type: 'mysql', host: 'localhost', port: 3306, username: 'u', password: '', database: 'app' }],
    dbQueryFn: async (connectionId, sql, params, scriptContext) => {
      calls.push({ connectionId, sql, params, scriptContext });
      return {
        rows: [{ ok: 1 }],
        columns: ['ok'],
        rowCount: 1,
      };
    },
  };

  const item = {
    id: 'parent-sql',
    name: 'SQL With Pre Script',
    request: {
      method: 'MYSQL',
      requestType: 'sql',
      url: { raw: '' },
      sql: {
        connectionId: 'db-main',
        query: 'SELECT main',
        params: '[]',
      },
    },
    event: [
      {
        listen: 'prerequest',
        script: {
          exec: ["apx.db.query('db-main', 'SELECT pre', []);"]
        },
      },
    ],
  };

  const result = await executeRequest(item, ctx);
  assert.equal(result.error, null);
  const preCall = calls.find(c => c.sql === 'SELECT pre');
  assert.ok(preCall, 'expected pre-request apx.db.query call');
  assert.equal(Array.isArray(preCall.scriptContext.databases), true);
  assert.equal(preCall.scriptContext.databases.length, 1);
  assert.deepEqual(preCall.scriptContext.mongoConnections, {
    namedMongo: { uri: 'mongodb://localhost:27017', database: 'app' },
  });
});
