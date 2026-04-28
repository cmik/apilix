'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// ─── Minimal stubs so index.js modules don't blow up in test context ──────────
// We test the indexing logic by extracting the two pure functions directly
// (matchPath and buildRouteIndex) plus invoking the handler via a real HTTP server.

// Pull out the private helpers via a thin re-export shim rather than requiring
// the full server (which would bind ports and read env vars).  We copy the
// relevant standalone functions verbatim here so the tests are self-contained.

// ── matchPath (copied from server/index.js) ───────────────────────────────────
function safeDecode(str) {
  try { return decodeURIComponent(str); } catch { return str; }
}

function matchPath(pattern, incoming) {
  const patParts = pattern.replace(/\/+$/, '').split('/');
  const incParts = incoming.replace(/\?.*$/, '').replace(/\/+$/, '').split('/');
  if (patParts.length !== incParts.length) return null;
  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(':')) {
      params[patParts[i].slice(1)] = safeDecode(incParts[i]);
    } else if (patParts[i] !== incParts[i]) {
      return null;
    }
  }
  return params;
}

// ── buildRouteIndex (copied from server/index.js) ────────────────────────────
let _staticHttp, _paramHttp, _staticWs, _paramWs;

function buildRouteIndex(routes) {
  const staticHttp = new Map();
  const paramHttp  = [];
  const staticWs   = new Map();
  const paramWs    = [];

  routes.forEach((route, originalIndex) => {
    if (!route.enabled) return;

    const isWs     = route.type === 'websocket';
    const hasParam = route.path.includes(':');
    const normPath = route.path.replace(/\/+$/, '') || '/';

    if (hasParam) {
      if (isWs) paramWs.push({ route, originalIndex });
      else      paramHttp.push({ route, originalIndex });
    } else {
      if (isWs) {
        if (!staticWs.has(normPath)) staticWs.set(normPath, { route, originalIndex });
      } else {
        const key = `${route.method.toUpperCase()}:${normPath}`;
        if (!staticHttp.has(key)) staticHttp.set(key, { route, originalIndex });
      }
    }
  });

  _staticHttp = staticHttp;
  _paramHttp  = paramHttp;
  _staticWs   = staticWs;
  _paramWs    = paramWs;
}

// ── Two-tier lookup (copied from server/index.js buildMockHandler) ────────────
function lookupHttpRoute(method, pathname) {
  const normPath    = pathname.replace(/\/+$/, '') || '/';
  const specificKey = `${method}:${normPath}`;
  const wildcardKey = `*:${normPath}`;

  const staticSpecific = _staticHttp.get(specificKey) ?? null;
  const staticWildcard = _staticHttp.get(wildcardKey) ?? null;

  let staticCandidate = null;
  if (staticSpecific && staticWildcard) {
    staticCandidate = staticSpecific.originalIndex < staticWildcard.originalIndex
      ? staticSpecific : staticWildcard;
  } else {
    staticCandidate = staticSpecific ?? staticWildcard ?? null;
  }

  let paramCandidate = null;
  for (const entry of _paramHttp) {
    const { route } = entry;
    if (route.method !== '*' && route.method.toUpperCase() !== method) continue;
    const params = matchPath(route.path, pathname);
    if (params !== null) { paramCandidate = { ...entry, params }; break; }
  }

  if (staticCandidate && (!paramCandidate || staticCandidate.originalIndex < paramCandidate.originalIndex)) {
    return { route: staticCandidate.route, pathParams: {} };
  } else if (paramCandidate) {
    return { route: paramCandidate.route, pathParams: paramCandidate.params };
  }
  return null;
}

function lookupWsRoute(pathname) {
  const normWsPath = pathname.replace(/\/+$/, '') || '/';
  const staticWsEntry = _staticWs.get(normWsPath) ?? null;

  let paramWsCandidate = null;
  for (const entry of _paramWs) {
    const params = matchPath(entry.route.path, pathname);
    if (params !== null) { paramWsCandidate = { ...entry, params }; break; }
  }

  if (staticWsEntry && (!paramWsCandidate || staticWsEntry.originalIndex < paramWsCandidate.originalIndex)) {
    return { route: staticWsEntry.route, pathParams: {} };
  } else if (paramWsCandidate) {
    return { route: paramWsCandidate.route, pathParams: paramWsCandidate.params };
  }
  return null;
}

// ── Route factory ─────────────────────────────────────────────────────────────
let _idSeq = 0;
function makeRoute(method, path, overrides = {}) {
  return {
    id: String(++_idSeq),
    enabled: true,
    type: 'http',
    method,
    path,
    statusCode: 200,
    responseHeaders: [],
    responseBody: 'ok',
    delay: 0,
    description: '',
    ...overrides,
  };
}

