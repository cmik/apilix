'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateTokens, truncateText, truncateJson, assertWithinBudget } = require('../src/budget');

test('estimateTokens is ceil(chars/4)', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test('truncateText leaves small text and cuts large text', () => {
  assert.equal(truncateText('hi', 10).truncated, false);
  const r = truncateText('x'.repeat(1000), 10);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length < 100);
  assert.equal(r.originalTokens, 250);
});

test('truncateJson caps arrays and depth', () => {
  const r = truncateJson({ a: [1, 2, 3, 4, 5, 6, 7], b: { c: { d: { e: 1 } } } }, { maxArrayItems: 3, maxDepth: 3 });
  assert.equal(r.truncated, true);
  assert.deepEqual(r.value.a, [1, 2, 3]);
  assert.equal(r.value.b.c.d, '{…}');
  assert.equal(truncateJson({ a: [1] }).truncated, false);
});

test('assertWithinBudget throws TOO_LARGE', () => {
  assert.equal(assertWithinBudget(['abcd', 'abcd'], 5), 2);
  assert.throws(() => assertWithinBudget(['x'.repeat(100)], 5), e => e.code === 'TOO_LARGE' && e.status === 413);
});
