'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const MONGO_CONNECTION_ID_RE = /^[a-z0-9_-]{1,64}$/i;
const MONGO_RESERVED_CONNECTION_IDS = new Set(['__proto__', 'prototype', 'constructor']);

function validateMongoUri(uri) {
  if (!uri || typeof uri !== 'string') return false;
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'mongodb:' || parsed.protocol === 'mongodb+srv:';
  } catch {
    return false;
  }
}

function isReservedMongoConnectionId(id) {
  return MONGO_RESERVED_CONNECTION_IDS.has(String(id || '').toLowerCase());
}

function isValidMongoConnectionId(id) {
  return typeof id === 'string'
    && MONGO_CONNECTION_ID_RE.test(id)
    && !isReservedMongoConnectionId(id);
}

function isIntegerInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validateDatabaseConfig(config, requireId = false) {
  if (!config || typeof config !== 'object') return 'Invalid database config';
  if (requireId) {
    if (typeof config._id !== 'string' || !config._id.trim()) return 'Missing required fields: _id, type';
  }
  if (typeof config.type !== 'string') return 'Missing required field: type';

  if (config.connectionTimeout !== undefined && !isIntegerInRange(config.connectionTimeout, 100, 120000)) {
    return 'connectionTimeout must be an integer between 100 and 120000';
  }
  if (config.queryTimeout !== undefined && !isIntegerInRange(config.queryTimeout, 100, 600000)) {
    return 'queryTimeout must be an integer between 100 and 600000';
  }
  if (config.maxConnections !== undefined && !isIntegerInRange(config.maxConnections, 1, 50)) {
    return 'maxConnections must be an integer between 1 and 50';
  }

  if (config.type === 'mysql' || config.type === 'postgres') {
    if (typeof config.host !== 'string' || !config.host.trim()) return 'host is required';
    if (!isIntegerInRange(config.port, 1, 65535)) return 'port must be an integer between 1 and 65535';
    if (typeof config.username !== 'string' || !config.username.trim()) return 'username is required';
    if (typeof config.database !== 'string' || !config.database.trim()) return 'database is required';
  }

  if (config.type === 'mongodb') {
    if (typeof config.connectionUri !== 'string' || !config.connectionUri.trim()) {
      return 'connectionUri is required';
    }
    if (!validateMongoUri(config.connectionUri)) {
      return 'connectionUri must use the mongodb:// or mongodb+srv:// scheme';
    }
  }

  return null;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', chunk => { buf += chunk; });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function createTestServer() {
  const calls = {
    testConnection: [],
    createPool: [],
    executeQuery: [],
    mongoQuery: [],
  };

  const dbManager = {
    async testConnection(config) {
      calls.testConnection.push(config);
      return { ok: true, latencyMs: 1 };
    },
    async createPool(poolId, config) {
      calls.createPool.push({ poolId, config });
    },
    async executeQuery(connectionId, sql, params) {
      calls.executeQuery.push({ connectionId, sql, params });
      return { rows: [], columns: [], rowCount: 0 };
    },
    async mongoQuery(connectionId, operation, document, options) {
      calls.mongoQuery.push({ connectionId, operation, document, options });
      return { result: [] };
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/api/mongo/introspect/databases') {
      let body;
      try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
      const connectionId = typeof body?.connectionId === 'string' ? body.connectionId.trim() : '';
      if (connectionId && !isValidMongoConnectionId(connectionId)) {
        return sendJson(res, 400, { error: 'Invalid connection id' });
      }
      return sendJson(res, 200, { databases: [] });
    }

    if (req.method === 'POST' && url.pathname === '/api/databases/test') {
      let config;
      try { config = await readBody(req); } catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
      const validationError = validateDatabaseConfig(config, false);
      if (validationError) return sendJson(res, 400, { error: validationError });
      const out = await dbManager.testConnection(config);
      return sendJson(res, 200, out);
    }

    if (req.method === 'POST' && url.pathname === '/api/databases/query') {
      let body;
      try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
      const { connectionId, sql, params, operation, document, options } = body;
      if (typeof connectionId !== 'string' || !connectionId.trim()) {
        return sendJson(res, 400, { error: 'connectionId is required' });
      }

      if (sql !== undefined) {
        if (typeof sql !== 'string') return sendJson(res, 400, { error: 'sql must be a string' });
        if (params !== undefined && !Array.isArray(params)) {
          return sendJson(res, 400, { error: 'params must be an array when provided' });
        }
        const out = await dbManager.executeQuery(connectionId, sql, params || []);
        return sendJson(res, 200, { success: true, ...out });
      }

      if (operation !== undefined) {
        if (typeof operation !== 'string') return sendJson(res, 400, { error: 'operation must be a string' });
        if (document !== undefined && (document === null || typeof document !== 'object' || Array.isArray(document))) {
          return sendJson(res, 400, { error: 'document must be an object when provided' });
        }
        if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options))) {
          return sendJson(res, 400, { error: 'options must be an object when provided' });
        }
        const out = await dbManager.mongoQuery(connectionId, operation, document || {}, options || {});
        return sendJson(res, 200, { success: true, ...out });
      }

      return sendJson(res, 400, { error: 'Either "sql" or "operation" must be provided' });
    }

    if (req.method === 'POST' && url.pathname === '/api/databases/pool/open') {
      let config;
      try { config = await readBody(req); } catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
      if (!config || !config._id || !config.type) {
        return sendJson(res, 400, { error: 'Missing required fields: _id, type' });
      }
      const validationError = validateDatabaseConfig(config, true);
      if (validationError) return sendJson(res, 400, { error: validationError });
      await dbManager.createPool(config._id, config);
      return sendJson(res, 200, { ok: true, poolId: config._id });
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  return { server, calls };
}