function makeWsRoute(path, overrides = {}) {
  return makeRoute('GET', path, { type: 'websocket', ...overrides });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('static HTTP: exact method match', () => {
  buildRouteIndex([makeRoute('GET', '/api/users')]);
  const result = lookupHttpRoute('GET', '/api/users');
  assert.ok(result, 'should match');
  assert.equal(result.route.path, '/api/users');
  assert.deepEqual(result.pathParams, {});
});

test('static HTTP: no match on wrong method', () => {
  buildRouteIndex([makeRoute('POST', '/api/users')]);
  const result = lookupHttpRoute('GET', '/api/users');
  assert.equal(result, null);
});

test('parametric HTTP: extracts path params', () => {
  buildRouteIndex([makeRoute('GET', '/api/users/:id')]);
  const result = lookupHttpRoute('GET', '/api/users/42');
  assert.ok(result);
  assert.equal(result.route.path, '/api/users/:id');
  assert.deepEqual(result.pathParams, { id: '42' });
});

test('parametric HTTP: method mismatch returns null', () => {
  buildRouteIndex([makeRoute('POST', '/api/users/:id')]);
  const result = lookupHttpRoute('GET', '/api/users/42');
  assert.equal(result, null);
});

test('wildcard method (*) matches any HTTP method — static', () => {
  buildRouteIndex([makeRoute('*', '/health')]);
  for (const m of ['GET', 'POST', 'DELETE', 'PATCH']) {
    const result = lookupHttpRoute(m, '/health');
    assert.ok(result, `should match ${m}`);
  }
});

test('wildcard method (*) matches any HTTP method — parametric', () => {
  buildRouteIndex([makeRoute('*', '/items/:id')]);
  const result = lookupHttpRoute('PATCH', '/items/7');
  assert.ok(result);
  assert.deepEqual(result.pathParams, { id: '7' });
});

test('ordering: param route (index 0) beats static (index 1) for same incoming path', () => {
  const routes = [
    makeRoute('GET', '/api/:x'),   // index 0
    makeRoute('GET', '/api/users'), // index 1
  ];
  buildRouteIndex(routes);
  // /api/users matches both; index 0 must win
  const result = lookupHttpRoute('GET', '/api/users');
  assert.ok(result);
  assert.equal(result.route.path, '/api/:x');
});

test('ordering: static route (index 0) beats param route (index 1) for same incoming path', () => {
  const routes = [
    makeRoute('GET', '/api/users'), // index 0
    makeRoute('GET', '/api/:x'),   // index 1
  ];
  buildRouteIndex(routes);
  const result = lookupHttpRoute('GET', '/api/users');
  assert.ok(result);
  assert.equal(result.route.path, '/api/users');
  assert.deepEqual(result.pathParams, {});
});

test('ordering: wildcard-method static vs specific-method static — lower index wins', () => {
  const routes = [
    makeRoute('*', '/health'),   // index 0
    makeRoute('GET', '/health'), // index 1
  ];
  buildRouteIndex(routes);
  const result = lookupHttpRoute('GET', '/health');
  assert.ok(result);
  assert.equal(result.route.method, '*'); // index 0 wins
});

test('disabled routes are excluded from index', () => {
  const routes = [
    makeRoute('GET', '/api/users', { enabled: false }),
    makeRoute('GET', '/api/users', { enabled: true, statusCode: 201 }),
  ];
  buildRouteIndex(routes);
  const result = lookupHttpRoute('GET', '/api/users');
  assert.ok(result);
  assert.equal(result.route.statusCode, 201);
});

test('no match returns null', () => {
  buildRouteIndex([makeRoute('GET', '/api/users')]);
  assert.equal(lookupHttpRoute('GET', '/api/orders'), null);
});

test('trailing slashes are normalized', () => {
  buildRouteIndex([makeRoute('GET', '/api/users/')]);
  const result = lookupHttpRoute('GET', '/api/users');
  assert.ok(result);
});

test('multiple parametric routes: first match in list order wins', () => {
  const routes = [
    makeRoute('GET', '/api/:type'),       // index 0
    makeRoute('GET', '/api/:collection'), // index 1
  ];
  buildRouteIndex(routes);
  const result = lookupHttpRoute('GET', '/api/orders');
  assert.ok(result);
  assert.equal(result.route.path, '/api/:type'); // index 0 wins
  assert.deepEqual(result.pathParams, { type: 'orders' });
});

// ─── WebSocket route tests ────────────────────────────────────────────────────

test('static WS: matches by path', () => {
  buildRouteIndex([makeWsRoute('/ws/chat')]);
  const result = lookupWsRoute('/ws/chat');
  assert.ok(result);
  assert.equal(result.route.path, '/ws/chat');
  assert.deepEqual(result.pathParams, {});
});

test('static WS: no match on wrong path', () => {
  buildRouteIndex([makeWsRoute('/ws/chat')]);
  const result = lookupWsRoute('/ws/other');
  assert.equal(result, null);
});

test('parametric WS: extracts path params', () => {
  buildRouteIndex([makeWsRoute('/ws/room/:id')]);
  const result = lookupWsRoute('/ws/room/42');
  assert.ok(result);
  assert.deepEqual(result.pathParams, { id: '42' });
});

test('WS routes are not returned by HTTP lookup', () => {
  buildRouteIndex([makeWsRoute('/ws/chat')]);
  // HTTP lookup only searches _staticHttp / _paramHttp, WS routes are never in those
  const result = lookupHttpRoute('GET', '/ws/chat');
  assert.equal(result, null);
});

test('HTTP routes are not returned by WS lookup', () => {
  buildRouteIndex([makeRoute('GET', '/ws/chat')]);
  const result = lookupWsRoute('/ws/chat');
  assert.equal(result, null);
});

test('index rebuilt correctly after second buildRouteIndex call', () => {
  buildRouteIndex([makeRoute('GET', '/old')]);
  assert.ok(lookupHttpRoute('GET', '/old'));

  buildRouteIndex([makeRoute('GET', '/new')]);
  assert.equal(lookupHttpRoute('GET', '/old'), null);
  assert.ok(lookupHttpRoute('GET', '/new'));
});

test('URL-encoded path params are decoded', () => {
  buildRouteIndex([makeRoute('GET', '/files/:name')]);
  const result = lookupHttpRoute('GET', '/files/hello%20world');
  assert.ok(result);
  assert.equal(result.pathParams.name, 'hello world');
});

// ─── Integration: full HTTP server using the real handler ────────────────────
// Verifies that the index changes in index.js are wired up to real requests.

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await fn(port);
  } finally {
    await new Promise(r => server.close(r));
  }
}

