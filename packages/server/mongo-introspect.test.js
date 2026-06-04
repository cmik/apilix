'use strict';

/**
 * Tests for MongoDB introspection route validation and the underlying
 * executeMongoIntrospect core function.
 *
 * Route logic is replicated in a standalone http.createServer so we do not
 * need to import the monolithic server/index.js (which starts listening at
 * require-time on a fixed port).  This mirrors the pattern used in
 * mongo-connections.test.js.
 *
 * Because no real MongoDB is running in CI, all tests that exercise the
 * mongo driver path use an unreachable address (127.0.0.1:1) and assert on
 * the error contract rather than on actual data.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { executeMongoIntrospect } = require('@apilix/core');

const MONGO_CONNECTION_ID_RE = /^[a-z0-9_-]{1,64}$/i;
const MONGO_RESERVED_CONNECTION_IDS = new Set(['__proto__', 'prototype', 'constructor']);

// ─── Minimal HTTP helpers ─────────────────────────────────────────────────────

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

function isReservedMongoConnectionId(id) {
  return MONGO_RESERVED_CONNECTION_IDS.has(String(id || '').toLowerCase());
}

function isValidMongoConnectionId(id) {
  return typeof id === 'string'
    && MONGO_CONNECTION_ID_RE.test(id)
    && !isReservedMongoConnectionId(id);
}

function validateMongoUri(uri) {
  if (!uri || typeof uri !== 'string') return false;
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'mongodb:' || parsed.protocol === 'mongodb+srv:';
  } catch {
    return false;
  }
}

function applyMongoAuthToUri(uri, auth) {
  if (!auth || !auth.mode) return uri;
  try {
    const parsed = new URL(uri);
    if (auth.username) parsed.username = auth.username;
    if (auth.password) parsed.password = auth.password;
    if (auth.authSource) parsed.searchParams.set('authSource', auth.authSource);
    if (auth.mode === 'x509') parsed.searchParams.set('authMechanism', 'MONGODB-X509');
    if (auth.mode === 'ldap-plain') parsed.searchParams.set('authMechanism', 'PLAIN');
    if (auth.mode === 'oidc') parsed.searchParams.set('authMechanism', 'MONGODB-OIDC');
    return parsed.toString();
  } catch {
    return uri;
  }
}

function resolveIntrospectUri(input) {
  const uri = typeof input?.uri === 'string' ? input.uri.trim() : '';
  const connectionId = typeof input?.connectionId === 'string' ? input.connectionId.trim() : '';
  const databases = Array.isArray(input?.databases) ? input.databases : [];
  const auth = input?.auth && typeof input.auth === 'object' ? input.auth : null;

  let resolvedUri;

  if (uri) {
    if (!validateMongoUri(uri)) {
      return { errorStatus: 400, error: 'uri must use the mongodb:// or mongodb+srv:// scheme' };
    }
    resolvedUri = uri;
  } else {
    if (!connectionId) {
      return { errorStatus: 400, error: 'uri or connectionId is required' };
    }
    if (!isValidMongoConnectionId(connectionId)) {
      return { errorStatus: 400, error: 'Invalid connection id' };
    }
    const conn = databases.find(d => d && d.type === 'mongodb' && d._id === connectionId);
    if (!conn || typeof conn.connectionUri !== 'string' || !conn.connectionUri.trim()) {
      return { errorStatus: 404, error: 'Connection not found' };
    }
    if (!validateMongoUri(conn.connectionUri)) {
      return { errorStatus: 400, error: 'stored connection URI must use the mongodb:// or mongodb+srv:// scheme' };
    }
    resolvedUri = conn.connectionUri;
  }

  return { uri: applyMongoAuthToUri(resolvedUri, auth) };
}

test('resolveIntrospectUri applies auth override credentials to resolved URI', () => {
  const resolved = resolveIntrospectUri({
    uri: 'mongodb://base-user:base-pass@127.0.0.1:27017/app',
    auth: {
      mode: 'scram',
      username: 'override-user',
      password: 'override-pass',
      authSource: 'admin',
    },
  });

  assert.equal(typeof resolved.uri, 'string');
  const parsed = new URL(resolved.uri);
  assert.equal(parsed.username, 'override-user');
  assert.equal(parsed.password, 'override-pass');
  assert.equal(parsed.searchParams.get('authSource'), 'admin');
});

/**
 * Standalone server that replicates the two introspect route handlers from
 * packages/server/index.js exactly.
 */
