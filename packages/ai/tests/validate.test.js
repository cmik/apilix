'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateOutput } = require('../src/validate');

test('validates registered schema by name', () => {
  assert.equal(validateOutput('connectionTest', { ok: true }).ok, true);
  const bad = validateOutput('connectionTest', { ok: 'yes' });
  assert.equal(bad.ok, false);
  assert.match(bad.formatted, /ok/);
});

test('rejects additional properties and unknown schema names', () => {
  assert.equal(validateOutput('connectionTest', { ok: true, extra: 1 }).ok, false);
  const r = validateOutput('nope', {});
  assert.equal(r.ok, false);
  assert.match(r.formatted, /Unknown schema/);
});

test('accepts a schema object', () => {
  assert.equal(validateOutput({ type: 'array', items: { type: 'string' } }, ['a']).ok, true);
});