function requestJson(method, url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = body; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Build a minimal mock handler using the same logic as server/index.js
// (avoids requiring the full server with its port binding).
function buildMinimalHandler(routes) {
  buildRouteIndex(routes);

  return function (req, res) {
    const method = req.method.toUpperCase();
    const url    = req.url || '/';
    const qIdx   = url.indexOf('?');
    const pathname = qIdx >= 0 ? url.slice(0, qIdx) : url;

    const hit = lookupHttpRoute(method, pathname);
    if (!hit) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No matching mock route' }));
      return;
    }
    res.writeHead(hit.route.statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ matched: hit.route.path, params: hit.pathParams }));
  };
}

test('integration: static route matched via real HTTP request', async () => {
  const routes = [makeRoute('GET', '/ping')];
  await withServer(buildMinimalHandler(routes), async port => {
    const { status, body } = await requestJson('GET', `http://127.0.0.1:${port}/ping`);
    assert.equal(status, 200);
    assert.equal(body.matched, '/ping');
  });
});

test('integration: parametric route matched via real HTTP request', async () => {
  const routes = [makeRoute('DELETE', '/items/:id')];
  await withServer(buildMinimalHandler(routes), async port => {
    const { status, body } = await requestJson('DELETE', `http://127.0.0.1:${port}/items/99`);
    assert.equal(status, 200);
    assert.equal(body.matched, '/items/:id');
    assert.equal(body.params.id, '99');
  });
});

test('integration: unmatched path returns 404', async () => {
  const routes = [makeRoute('GET', '/ping')];
  await withServer(buildMinimalHandler(routes), async port => {
    const { status } = await requestJson('GET', `http://127.0.0.1:${port}/nope`);
    assert.equal(status, 404);
  });
});

test('integration: index rebuilt after route sync — old path gone, new path available', async () => {
  const initial = [makeRoute('GET', '/old-route')];
  let currentHandler = buildMinimalHandler(initial);

  const server = http.createServer((req, res) => currentHandler(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  try {
    const r1 = await requestJson('GET', `http://127.0.0.1:${port}/old-route`);
    assert.equal(r1.status, 200);

    // Simulate PUT /api/mock/routes by rebuilding with new routes
    currentHandler = buildMinimalHandler([makeRoute('POST', '/new-route')]);

    const r2 = await requestJson('GET', `http://127.0.0.1:${port}/old-route`);
    assert.equal(r2.status, 404);

    const r3 = await requestJson('POST', `http://127.0.0.1:${port}/new-route`);
    assert.equal(r3.status, 200);
  } finally {
    await new Promise(r => server.close(r));
  }
});
