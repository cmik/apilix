'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRpcServer, RpcError, CODES } = require('../src/rpc');
const { makeHarness } = require('./helpers');

function build(extra = {}) {
  return createRpcServer({
    serverInfo: { name: 'test', version: '0.0.1' },
    capabilities: { tools: {} },
    methods: {
      'echo': async (p) => ({ echoed: p }),
      'boom': async () => { throw new Error('secret internal detail'); },
      'bad': async () => { throw new RpcError(CODES.INVALID_PARAMS, 'nope'); },
      'waitShutdown': async (p, ctx) => new Promise((resolve) => {
        ctx.shutdown.addEventListener('abort', () => resolve({ stoppedByShutdown: true }));
        setTimeout(() => resolve({ timedOut: true }), 8000);
      }),
      'slow': async (p, ctx) => new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve({ cancelled: true }));
        setTimeout(() => resolve({ slow: true }), 3000);
      }),
    },
    ...extra,
  });
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } };

test('initialize negotiates the protocol version and returns capabilities', async () => {
  const h = makeHarness(build());
  h.send(INIT);
  const r = await h.next();
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.deepEqual(r.result.serverInfo, { name: 'test', version: '0.0.1' });
  assert.deepEqual(r.result.capabilities, { tools: {} });
  await h.end();
});

test('an unsupported protocolVersion gets the latest supported one', async () => {
  const h = makeHarness(build());
  h.send({ ...INIT, params: { ...INIT.params, protocolVersion: '1999-01-01' } });
  assert.equal((await h.next()).result.protocolVersion, '2025-06-18');
  await h.end();
});

test('older supported protocol versions are echoed back', async () => {
  const h = makeHarness(build());
  h.send({ ...INIT, params: { ...INIT.params, protocolVersion: '2024-11-05' } });
  assert.equal((await h.next()).result.protocolVersion, '2024-11-05');
  await h.end();
});

test('initialize without protocolVersion is -32602; a second initialize is -32600', async () => {
  const h = makeHarness(build());
  h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal((await h.next()).error.code, CODES.INVALID_PARAMS);
  h.send(INIT);
  assert.ok((await h.next()).result);
  h.send({ ...INIT, id: 2 });
  assert.equal((await h.next()).error.code, CODES.INVALID_REQUEST);
  await h.end();
});

test('requests before initialize are refused (except ping)', async () => {
  const h = makeHarness(build());
  h.send({ jsonrpc: '2.0', id: 1, method: 'echo', params: {} });
  const r = await h.next();
  assert.equal(r.error.code, CODES.NOT_INITIALIZED);
  h.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual((await h.next()).result, {});
  await h.end();
});

test('ping, known method, unknown method', async () => {
  const h = makeHarness(build());
  h.send(INIT); await h.next();
  h.send({ jsonrpc: '2.0', id: 'a', method: 'ping' });
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 'a', result: {} });
  h.send({ jsonrpc: '2.0', id: 2, method: 'echo', params: { x: 1 } });
  assert.deepEqual((await h.next()).result, { echoed: { x: 1 } });
  h.send({ jsonrpc: '2.0', id: 3, method: 'does/not/exist' });
  const e = await h.next();
  assert.equal(e.id, 3);
  assert.equal(e.error.code, CODES.METHOD_NOT_FOUND);
  // prototype keys must not resolve to handlers
  h.send({ jsonrpc: '2.0', id: 4, method: 'constructor' });
  assert.equal((await h.next()).error.code, CODES.METHOD_NOT_FOUND);
  h.send({ jsonrpc: '2.0', id: 5, method: '__proto__' });
  assert.equal((await h.next()).error.code, CODES.METHOD_NOT_FOUND);
  await h.end();
});

test('notifications never get a response, even when they are invalid or unknown', async () => {
  const h = makeHarness(build());
  h.send(INIT); await h.next();
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', method: 'echo', params: {} });
  h.send({ jsonrpc: '2.0', method: 'unknown/notification' });
  h.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
  const r = await h.next();
  assert.equal(r.id, 9, 'the only message on the wire is the ping answer');
  assert.equal(h.pendingLines(), 0);
  await h.end();
});

