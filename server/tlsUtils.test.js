'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getSystemCAs, makeHttpsAgent } = require('../packages/core/src/tls-utils');

test('getSystemCAs returns same array instance on multiple calls', () => {
  const first = getSystemCAs();
  const second = getSystemCAs();

  assert.equal(Array.isArray(first), true);
  assert.equal(first.length > 0, true);
  assert.strictEqual(first, second);
});

test('makeHttpsAgent with rejectUnauthorized=true merges custom CA with system CAs', () => {
  const customCA = '-----BEGIN CERTIFICATE-----\nCUSTOM\n-----END CERTIFICATE-----';
  const systemCAs = getSystemCAs();
  const agent = makeHttpsAgent(true, { ca: customCA });

  assert.equal(agent.options.rejectUnauthorized, true);
  assert.equal(Array.isArray(agent.options.ca), true);
  assert.equal(agent.options.ca.includes(customCA), true);
  assert.equal(agent.options.ca.length, systemCAs.length + 1);
});

test('makeHttpsAgent(false) does not set CA list', () => {
  const agent = makeHttpsAgent(false);

  assert.equal(agent.options.rejectUnauthorized, false);
  assert.equal(agent.options.ca, undefined);
});
