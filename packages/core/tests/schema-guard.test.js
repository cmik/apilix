'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../src/schema-guard');
const { buildSchemaTest } = require('../src/collection-runner');
const { runScript } = require('../src/script-runtime');

const REDOS = { type: 'string', pattern: '^(a+)+$' };
const EVIL = 'a'.repeat(45) + '!';

test.after(() => guard._shutdown());

test('clamp and default', () => {
  assert.equal(guard.clampTimeoutMs(undefined), guard.DEFAULT_TIMEOUT_MS);
  assert.equal(guard.clampTimeoutMs('abc'), guard.DEFAULT_TIMEOUT_MS);
  assert.equal(guard.clampTimeoutMs(1), guard.MIN_TIMEOUT_MS);
  assert.equal(guard.MAX_TIMEOUT_MS, 10000);
  assert.equal(guard.clampTimeoutMs(10 ** 9), 10000);
  assert.equal(guard.clampTimeoutMs(60000), 10000);
  assert.equal(guard.clampTimeoutMs('500'), 500);
  assert.equal(guard.setSchemaValidationTimeoutMs(undefined), 2000);
  assert.equal(guard.getSchemaValidationTimeoutMs(), 2000);
});

test('worker mode: normal validation matches the plain validator, repeat calls reuse the worker', () => {
  assert.equal(guard.mode(), 'worker');
  assert.deepEqual(guard.validateWithTimeout({ type: 'string' }, 'x'), { valid: true, errors: [] });
  const bad = guard.validateWithTimeout({ type: 'object', required: ['id'] }, {}, { allErrors: true });
  assert.equal(bad.valid, false);
  assert.equal(bad.errors[0].keyword, 'required');
  const schemas = [{ name: 'Id', schema: { type: 'integer' } }];
  assert.equal(guard.validateWithTimeout({ $ref: 'Id' }, 1, { schemas }).valid, true);
  assert.equal(guard.validateWithTimeout({ $ref: 'Id' }, 'x', { schemas }).valid, false); // registry cached worker-side
  assert.throws(() => guard.validateWithTimeout('Nope', 1, { schemas }), /Unknown schema "Nope"/);
  assert.ok(guard.validateWithTimeout({ type: 'nonsense' }, 1).schemaError);
});

test('ReDoS pattern is cut off at the time limit, and the guard recovers afterwards', () => {
  const t = Date.now();
  const r = guard.validateWithTimeout(REDOS, EVIL, { timeoutMs: 300 });
  const took = Date.now() - t;
  assert.equal(r.valid, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.errors[0].keyword, 'timeout');
  assert.match(r.errors[0].message, /300 ms/);
  assert.ok(took < 3000, `took ${took} ms`);
  assert.equal(guard.validateWithTimeout({ type: 'string' }, 'ok').valid, true);
});

test('default limit comes from setSchemaValidationTimeoutMs', () => {
  guard.setSchemaValidationTimeoutMs(250);
  try {
    assert.equal(guard.validateWithTimeout(REDOS, EVIL).timedOut, true);
  } finally { guard.setSchemaValidationTimeoutMs(undefined); }
});

test('risky pattern heuristic', () => {
  for (const p of ['^(a+)+$', '(a|a)*', '(.*)*x', '^(\\w+\\s?)*$', '(a+){2,}', '(a)\\1', 'x'.repeat(1001)]) assert.equal(guard.isRiskyPattern(p), true, p);
  for (const p of ['^[a-z]+$', '^(\\d{3})-\\d+$', '^[A-Z]{2}\\d{4}$', '^(ab)+$', '^[(+*]+$', '^\\(a+\\)$', '^(foo|bar)$']) assert.equal(guard.isRiskyPattern(p), false, p);
  const reg = [{ name: 'Bad', schema: REDOS }];
  assert.equal(guard.schemaHasRiskyPattern({ $ref: 'Bad' }, reg), true);
  assert.equal(guard.schemaHasRiskyPattern({ properties: { a: { patternProperties: { '^(a+)+$': {} } } } }, []), true);
  assert.equal(guard.schemaHasRiskyPattern({ enum: ['(a+)+'] }, []), false);
});

