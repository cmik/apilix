'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProvider } = require('../src/provider');
const { startFake, json } = require('./helpers');

const KEY = 'sk-ant-test-KEY-123456';
const toolReply = (input) => ({ content: [{ type: 'tool_use', name: 'respond', input }], usage: { input_tokens: 10, output_tokens: 5 } });
const cfg = (fake, extra = {}) => ({ kind: 'anthropic', baseUrl: fake.url, model: 'm', apiKey: KEY, ...extra });
const req = { system: 'sys', messages: [{ role: 'user', content: 'hi' }], schema: 'connectionTest' };

test('valid structured output via forced tool use', async () => {
  const fake = await startFake((_c, res) => json(res, 200, toolReply({ ok: true })));
  try {
    const r = await createProvider(cfg(fake)).complete(req);
    assert.deepEqual(r.data, { ok: true });
    assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5 });
    assert.equal(r.retries, 0);
    const c = fake.calls[0];
    assert.equal(c.url, '/v1/messages');
    assert.equal(c.headers['x-api-key'], KEY);
    assert.ok(c.headers['anthropic-version']);
    assert.deepEqual(c.body.tool_choice, { type: 'tool', name: 'connectionTest' });
    assert.equal(c.body.tools[0].name, 'connectionTest');
    assert.equal(c.body.system, 'sys');
  } finally { await fake.close(); }
});

test('invalid output then retry succeeds', async () => {
  const fake = await startFake((_c, res, n) => json(res, 200, toolReply(n === 1 ? { ok: 'nope' } : { ok: true })));
  try {
    const r = await createProvider(cfg(fake)).complete(req);
    assert.equal(r.retries, 1);
    assert.equal(fake.calls.length, 2);
    const last = fake.calls[1].body.messages;
    assert.equal(last[last.length - 1].role, 'user');
    assert.match(last[last.length - 1].content, /invalid/);
  } finally { await fake.close(); }
});

test('invalid twice → INVALID_OUTPUT (422)', async () => {
  const fake = await startFake((_c, res) => json(res, 200, toolReply({ ok: 'nope' })));
  try {
    await assert.rejects(createProvider(cfg(fake)).complete(req), e => e.code === 'INVALID_OUTPUT' && e.status === 422);
    assert.equal(fake.calls.length, 2);
  } finally { await fake.close(); }
});

test('401 → AUTH, 429 → RATE_LIMIT, 500 → NETWORK', async () => {
  for (const [status, code] of [[401, 'AUTH'], [429, 'RATE_LIMIT'], [500, 'NETWORK']]) {
    const fake = await startFake((_c, res) => json(res, status, { error: { message: 'nope' } }));
    try {
      await assert.rejects(createProvider(cfg(fake)).complete(req), e => e.code === code);
    } finally { await fake.close(); }
  }
});

test('timeout → TIMEOUT', async () => {
  const fake = await startFake(() => { /* never answer */ });
  try {
    await assert.rejects(createProvider(cfg(fake, { timeoutMs: 80 })).complete(req), e => e.code === 'TIMEOUT');
  } finally { await fake.close(); }
});

test('AbortController → ABORTED', async () => {
  const fake = await startFake(() => { /* never answer */ });
  try {
    const ac = new AbortController();
    const p = createProvider(cfg(fake)).complete({ ...req, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p, e => e.code === 'ABORTED');
  } finally { await fake.close(); }
});

test('the API key never appears in error messages', async () => {
  const fake = await startFake((_c, res) => json(res, 400, { error: { message: `bad key ${KEY}` } }));
  try {
    await assert.rejects(createProvider(cfg(fake)).complete(req), e => {
      assert.ok(!e.message.includes(KEY));
      assert.ok(!String(e.stack).includes(KEY));
      assert.ok(!JSON.stringify(e).includes(KEY));
      return true;
    });
  } finally { await fake.close(); }
});

test('connection refused → NETWORK; missing provider/model → NO_PROVIDER', async () => {
  await assert.rejects(createProvider({ kind: 'anthropic', baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: KEY }).complete(req), e => e.code === 'NETWORK');
  assert.throws(() => createProvider({}), e => e.code === 'NO_PROVIDER');
  assert.throws(() => createProvider({ kind: 'anthropic' }), e => e.code === 'NO_PROVIDER');
});

test('plain text completion without schema', async () => {
  const fake = await startFake((_c, res) => json(res, 200, { content: [{ type: 'text', text: 'hello' }], usage: {} }));
  try {
    const r = await createProvider(cfg(fake)).complete({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.data, 'hello');
    assert.equal(fake.calls[0].body.tools, undefined);
  } finally { await fake.close(); }
});
