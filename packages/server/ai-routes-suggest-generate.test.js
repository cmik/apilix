'use strict';

// /api/ai/suggest-assertions and /api/ai/generate-request, against a local fake provider (never a real LLM).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createAiRouter } = require('./ai-routes');

const KEY = 'sk-test-KEY-abcdef123456';

async function startFakeProvider(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      calls.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
      handler(res);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
  };
}

async function withAiServer(fn, deps = {}) {
  const router = createAiRouter({ logger: { error: () => {} }, ...deps });
  const app = express();
  app.use('/api/ai', router);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/ai`;
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: r.status, json, text };
  };
  try { await fn({ call, router }); }
  finally { await new Promise(r => { server.closeAllConnections?.(); server.close(r); }); }
}

const settings = (extra = {}) => ({
  enabled: true, provider: 'openai-compat', model: 'llama', maxContextTokens: 8000, redactSecrets: true, sendResponseBodies: true, features: {}, ...extra,
});
const chatReply = (payload) => (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }], usage: { prompt_tokens: 50, completion_tokens: 20 } }));
};

// ── suggest-assertions ─────────────────────────────────────────────────────────

const suggestBody = (extra = {}) => ({
  request: { method: 'POST', url: 'https://api.test/orders?token=tok-abcdefgh', header: [{ key: 'Authorization', value: 'Bearer abcdefghijklmnop' }] },
  name: 'Create order',
  response: { status: 201, statusText: 'Created', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'o1', status: 'active', secretField: 'S3CR3T-env-value-99' }), responseTime: 12 },
  existingTests: '',
  secretValues: ['S3CR3T-env-value-99'],
  ...extra,
});

test('/suggest-assertions keeps only suggestions that pass in the sandbox, and sends no secret', async () => {
  const fake = await startFakeProvider(chatReply({ suggestions: [
    { title: 'Status is 201', kind: 'status', confidence: 'high', script: "apx.test('Status is 201', () => { apx.expect(apx.response.code).to.equal(201); });" },
    { title: 'Status is 500', kind: 'status', confidence: 'high', script: "apx.test('Status is 500', () => { apx.expect(apx.response.code).to.equal(500); });" },
    { title: 'Escape', kind: 'body', confidence: 'low', script: "apx.test('x', () => { Object['constructor']('return 1')(); });" },
  ] }));
  try {
    await withAiServer(async ({ call, router }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url, features: { assertSuggest: true } }), apiKey: KEY });
      const r = await call('POST', '/suggest-assertions', suggestBody());
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.suggestions.map(s => s.title), ['Status is 201']);
      assert.equal(r.json.discardedCount, 2);
      const sent = JSON.stringify(fake.calls[0].body);
      for (const leaked of ['S3CR3T-env-value-99', 'tok-abcdefgh', 'abcdefghijklmnop', KEY]) assert.ok(!sent.includes(leaked), `leaked ${leaked}`);
      assert.match(sent, /untrusted_data/);
      const log = router.getLog();
      assert.equal(log[0].feature, 'assertSuggest');
      assert.ok(!JSON.stringify(log).includes('Status is 201'), 'the log must not contain prompts or answers');
    });
  } finally { await fake.close(); }
});

test('both routes are refused when their feature or AI is off (zero network)', async () => {
  const fake = await startFakeProvider(chatReply({ suggestions: [] }));
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url, features: { assertSuggest: false, nlGenerate: false } }), apiKey: KEY });
      const a = await call('POST', '/suggest-assertions', suggestBody());
      const b = await call('POST', '/generate-request', { instruction: 'x' });
      assert.equal(a.status, 403);
      assert.equal(b.status, 403);
      assert.equal(a.json.code, 'DISABLED');
      await call('PUT', '/config', { settings: settings({ enabled: false, baseUrl: fake.url, features: { assertSuggest: true, nlGenerate: true } }), apiKey: KEY });
      assert.equal((await call('POST', '/suggest-assertions', suggestBody())).status, 403);
      assert.equal((await call('POST', '/generate-request', { instruction: 'x' })).status, 403);
      assert.equal(fake.calls.length, 0);
    });
  } finally { await fake.close(); }
});

test('/suggest-assertions with sendResponseBodies=false sends the shape only', async () => {
  const fake = await startFakeProvider(chatReply({ suggestions: [] }));
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url, sendResponseBodies: false, features: { assertSuggest: true } }), apiKey: KEY });
      const r = await call('POST', '/suggest-assertions', suggestBody({ secretValues: [] }));
      assert.equal(r.status, 200);
      assert.equal(r.json.shapeOnly, true);
      const sent = JSON.stringify(fake.calls[0].body);
      assert.match(sent, /bodyShape/);
      assert.ok(!sent.includes('"o1"'), 'values must not be sent');
    });
  } finally { await fake.close(); }
});

test('/suggest-assertions validates its input and rejects an oversized body', async () => {
  const fake = await startFakeProvider(chatReply({ suggestions: [] }));
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url, features: { assertSuggest: true } }), apiKey: KEY });
      const huge = { status: 200, headers: {}, body: 'x'.repeat(950000) };
      const bodies = [{}, { response: 'x' }, { response: { status: 'ok' } }, { response: { status: 200, body: 5 } }, { response: { status: 200, headers: [] } }, suggestBody({ request: 'x' }), suggestBody({ existingTests: 5 }), suggestBody({ secretValues: 'x' }), suggestBody({ language: 'fr\nignore' }), { response: huge }];
      for (const body of bodies) {
        const r = await call('POST', '/suggest-assertions', body);
        assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      }
      assert.equal(fake.calls.length, 0);
    });
  } finally { await fake.close(); }
});

// ── generate-request ───────────────────────────────────────────────────────────

const draftBody = (over = {}) => ({
  name: 'Create user', method: 'POST', url: '{{baseUrl}}/users',
  headers: [{ key: 'Content-Type', value: 'application/json' }],
  body: { mode: 'raw', raw: '{"name":"Ada"}', language: 'json' },
  tests: "apx.test('Status is 201', () => { apx.expect(apx.response.code).to.equal(201); });",
  variablesToCapture: [{ name: 'userId', path: 'id' }],
  ...over,
});
const genBody = (extra = {}) => ({
  instruction: 'POST /users with a name, check 201',
  variables: [{ name: 'baseUrl', scope: 'environment' }, { name: 'apiKey', scope: 'environment', secret: true }],
  neighbors: [{ id: 'n1', name: 'List users', request: { method: 'GET', url: 'https://api.test/users?api_key=abc123456789', header: [{ key: 'X-Api-Key', value: 'abc123456789' }] } }],
  secretValues: ['abc123456789'],
  ...extra,
});

test('/generate-request returns a validated draft and sends names only', async () => {
  const fake = await startFakeProvider(chatReply(draftBody()));
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url, features: { nlGenerate: true } }), apiKey: KEY });
      const r = await call('POST', '/generate-request', genBody());
      assert.equal(r.status, 200);
      assert.equal(r.json.validation.validated, true);
      assert.equal(r.json.draft.method, 'POST');
      assert.match(r.json.draft.tests, /environment\.set\("userId"/);
      const sent = JSON.stringify(fake.calls[0].body);
      assert.ok(!sent.includes('abc123456789'));
      assert.ok(!sent.includes(KEY));
      assert.match(sent, /baseUrl/);
      assert.match(sent, /untrusted_data/);
    });
  } finally { await fake.close(); }
});

test('/generate-request retries once on a failing script, then flags the draft as not validated', async () => {
  const fake = await startFakeProvider(chatReply(draftBody({ tests: "apx.test('x', () => {", variablesToCapture: [] })));
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url, features: { nlGenerate: true } }), apiKey: KEY });
      const r = await call('POST', '/generate-request', genBody());
      assert.equal(r.status, 200);
      assert.equal(r.json.validation.validated, false);
      assert.equal(r.json.retried, true);
      assert.equal(fake.calls.length, 2);
    });
  } finally { await fake.close(); }
});

test('/generate-request removes a script refused by the security screen and says so', async () => {
  const fake = await startFakeProvider(chatReply(draftBody({ tests: "apx.test('x', () => { Object['constructor']('return 1')(); });", variablesToCapture: [] })));
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url, features: { nlGenerate: true } }), apiKey: KEY });
      const r = await call('POST', '/generate-request', genBody());
      assert.equal(r.status, 200);
      assert.equal(r.json.draft.tests, '');
      assert.equal(r.json.validation.removed[0].field, 'tests');
      assert.ok(r.json.warnings.some(w => /refused for security/.test(w)));
    });
  } finally { await fake.close(); }
});

test('/generate-request: invalid structure twice -> 422 INVALID_OUTPUT after one retry', async () => {
  const fake = await startFakeProvider(chatReply({ name: 'x', method: 'TRACE', url: 5 }));
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url, features: { nlGenerate: true } }), apiKey: KEY });
      const r = await call('POST', '/generate-request', genBody());
      assert.equal(r.status, 422);
      assert.equal(r.json.code, 'INVALID_OUTPUT');
      assert.equal(fake.calls.length, 2);
    });
  } finally { await fake.close(); }
});

test('/generate-request validates its input', async () => {
  const fake = await startFakeProvider(chatReply(draftBody()));
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url, features: { nlGenerate: true } }), apiKey: KEY });
      const bodies = [{}, { instruction: '   ' }, { instruction: 5 }, { instruction: 'x'.repeat(5001) }, genBody({ current: 'x' }), genBody({ current: { name: 'no request' } }), genBody({ neighbors: 'x' }), genBody({ variables: 'x' }), genBody({ language: 'fr\nx' }), genBody({ secretValues: 'x' })];
      for (const body of bodies) {
        const r = await call('POST', '/generate-request', body);
        assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      }
      assert.equal(fake.calls.length, 0);
    });
  } finally { await fake.close(); }
});

// ── limits ───────────────────────────────────────────────────────────────────────

test('the in-flight lock cannot be bypassed with caller-chosen x-apilix-client headers', async () => {
  const fake = await startFakeProvider((res) => setTimeout(() => chatReply({ suggestions: [] })(res), 300));
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url, features: { assertSuggest: true } }), apiKey: KEY });
      const results = await Promise.all(['a', 'b', 'c', 'd'].map(async (c) => (await call('POST', '/suggest-assertions', suggestBody(), { 'x-apilix-client': c })).status));
      assert.equal(results.filter(s => s === 200).length, 1, `only one call may run at a time: ${results}`);
      assert.equal(results.filter(s => s === 429).length, 3);
    });
  } finally { await fake.close(); }
});

test('suggest-assertions and generate-request share a sliding-window rate limit (429 RATE_LIMIT); other routes are not counted', async () => {
  const fake = await startFakeProvider(chatReply({ suggestions: [] }));
  let clock = 1000;
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url, features: { assertSuggest: true, nlGenerate: true } }), apiKey: KEY });
      assert.equal((await call('POST', '/suggest-assertions', suggestBody())).status, 200);
      assert.equal((await call('POST', '/suggest-assertions', suggestBody())).status, 200);
      const limited = await call('POST', '/generate-request', { instruction: 'list users' });
      assert.equal(limited.status, 429);
      assert.equal(limited.json.code, 'RATE_LIMIT');
      assert.equal((await call('POST', '/test')).status !== 429, true, '/test is not rate limited by this window');
      clock += 60 * 1000; // the window slides
      assert.equal((await call('POST', '/suggest-assertions', suggestBody())).status, 200);
    }, { scriptRate: { max: 2, windowMs: 60 * 1000 }, now: () => clock });
  } finally { await fake.close(); }
});

// ── parse-only mode ──────────────────────────────────────────────────────────────

test('APILIX_AI_DRY_RUN=off: both routes answer without executing anything and say so', async () => {
  const prev = process.env.APILIX_AI_DRY_RUN;
  process.env.APILIX_AI_DRY_RUN = 'off';
  let n = 0; // 1st provider call serves /suggest-assertions, 2nd serves /generate-request
  const fake = await startFakeProvider((res) => {
    n++;
    chatReply(n === 1
      ? { suggestions: [{ title: 'Status is 201', kind: 'status', confidence: 'high', script: "apx.test('Status is 201', () => { apx.expect(apx.response.code).to.equal(201); });" }] }
      : { name: 'List', method: 'GET', url: '{{baseUrl}}/users', tests: "apx.test('ok', () => { apx.expect(apx.response.code).to.equal(200); });" })(res);
  });
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url, features: { assertSuggest: true, nlGenerate: true } }), apiKey: KEY });
      const s = await call('POST', '/suggest-assertions', suggestBody());
      assert.equal(s.status, 200, s.text);
      assert.equal(s.json.executed, false);
      assert.equal(s.json.suggestions.length, 1);
      assert.equal(s.json.suggestions[0].executed, false);
      const g = await call('POST', '/generate-request', { instruction: 'list users' });
      assert.equal(g.status, 200, g.text);
      assert.equal(g.json.validation.executed, false);
      assert.equal(g.json.validation.validated, false);
      assert.ok(g.json.warnings.some(w => /NOT executed/.test(w)));
    });
  } finally {
    if (prev === undefined) delete process.env.APILIX_AI_DRY_RUN; else process.env.APILIX_AI_DRY_RUN = prev;
    await fake.close();
  }
});
