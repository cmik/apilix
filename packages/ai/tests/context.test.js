'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPreviewContext, buildShapeSchema } = require('../src/context');

const item = {
  name: 'Login',
  request: {
    method: 'POST',
    url: 'https://api.test/login?api_key=AKIA999999',
    header: [{ key: 'Authorization', value: 'Bearer abc.def.ghi' }],
    body: { mode: 'raw', raw: '{"email":"a@b.c","password":"hunter2pw"}' },
  },
  event: [{ listen: 'test', script: { exec: ["apx.environment.set('token', 'lit-token-12345');", 'apx.test("ok", () => {});'] } }],
};
const response = {
  status: 200,
  statusText: 'OK',
  headers: { 'Set-Cookie': 'sid=abcdef12345' },
  body: JSON.stringify({ user: { id: 7, name: 'Bob', access_token: 'tok-secret-1' }, items: [1, 2, 3, 4, 5, 6, 7, 8] }),
};

test('preview is redacted and lists sections', () => {
  const r = buildPreviewContext({ item, response, secretValues: ['Bob-the-secret'], variablesMeta: [{ name: 'baseUrl', scope: 'env' }, { name: 'apiPass', scope: 'env', secret: true }] });
  const all = r.sections.map(s => s.text).join('\n');
  for (const leak of ['AKIA999999', 'abc.def.ghi', 'hunter2pw', 'lit-token-12345', 'sid=abcdef12345', 'tok-secret-1']) {
    assert.ok(!all.includes(leak), `leaked ${leak}`);
  }
  assert.ok(r.sections.some(s => s.label === 'Request'));
  assert.ok(r.sections.some(s => s.label === 'Test script'));
  assert.ok(r.sections.some(s => s.label === 'Response body'));
  assert.ok(all.includes('baseUrl'));
  assert.ok(all.includes('apiPass (secret, value never sent)'));
  assert.ok(r.redactions >= 5);
  assert.ok(r.estimatedTokens > 0);
});

test('response arrays are truncated', () => {
  const r = buildPreviewContext({ response });
  const body = r.sections.find(s => s.label === 'Response body');
  assert.equal(body.truncated, true);
});

test('sendResponseBodies:false emits only the shape, no values', () => {
  const r = buildPreviewContext({ response, settings: { sendResponseBodies: false } });
  const body = r.sections.find(s => s.label === 'Response body (shape only)');
  assert.ok(body);
  assert.ok(!r.sections.some(s => s.label === 'Response body'));
  assert.ok(!body.text.includes('Bob'));
  assert.ok(!/"id": 7/.test(body.text));
  assert.match(body.text, /"id": "number"/);
  assert.match(body.text, /"name": "string"/);
});

test('non-JSON bodies in shape mode report type and length only', () => {
  const r = buildPreviewContext({ response: { status: 200, body: 'plain text body' }, settings: { sendResponseBodies: false } });
  const body = r.sections.find(s => s.label === 'Response body (shape only)');
  assert.ok(!body.text.includes('plain text'));
  assert.match(body.text, /"length": 15/);
});

test('a small budget truncates sections', () => {
  const big = { status: 200, body: 'x'.repeat(5000) };
  const r = buildPreviewContext({ response: big, settings: { maxContextTokens: 100 } });
  assert.ok(r.sections.some(s => s.truncated));
});

test('buildShapeSchema returns types only', () => {
  assert.deepEqual(buildShapeSchema({ a: 1, b: 'x', c: null, d: [{ e: true }], f: [] }), { a: 'number', b: 'string', c: 'null', d: [{ e: 'boolean' }], f: [] });
});

test('empty input yields no sections', () => {
  const r = buildPreviewContext({});
  assert.deepEqual(r.sections, []);
  assert.equal(r.redactions, 0);
});

test('shape-only preview shows header names and allowlisted values only, like the payload', () => {
  const input = {
    item: { request: { method: 'GET', url: 'https://api.test/x', header: [{ key: 'x-session', value: 'sess-9999' }] } },
    response: { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'sid=SECRET123', location: '/users/4242' }, body: '{"email":"john.doe@corp.com"}' },
  };
  const shape = JSON.stringify(buildPreviewContext({ ...input, settings: { sendResponseBodies: false } }).sections);
  for (const v of ['SECRET123', '4242', 'sess-9999', 'john.doe']) assert.ok(!shape.includes(v), `leaked ${v}`);
  for (const n of ['set-cookie', 'location', 'x-session']) assert.ok(shape.includes(n), n);
  assert.ok(shape.includes('application/json'));
  const full = JSON.stringify(buildPreviewContext({ ...input, settings: { sendResponseBodies: true, redactSecrets: false } }).sections);
  assert.ok(full.includes('/users/4242') && full.includes('sess-9999'));
});