test('fallback mode (no worker): risky patterns are rejected without running them', () => {
  process.env.APILIX_SCHEMA_NO_WORKER = '1';
  try {
    assert.equal(guard.mode(), 'static-check');
    const t = Date.now();
    const r = guard.validateWithTimeout(REDOS, EVIL);
    assert.ok(Date.now() - t < 500);
    assert.equal(r.unsafePattern, true);
    assert.equal(r.errors[0].keyword, 'unsafe-pattern');
    assert.equal(guard.validateWithTimeout({ type: 'string', pattern: '^[a-z]+$' }, 'abc').valid, true);
    assert.equal(guard.validateWithTimeout({ type: 'string' }, 5).valid, false);
  } finally { delete process.env.APILIX_SCHEMA_NO_WORKER; }
});

test('runner: timeout is a warning in warn mode and a failure in strict mode', () => {
  const schemas = [{ id: 's1', name: 'Slow', version: 1, schema: REDOS }];
  const result = { status: 200, body: JSON.stringify(EVIL) };
  const links = [{ schemaId: 's1', match: '2xx' }];
  guard.setSchemaValidationTimeoutMs(200);
  try {
    const warn = buildSchemaTest(result, links, schemas, 'warn');
    assert.equal(warn.passed, true);
    assert.equal(warn.schemaSeverity, 'warn');
    assert.match(warn.error, /could not be checked.*time limit/);
    const strict = buildSchemaTest(result, links, schemas, 'strict');
    assert.equal(strict.passed, false);
    assert.equal(strict.schemaSeverity, 'fail');
  } finally { guard.setSchemaValidationTimeoutMs(undefined); }
});

test('sandbox matchSchema: timeout surfaces as a script error, not a crash', async () => {
  guard.setSchemaValidationTimeoutMs(200);
  try {
    const out = await runScript(
      `apx.test('slow', () => { apx.expect(${JSON.stringify(EVIL)}).to.matchSchema(${JSON.stringify(REDOS)}); });`,
      { response: { code: 200, status: 'OK', headers: [], body: '' } },
      {},
    );
    const t = (out.tests || out.testResults || [])[0];
    assert.ok(t, JSON.stringify(out).slice(0, 300));
    assert.equal(t.passed, false);
    assert.match(String(t.error), /time limit/);
  } finally { guard.setSchemaValidationTimeoutMs(undefined); }
});

test('risky pattern heuristic: polynomial and counted-group shapes, without rejecting common patterns', () => {
  for (const p of ['a*a*a*a*b', '^\\d+\\d+\\d+$', '(a?){30}a{30}', '^(a|b?){12}$', '(a+){10}']) assert.equal(guard.isRiskyPattern(p), true, p);
  for (const p of ['^\\d+-\\d+-\\d+$', '^.*foo.*bar.*$', '^(\\d{3}-?){2}$', '^a*b*c*$', '^[a-z]+\\s*[a-z]*$', '^(?:https?)://[^/]+/.*$', '^(\\d{1,3}\\.){3}\\d{1,3}$', '^a{1,5}$', '^(?<y>\\d{4})-\\d{2}$']) assert.equal(guard.isRiskyPattern(p), false, p);
});

test('static pattern collection skips enum/const/default/examples keywords but not property names', () => {
  const risky = '^(a+)+$';
  for (const name of ['enum', 'const', 'default', 'examples']) {
    assert.equal(guard.schemaHasRiskyPattern({ properties: { [name]: { type: 'string', pattern: risky } } }, []), true, `properties.${name}`);
    assert.equal(guard.schemaHasRiskyPattern({ $defs: { [name]: { pattern: risky } } }, []), true, `$defs.${name}`);
    assert.equal(guard.schemaHasRiskyPattern({ definitions: { [name]: { pattern: risky } } }, []), true, `definitions.${name}`);
    assert.equal(guard.schemaHasRiskyPattern({ patternProperties: { '^x$': { properties: { [name]: { pattern: risky } } } } }, []), true);
  }
  assert.equal(guard.schemaHasRiskyPattern({ type: 'string', enum: [{ pattern: risky }], const: { pattern: risky }, default: { pattern: risky }, examples: [{ pattern: risky }] }, []), false);
});

