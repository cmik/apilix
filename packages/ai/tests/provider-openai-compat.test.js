'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProvider } = require('../src/provider');
const { chatUrl, parseJsonLoose } = require('../src/providers/openai-compat');
const { startFake, json } = require('./helpers');

const chat = (content) => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
const cfg = (fake, extra = {}) => ({ kind: 'openai-compat', baseUrl: fake.url, model: 'llama', apiKey: 'k-123456', ...extra });
const req = { system: 'sys', messages: [{ role: 'user', content: 'hi' }], schema: 'connectionTest' };

test('sends json_schema response_format and parses the content', async () => {
  const fake = await startFake((_c, res) => json(res, 200, chat('{"ok":true}')));
  try {
    const r = await createProvider(cfg(fake)).complete(req);
    assert.deepEqual(r.data, { ok: true });
    assert.deepEqual(r.usage, { inputTokens: 7, outputTokens: 3 });
    const c = fake.calls[0];
    assert.equal(c.url, '/v1/chat/completions');
    assert.equal(c.body.response_format.type, 'json_schema');
    assert.equal(c.body.response_format.json_schema.name, 'connectionTest');
    assert.equal(c.body.messages[0].role, 'system');
    assert.equal(c.headers.authorization, 'Bearer k-123456');
  } finally { await fake.close(); }
});

test('falls back to a prompt-described schema when response_format is rejected (400)', async () => {
  const fake = await startFake((c, res) => (c.body.response_format
    ? json(res, 400, { error: { message: 'response_format unsupported' } })
    : json(res, 200, chat('```json\n{"ok":true}\n```'))));
  try {
    const r = await createProvider(cfg(fake)).complete(req);
    assert.deepEqual(r.data, { ok: true });
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[1].body.response_format, undefined);
    assert.match(fake.calls[1].body.messages[0].content, /JSON schema/);
  } finally { await fake.close(); }
});

test('base URL with or without /v1 resolves to a single /v1', () => {
  assert.equal(chatUrl('http://localhost:11434'), 'http://localhost:11434/v1/chat/completions');
  assert.equal(chatUrl('http://localhost:11434/'), 'http://localhost:11434/v1/chat/completions');
  assert.equal(chatUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1/chat/completions');
  assert.equal(chatUrl(undefined), 'https://api.openai.com/v1/chat/completions');
});

test('empty key → no Authorization header (Ollama)', async () => {
  const fake = await startFake((_c, res) => json(res, 200, chat('{"ok":true}')));
  try {
    await createProvider(cfg(fake, { apiKey: '' })).complete(req);
    assert.equal(fake.calls[0].headers.authorization, undefined);
  } finally { await fake.close(); }
});

test('non-JSON content triggers one retry then INVALID_OUTPUT', async () => {
  const fake = await startFake((_c, res) => json(res, 200, chat('I think it works!')));
  try {
    await assert.rejects(createProvider(cfg(fake)).complete(req), e => e.code === 'INVALID_OUTPUT');
    assert.equal(fake.calls.length, 2);
  } finally { await fake.close(); }
});

test('401 → AUTH; key not leaked', async () => {
  const fake = await startFake((_c, res) => json(res, 401, { error: { message: 'bad key k-123456' } }));
  try {
    await assert.rejects(createProvider(cfg(fake)).complete(req), e => e.code === 'AUTH' && !JSON.stringify(e).includes('k-123456') && !String(e.stack).includes('k-123456'));
  } finally { await fake.close(); }
});

test('parseJsonLoose strips fences and rejects garbage', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(parseJsonLoose('nope'), undefined);
  assert.equal(parseJsonLoose(undefined), undefined);
});

test('307 redirect to another host is not followed (no credential replay)', async () => {
  const other = await startFake((_c, res) => json(res, 200, { choices: [{ message: { content: '{"ok":true}' } }] }));
  const fake = await startFake((_c, res) => { res.writeHead(307, { location: `${other.url}/v1/chat/completions` }); res.end(); });
  try {
    await assert.rejects(
      createProvider({ kind: 'openai-compat', baseUrl: fake.url, model: 'm', apiKey: 'sk-secret-123456' })
        .complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], schema: 'connectionTest' }),
      e => e.code === 'NETWORK',
    );
    assert.equal(other.calls.length, 0);
  } finally { await fake.close(); await other.close(); }
});

test('output-limit parameter: max_completion_tokens only for the default OpenAI endpoint', () => {
  const { usesCompletionTokens } = require('../src/providers/openai-compat');
  assert.equal(usesCompletionTokens(undefined), true);
  assert.equal(usesCompletionTokens('https://api.openai.com/v1'), true);
  assert.equal(usesCompletionTokens('http://localhost:11434/v1'), false);
  assert.equal(usesCompletionTokens('http://127.0.0.1:1234'), false);
});

test('default endpoint sends max_completion_tokens (injected transport, no network)', async () => {
  const seen = [];
  const axiosInstance = { post: async (url, body) => { seen.push({ url, body }); return { data: chat('{"ok":true}') }; } };
  const r = await createProvider({ kind: 'openai-compat', model: 'gpt-x', apiKey: 'k' }, { axiosInstance }).complete(req);
  assert.deepEqual(r.data, { ok: true });
  assert.equal(seen[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(seen[0].body.max_completion_tokens, 1024);
  assert.equal('max_tokens' in seen[0].body, false);
});

test('local server keeps max_tokens', async () => {
  const fake = await startFake((_c, res) => json(res, 200, chat('{"ok":true}')));
  try {
    await createProvider(cfg(fake, { model: 'local-keeps' })).complete(req);
    assert.equal(fake.calls[0].body.max_tokens, 1024);
    assert.equal('max_completion_tokens' in fake.calls[0].body, false);
  } finally { await fake.close(); }
});

test('local server rejecting max_tokens → retries once with max_completion_tokens and remembers', async () => {
  const fake = await startFake((c, res) => ('max_tokens' in c.body
    ? json(res, 400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } })
    : json(res, 200, chat('{"ok":true}'))));
  try {
    const p = createProvider(cfg(fake, { model: 'local-swaps' }));
    const r = await p.complete(req);
    assert.deepEqual(r.data, { ok: true });
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[1].body.max_completion_tokens, 1024);
    await p.complete(req);
    assert.equal(fake.calls.length, 3, 'next call goes straight to the accepted parameter');
    assert.equal('max_tokens' in fake.calls[2].body, false);
  } finally { await fake.close(); }
});

test('default endpoint rejecting max_completion_tokens → retries with max_tokens', async () => {
  const seen = [];
  const axiosInstance = {
    post: async (_u, body) => {
      seen.push(body);
      if ('max_completion_tokens' in body) {
        const err = new Error('bad'); err.response = { status: 400, data: { error: { message: 'Unrecognized request argument supplied: max_completion_tokens' } } };
        throw err;
      }
      return { data: chat('{"ok":true}') };
    },
  };
  const r = await createProvider({ kind: 'openai-compat', model: 'azure-old', apiKey: 'k' }, { axiosInstance }).complete(req);
  assert.deepEqual(r.data, { ok: true });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].max_tokens, 1024);
});

test('unrelated 400 is not retried with another token parameter', async () => {
  const fake = await startFake((_c, res) => json(res, 400, { error: { message: 'model not found' } }));
  try {
    await assert.rejects(createProvider(cfg(fake, { model: 'local-nf' })).complete({ ...req, schema: undefined }));
    assert.equal(fake.calls.length, 1);
  } finally { await fake.close(); }
});