test('handler errors: RpcError keeps its code, other errors are masked as -32603', async () => {
  const logs = [];
  const h = makeHarness(build({ log: (m) => logs.push(m) }));
  h.send(INIT); await h.next();
  h.send({ jsonrpc: '2.0', id: 2, method: 'bad' });
  const bad = await h.next();
  assert.equal(bad.error.code, CODES.INVALID_PARAMS);
  assert.equal(bad.error.message, 'nope');
  h.send({ jsonrpc: '2.0', id: 3, method: 'boom' });
  const boom = await h.next();
  assert.equal(boom.error.code, CODES.INTERNAL_ERROR);
  assert.equal(boom.error.message, 'Internal error');
  assert.ok(!JSON.stringify(boom).includes('secret internal detail'));
  assert.ok(logs.some((l) => l.includes('secret internal detail')), 'details go to the log (stderr) only');
  await h.end();
});

test('malformed input: parse error, invalid request, batch, bad id, non-object', async () => {
  const h = makeHarness(build());
  h.send('{not json');
  let r = await h.next();
  assert.equal(r.error.code, CODES.PARSE_ERROR);
  assert.equal(r.id, null);
  h.send('[]');
  r = await h.next();
  assert.equal(r.error.code, CODES.INVALID_REQUEST);
  h.send('[{"jsonrpc":"2.0","id":1,"method":"ping"}]');
  r = await h.next();
  assert.equal(r.error.code, CODES.INVALID_REQUEST);
  h.send('42');
  assert.equal((await h.next()).error.code, CODES.INVALID_REQUEST);
  h.send('null');
  assert.equal((await h.next()).error.code, CODES.INVALID_REQUEST);
  h.send({ jsonrpc: '1.0', id: 1, method: 'ping' });
  r = await h.next();
  assert.equal(r.error.code, CODES.INVALID_REQUEST);
  assert.equal(r.id, 1);
  h.send({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' });
  assert.equal((await h.next()).error.code, CODES.INVALID_REQUEST);
  h.send({ jsonrpc: '2.0', id: null, method: 'ping' });
  assert.equal((await h.next()).error.code, CODES.INVALID_REQUEST);
  h.send({ jsonrpc: '2.0', id: 3, method: 'ping', params: 'str' });
  assert.equal((await h.next()).error.code, CODES.INVALID_PARAMS);
  h.send({ jsonrpc: '2.0', id: 4, method: 42 });
  assert.equal((await h.next()).error.code, CODES.INVALID_REQUEST);
  // still alive
  h.send({ jsonrpc: '2.0', id: 5, method: 'ping' });
  assert.deepEqual((await h.next()).result, {});
  await h.end();
});

test('client responses and empty lines are ignored; CRLF line endings work', async () => {
  const h = makeHarness(build());
  h.sendRaw('\n\n   \n');
  h.send({ jsonrpc: '2.0', id: 1, result: {} });
  h.sendRaw('{"jsonrpc":"2.0","id":7,"method":"ping"}\r\n');
  const r = await h.next();
  assert.equal(r.id, 7);
  assert.equal(h.pendingLines(), 0);
  await h.end();
});

test('a message split across several chunks (including multi-byte UTF-8) is reassembled', async () => {
  const h = makeHarness(build());
  h.send(INIT); await h.next();
  const payload = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'echo', params: { s: 'héllo €uro 😀' } })}\n`);
  // cut in the middle of a multi-byte sequence
  const cut = payload.indexOf(Buffer.from('€')) + 1;
  h.sendRaw(payload.subarray(0, cut));
  h.sendRaw(payload.subarray(cut));
  assert.deepEqual((await h.next()).result, { echoed: { s: 'héllo €uro 😀' } });
  await h.end();
});

test('oversized line is discarded with -32600 and the server recovers', async () => {
  const h = makeHarness(build({ maxLineBytes: 1024 }));
  h.send(INIT); await h.next();
  h.sendRaw(`${'x'.repeat(5000)}`);
  h.sendRaw(`${'y'.repeat(5000)}\n`);
  const e = await h.next();
  assert.equal(e.error.code, CODES.INVALID_REQUEST);
  assert.equal(e.id, null);
  assert.match(e.error.message, /too large/i);
  h.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.equal((await h.next()).id, 3);
  await h.end();
});

test('a last line without trailing newline is still processed at EOF', async () => {
  const h = makeHarness(build());
  h.sendRaw('{"jsonrpc":"2.0","id":11,"method":"ping"}');
  await h.end();
  assert.equal((await h.next()).id, 11);
});

test('responses are single-line JSON (no raw newline in output)', async () => {
  const h = makeHarness(build());
  h.send(INIT); await h.next();
  h.send({ jsonrpc: '2.0', id: 2, method: 'echo', params: { s: 'a\nb\r\nc d' } });
  const r = await h.next(); // would throw on a split line
  assert.equal(r.result.echoed.s, 'a\nb\r\nc d');
  assert.equal(h.pendingLines(), 0);
  await h.end();
});

test('scrub is applied to results and errors but never to the id', async () => {
  const scrub = (v) => JSON.parse(JSON.stringify(v).replaceAll('SECRET', '<x>'));
  const h = makeHarness(build({ scrub }));
  h.send(INIT); await h.next();
  h.send({ jsonrpc: '2.0', id: 'SECRET', method: 'echo', params: { a: 'my SECRET' } });
  const r = await h.next();
  assert.equal(r.id, 'SECRET');
  assert.equal(r.result.echoed.a, 'my <x>');
  await h.end();
});

test('notifications/cancelled aborts an in-flight request and suppresses its response', async () => {
  const h = makeHarness(build());
  h.send(INIT); await h.next();
  h.send({ jsonrpc: '2.0', id: 20, method: 'slow' });
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 20 } });
  h.send({ jsonrpc: '2.0', id: 21, method: 'ping' });
  const r = await h.next();
  assert.equal(r.id, 21);
  await h.end();
  assert.equal(h.pendingLines(), 0, 'no response for the cancelled request');
});

test('concurrent requests are answered independently', async () => {
  const h = makeHarness(build());
  h.send(INIT); await h.next();
  h.send({ jsonrpc: '2.0', id: 30, method: 'slow' });
  h.send({ jsonrpc: '2.0', id: 31, method: 'ping' });
  const first = await h.next();
  assert.equal(first.id, 31, 'ping is not blocked by a slow request');
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 30 } });
  await h.end();
});

test('EOF aborts long-running operations (shutdown signal) and serve() ends promptly', async () => {
  const h = makeHarness(build());
  h.send(INIT); await h.next();
  h.send({ jsonrpc: '2.0', id: 40, method: 'waitShutdown' });
  await new Promise((r) => setTimeout(r, 100));
  const t0 = Date.now();
  await Promise.race([h.end(), new Promise((_, rej) => setTimeout(() => rej(new Error('serve() did not end after EOF')), 4000))]);
  assert.ok(Date.now() - t0 < 3000, `ended in ${Date.now() - t0} ms`);
  const r = await h.next(1000);
  assert.deepEqual(r.result, { stoppedByShutdown: true }, 'the operation saw the shutdown, its response is still sent');
});

test('stop() ends serve() even though stdin stays open', async () => {
  const server = build();
  const h = makeHarness(server);
  h.send(INIT); await h.next();
  h.send({ jsonrpc: '2.0', id: 41, method: 'waitShutdown' });
  await new Promise((r) => setTimeout(r, 100));
  const t0 = Date.now();
  await server.stop();
  assert.ok(Date.now() - t0 < 3000);
});

test('an error on the output stream (EPIPE) ends the session instead of throwing', async () => {
  const server = build();
  const { PassThrough } = require('node:stream');
  const input = new PassThrough();
  const output = new PassThrough();
  const done = server.serve(input, output);
  input.write(`${JSON.stringify(INIT)}\n`);
  await new Promise((r) => setTimeout(r, 50));
  output.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('serve() did not end')), 3000))]);
});