function postJson(server, pathname, body) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', chunk => { buf += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : {} });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

let fixture;

test.before(async () => {
  fixture = createTestServer();
  await new Promise(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
});

test.after(async () => {
  await new Promise(resolve => fixture.server.close(resolve));
});

test('mongo introspect rejects malformed connectionId with 400', async () => {
  const res = await postJson(fixture.server, '/api/mongo/introspect/databases', { connectionId: 'bad.id' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /invalid connection id/i);
});

test('databases test route rejects invalid timeout range', async () => {
  const res = await postJson(fixture.server, '/api/databases/test', {
    type: 'mysql',
    host: 'localhost',
    port: 3306,
    username: 'root',
    database: 'app',
    connectionTimeout: 99,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /connectionTimeout/i);
});

test('databases test route rejects invalid mongodb URI scheme', async () => {
  const res = await postJson(fixture.server, '/api/databases/test', {
    type: 'mongodb',
    connectionUri: 'https://example.com',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /mongodb:\/\//i);
});

test('databases test route accepts valid SQL config and calls db manager', async () => {
  const res = await postJson(fixture.server, '/api/databases/test', {
    type: 'mysql',
    host: 'localhost',
    port: 3306,
    username: 'root',
    database: 'app',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(fixture.calls.testConnection.length > 0, true);
});

test('databases query route validates SQL payload types', async () => {
  const res = await postJson(fixture.server, '/api/databases/query', {
    connectionId: 'db1',
    sql: 123,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /sql must be a string/i);
});

test('databases query route validates SQL params type', async () => {
  const res = await postJson(fixture.server, '/api/databases/query', {
    connectionId: 'db1',
    sql: 'SELECT 1',
    params: { bad: true },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /params must be an array/i);
});

test('databases query route validates mongo operation payload types', async () => {
  const res = await postJson(fixture.server, '/api/databases/query', {
    connectionId: 'mongo1',
    operation: 10,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /operation must be a string/i);
});

test('databases query route accepts valid SQL payload', async () => {
  const res = await postJson(fixture.server, '/api/databases/query', {
    connectionId: 'db1',
    sql: 'SELECT 1',
    params: [],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(fixture.calls.executeQuery.length > 0, true);
});

test('databases pool open rejects invalid config with 400', async () => {
  const res = await postJson(fixture.server, '/api/databases/pool/open', {
    _id: 'pool1',
    type: 'postgres',
    host: '',
    port: 0,
    username: '',
    database: '',
  });
  assert.equal(res.status, 400);
  assert.equal(typeof res.body.error, 'string');
});

test('databases pool open accepts valid config and opens pool', async () => {
  const res = await postJson(fixture.server, '/api/databases/pool/open', {
    _id: 'pool1',
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    username: 'postgres',
    database: 'app',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(fixture.calls.createPool.length > 0, true);
});
