'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

const { runCli, usage } = require('../src/index');
const { generateCurl } = require('../src/docs-curl');

function sink() {
  let text = '';
  const stream = new Writable({ write(chunk, enc, cb) { text += chunk.toString(); cb(); } });
  return { stream, get text() { return text; } };
}

async function run(argv, cwd) {
  const out = sink();
  const err = sink();
  const code = await runCli(argv, { cwd, stdout: out.stream, stderr: err.stream });
  return { code, stdout: out.text, stderr: err.text };
}

const collection = {
  info: { name: 'CLI Demo', schema: 'x' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: 'TOP-SECRET-TOKEN' }] },
  item: [
    { name: 'Group', item: [
      { name: 'Hello', request: { method: 'GET', url: '{{base}}/hello?name=x', header: [{ key: 'X-A', value: '1' }] } },
    ] },
    { name: 'Other', request: { method: 'POST', url: 'https://o.test/x', body: { mode: 'raw', raw: '{"a":1}' } } },
  ],
};
const environment = {
  name: 'e',
  values: [
    { key: 'base', value: 'https://api.test', enabled: true },
    { key: 'hidden', value: 'ENV-SECRET', enabled: true, secret: true },
  ],
};

async function fixtures() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apilix-docs-'));
  await fs.writeFile(path.join(dir, 'c.json'), JSON.stringify(collection));
  await fs.writeFile(path.join(dir, 'e.json'), JSON.stringify(environment));
  return dir;
}

test('docs: html to stdout, credentials redacted', async () => {
  const dir = await fixtures();
  const r = await run(['docs', 'c.json'], dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^<!DOCTYPE html>/);
  assert.match(r.stdout, /Content-Security-Policy/);
  assert.ok(!r.stdout.includes('TOP-SECRET-TOKEN'));
});

test('docs: markdown with curl snippets', async () => {
  const dir = await fixtures();
  const r = await run(['docs', 'c.json', '--format', 'md', '--snippets', 'curl'], dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^# CLI Demo/);
  assert.match(r.stdout, /curl -X 'GET'/);
  assert.match(r.stdout, /Authorization: Bearer <redacted>/);
  assert.ok(!r.stdout.includes('TOP-SECRET-TOKEN'));
});

test('docs: openapi yaml to --out file and folder scope', async () => {
  const dir = await fixtures();
  const r = await run(['docs', 'c.json', '--format', 'openapi', '--openapi-format', 'yaml', '--folder', 'Group', '--out', 'out/spec.yaml'], dir);
  assert.equal(r.code, 0);
  const text = await fs.readFile(path.join(dir, 'out', 'spec.yaml'), 'utf8');
  assert.match(text, /^openapi: "3\.0\.3"/);
  assert.match(text, /\/hello/);
  assert.ok(!text.includes('/x:'), 'folder scope excludes other requests');
});

test('docs: openapi json 3.1', async () => {
  const dir = await fixtures();
  const r = await run(['docs', 'c.json', '--format', 'openapi', '--openapi-version', '3.1.0'], dir);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).openapi, '3.1.0');
});

test('docs: --resolve-variables substitutes non-secret env values only', async () => {
  const dir = await fixtures();
  const r = await run(['docs', 'c.json', '--format', 'md', '-e', 'e.json', '--resolve-variables'], dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /https:\/\/api\.test\/hello/);
  assert.ok(!r.stdout.includes('ENV-SECRET'));
});

test('docs: --include-credentials keeps literals', async () => {
  const dir = await fixtures();
  const r = await run(['docs', 'c.json', '--format', 'md', '--include-credentials'], dir);
  assert.match(r.stdout, /TOP-SECRET-TOKEN/);
});

test('docs: usage errors exit 2', async () => {
  const dir = await fixtures();
  const cases = [
    ['docs'],
    ['docs', 'missing.json'],
    ['docs', 'c.json', '--format', 'pdf'],
    ['docs', 'c.json', '--openapi-format', 'xml'],
    ['docs', 'c.json', '--snippets', 'python'],
    ['docs', 'c.json', '--resolve-variables'],
    ['docs', 'c.json', '--folder', 'Nope'],
    ['docs', 'c.json', '--theme', 'purple'],
  ];
  for (const argv of cases) {
    const r = await run(argv, dir);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.stderr, /Error:/);
  }
});

