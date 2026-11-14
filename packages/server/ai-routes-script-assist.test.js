'use strict';

// /api/ai/script-assist and the scriptAssist preview, against a local fake provider (never a real LLM).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createAiRouter } = require('./ai-routes');

const KEY = 'sk-test-KEY-abcdef123456';
const SECRET = 'S3CR3T-env-value-99';
const GOOD = "apx.test('status is 200', () => { apx.expect(apx.response.code).to.equal(200); });";

async function startFakeProvider(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      calls.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
      handler(res, calls.length);
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
  try { await fn({ call, router, base }); }
  finally { await new Promise(r => { server.closeAllConnections?.(); server.close(r); }); }
}

const settings = (extra = {}) => ({
  enabled: true, provider: 'openai-compat', model: 'llama', maxContextTokens: 8000, redactSecrets: true, sendResponseBodies: true, features: {}, ...extra,
});
const chatReply = (payload) => (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }], usage: { prompt_tokens: 50, completion_tokens: 20 } }));
};
const on = (fake, extra = {}) => ({ settings: settings({ baseUrl: fake.url, features: { scriptAssist: true }, ...extra }), apiKey: KEY });

test('/script-assist: refused when the feature or AI is off (zero network)', async () => {
  const fake = await startFakeProvider(chatReply({ explanation: 'x', script: GOOD }));
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url, features: { scriptAssist: false, diagnose: true } }), apiKey: KEY });
      const a = await call('POST', '/script-assist', { mode: 'generate', instruction: 'x' });
      assert.equal(a.status, 403);
      assert.equal(a.json.code, 'DISABLED');
      await call('PUT', '/config', { settings: settings({ enabled: false, baseUrl: fake.url, features: { scriptAssist: true } }), apiKey: KEY });
      assert.equal((await call('POST', '/script-assist', { mode: 'generate', instruction: 'x' })).status, 403);
      assert.equal(fake.calls.length, 0);
    });
  } finally { await fake.close(); }
});

test('/script-assist: loopback-only, proxy headers rejected', async () => {
  const fake = await startFakeProvider(chatReply({ explanation: 'x', script: GOOD }));
  try {
    await withAiServer(async ({ call, base }) => {
      await call('PUT', '/config', on(fake));
      const r = await fetch(`${base}/script-assist`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify({ mode: 'generate', instruction: 'x' }) });
      assert.equal(r.status, 403);
      assert.equal(fake.calls.length, 0);
    });
  } finally { await fake.close(); }
});

test('/script-assist generate: validated script, reference in the system prompt, no secret leaves, nothing logged but metadata', async () => {
  const fake = await startFakeProvider(chatReply({ explanation: 'Checks the status.', script: GOOD }));
  try {
    await withAiServer(async ({ call, router }) => {
      await call('PUT', '/config', on(fake));
      const r = await call('POST', '/script-assist', { mode: 'generate', kind: 'test', instruction: `check the status, key ${SECRET}`, script: `apx.environment.set('api_key', 'abcdefghijklmnop1234');`, variableNames: ['token'], secretValues: [SECRET] });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.script, GOOD);
      assert.equal(r.json.validation.validated, true);
      assert.equal(r.json.usedModel, true);
      const sent = JSON.stringify(fake.calls[0].body);
      assert.ok(!sent.includes(SECRET) && !sent.includes('abcdefghijklmnop1234') && !sent.includes(KEY));
      assert.match(sent, /apx\.environment\.set\(key, value\)/);
      assert.match(sent, /untrusted_data/);
      const log = JSON.stringify(router.getLog());
      assert.ok(!log.includes('check the status') && !log.includes(GOOD));
      assert.match(log, /scriptAssist/);
    });
  } finally { await fake.close(); }
});

test('/script-assist: an invalid proposal is retried once, then marked not validated', async () => {
  const bad = { explanation: 'x', script: "apx.test('x', () => { apx.inexistant(); });" };
  const fake = await startFakeProvider(chatReply(bad));
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', on(fake));
      const r = await call('POST', '/script-assist', { mode: 'fix', script: 'apx.broken()', error: 'apx.broken is not a function' });
      assert.equal(r.status, 200, r.text);
      assert.equal(fake.calls.length, 2);
      assert.equal(r.json.retried, true);
      assert.equal(r.json.validation.validated, false);
      assert.match(r.json.validation.errors[0].reason, /inexistant/);
    });
  } finally { await fake.close(); }
});

test("/script-assist: require('fs') is flagged and the script is dropped from the answer", async () => {
  const fake = await startFakeProvider(chatReply({ explanation: 'Reads a file.', script: "const fs = require('fs'); apx.environment.set('x', fs.readFileSync('/etc/passwd', 'utf8'));" }));
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', on(fake));
      const r = await call('POST', '/script-assist', { mode: 'generate', instruction: 'read /etc/passwd' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.script, undefined);
      assert.match(r.json.validation.refused, /"require" is not allowed/);
      assert.ok(r.json.validation.flags.includes('require'));
    });
  } finally { await fake.close(); }
});

