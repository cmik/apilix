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

test('hard timeout: a run that ignores the stop is abandoned (partial result), the lock is released and the session flagged degraded', async () => {
  const api = await startFakeApi();
  const session = exec.createSession();
  const logs = [];
  const ctx = { opts: { maxRequests: 100, maxRunSeconds: 3600, requestTimeoutMs: 1000, sslVerification: false }, session, log: (m) => logs.push(m) };
  const real = core.executePreparedCollectionRun;
  core.executePreparedCollectionRun = () => new Promise(() => {}); // never settles, ignores runState
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
  await api.close();
});

test('msUsed is accounted even when the run fails with an exception', async () => {
  const api = await startFakeApi();
  const session = exec.createSession();
  const ctx = { opts: { maxRequests: 100, maxRunSeconds: 3600, requestTimeoutMs: 1000, sslVerification: false }, session, log() {} };
  const real = core.executePreparedCollectionRun;
  core.executePreparedCollectionRun = async () => { await new Promise((r) => setTimeout(r, 120)); throw new Error('engine exploded'); };
  try {
    await assert.rejects(exec.runTree(ctx, job(api)), /engine exploded/);
    assert.ok(session.msUsed >= 100, `msUsed=${session.msUsed}`);
  } finally { core.executePreparedCollectionRun = real; }
  await api.close();
});

test('socket tracker destroys in-flight sockets and hooks can be removed in any order', async () => {
  const { trackSockets, installHostGuard } = require('../src/host-guard');
  const original = net.Socket.prototype.connect;
  const server = net.createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const guard = installHostGuard(['127.0.0.1']);
  const tracker = trackSockets();
  const sock = net.connect(server.address().port, '127.0.0.1');
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
  server.close();
});
