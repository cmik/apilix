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

