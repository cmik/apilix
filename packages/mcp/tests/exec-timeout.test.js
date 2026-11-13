'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const core = require('@apilix/core');
const exec = require('../src/exec');
const { startFakeApi } = require('./fake-server');

function job(api, extra = {}) {
  return {
    collection: { info: { name: 'T' }, item: [{ name: 'P', id: 'p', request: { method: 'GET', url: `${api.base}/ping` } }] },
    requestCount: 1, iterations: 1, environment: {}, variables: {}, dataRows: null, timeoutMs: 1000, delayMs: 0, bail: false,
    ...extra,
  };
}

/** Start a fake API that is closed (sockets included) even when an assertion fails. */
async function api4(t) {
  const api = await startFakeApi();
  t.after(() => api.close());
  return api;
}

test('hard timeout: a run that ignores the stop is abandoned (partial result), the lock is released and the session flagged degraded', async (t) => {
  const api = await api4(t);
  const session = exec.createSession();
  const logs = [];
  const ctx = { opts: { maxRequests: 100, maxRunSeconds: 3600, requestTimeoutMs: 1000, sslVerification: false }, session, log: (m) => logs.push(m) };
  const real = core.executePreparedCollectionRun;
  core.executePreparedCollectionRun = () => new Promise(() => {}); // never settles, ignores runState
  t.after(() => { core.executePreparedCollectionRun = real; });
  try {
    const t0 = Date.now();
    const out = await exec.runTree(ctx, job(api));
    assert.ok(Date.now() - t0 < 8000, `bounded (took ${Date.now() - t0} ms)`);
    assert.equal(out.timedOut, true);
    assert.equal(session.degraded, true);
    assert.ok(out.errors.some((e) => /abandoned/.test(e)));
    assert.ok(logs.some((l) => /degraded/.test(l)));
    assert.ok(session.msUsed >= 1000, 'time spent is accounted');
  } finally {
    core.executePreparedCollectionRun = real;
  }
  // the lock was released: a following run executes normally
  const next = await exec.runTree(ctx, job(api));
  assert.equal(next.results.length, 1);
  assert.equal(next.results[0].status, 200);
});

test('msUsed is accounted even when the run fails with an exception', async (t) => {
  const api = await api4(t);
  const session = exec.createSession();
  const ctx = { opts: { maxRequests: 100, maxRunSeconds: 3600, requestTimeoutMs: 1000, sslVerification: false }, session, log() {} };
  const real = core.executePreparedCollectionRun;
  core.executePreparedCollectionRun = async () => { await new Promise((r) => setTimeout(r, 120)); throw new Error('engine exploded'); };
  t.after(() => { core.executePreparedCollectionRun = real; });
  try {
    await assert.rejects(exec.runTree(ctx, job(api)), /engine exploded/);
    assert.ok(session.msUsed >= 100, `msUsed=${session.msUsed}`);
  } finally { core.executePreparedCollectionRun = real; }
});