test('static-check mode exposes a timeout-not-enforced warning; worker mode has none', () => {
  assert.equal(guard.getTimeoutWarning(), null);
  process.env.APILIX_SCHEMA_NO_WORKER = '1';
  try {
    assert.equal(guard.getTimeoutWarning(), guard.TIMEOUT_NOT_ENFORCED_WARNING);
    assert.match(guard.getTimeoutWarning(), /not enforced/);
  } finally { delete process.env.APILIX_SCHEMA_NO_WORKER; }
});

test('worker mode: non-cloneable input is JSON round-tripped or reported, never run unbounded in-process', () => {
  assert.equal(guard.mode(), 'worker');
  // A function value cannot be structured-cloned but survives the JSON round trip.
  const withFn = guard.validateWithTimeout({ type: 'object', required: ['a'] }, { a: 1, f() {} });
  assert.equal(withFn.valid, true);
  // A function plus a cycle defeats both structured clone and JSON: an error result, and the risky pattern is not run in-process.
  const cyc = { f() {} }; cyc.self = cyc;
  const bad = guard.validateWithTimeout(REDOS, cyc);
  assert.equal(bad.valid, false);
  assert.ok(bad.schemaError);
  assert.equal(bad.timedOut, undefined);
  // The guard still works afterwards.
  assert.equal(guard.validateWithTimeout({ type: 'string' }, 'ok').valid, true);
});

test('runner: a timed-out schema is not re-validated (no repeated stall) within one run context', () => {
  const schemas = [{ id: 's1', name: 'Slow', version: 1, schema: REDOS }];
  const result = { status: 200, body: JSON.stringify(EVIL) };
  const links = [{ schemaId: 's1', match: '2xx' }];
  const ctx = { registry: schemas.map(s => ({ name: s.name, schema: s.schema })), timedOut: new Map() };
  guard.setSchemaValidationTimeoutMs(400);
  try {
    let t = Date.now();
    const first = buildSchemaTest(result, links, schemas, 'warn', ctx);
    const firstMs = Date.now() - t;
    assert.match(first.error, /time limit/);
    assert.ok(firstMs >= 300, `first took ${firstMs}`);
    t = Date.now();
    for (let i = 0; i < 5; i++) {
      const again = buildSchemaTest(result, links, schemas, 'warn', ctx);
      assert.match(again.error, /could not be checked.*skipped for the rest of this run/);
    }
    assert.ok(Date.now() - t < 200, `repeats took ${Date.now() - t}`);
    // Without a shared context nothing is cached.
    assert.ok(!buildSchemaTest(result, links, schemas, 'warn').error.includes('skipped for the rest'));
  } finally { guard.setSchemaValidationTimeoutMs(undefined); }
});

test('registry fingerprint is memoised by array identity', () => {
  const registry = [{ name: 'MemoTest', schema: { type: 'integer' } }];
  const orig = JSON.stringify;
  let fpCalls = 0;
  JSON.stringify = function (v, ...rest) {
    if (Array.isArray(v) && Array.isArray(v[0]) && v[0][0] === 'MemoTest') fpCalls++;
    return orig.call(this, v, ...rest);
  };
  try {
    for (let i = 0; i < 5; i++) assert.equal(guard.validateWithTimeout({ $ref: 'MemoTest' }, 1, { schemas: registry }).valid, true);
  } finally { JSON.stringify = orig; }
  assert.equal(fpCalls, 1);
});
