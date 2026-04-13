'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getSystemCAs, makeHttpsAgent } = require('./tlsUtils');

test('getSystemCAs is memoized', () => {
  const first = getSystemCAs();
  const second = getSystemCAs();

  assert.equal(Array.isArray(first), true);
  assert.equal(first.length > 0, true);
  assert.strictEqual(first, second);
});

test('makeHttpsAgent(true) sets CA list and keeps caller CA values', () => {
  const customCA = '-----BEGIN CERTIFICATE-----\nCUSTOM\n-----END CERTIFICATE-----';
  const agent = makeHttpsAgent(true, { ca: customCA });

  assert.equal(agent.options.rejectUnauthorized, true);
  assert.equal(Array.isArray(agent.options.ca), true);
  assert.equal(agent.options.ca.includes(customCA), true);
  assert.equal(agent.options.ca.length >= getSystemCAs().length, true);
});

test('makeHttpsAgent(false) does not set CA list', () => {
  const agent = makeHttpsAgent(false);

  assert.equal(agent.options.rejectUnauthorized, false);
  assert.equal(agent.options.ca, undefined);
});
