'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createAiRouter, loopbackOnly, validateSettings } = require('./ai-routes');

const KEY = 'sk-test-KEY-abcdef123456';

/** Fake OpenAI-compatible provider. `handler(call, res)`; calls are recorded. */
async function startFakeProvider(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const call = { url: req.url, headers: req.headers, aborted: false, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') };
      calls.push(call);
      res.on('close', () => { if (!res.writableEnded) call.aborted = true; });
      handler(call, res);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
  };
}

const okReply = (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
};

/** Mount the AI router on an ephemeral app. */
async function withAiServer(opts, fn) {
  const errors = [];
  const router = createAiRouter({ logger: { error: (...a) => errors.push(a.join(' ')) }, ...opts });
  const app = express();
  app.use('/api/ai', router);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/ai`;
  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: r.status, json, text };
  };
  try { await fn({ call, router, errors, base }); }
  finally { await new Promise(r => { server.closeAllConnections?.(); server.close(r); }); }
}

const settings = (extra = {}) => ({
  enabled: true,
  provider: 'openai-compat',
  model: 'llama',
  maxContextTokens: 8000,
  redactSecrets: true,
  sendResponseBodies: true,
  features: {},
  ...extra,
});

test('loopbackOnly rejects non-loopback addresses and accepts loopback ones', () => {
  const run = (addr) => {
    let status = 200; let nexted = false;
    const res = { status(c) { status = c; return this; }, json() { return this; } };
    loopbackOnly({ socket: { remoteAddress: addr } }, res, () => { nexted = true; });
    return { status, nexted };
  };
  assert.deepEqual(run('10.0.0.5'), { status: 403, nexted: false });
  assert.deepEqual(run('192.168.1.2'), { status: 403, nexted: false });
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.deepEqual(run(a), { status: 200, nexted: true });
});

test('loopbackOnly rejects loopback requests carrying reverse-proxy headers', () => {
  for (const h of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'via', 'x-forwarded-host']) {
    let status = 200; let nexted = false;
    const res = { status(c) { status = c; return this; }, json() { return this; } };
    loopbackOnly({ socket: { remoteAddress: '127.0.0.1' }, headers: { [h]: '203.0.113.9' } }, res, () => { nexted = true; });
    assert.deepEqual({ status, nexted }, { status: 403, nexted: false }, h);
  }
});

test('PUT /config validates settings (bad provider, non-http baseUrl, bad limits)', async () => {
  await withAiServer({}, async ({ call }) => {
    assert.equal((await call('PUT', '/config', { settings: settings({ provider: 'nope' }) })).status, 400);
    assert.equal((await call('PUT', '/config', { settings: settings({ baseUrl: 'file:///etc/passwd' }) })).status, 400);
    assert.equal((await call('PUT', '/config', { settings: settings({ baseUrl: 'javascript:alert(1)' }) })).status, 400);
    assert.equal((await call('PUT', '/config', { settings: settings({ maxContextTokens: 5 }) })).status, 400);
    assert.equal((await call('PUT', '/config', { settings: settings({ enabled: 'yes' }) })).status, 400);
    assert.equal((await call('PUT', '/config', { settings: settings(), apiKey: 42 })).status, 400);
    assert.equal((await call('PUT', '/config', {})).status, 400);
    const ok = await call('PUT', '/config', { settings: settings(), apiKey: KEY });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true, hasKey: true });
    assert.ok(!ok.text.includes(KEY));
  });
  assert.equal(validateSettings(settings({ features: { nlGenerate: true, bogus: true } })).settings.features.bogus, undefined);
});

test('invalid JSON body → 400', async () => {
  await withAiServer({}, async ({ base }) => {
    const r = await fetch(`${base}/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'BAD_REQUEST');
  });
});

test('/test with enabled:false never contacts the provider (zero network)', async () => {
  const fake = await startFakeProvider(okReply);
  try {
    await withAiServer({}, async ({ call }) => {
      // no config at all
      assert.equal((await call('POST', '/test')).json.code, 'DISABLED');
      // config present but disabled
      await call('PUT', '/config', { settings: settings({ enabled: false, baseUrl: fake.url }), apiKey: KEY });
      const r = await call('POST', '/test');
      assert.equal(r.status, 403);
      assert.equal(r.json.code, 'DISABLED');
    });
    assert.equal(fake.calls.length, 0);
  } finally { await fake.close(); }
});