test('docs: usage() documents the docs command', () => {
  assert.match(usage(), /apilix docs <collection-file>/);
  assert.match(usage(), /--include-credentials/);
});

test('generateCurl quotes single quotes and uses redacted auth', () => {
  const out = generateCurl({
    method: 'POST', fullUrl: "https://x.test/a?q=it's", headers: [{ key: 'X-A', value: "o'k" }],
    auth: { type: 'bearer', fields: [{ key: 'token', value: '<redacted>' }] },
    body: { mode: 'raw', raw: '{"a":1}' },
  });
  assert.match(out, /Bearer <redacted>/);
  assert.match(out, /'https:\/\/x\.test\/a\?q=it'\\''s'/);
  assert.match(out, /--data-raw '\{"a":1\}'/);
});

test('docs: --out pointing at the collection or environment file is refused (exit 2) and input is untouched', async () => {
  const dir = await fixtures();
  const before = await fs.readFile(path.join(dir, 'c.json'), 'utf8');
  const envBefore = await fs.readFile(path.join(dir, 'e.json'), 'utf8');
  for (const argv of [
    ['docs', 'c.json', '--out', 'c.json'],
    ['docs', 'c.json', '--out', './sub/../c.json'],
    ['docs', 'c.json', '--out', path.join(dir, 'c.json')],
    ['docs', 'c.json', '-e', 'e.json', '--out', 'e.json'],
  ]) {
    const r = await run(argv, dir);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.stderr, /refusing to overwrite/);
  }
  assert.equal(await fs.readFile(path.join(dir, 'c.json'), 'utf8'), before);
  assert.equal(await fs.readFile(path.join(dir, 'e.json'), 'utf8'), envBefore);
  // a symlink to the collection is also the same file
  await fs.symlink(path.join(dir, 'c.json'), path.join(dir, 'link.json'));
  const r = await run(['docs', 'c.json', '--out', 'link.json'], dir);
  assert.equal(r.code, 2);
  assert.equal(await fs.readFile(path.join(dir, 'c.json'), 'utf8'), before);
});

test('generateCurl shell-quotes the method', () => {
  const out = generateCurl({ method: 'GET; echo injected', fullUrl: 'https://x.test/', headers: [] });
  assert.ok(out.startsWith("curl -X 'GET; echo injected'"));
});

test('docs: --no-images renders images as links and blocks image loading; default keeps images', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apilix-docs-img-'));
  const col = JSON.parse(JSON.stringify(collection));
  col.item[1].request.description = 'x ![logo](https://img.test/a.png) <img src="https://img.test/b.png" alt="bee">';
  await fs.writeFile(path.join(dir, 'c.json'), JSON.stringify(col));
  const on = await run(['docs', 'c.json'], dir);
  assert.equal(on.code, 0);
  assert.match(on.stdout, /<img src="https:\/\/img\.test\/a\.png" alt="logo">/);
  assert.match(on.stdout, /img-src data: https: http:/);
  const off = await run(['docs', 'c.json', '--no-images'], dir);
  assert.equal(off.code, 0);
  assert.ok(!/<img\b/.test(off.stdout));
  assert.match(off.stdout, /img-src 'none'/);
  assert.match(off.stdout, /<a href="https:\/\/img\.test\/a\.png"[^>]*>logo<\/a>/);
  assert.match(off.stdout, /<a href="https:\/\/img\.test\/b\.png"[^>]*>bee<\/a>/);
  const md = await run(['docs', 'c.json', '--format', 'md', '--no-images'], dir);
  assert.equal(md.code, 0);
  assert.match(md.stdout, /!\[logo\]\(https:\/\/img\.test\/a\.png\)/);
  assert.match(usage(), /--no-images/);
});

// ── --ai-describe ───────────────────────────────────────────────────────────────

const http = require('node:http');

async function fakeLlm(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      calls.push({ url: req.url, headers: req.headers, body });
      handler(body, res);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, calls, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}

