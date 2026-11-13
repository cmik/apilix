'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { startServer } = require('./client');
const { makeTmp, writeJson } = require('./fixtures');
const { KEY, CERT } = require('./tls-fixture');

async function setup(flags, requestSettings) {
  let hits = 0;
  const server = https.createServer({ key: KEY, cert: CERT }, (req, res) => { hits += 1; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"secure":true}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = makeTmp();
  writeJson(dir, 'c.json', { info: { name: 'TLS' }, item: [{ name: 'Get', id: 'g', request: { method: 'GET', url: `https://127.0.0.1:${server.address().port}/x`, ...(requestSettings ? { requestSettings } : {}) } }] });
  const s = startServer(['--workspace', dir, '--allow-host', '127.0.0.1', ...flags]);
  await s.initialize();
  return { s, hits: () => hits, done: async () => { await s.close(); server.closeAllConnections(); server.close(); } };
}

test('TLS verification is off by default (like the CLI) and on with --ssl-verification', async () => {
  const off = await setup([]);
  try {
    const r = await off.s.call('run_request', { collection: 'c.json', request: 'Get' });
    assert.equal(r.data.result.status, 200, r.text);
    assert.equal(off.hits(), 1);
  } finally { await off.done(); }
  const on = await setup(['--ssl-verification']);
  try {
    const r = await on.s.call('run_request', { collection: 'c.json', request: 'Get' });
    assert.ok(r.data.result.error, 'the self-signed certificate is rejected');
    assert.match(r.data.result.error, /self.signed|certificate|SSL|CERT/i);
    assert.equal(on.hits(), 0, 'no request reached the handler');
  } finally { await on.done(); }
});

test('a collection cannot turn verification off (sslVerification:false is ignored) but may turn it on', async () => {
  const forcedOff = await setup(['--ssl-verification'], { sslVerification: false });
  try {
    const r = await forcedOff.s.call('run_request', { collection: 'c.json', request: 'Get' });
    assert.ok(r.data.result.error, 'still verified');
    assert.equal(forcedOff.hits(), 0);
  } finally { await forcedOff.done(); }
  const stricter = await setup([], { sslVerification: true });
  try {
    const r = await stricter.s.call('run_request', { collection: 'c.json', request: 'Get' });
    assert.ok(r.data.result.error, 'a stricter per-request setting is honoured');
  } finally { await stricter.done(); }
});
