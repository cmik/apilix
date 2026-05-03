'use strict';

/**
 * Tests for the MongoDB connection CRUD HTTP routes.
 *
 * Because the full server/index.js is monolithic (it calls app.listen at load
 * time), we replicate the exact handler logic here in a standalone Express app
 * and test it over a real HTTP server on an ephemeral port.  This mirrors the
 * pattern used in mock-routing.test.js.
 *
 * We control the settings file path via a temp directory so the tests never
 * touch the real ~/.apilix directory.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// ─── Isolated settings helpers (mirrors server/index.js) ─────────────────────

let SETTINGS_FILE; // set in before()

function ensureDirFor(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function settingsKey() {
  return crypto
    .createHash('sha256')
    .update(String(process.env.APILIX_MONGO_SETTINGS_KEY || 'test-only-key'))
    .digest();
}

function encryptJson(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', settingsKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptJson(blob) {
  if (!blob || typeof blob !== 'object' || !blob.iv || !blob.tag || !blob.data) {
    return { connections: {} };
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    settingsKey(),
    Buffer.from(blob.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(blob.data, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const data = decryptJson(parsed);
    if (!data || typeof data !== 'object') return { connections: {} };
    return {
      connections: data.connections && typeof data.connections === 'object'
        ? data.connections : {},
    };
  } catch {
    return { connections: {} };
  }
}

function writeSettings(data) {
  ensureDirFor(SETTINGS_FILE);
  const payload = encryptJson({ connections: data.connections || {} });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

// ─── Minimal HTTP server replicating the CRUD route logic ─────────────────────
// Mirrors app.get/post/delete routes in server/index.js for:
//   GET  /api/mongo/connections
//   POST /api/mongo/connections
//   DEL  /api/mongo/connections/:id
//   POST /api/mongo/connections/:id/test

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
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    // GET /api/mongo/connections
    if (req.method === 'GET' && pathname === '/api/mongo/connections') {
      const settings = readSettings();
      const entries = Object.entries(settings.connections || {}).map(([id, value]) => ({
        id,
        name: value.name || id,
        database: value.database || '',
        authMode: value.authMode || 'scram',
        hasUri: !!value.uri,
      }));
      return sendJson(res, 200, { connections: entries });
    }

    // POST /api/mongo/connections
    if (req.method === 'POST' && pathname === '/api/mongo/connections') {
      const body = await readBody(req);
      const { id, name, uri, database, authMode } = body || {};

      if (!id || typeof id !== 'string') {
        return sendJson(res, 400, { error: 'id is required' });
      }
      if (!/^[a-z0-9_-]{1,64}$/i.test(id)) {
        return sendJson(res, 400, { error: 'id must be 1–64 alphanumeric, dash, or underscore characters' });
      }
      if (!uri || typeof uri !== 'string') {
        return sendJson(res, 400, { error: 'uri is required' });
      }

      const settings = readSettings();
      settings.connections[id] = {
        name: typeof name === 'string' && name.trim() ? name.trim() : id,
        uri,
        database: typeof database === 'string' ? database : '',
        authMode: typeof authMode === 'string' ? authMode : 'scram',
        updatedAt: new Date().toISOString(),
      };
      writeSettings(settings);
      return sendJson(res, 200, { ok: true });
    }

    // DELETE /api/mongo/connections/:id
    const deleteMatch = pathname.match(/^\/api\/mongo\/connections\/([^/]+)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      const id = decodeURIComponent(deleteMatch[1]);
      const settings = readSettings();
      if (settings.connections[id]) delete settings.connections[id];
      writeSettings(settings);
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/mongo/connections/:id/test
    const testMatch = pathname.match(/^\/api\/mongo\/connections\/([^/]+)\/test$/);
    if (req.method === 'POST' && testMatch) {
      const id = decodeURIComponent(testMatch[1]);
      const settings = readSettings();
      const conn = settings.connections[id];
      if (!conn) return sendJson(res, 404, { error: 'Connection not found' });
      // In unit tests we don't actually connect to MongoDB; we just exercise
      // the route plumbing.  Return a synthetic "unreachable" response that
      // mirrors what executeMongoTest returns on failure.
      return sendJson(res, 200, { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:1' });
    }

    sendJson(res, 404, { error: 'Not found' });
  });
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpRequest(server, method, pathname, body) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const opts = {
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = http.request(opts, res => {
      let buf = '';
      res.on('data', chunk => { buf += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

let server;
let tmpDir;

test.before(async () => {
  // Stable encryption key for all tests
  process.env.APILIX_MONGO_SETTINGS_KEY = 'unit-test-deterministic-key-123';

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apilix-mongo-test-'));
  SETTINGS_FILE = path.join(tmpDir, '.apilix', 'mongo-connections.enc.json');

  server = createTestServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  // Reset settings file before each test for isolation
  try { fs.rmSync(SETTINGS_FILE); } catch (_) {}
});

// ── GET /api/mongo/connections ─────────────────────────────────────────────────

test('GET /api/mongo/connections returns empty list when no connections saved', async () => {
  const res = await httpRequest(server, 'GET', '/api/mongo/connections');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { connections: [] });
});

// ── POST /api/mongo/connections ────────────────────────────────────────────────

test('POST /api/mongo/connections creates a connection and it appears in GET', async () => {
  const post = await httpRequest(server, 'POST', '/api/mongo/connections', {
    id: 'local-dev',
    name: 'Local Dev',
    uri: 'mongodb://localhost:27017',
    database: 'mydb',
    authMode: 'scram',
  });
  assert.equal(post.status, 200);
  assert.equal(post.body.ok, true);

  const get = await httpRequest(server, 'GET', '/api/mongo/connections');
  assert.equal(get.status, 200);
  assert.equal(get.body.connections.length, 1);
  const conn = get.body.connections[0];
  assert.equal(conn.id, 'local-dev');
  assert.equal(conn.name, 'Local Dev');
  assert.equal(conn.database, 'mydb');
  assert.equal(conn.authMode, 'scram');
  // URI must NOT be returned — only hasUri flag
  assert.equal(conn.hasUri, true);
  assert.equal(conn.uri, undefined);
});

test('POST /api/mongo/connections uses id as name when name is omitted', async () => {
  const post = await httpRequest(server, 'POST', '/api/mongo/connections', {
    id: 'no-name-conn',
    uri: 'mongodb://localhost:27017',
  });
  assert.equal(post.status, 200);

  const get = await httpRequest(server, 'GET', '/api/mongo/connections');
  const conn = get.body.connections[0];
  assert.equal(conn.name, 'no-name-conn');
});

test('POST /api/mongo/connections rejects missing id', async () => {
  const res = await httpRequest(server, 'POST', '/api/mongo/connections', {
    uri: 'mongodb://localhost:27017',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /id is required/i);
});

test('POST /api/mongo/connections rejects missing uri', async () => {
  const res = await httpRequest(server, 'POST', '/api/mongo/connections', {
    id: 'my-conn',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /uri is required/i);
});

test('POST /api/mongo/connections rejects id containing dots (path traversal guard)', async () => {
  const res = await httpRequest(server, 'POST', '/api/mongo/connections', {
    id: '../evil',
    uri: 'mongodb://localhost:27017',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /alphanumeric/i);
});

test('POST /api/mongo/connections rejects id containing slashes', async () => {
  const res = await httpRequest(server, 'POST', '/api/mongo/connections', {
    id: 'a/b',
    uri: 'mongodb://localhost:27017',
  });
  assert.equal(res.status, 400);
});

test('POST /api/mongo/connections rejects id with spaces', async () => {
  const res = await httpRequest(server, 'POST', '/api/mongo/connections', {
    id: 'bad id with spaces',
    uri: 'mongodb://localhost:27017',
  });
  assert.equal(res.status, 400);
});

test('POST /api/mongo/connections rejects id longer than 64 characters', async () => {
  const res = await httpRequest(server, 'POST', '/api/mongo/connections', {
    id: 'a'.repeat(65),
    uri: 'mongodb://localhost:27017',
  });
  assert.equal(res.status, 400);
});

test('POST /api/mongo/connections accepts id with dashes and underscores', async () => {
  const res = await httpRequest(server, 'POST', '/api/mongo/connections', {
    id: 'my-conn_v2',
    uri: 'mongodb://localhost:27017',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('POST /api/mongo/connections upserts existing id', async () => {
  await httpRequest(server, 'POST', '/api/mongo/connections', {
    id: 'upsert-me',
    name: 'Original',
    uri: 'mongodb://localhost:27017',
  });
  await httpRequest(server, 'POST', '/api/mongo/connections', {
    id: 'upsert-me',
    name: 'Updated',
    uri: 'mongodb://localhost:27018',
  });

  const get = await httpRequest(server, 'GET', '/api/mongo/connections');
  assert.equal(get.body.connections.length, 1);
  assert.equal(get.body.connections[0].name, 'Updated');
});

// ── DELETE /api/mongo/connections/:id ─────────────────────────────────────────

test('DELETE /api/mongo/connections/:id removes the connection', async () => {
  await httpRequest(server, 'POST', '/api/mongo/connections', {
    id: 'to-delete',
    uri: 'mongodb://localhost:27017',
  });

  const del = await httpRequest(server, 'DELETE', '/api/mongo/connections/to-delete');
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);

  const get = await httpRequest(server, 'GET', '/api/mongo/connections');
  assert.equal(get.body.connections.length, 0);
});

test('DELETE /api/mongo/connections/:id is idempotent for unknown ids', async () => {
  const del = await httpRequest(server, 'DELETE', '/api/mongo/connections/does-not-exist');
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);
});

// ── POST /api/mongo/connections/:id/test ──────────────────────────────────────

test('POST /api/mongo/connections/:id/test returns 404 for unknown connection', async () => {
  const res = await httpRequest(server, 'POST', '/api/mongo/connections/ghost/test');
  assert.equal(res.status, 404);
  assert.match(res.body.error, /not found/i);
});

test('POST /api/mongo/connections/:id/test returns { ok, error } shape for existing connection', async () => {
  await httpRequest(server, 'POST', '/api/mongo/connections', {
    id: 'test-me',
    uri: 'mongodb://localhost:27017',
  });

  const res = await httpRequest(server, 'POST', '/api/mongo/connections/test-me/test');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.ok, 'boolean');
  // The test server returns ok:false; in production this would be executeMongoTest()
});

// ── Persistence: settings survive across reads ─────────────────────────────────

test('connections persist to encrypted file and survive a cold read', async () => {
  await httpRequest(server, 'POST', '/api/mongo/connections', {
    id: 'persist-me',
    name: 'Persistent',
    uri: 'mongodb://localhost:27017',
    database: 'proddb',
  });

  // Wipe any cached state — readSettings() reads from disk each time
  const fresh = readSettings();
  assert.ok(fresh.connections['persist-me'], 'connection should be persisted to disk');
  assert.equal(fresh.connections['persist-me'].name, 'Persistent');
  assert.equal(fresh.connections['persist-me'].database, 'proddb');
  // URI must be stored (encrypted on disk, readable via readSettings)
  assert.equal(fresh.connections['persist-me'].uri, 'mongodb://localhost:27017');
});
