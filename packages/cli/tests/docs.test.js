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
