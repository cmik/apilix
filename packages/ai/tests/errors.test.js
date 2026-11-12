'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AiError, httpStatusFor, fromAxiosError } = require('../src/errors');

test('code → HTTP status table', () => {
  const table = { AUTH: 401, RATE_LIMIT: 429, INVALID_OUTPUT: 422, TOO_LARGE: 413, NO_PROVIDER: 409, DISABLED: 403, ABORTED: 499, TIMEOUT: 504, NETWORK: 502 };
  for (const [code, status] of Object.entries(table)) {
    assert.equal(httpStatusFor(code), status);
    assert.equal(new AiError(code, 'x').status, status);
  }
});

test('fromAxiosError maps statuses and drops the original (which holds the API key)', () => {
  const mk = (extra) => Object.assign(new Error('boom'), { config: { headers: { 'x-api-key': 'SECRETKEY' } }, ...extra });
  assert.equal(fromAxiosError(mk({ response: { status: 401 } })).code, 'AUTH');
  assert.equal(fromAxiosError(mk({ response: { status: 429 } })).code, 'RATE_LIMIT');
  assert.equal(fromAxiosError(mk({ code: 'ECONNABORTED' })).code, 'TIMEOUT');
  assert.equal(fromAxiosError(mk({ name: 'CanceledError' })).code, 'ABORTED');
  const net = fromAxiosError(mk({ code: 'ECONNREFUSED' }));
  assert.equal(net.code, 'NETWORK');
  assert.ok(!JSON.stringify(net).includes('SECRETKEY'));
  assert.ok(!String(net.stack).includes('SECRETKEY'));
  assert.ok(!('config' in net));
});

test('fromAxiosError returns AiError untouched', () => {
  const e = new AiError('TOO_LARGE', 'x');
  assert.equal(fromAxiosError(e), e);
});
