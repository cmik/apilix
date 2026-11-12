'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const { installHostGuard, isAllowed, parsePattern } = require('../src/host-guard');

test('pattern matching: exact, wildcard (subdomains only), port, IPv6, trailing dot, case', () => {
  const p = ['api.example.com', '*.corp.io', 'localhost:8080', '[::1]:9000', '127.0.0.1'].map(parsePattern);
  assert.ok(isAllowed(p, 'API.example.com', 80));
  assert.ok(isAllowed(p, 'api.example.com.', 80));
  assert.ok(!isAllowed(p, 'evil-api.example.com', 80));
  assert.ok(!isAllowed(p, 'api.example.com.evil.io', 80));
  assert.ok(isAllowed(p, 'a.b.corp.io', 443));
  assert.ok(!isAllowed(p, 'corp.io', 443), 'wildcard does not match the bare domain');
  assert.ok(!isAllowed(p, 'notcorp.io', 443));
  assert.ok(isAllowed(p, 'localhost', 8080));
  assert.ok(!isAllowed(p, 'localhost', 8081));
  assert.ok(isAllowed(p, '::1', 9000));
  assert.ok(!isAllowed(p, '::1', 1));
  assert.ok(isAllowed(p, '127.0.0.1', 1234));
  assert.ok(!isAllowed(p, '127.0.0.2', 1234));
  assert.ok(!isAllowed(p, '', 80));
});

test('socket guard blocks forbidden hosts and IPC, passes allowed ones, and uninstalls cleanly', async () => {
  const server = http.createServer((req, res) => res.end('hi'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const original = net.Socket.prototype.connect;
  const guard = installHostGuard(['127.0.0.1']);
  try {
    const ok = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
    });
    assert.equal(ok, 200);
    const err = await new Promise((resolve) => {
      http.get({ host: 'localhost', port, agent: false }, () => resolve(null)).on('error', resolve);
    });
    assert.equal(err.code, 'EAPILIXHOSTDENIED');
    const ipc = await new Promise((resolve) => {
      net.connect('/tmp/does-not-matter.sock').on('error', resolve);
    });
    assert.equal(ipc.code, 'EAPILIXHOSTDENIED');
    const portForm = await new Promise((resolve) => {
      net.connect(port, 'localhost').on('error', resolve);
    });
    assert.equal(portForm.code, 'EAPILIXHOSTDENIED');
    assert.deepEqual(guard.denied.slice(0, 2), ['localhost', 'local socket']);
  } finally {
    guard.uninstall();
    server.close();
  }
  assert.equal(net.Socket.prototype.connect, original);
});
