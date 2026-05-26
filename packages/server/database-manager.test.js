'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('createPool builds Oracle connectString from explicit value, serviceName, database, or sid', async () => {
  const originalRequire = Module.prototype.require;
  const createPoolCalls = [];

  Module.prototype.require = function patchedRequire(id) {
    if (id === 'oracledb') {
      return {
        createPool: async (opts) => {
          createPoolCalls.push(opts);
          return {
            close: async () => {},
            getConnection: async () => ({
              execute: async () => ({ rows: [] }),
              close: async () => {},
            }),
          };
        },
      };
    }
    return originalRequire.apply(this, arguments);
  };

  const dbManager = require('./database-manager.js');
  const poolIds = ['oracle_explicit', 'oracle_service', 'oracle_database', 'oracle_sid'];

  try {
    await dbManager.createPool('oracle_explicit', {
      type: 'oracle',
      username: 'u',
      password: 'p',
      connectString: 'my-custom-dsn',
    });

    await dbManager.createPool('oracle_service', {
      type: 'oracle',
      host: 'db.local',
      port: 1521,
      username: 'u',
      password: 'p',
      serviceName: 'XEPDB1',
    });

    await dbManager.createPool('oracle_database', {
      type: 'oracle',
      host: 'db.local',
      port: 1521,
      username: 'u',
      password: 'p',
      database: 'ORCLDB',
    });

    await dbManager.createPool('oracle_sid', {
      type: 'oracle',
      host: 'db.local',
      port: 1521,
      username: 'u',
      password: 'p',
      sid: 'ORCL',
    });

    assert.equal(createPoolCalls.length, 4);
    assert.equal(createPoolCalls[0].connectString, 'my-custom-dsn');
    assert.equal(createPoolCalls[1].connectString, 'db.local:1521/XEPDB1');
    assert.equal(createPoolCalls[2].connectString, 'db.local:1521/ORCLDB');
    assert.equal(createPoolCalls[3].connectString, 'db.local:1521:ORCL');
  } finally {
    for (const poolId of poolIds) {
      await dbManager.closePool(poolId);
    }
    Module.prototype.require = originalRequire;
  }
});