test('/test succeeds against a fake OpenAI-compatible provider', async () => {
  const fake = await startFakeProvider((_c, res) => okReply(res));
  try {
    await withAiServer({}, async ({ call }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url }), apiKey: KEY });
      const r = await call('POST', '/test');
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.model, 'llama');
      assert.equal(typeof r.json.latencyMs, 'number');
      assert.equal(fake.calls[0].headers.authorization, `Bearer ${KEY}`);
    });
  } finally { await fake.close(); }
});

test('provider errors map to AUTH / RATE_LIMIT', async () => {
  for (const [status, code] of [[401, 'AUTH'], [429, 'RATE_LIMIT']]) {
    const fake = await startFakeProvider((_c, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'x' } })); });
    try {
      await withAiServer({}, async ({ call }) => {
        await call('PUT', '/config', { settings: settings({ baseUrl: fake.url }), apiKey: KEY });
        const r = await call('POST', '/test');
        assert.equal(r.status, status);
        assert.equal(r.json.code, code);
      });
    } finally { await fake.close(); }
  }
});

test('anthropic provider without a key → NO_PROVIDER', async () => {
  await withAiServer({}, async ({ call }) => {
    await call('PUT', '/config', { settings: settings({ provider: 'anthropic', model: 'm' }) });
    const r = await call('POST', '/test');
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'NO_PROVIDER');
  });
});

test('a second concurrent request gets 429 while the first is running', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const fake = await startFakeProvider((_c, res) => { gate.then(() => okReply(res)); });
  try {
    await withAiServer({}, async ({ call }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url }), apiKey: KEY });
      const first = call('POST', '/test');
      while (fake.calls.length === 0) await new Promise(r => setTimeout(r, 10));
      const second = await call('POST', '/test');
      assert.equal(second.status, 429);
      assert.equal(second.json.code, 'RATE_LIMIT');
      release();
      assert.equal((await first).status, 200);
      // lock released afterwards
      assert.equal((await call('POST', '/test')).status, 200);
    });
  } finally { await fake.close(); }
});

test('closing the client connection aborts the provider request', async () => {
  const fake = await startFakeProvider(() => { /* never answer */ });
  try {
    await withAiServer({}, async ({ call, base }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url }), apiKey: KEY });
      const ac = new AbortController();
      const p = fetch(`${base}/test`, { method: 'POST', signal: ac.signal }).catch(() => {});
      while (fake.calls.length === 0) await new Promise(r => setTimeout(r, 10));
      ac.abort();
      await p;
      for (let i = 0; i < 100 && !fake.calls[0].aborted; i++) await new Promise(r => setTimeout(r, 20));
      assert.equal(fake.calls[0].aborted, true);
    });
  } finally { await fake.close(); }
});

test('/preview redacts secrets and makes no outbound request', async () => {
  const fake = await startFakeProvider(okReply);
  try {
    await withAiServer({}, async ({ call }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url }), apiKey: KEY });
      const r = await call('POST', '/preview', {
        item: {
          name: 'x',
          request: {
            method: 'POST',
            url: 'https://api.test/x?api_key=AKIA999999',
            header: [{ key: 'Cookie', value: 'sid=cookie-secret-1' }],
            body: { mode: 'raw', raw: '{"a":{"password":"nested-pw-123"}}' },
          },
          event: [{ listen: 'prerequest', script: { exec: ["apx.environment.set('token', 'script-tok-123');"] } }],
        },
        response: { status: 200, headers: {}, body: '{"echo":"env-secret-value-1"}' },
        secretValues: ['env-secret-value-1'],
        variables: [{ name: 'baseUrl', scope: 'env' }],
      });
      assert.equal(r.status, 200);
      for (const leak of ['AKIA999999', 'cookie-secret-1', 'nested-pw-123', 'script-tok-123', 'env-secret-value-1', KEY]) {
        assert.ok(!r.text.includes(leak), `leaked ${leak}`);
      }
      assert.ok(r.json.estimatedTokens > 0);
      assert.ok(r.json.redactions >= 4);
      assert.ok(r.json.sections.length >= 3);
    });
    assert.equal(fake.calls.length, 0);
  } finally { await fake.close(); }
});

test('/preview works without any config and rejects malformed input', async () => {
  await withAiServer({}, async ({ call }) => {
    assert.equal((await call('POST', '/preview', { item: { request: { method: 'GET', url: 'x' } } })).status, 200);
    assert.equal((await call('POST', '/preview', { item: 'nope' })).status, 400);
    assert.equal((await call('POST', '/preview', { secretValues: 'nope' })).status, 400);
  });
});

test('bodies over 2 MB → 413 TOO_LARGE', async () => {
  await withAiServer({}, async ({ call }) => {
    const r = await call('POST', '/preview', { item: { request: { method: 'POST', url: 'x', body: { mode: 'raw', raw: 'x'.repeat(2.5 * 1024 * 1024) } } } });
    assert.equal(r.status, 413);
    assert.equal(r.json.code, 'TOO_LARGE');
  });
});

