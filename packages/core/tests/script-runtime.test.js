'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runScript } = require('../src/script-runtime');

test('apx.response.headers exposes get/has/toObject in test scripts', async () => {
  const script = [
    "apx.test('headers api', () => {",
    "  apx.expect(apx.response.headers.get('Content-Type')).to.equal('application/json');",
    "  apx.expect(apx.response.headers.has('x-request-id')).to.equal(true);",
    "  const headersObj = apx.response.headers.toObject();",
    "  apx.expect(headersObj['content-type']).to.equal('application/json');",
    "  apx.expect(headersObj['x-request-id']).to.equal('abc123');",
    '});',
  ].join('\n');

  const result = await runScript(script, {
    code: 200,
    status: 'OK',
    responseTime: 10,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'abc123',
    },
    body: '{"ok":true}',
    jsonData: { ok: true },
  }, {}, {}, null);

  assert.equal(result.tests.length, 1);
  assert.equal(result.tests[0].name, 'headers api');
  assert.equal(result.tests[0].passed, true);
});

test('apx.response.headers.toObject returns a detached copy', async () => {
  const script = [
    "apx.test('headers copy', () => {",
    "  const headersObj = apx.response.headers.toObject();",
    "  headersObj['x-added'] = '1';",
    "  apx.expect(apx.response.headers.has('x-added')).to.equal(false);",
    '});',
  ].join('\n');

  const result = await runScript(script, {
    code: 200,
    status: 'OK',
    responseTime: 10,
    headers: {
      'content-type': 'application/json',
    },
    body: '{"ok":true}',
    jsonData: { ok: true },
  }, {}, {}, null);

  assert.equal(result.tests.length, 1);
  assert.equal(result.tests[0].name, 'headers copy');
  assert.equal(result.tests[0].passed, true);
});
