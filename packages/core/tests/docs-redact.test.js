'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../src/docs/doc-redact');

test('redactValue keeps variable references and hides literals', () => {
  assert.equal(r.redactValue('{{token}}', false), '{{token}}');
  assert.equal(r.redactValue('Bearer {{token}}', false), 'Bearer {{token}}');
  assert.equal(r.redactValue('Bearer abc.def', false), r.REDACTED);
  assert.equal(r.redactValue('abc{{x}}', false), r.REDACTED);
  assert.equal(r.redactValue('literal', true), 'literal');
  assert.equal(r.redactValue('', false), '');
});

test('sensitive names and headers are detected', () => {
  for (const n of ['access_token', 'apiKey', 'X-Api-Key', 'password', 'client_secret', 'sig', 'code', 'key']) {
    assert.equal(r.isSensitiveName(n), true, n);
  }
  for (const n of ['page', 'name', 'limit', 'monkey']) assert.equal(r.isSensitiveName(n), false, n);
  assert.equal(r.isSensitiveHeader('Authorization'), true);
  assert.equal(r.isSensitiveHeader('cookie'), true);
  assert.equal(r.isSensitiveHeader('Content-Type'), false);
});

test('redactUrlUserinfo strips credentials', () => {
  assert.equal(r.redactUrlUserinfo('https://u:p@host.com/x', false), `https://${r.REDACTED}@host.com/x`);
  assert.equal(r.redactUrlUserinfo('https://u:p@host.com/x', true), 'https://u:p@host.com/x');
  assert.equal(r.redactUrlUserinfo('https://host.com', false), 'https://host.com');
});

test('redactBodyText redacts sensitive JSON keys, leaves other text alone', () => {
  const out = JSON.parse(r.redactBodyText('{"a":1,"password":"x","nested":{"api_key":"y","ok":"z"},"t":"{{v}}","token":"{{v}}"}', false));
  assert.equal(out.password, r.REDACTED);
  assert.equal(out.nested.api_key, r.REDACTED);
  assert.equal(out.nested.ok, 'z');
  assert.equal(out.token, '{{v}}');
  assert.equal(r.redactBodyText('plain password=abc', false), 'plain password=abc');
  assert.equal(r.redactBodyText('{"a":1}', false), '{"a":1}');
});

test('redaction helpers are exposed as the public @apilix/core/redact subpath', () => {
  const pub = require('@apilix/core/redact');
  assert.equal(pub, r);
  for (const name of ['REDACTED', 'redactUrl', 'redactHeaderValue', 'redactBodyText', 'isSensitiveName']) {
    assert.ok(name in pub, name);
  }
});
