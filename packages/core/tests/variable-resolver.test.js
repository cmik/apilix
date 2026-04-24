'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveVariables } = require('../src/variable-resolver');

// ─── Basic substitution ───────────────────────────────────────────────────────

test('resolves a simple variable', () => {
  assert.equal(resolveVariables('{{host}}', { host: 'localhost' }), 'localhost');
});

test('resolves multiple variables in the same string', () => {
  assert.equal(
    resolveVariables('{{scheme}}://{{host}}:{{port}}', { scheme: 'https', host: 'api.example.com', port: '443' }),
    'https://api.example.com:443',
  );
});

test('leaves unknown tokens unchanged', () => {
  assert.equal(resolveVariables('{{missing}}', {}), '{{missing}}');
});

test('leaves unknown tokens unchanged when other tokens are resolved', () => {
  assert.equal(resolveVariables('{{known}}-{{unknown}}', { known: 'A' }), 'A-{{unknown}}');
});

// ─── Non-string inputs ────────────────────────────────────────────────────────

test('returns numbers unchanged', () => {
  assert.equal(resolveVariables(42, { foo: 'bar' }), 42);
});

test('returns null unchanged', () => {
  assert.equal(resolveVariables(null, {}), null);
});

test('returns undefined unchanged', () => {
  assert.equal(resolveVariables(undefined, {}), undefined);
});

test('returns boolean unchanged', () => {
  assert.equal(resolveVariables(true, {}), true);
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

test('resolves variable containing whitespace around key', () => {
  assert.equal(resolveVariables('{{ host }}', { host: 'trimmed' }), 'trimmed');
});

test('empty vars map leaves all tokens unchanged', () => {
  assert.equal(resolveVariables('{{a}} and {{b}}', {}), '{{a}} and {{b}}');
});

test('string with no tokens is returned as-is', () => {
  assert.equal(resolveVariables('no tokens here', { x: '1' }), 'no tokens here');
});

test('empty string is returned as-is', () => {
  assert.equal(resolveVariables('', { x: '1' }), '');
});

test('variable value that is empty string resolves correctly', () => {
  assert.equal(resolveVariables('prefix-{{empty}}-suffix', { empty: '' }), 'prefix--suffix');
});

test('variable value containing double braces is substituted literally', () => {
  assert.equal(resolveVariables('{{nested}}', { nested: '{{inner}}' }), '{{inner}}');
});

// ─── Precedence (caller controls the merged map) ─────────────────────────────

test('last-writer-wins when caller merges env over globals', () => {
  // Callers are responsible for merging; here env overrides a global value
  const vars = Object.assign({}, { base: 'global-value' }, { base: 'env-value' });
  assert.equal(resolveVariables('{{base}}', vars), 'env-value');
});