test('changing provider/baseUrl without a new key drops the stored key; same destination keeps it', async () => {
  await withAiServer({}, async ({ call, router }) => {
    await call('PUT', '/config', { settings: settings({ baseUrl: 'http://127.0.0.1:1' }), apiKey: KEY });
    assert.equal(router.hasKey(), true);
    assert.equal((await call('PUT', '/config', { settings: settings({ baseUrl: 'http://127.0.0.1:1', model: 'other' }) })).json.hasKey, true);
    assert.equal((await call('PUT', '/config', { settings: settings({ baseUrl: 'http://evil.example' }) })).json.hasKey, false);
    assert.equal(router.hasKey(), false);
    await call('PUT', '/config', { settings: settings(), apiKey: KEY });
    assert.equal((await call('PUT', '/config', { settings: settings(), apiKey: null })).json.hasKey, false);
  });
});

test('DELETE /config clears config and key', async () => {
  const fake = await startFakeProvider(okReply);
  try {
    await withAiServer({}, async ({ call, router }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url }), apiKey: KEY });
      assert.equal((await call('DELETE', '/config')).status, 200);
      assert.equal(router.hasKey(), false);
      assert.equal((await call('POST', '/test')).json.code, 'DISABLED');
    });
  } finally { await fake.close(); }
});

test('the API key never reaches ai-log.jsonl, the logger, or any response', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apilix-ai-'));
  const fake = await startFakeProvider((call, res) => {
    // Misbehaving provider that echoes the key back in its error.
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `invalid key ${KEY}` } }));
  });
  try {
    await withAiServer({ dataDir }, async ({ call, errors, router }) => {
      const put = await call('PUT', '/config', { settings: settings({ baseUrl: fake.url }), apiKey: KEY });
      const t = await call('POST', '/test');
      const bodies = [put.text, t.text, JSON.stringify(router.getLog()), errors.join('\n')];
      for (const b of bodies) assert.ok(!b.includes(KEY));
      const logFile = path.join(dataDir, 'ai-log.jsonl');
      const content = fs.readFileSync(logFile, 'utf8');
      assert.ok(content.includes('"ok":false'));
      assert.ok(!content.includes(KEY));
      const line = JSON.parse(content.trim().split('\n')[0]);
      assert.deepEqual(Object.keys(line).sort(), ['code', 'feature', 'model', 'ok', 'ts']);
    });
  } finally {
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a successful call logs tokens and latency only (no prompt or reply content)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apilix-ai-'));
  const fake = await startFakeProvider((_c, res) => okReply(res));
  try {
    await withAiServer({ dataDir }, async ({ call }) => {
      await call('PUT', '/config', { settings: settings({ baseUrl: fake.url }), apiKey: KEY });
      await call('POST', '/test');
      const line = JSON.parse(fs.readFileSync(path.join(dataDir, 'ai-log.jsonl'), 'utf8').trim());
      assert.equal(line.feature, 'test');
      assert.equal(line.ok, true);
      assert.equal(line.inputTokens, 4);
      assert.equal(line.outputTokens, 2);
      assert.deepEqual(Object.keys(line).sort(), ['feature', 'inputTokens', 'latencyMs', 'model', 'ok', 'outputTokens', 'ts']);
    });
  } finally {
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('isAiPath is case-insensitive and exact on the segment', () => {
  const { isAiPath } = require('./ai-routes');
  for (const p of ['/api/ai', '/api/ai/preview', '/API/AI/preview', '/Api/Ai/test']) assert.equal(isAiPath(p), true, p);
  for (const p of ['/api/aix', '/api/airline/x', '/api/execute', '/x/api/ai']) assert.equal(isAiPath(p), false, p);
});

test('mixed-case path still hits the 2 MB cap when the global parser skips isAiPath routes', async () => {
  const { isAiPath } = require('./ai-routes');
  const big = express.json({ limit: '50mb' });
  const app = express();
  app.use((req, res, next) => (isAiPath(req.path) ? next() : big(req, res, next)));
  app.use('/api/ai', createAiRouter({ logger: { error() {} } }));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const body = JSON.stringify({ pad: 'x'.repeat(3 * 1024 * 1024) });
    for (const p of ['/api/ai/preview', '/API/AI/preview']) {
      const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.equal(r.status, 413, p);
    }
  } finally { await new Promise(r => { server.closeAllConnections?.(); server.close(r); }); }
});
