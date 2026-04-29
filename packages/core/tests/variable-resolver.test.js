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

// ─── Dynamic tokens ───────────────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('$guid resolves to a UUID v4', () => {
  const result = resolveVariables('{{$guid}}', {});
  assert.match(result, UUID_PATTERN);
});

test('$uuid resolves to a UUID v4 (alias for $guid)', () => {
  const result = resolveVariables('{{$uuid}}', {});
  assert.match(result, UUID_PATTERN);
});

test('$guid generates a different value on each call', () => {
  const a = resolveVariables('{{$guid}}', {});
  const b = resolveVariables('{{$guid}}', {});
  // Astronomically unlikely to collide; validates freshness
  assert.notEqual(a, b);
});

test('$timestamp resolves to a numeric string close to Date.now()', () => {
  const before = Date.now();
  const result = resolveVariables('{{$timestamp}}', {});
  const after = Date.now();
  assert.match(result, /^\d+$/);
  const ts = parseInt(result, 10);
  assert.ok(ts >= before && ts <= after, `expected ${ts} between ${before} and ${after}`);
});

test('$isoTimestamp resolves to an ISO 8601 date-time string', () => {
  const result = resolveVariables('{{$isoTimestamp}}', {});
  assert.ok(!isNaN(new Date(result).getTime()), `expected valid date, got ${result}`);
  assert.match(result, /^\d{4}-\d{2}-\d{2}T/);
});

test('$isoDate resolves to an ISO 8601 date-time string (alias for $isoTimestamp)', () => {
  const result = resolveVariables('{{$isoDate}}', {});
  assert.ok(!isNaN(new Date(result).getTime()), `expected valid date, got ${result}`);
});

test('$randomInt resolves to an integer string in [0, 9999]', () => {
  const result = resolveVariables('{{$randomInt}}', {});
  assert.match(result, /^\d+$/);
  const n = parseInt(result, 10);
  assert.ok(n >= 0 && n <= 9999, `expected 0–9999, got ${n}`);
});

test('$randomInt(5,10) resolves to an integer in [5, 10]', () => {
  for (let i = 0; i < 20; i++) {
    const result = resolveVariables('{{$randomInt(5,10)}}', {});
    const n = parseInt(result, 10);
    assert.ok(n >= 5 && n <= 10, `expected 5–10, got ${n}`);
  }
});

test('$randomFloat(0,1) resolves to a float string in [0, 1] with 2 decimal places', () => {
  for (let i = 0; i < 10; i++) {
    const result = resolveVariables('{{$randomFloat(0,1)}}', {});
    assert.match(result, /^\d+\.\d{2}$/);
    const f = parseFloat(result);
    assert.ok(f >= 0 && f <= 1, `expected 0–1, got ${f}`);
  }
});

test('$randomItem(a,b,c) resolves to one of the provided items', () => {
  for (let i = 0; i < 10; i++) {
    const result = resolveVariables('{{$randomItem(apple,banana,cherry)}}', {});
    assert.ok(['apple', 'banana', 'cherry'].includes(result), `unexpected result: ${result}`);
  }
});

test('unknown $token is left unchanged', () => {
  assert.equal(resolveVariables('{{$unknownToken}}', {}), '{{$unknownToken}}');
});

test('dynamic token alongside a user variable both resolve', () => {
  const result = resolveVariables('{{$guid}}-{{env}}', { env: 'prod' });
  const parts = result.split('-prod');
  assert.equal(parts.length, 2);
  assert.match(parts[0], UUID_PATTERN);
});

test('user var named $guid in the map cannot shadow the dynamic token', () => {
  const result = resolveVariables('{{$guid}}', { '$guid': 'overridden' });
  assert.match(result, UUID_PATTERN);
  assert.notEqual(result, 'overridden');
});
