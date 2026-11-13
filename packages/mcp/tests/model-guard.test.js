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

test('m2: an auth block with more than 50 keys is fully inspected (tokenUrl in 60th position)', () => {
  const oauth2 = {};
  for (let i = 0; i < 59; i += 1) oauth2[`filler${i}`] = 'x';
  oauth2.tokenUrl = 'http://{{tok}}/token';
  const c = coll({ item: [req({ url: 'http://good.com/x', auth: { type: 'oauth2', oauth2 } })] });
  const hit = findHostOverride(c, { variables: { tok: 'evil.com' }, anyHost: true });
  assert.ok(hit, 'refused');
  assert.match(hit.field, /oauth2\.tokenUrl/);
  // array form (Postman key/value rows) too
  const rows = [...Array.from({ length: 59 }, (_, i) => ({ key: `f${i}`, value: 'x' })), { key: 'tokenUrl', value: 'http://{{tok}}/token' }];
  const c2 = coll({ item: [req({ url: 'http://good.com/x', auth: { type: 'oauth2', oauth2: rows } })] });
  assert.ok(findHostOverride(c2, { variables: { tok: 'evil.com' }, anyHost: true }));
});

test('m2: an auth block over the safety ceiling is refused (fail closed)', () => {
  const oauth2 = {};
  for (let i = 0; i < 10001; i += 1) oauth2[`k${i}`] = 'x';
  const c = coll({ item: [req({ url: 'http://good.com/x', auth: { type: 'oauth2', oauth2 } })] });
  assert.ok(findHostOverride(c, { variables: {}, anyHost: false }));
});

test('M6: dynamic tokens in the authority or port are neutralized, no false refusal', () => {
  const c = coll({ item: [req({ url: 'http://h-{{$guid}}.good.com:{{$randomInt(1,5)}}/p/{{x}}' })] });
  assert.equal(findHostOverride(c, { variables: { x: '1' }, anyHost: true }), null);
  assert.equal(findHostOverride(c, { variables: { x: '1' }, anyHost: false }), null);
  const c2 = coll({ item: [req({ url: { raw: 'http://{{$guid}}.good.com/{{x}}' } })] });
  assert.equal(findHostOverride(c2, { variables: { x: '1' }, anyHost: true }), null);
});

test('M11: url.variable ":id" is applied like the engine (the host can come from a path variable)', () => {
  const c = coll({ item: [req({ url: { raw: 'http://:hv/x', variable: [{ key: 'hv', value: '{{h}}' }] } })] });
  const hit = findHostOverride(c, { variables: { h: 'evil.com' }, anyHost: true });
  assert.ok(hit, 'refused');
  assert.equal(hit.to, 'evil.com');
  assert.equal(hit.from, 'good.com');
  assert.equal(findHostOverride(c, { variables: {} }), null);
});

test('M13: a placeholder scheme "{{s}}://{{h}}/x" still has its authority checked', () => {
  const c = coll({ item: [req({ url: '{{s}}://{{h}}/x' })] });
  const hit = findHostOverride(c, { variables: { h: 'evil.com' }, anyHost: true });
  assert.ok(hit, 'refused');
  assert.equal(hit.to, 'evil.com');
  assert.equal(findHostOverride(c, { variables: { s: 'https' }, anyHost: true }), null, 'changing only the scheme keeps the host');
});

test('M13: a scheme left as a placeholder by the collection still yields its authority (host from the collection stays trusted)', () => {
  const c = { info: { name: 'c' }, variable: [{ key: 'h', value: 'good.com' }], item: [req({ url: '{{s}}://{{h}}/x' })] };
  assert.deepEqual(classifyUrl('{{s}}://good.com/x'), { kind: 'host', host: 'good.com' });
  assert.equal(findHostOverride(c, { variables: { s: 'https' }, anyHost: true }), null, 'only the scheme is supplied by the agent');
  assert.ok(findHostOverride(c, { variables: { s: 'https', h: 'evil.com' }, anyHost: true }));
});