test('socket tracker destroys in-flight sockets and hooks can be removed in any order', async (t) => {
  const { trackSockets, installHostGuard } = require('../src/host-guard');
  const original = net.Socket.prototype.connect;
  const server = net.createServer((c) => { c.on('error', () => {}); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const guard = installHostGuard(['127.0.0.1']);
  const tracker = trackSockets();
  const sock = net.connect(server.address().port, '127.0.0.1');
  t.after(() => { sock.destroy(); tracker.stop(); guard.uninstall(); server.close(); });
  await new Promise((r) => sock.once('connect', r));
  assert.equal(tracker.size, 1);
  const closed = new Promise((r) => sock.once('close', r));
  sock.on('error', () => {});
  tracker.destroyAll();
  await closed;
  guard.uninstall(); // removed BEFORE the tracker although installed first
  assert.notEqual(net.Socket.prototype.connect, original, 'tracker still hooked');
  const err = await new Promise((resolve) => { net.connect(server.address().port, '127.0.0.1').on('connect', function () { this.destroy(); resolve(null); }).on('error', resolve); });
  assert.equal(err, null, 'guard is gone: the connection is allowed');
  tracker.stop();
  assert.equal(net.Socket.prototype.connect, original, 'original restored once the last hook is removed');
});

test('a REAL request that never gets an answer keeps the run alive past the hard timeout: it is abandoned, flagged degraded, the lock is released', async (t) => {
  const api = await api4(t);
  const session = exec.createSession();
  const logs = [];
  const ctx = { opts: { maxRequests: 100, maxRunSeconds: 3600, requestTimeoutMs: 1000, sslVerification: false }, session, log: (m) => logs.push(m) };
  // a test script that keeps issuing requests to an endpoint that never answers: closing the sockets of the
  // run once is not enough to make it finish (each new request opens a fresh, tracked-then-forgotten socket)
  const script = `var t0 = Date.now(); function again() { if (Date.now() - t0 < 7000) apx.sendRequest("${api.base}/hang", again); } again();`;
  const stuck = job(api, {
    collection: { info: { name: 'T' }, item: [{ name: 'P', id: 'p', request: { method: 'GET', url: `${api.base}/ping` }, event: [{ listen: 'test', script: { exec: [script] } }] }] },
  });
  const real = core.executePreparedCollectionRun;
  let underlying; // the real run (called through, not stubbed), awaited at the end so nothing outlives the test
  core.executePreparedCollectionRun = (...a) => { underlying = real(...a); return underlying; };
  t.after(async () => { core.executePreparedCollectionRun = real; if (underlying) await Promise.race([underlying.catch(() => {}), new Promise((r) => setTimeout(r, 20000))]); });
  const t0 = Date.now();
  const out = await exec.runTree(ctx, stuck);
  assert.ok(Date.now() - t0 < 12000, `bounded (took ${Date.now() - t0} ms)`);
  assert.ok(api.hits['/hang'] >= 1, 'the blocked request really reached the server');
  assert.equal(out.timedOut, true);
  assert.equal(session.degraded, true);
  assert.ok(out.errors.some((e) => /abandoned/.test(e)), JSON.stringify(out.errors));
  assert.ok(logs.some((l) => /degraded/.test(l)));
  // the lock was released: the next run is not stuck behind the abandoned one
  core.executePreparedCollectionRun = real;
  const next = await exec.runTree(ctx, job(api));
  assert.equal(next.results[0].status, 200);
});

test('M16: an exhausted run-time budget is a clean refusal and nothing is sent', async (t) => {
  const api = await api4(t);
  const session = exec.createSession();
  session.msUsed = 20000;
  const ctx = { opts: { maxRequests: 100, maxRunSeconds: 20, requestTimeoutMs: 1000, sslVerification: false }, session, log() {} };
  await assert.rejects(exec.runTree(ctx, job(api)), (e) => e.expected === true && /run-time budget exhausted/.test(e.message));
  assert.equal(api.hits['/ping'] || 0, 0);
  session.msUsed = 19999; // one ms left: still allowed (the budget is not exhausted)
  const out = await exec.runTree(ctx, job(api));
  assert.equal(out.results.length, 1);
});

test('M17: the remaining run-time budget bounds the timeout handed to the engine', async (t) => {
  const api = await api4(t);
  const session = exec.createSession();
  session.msUsed = 15000;
  const ctx = { opts: { maxRequests: 100, maxRunSeconds: 20, requestTimeoutMs: 60000, sslVerification: false }, session, log() {} };
  const seen = [];
  const real = core.setExecutorConfig;
  core.setExecutorConfig = (c) => { seen.push(c.requestTimeout); return real(c); };
  t.after(() => { core.setExecutorConfig = real; });
  await exec.runTree(ctx, job(api, { timeoutMs: 50000 }));
  assert.deepEqual(seen, [5000], 'bounded to the 5 s that remain, not to the 50 s asked for');
  // never below the 1 s floor, even with less than a second left (documented overshoot)
  session.msUsed = 19500;
  seen.length = 0;
  await exec.runTree(ctx, job(api, { timeoutMs: 50000 }));
  assert.deepEqual(seen, [1000]);
});