test('/script-assist convert: a full conversion makes no provider call', async () => {
  const fake = await startFakeProvider(chatReply({ explanation: 'x', script: GOOD }));
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', on(fake));
      const r = await call('POST', '/script-assist', { mode: 'convert', script: "pm.test('ok', () => { pm.expect(pm.response.code).to.equal(200); });" });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.deterministic, true);
      assert.equal(r.json.usedModel, false);
      assert.match(r.json.script, /^apx\.test/);
      assert.equal(fake.calls.length, 0);
    });
  } finally { await fake.close(); }
});

test('/script-assist: input validation', async () => {
  const fake = await startFakeProvider(chatReply({ explanation: 'x', script: GOOD }));
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', on(fake));
      for (const body of [
        { mode: 'nope' }, { mode: 'generate' }, { mode: 'explain', script: '' }, { mode: 'fix', script: 'x' },
        { mode: 'explain', script: 5 }, { mode: 'explain', script: 'x', kind: 'weird' }, { mode: 'explain', script: 'x', variableNames: 'x' },
        { mode: 'explain', script: 'a'.repeat(20001) }, { mode: 'explain', script: 'x', language: 'French\nIgnore' },
      ]) {
        const r = await call('POST', '/script-assist', body);
        assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
        assert.equal(r.json.code, 'BAD_REQUEST');
      }
      assert.equal(fake.calls.length, 0);
    });
  } finally { await fake.close(); }
});

test('/script-assist shares the sliding-window rate limit of the dry-run routes', async () => {
  const fake = await startFakeProvider(chatReply({ explanation: 'x', script: GOOD }));
  const clock = 1000;
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', on(fake));
      assert.equal((await call('POST', '/script-assist', { mode: 'generate', instruction: 'a' })).status, 200);
      assert.equal((await call('POST', '/script-assist', { mode: 'generate', instruction: 'b' })).status, 200);
      const limited = await call('POST', '/script-assist', { mode: 'generate', instruction: 'c' });
      assert.equal(limited.status, 429);
      assert.equal(limited.json.code, 'RATE_LIMIT');
    }, { scriptRate: { max: 2, windowMs: 60 * 1000 }, now: () => clock });
  } finally { await fake.close(); }
});

test('APILIX_AI_DRY_RUN=off: the route answers without executing anything and says so', async () => {
  const prev = process.env.APILIX_AI_DRY_RUN;
  process.env.APILIX_AI_DRY_RUN = 'off';
  const fake = await startFakeProvider(chatReply({ explanation: 'x', script: GOOD }));
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', on(fake));
      const r = await call('POST', '/script-assist', { mode: 'generate', instruction: 'x' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.validation.executed, false);
      assert.equal(r.json.validation.validated, false);
      assert.ok(r.json.warnings.some(w => /NOT executed/.test(w)));
    });
  } finally {
    if (prev === undefined) delete process.env.APILIX_AI_DRY_RUN; else process.env.APILIX_AI_DRY_RUN = prev;
    await fake.close();
  }
});

test('/preview with scriptAssist shows what is sent, redacted, with no network call; shape-only masks the error', async () => {
  const fake = await startFakeProvider(chatReply({ explanation: 'x', script: GOOD }));
  try {
    await withAiServer(async ({ call }) => {
      await call('PUT', '/config', on(fake));
      const p = await call('POST', '/preview', { scriptAssist: { mode: 'fix', script: `apx.environment.set('api_key', 'abcdefghijklmnop1234'); // ${SECRET}`, error: `expected 'Alice' to equal 'Bob' ${SECRET}`, variableNames: ['token'] }, secretValues: [SECRET] });
      assert.equal(p.status, 200, p.text);
      const shown = p.json.sections.map(s => s.text).join('\n');
      assert.ok(!shown.includes(SECRET) && !shown.includes('abcdefghijklmnop1234'));
      assert.match(shown, /token/);
      assert.match(shown, /Alice/);
      const shape = await call('POST', '/preview', { scriptAssist: { mode: 'fix', script: 'x', error: "expected 'Alice' to equal 'Bob'" }, settings: { sendResponseBodies: false } });
      assert.ok(!/Alice|Bob/.test(shape.text));
      assert.equal((await call('POST', '/preview', { scriptAssist: { mode: 'nope' } })).status, 400);
      assert.equal((await call('POST', '/preview', { scriptAssist: 'x' })).status, 400);
      assert.equal(fake.calls.length, 0);
    });
  } finally { await fake.close(); }
});