const llmReply = (items) => (_body, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }], usage: { prompt_tokens: 20, completion_tokens: 8 } }));
};

async function runAi(argv, cwd, env) {
  const out = sink();
  const err = sink();
  const code = await runCli(argv, { cwd, stdout: out.stream, stderr: err.stream, env });
  return { code, stdout: out.text, stderr: err.text };
}

test('docs --ai-describe: fills gaps, marks them, and sends no credentials or secret values', async () => {
  const dir = await fixtures();
  const fake = await fakeLlm(llmReply([{ id: 'item-1', description: 'Says hello.', params: [{ name: 'name', description: 'Who to greet.' }] }]));
  try {
    const r = await runAi(['docs', 'c.json', '--format', 'md', '-e', 'e.json', '--ai-describe', '--ai-language', 'French'], dir, {
      APILIX_AI_PROVIDER: 'openai-compat', APILIX_AI_MODEL: 'm', APILIX_AI_BASE_URL: fake.url,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Says hello\./);
    assert.match(r.stdout, /Description generated by AI/);
    assert.match(r.stdout, /Who to greet\. _\(AI\)_/);
    assert.equal(fake.calls.length, 1);
    const sent = JSON.stringify(fake.calls[0].body);
    assert.ok(!sent.includes('TOP-SECRET-TOKEN') && !sent.includes('ENV-SECRET'));
    assert.match(sent, /French/);
    assert.match(r.stderr, /AI: 1 description generated/);
  } finally { await fake.close(); }
});

test('docs --ai-describe --no-ai-mark: no AI markers in the output', async () => {
  const dir = await fixtures();
  const fake = await fakeLlm(llmReply([{ id: 'item-1', description: 'Says hello.' }]));
  try {
    const r = await runAi(['docs', 'c.json', '--format', 'md', '--ai-describe', '--no-ai-mark'], dir, {
      APILIX_AI_PROVIDER: 'openai-compat', APILIX_AI_MODEL: 'm', APILIX_AI_BASE_URL: fake.url,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Says hello\./);
    assert.doesNotMatch(r.stdout, /generated by AI|\(AI\)/);
  } finally { await fake.close(); }
});

test('docs --ai-describe: an AI failure is a warning and the docs are still produced', async () => {
  const dir = await fixtures();
  const fake = await fakeLlm((_b, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad key"}}'); });
  try {
    const r = await runAi(['docs', 'c.json', '--format', 'md', '--ai-describe'], dir, {
      APILIX_AI_PROVIDER: 'openai-compat', APILIX_AI_MODEL: 'm', APILIX_AI_API_KEY: 'sk-secret-xyz', APILIX_AI_BASE_URL: fake.url,
    });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /# CLI Demo/);
    assert.match(r.stderr, /Warning: AI descriptions skipped/);
    assert.ok(!r.stderr.includes('sk-secret-xyz'));
  } finally { await fake.close(); }
});

test('docs --ai-describe: incomplete configuration is a usage error (exit 2, nothing written)', async () => {
  const dir = await fixtures();
  for (const env of [{}, { APILIX_AI_MODEL: 'm' }, { APILIX_AI_PROVIDER: 'nope', APILIX_AI_MODEL: 'm' }, { APILIX_AI_PROVIDER: 'openai-compat', APILIX_AI_MODEL: 'm', APILIX_AI_BASE_URL: 'ftp://x' }]) {
    const r = await runAi(['docs', 'c.json', '--ai-describe'], dir, env);
    assert.equal(r.code, 2, JSON.stringify(env));
    assert.equal(r.stdout, '');
  }
});

test('docs without --ai-describe never contacts an AI provider', async () => {
  const dir = await fixtures();
  const fake = await fakeLlm(llmReply([]));
  try {
    const r = await runAi(['docs', 'c.json', '--format', 'md'], dir, { APILIX_AI_PROVIDER: 'openai-compat', APILIX_AI_MODEL: 'm', APILIX_AI_BASE_URL: fake.url });
    assert.equal(r.code, 0);
    assert.equal(fake.calls.length, 0);
    assert.doesNotMatch(r.stdout, /generated by AI/);
  } finally { await fake.close(); }
});
