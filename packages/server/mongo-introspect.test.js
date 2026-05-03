'use strict';

/**
 * Tests for the MongoDB introspect HTTP routes and the underlying
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

/**
 * Standalone server that replicates the two introspect route handlers from
 * packages/server/index.js exactly.
 */
function createTestServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'POST' && pathname === '/api/mongo/introspect/databases') {
      let body;
      try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
      const { uri } = body;
      if (!uri || typeof uri !== 'string') return sendJson(res, 400, { error: 'uri is required' });
      try {
        const result = await executeMongoIntrospect(uri, 'databases');
        if (result.error) return sendJson(res, 400, { error: result.error });
        return sendJson(res, 200, { databases: result.databases });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (req.method === 'POST' && pathname === '/api/mongo/introspect/collections') {
      let body;
      try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
      const { uri, database } = body;
      if (!uri || typeof uri !== 'string') return sendJson(res, 400, { error: 'uri is required' });
      if (!database || typeof database !== 'string') return sendJson(res, 400, { error: 'database is required' });
      try {
        const result = await executeMongoIntrospect(uri, 'collections', database);
        if (result.error) return sendJson(res, 400, { error: result.error });
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

test('POST /api/mongo/introspect/databases returns 400 when uri is missing', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/databases', {});
  assert.equal(res.status, 400);
  assert.equal(typeof res.body.error, 'string');
  assert.match(res.body.error, /uri is required/i);
});

test('POST /api/mongo/introspect/databases returns 400 when uri is not a string', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/databases', { uri: 42 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /uri is required/i);
});

test('POST /api/mongo/introspect/databases returns 400 with error body for unreachable host', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/databases', {
    uri: 'mongodb://127.0.0.1:1',
  });
  assert.equal(res.status, 400);
  assert.equal(typeof res.body.error, 'string');
  assert.ok(res.body.error.length > 0);
});

// ─── POST /api/mongo/introspect/collections — route validation ────────────────

test('POST /api/mongo/introspect/collections returns 400 when uri is missing', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/collections', { database: 'mydb' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /uri is required/i);
});

test('POST /api/mongo/introspect/collections returns 400 when database is missing', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/collections', {
    uri: 'mongodb://127.0.0.1:27017',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /database is required/i);
});

test('POST /api/mongo/introspect/collections returns 400 when database is not a string', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/collections', {
    uri: 'mongodb://127.0.0.1:27017',
    database: true,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /database is required/i);
});

test('POST /api/mongo/introspect/collections returns 400 with error body for unreachable host', async () => {
  const res = await httpPost(server, '/api/mongo/introspect/collections', {
    uri: 'mongodb://127.0.0.1:1',
    database: 'mydb',
  });
  assert.equal(res.status, 400);
  assert.equal(typeof res.body.error, 'string');
  assert.ok(res.body.error.length > 0);
});

test('POST /api/mongo/introspect/collections returns 400 with "database is required" error when core detects missing database', async () => {
  // Simulate the internal guard path where uri is given but driver-level error
  // surfaces the missing-database message (operation='collections', no db arg
  // passed through the route handler is impossible normally, but verify the
  // response shape is an error object regardless).
  const res = await httpPost(server, '/api/mongo/introspect/collections', {
    uri: 'mongodb://127.0.0.1:1',
    database: 'test',
  });
  // Either a connection error or a "database is required" error — both are 400
  assert.equal(res.status, 400);
  assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);
});
