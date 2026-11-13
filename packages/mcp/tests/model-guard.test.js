'use strict';

/** Unit tests of the agent-variable host guard (findHostOverride / classifyUrl), no network. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { findHostOverride, classifyUrl } = require('../src/model');

const coll = (extra) => ({ info: { name: 'c' }, variable: [{ key: 'h', value: 'good.com' }, { key: 's', value: 'http' }], item: [], ...extra });
const req = (request) => ({ name: 'R', id: 'r', request: { method: 'GET', ...request } });

test('I1: classifyUrl trims long runs of spaces in linear time (start, end, middle, only spaces)', () => {
  const n = 100000;
  for (const [label, text] of [
    ['start', `${' '.repeat(n)}http://a.com/x`],
    ['end', `http://a.com/x${' '.repeat(n)}`],
    ['middle', `http://a.com/${' '.repeat(n)}x`],
    ['only', ' '.repeat(n)],
    ['both', `${' '.repeat(n)}x${' '.repeat(n)}`],
    ['control', `${'\t '.repeat(n / 2)}x`],
  ]) {
    const t0 = process.hrtime.bigint();
    classifyUrl(text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 500, `${label}: ${ms.toFixed(0)} ms`);
  }
  assert.deepEqual(classifyUrl('  http://a.com/x \t'), { kind: 'host', host: 'a.com' });
  assert.deepEqual(classifyUrl('   '), { kind: 'invalid' });
});

test('m1: a literal control character in the scheme cannot hide an agent-supplied host', () => {
  const c = coll({ item: [req({ url: { raw: 'ht\ttp://{{h}}/x' } })] });
  const hit = findHostOverride(c, { variables: { h: 'evil.com' }, anyHost: true });
  assert.ok(hit, 'refused');
  assert.equal(findHostOverride(coll({ item: [req({ url: { raw: 'ht\ttp://{{h}}/x' } })] }), { variables: { h: 'evil.com' }, anyHost: false }) !== null, true, 'also in --allow-host mode');
  // nothing supplied by the agent: unchanged, not refused for being different
  assert.equal(findHostOverride(c, { variables: {} }), null);
});