function createTestServer() {
  const databases = [
    { _id: 'validConn', type: 'mongodb', connectionUri: 'mongodb://127.0.0.1:1', database: 'mydb' },
    { _id: 'badSchemeConn', type: 'mongodb', connectionUri: 'https://127.0.0.1:1', database: 'mydb' },
  ];

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'POST' && pathname === '/api/mongo/introspect/databases') {
      let body;
      try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
      const resolved = resolveIntrospectUri({ ...(body || {}), databases });
      if (!resolved.uri) return sendJson(res, resolved.errorStatus, { error: resolved.error });
      try {
        const result = await executeMongoIntrospect(resolved.uri, 'databases');
        if (result.error) return sendJson(res, 502, { error: result.error });
        return sendJson(res, 200, { databases: result.databases });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (req.method === 'POST' && pathname === '/api/mongo/introspect/collections') {
      let body;
      try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
      const { database } = body;
      if (!database || typeof database !== 'string') return sendJson(res, 400, { error: 'database is required' });
      const resolved = resolveIntrospectUri({ ...(body || {}), databases });
      if (!resolved.uri) return sendJson(res, resolved.errorStatus, { error: resolved.error });
      try {
        const result = await executeMongoIntrospect(resolved.uri, 'collections', database);
        if (result.error) return sendJson(res, 502, { error: result.error });
        return sendJson(res, 200, { collections: result.collections });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    sendJson(res, 404, { error: 'Not found' });
  });
}

function httpPost(server, pathname, body) {
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
      res => {
        let buf = '';
        res.on('data', chunk => { buf += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let server;

test.before(async () => {
  server = createTestServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

// ─── executeMongoIntrospect — core unit tests ─────────────────────────────────

test('executeMongoIntrospect returns { error } when collections requested without database', async () => {
  // This path never touches the network — it returns early.
  const result = await executeMongoIntrospect('mongodb://127.0.0.1:1', 'collections', undefined);
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.error, 'string');
  assert.match(result.error, /database is required/i);
});

test('executeMongoIntrospect returns { error } when databases requested with unreachable host', async () => {
  const result = await executeMongoIntrospect('mongodb://127.0.0.1:1', 'databases');
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0, 'error message should be non-empty');
  assert.equal(result.databases, undefined);
});

test('executeMongoIntrospect returns { error } when collections requested with unreachable host', async () => {
  const result = await executeMongoIntrospect('mongodb://127.0.0.1:1', 'collections', 'mydb');
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0, 'error message should be non-empty');
  assert.equal(result.collections, undefined);
});

test('executeMongoIntrospect returns { error } for a completely invalid URI', async () => {
  const result = await executeMongoIntrospect('not-a-mongo-uri', 'databases');
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.error, 'string');
});

// ─── POST /api/mongo/introspect/databases — route validation ──────────────────

test('POST /api/mongo/introspect/databases returns 400 when uri and connectionId are missing', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/databases', {});
  assert.equal(res.status, 400);
  assert.equal(typeof res.body.error, 'string');
  assert.match(res.body.error, /uri or connectionId is required/i);
});

test('POST /api/mongo/introspect/databases returns 400 when explicit uri scheme is invalid', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/databases', { uri: 'https://127.0.0.1:1' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /mongodb/i);
});

test('POST /api/mongo/introspect/databases returns 400 when connectionId is invalid', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/databases', { connectionId: 'bad.id' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /invalid connection id/i);
});

test('POST /api/mongo/introspect/databases returns 400 when connectionId is reserved', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/databases', { connectionId: '__proto__' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /invalid connection id/i);
});

test('POST /api/mongo/introspect/databases returns 404 when connectionId does not exist', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/databases', { connectionId: 'missing' });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /connection not found/i);
});

test('POST /api/mongo/introspect/databases returns 400 when stored connection uri scheme is invalid', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/databases', { connectionId: 'badSchemeConn' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /stored connection uri/i);
});

test('POST /api/mongo/introspect/databases returns 502 with error body for unreachable host via explicit uri', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/databases', {
    uri: 'mongodb://127.0.0.1:1',
  });
  assert.equal(res.status, 502);
  assert.equal(typeof res.body.error, 'string');
  assert.ok(res.body.error.length > 0);
});

test('POST /api/mongo/introspect/databases returns 502 with error body for unreachable host via connectionId', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/databases', {
    connectionId: 'validConn',
  });
  assert.equal(res.status, 502);
  assert.equal(typeof res.body.error, 'string');
  assert.ok(res.body.error.length > 0);
});

// ─── POST /api/mongo/introspect/collections — route validation ────────────────

test('POST /api/mongo/introspect/collections returns 400 when database is missing even if connectionId is present', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/collections', { connectionId: 'validConn' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /database is required/i);
});

test('POST /api/mongo/introspect/collections returns 400 when uri and connectionId are missing', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/collections', { database: 'mydb' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /uri or connectionId is required/i);
});

test('POST /api/mongo/introspect/collections returns 400 when database is not a string', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/collections', {
    uri: 'mongodb://127.0.0.1:27017',
    database: true,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /database is required/i);
});

test('POST /api/mongo/introspect/collections returns 400 when connectionId is invalid', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/collections', {
    connectionId: 'bad.id',
    database: 'mydb',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /invalid connection id/i);
});

test('POST /api/mongo/introspect/collections returns 502 with error body for unreachable host', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/collections', {
    uri: 'mongodb://127.0.0.1:1',
    database: 'mydb',
  });
  assert.equal(res.status, 502);
  assert.equal(typeof res.body.error, 'string');
  assert.ok(res.body.error.length > 0);
});

test('POST /api/mongo/introspect/collections returns 502 with error body for unreachable host via connectionId', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/collections', {
    connectionId: 'validConn',
    database: 'mydb',
  });
  assert.equal(res.status, 502);
  assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);
});
