'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRedactor, REDACTED } = require('../src/redact');
const { SECRET_TOKEN, ENV_SECRET, LITERAL_AUTH, PASSWORD, collectionFixture, environmentFixture } = require('./fixtures');

function make(opts) {
  const r = createRedactor(opts);
  r.addEnvironment(environmentFixture('http://x').values);
  r.addCollection(collectionFixture());
  return r;
}

test('secret values are scrubbed in raw, url-encoded and base64 forms', () => {
  const r = make();
  const b64 = Buffer.from(ENV_SECRET).toString('base64');
  const out = r.scrub(`a ${ENV_SECRET} b ${encodeURIComponent(ENV_SECRET + ' x')} c ${b64}`);
  assert.ok(!out.includes(ENV_SECRET));
  assert.ok(!out.includes(b64));
  assert.ok(out.includes(REDACTED));
});

test('env vars with sensitive names and literal collection auth are secrets too', () => {
  const r = make();
  for (const s of [SECRET_TOKEN, LITERAL_AUTH, ENV_SECRET]) assert.ok(!r.scrub(`x ${s} y`).includes(s), s);
  assert.equal(r.scrub('visible-value'), 'visible-value');
});

test('variable references are never treated as secrets', () => {
  const r = createRedactor();
  r.addEnvironment([{ key: 'token', value: '{{other}}' }]);
  assert.equal(r.secretCount(), 0);
});

test('scrubDeep reaches nested strings and keys but leaves numbers/booleans', () => {
  const r = make();
  const out = r.scrubDeep({ [ENV_SECRET]: [1, true, null, { a: `v=${ENV_SECRET}` }] });
  assert.ok(!JSON.stringify(out).includes(ENV_SECRET));
  assert.deepEqual(Object.values(out)[0].slice(0, 3), [1, true, null]);
});

test('structural redaction: URL userinfo/query, headers, JSON bodies', () => {
  const r = make();
  assert.ok(!r.url('https://u:hunter2pw@h.test/p?api_key=abcdef&x=1').includes('hunter2pw'));
  assert.ok(r.url('https://h.test/p?x=1&api_key=abcdef').includes('x=1'));
  assert.equal(r.header('Authorization', 'Bearer abc'), REDACTED);
  assert.equal(r.header('X-Trace', 'abc'), 'abc');
  const body = r.body('{"user":"bob","password":"hunter2pw"}');
  assert.ok(!body.includes('hunter2pw'));
  assert.ok(body.includes('bob'));
  const hs = r.headers({ 'Set-Cookie': 'sid=1', Location: 'https://h.test/cb?token=zzzzzz', 'X-Ok': 'fine' });
  assert.equal(hs['Set-Cookie'], REDACTED);
  assert.ok(!hs.Location.includes('zzzzzz'));
  assert.equal(hs['X-Ok'], 'fine');
});

test('--include-credentials lifts structural redaction and soft secrets, but flagged secrets stay hidden', () => {
  const r = make({ includeCredentials: true });
  assert.equal(r.header('Authorization', 'Bearer abc'), 'Bearer abc');
  assert.ok(r.scrub(`x ${SECRET_TOKEN}`).includes(SECRET_TOKEN), 'soft secrets visible when requested');
  assert.ok(!r.scrub(`x ${ENV_SECRET}`).includes(ENV_SECRET), 'secret-flagged env values are never returned');
});

test('clip adds an explicit truncation marker', () => {
  const r = createRedactor();
  assert.match(r.text('x'.repeat(50), 10), /^x{10}\.\.\.\[truncated 40 chars\]$/);
});
