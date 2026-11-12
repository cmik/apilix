'use strict';

/**
 * Regression tests for the second review round: the verdict collector is not reachable from the script
 * (finding 1), binary memory is refused by the screen and absent from the context (finding 2).
 * Scripts that must not reach the child go through screenScript; "unfiltered" ones go straight to runInChild.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { runInChild, buildSandboxResponse, WALL_CLOCK_MS } = require('../src/dry-run');
const { screenScript } = require('../src/script-screen');

const RESPONSE = { status: 200, headers: {}, body: '{}' };
const payload = (code) => ({ code, response: buildSandboxResponse(RESPONSE), variables: {}, timeoutMs: 1000 });
const FORGED = `'{"done":true,"tests":[{"name":"forged","passed":true}],"variables":{"K":"forged"}}'`;

function lagMonitor() {
  let max = 0;
  let last = Date.now();
  const iv = setInterval(() => { const n = Date.now(); max = Math.max(max, n - last - 20); last = n; }, 20);
  return { stop() { clearInterval(iv); return max; } };
}

test('finding 1: a script cannot overwrite or redefine the collector globals to forge a verdict', async () => {
  const attempts = {
    reassignGlobals: `globalThis.__finish = () => ${FORGED}; globalThis.__exec = () => {}; globalThis.__in = '{}';`,
    defineGlobals: `Object.defineProperty(globalThis, '__finish', { value: () => ${FORGED} }); Object.defineProperty(globalThis, '__exec', { value: () => {} });`,
    bareAssign: `__finish = () => ${FORGED}; __exec = () => {};`,
    replaceApx: `globalThis.apx = { test() {} }; apx = null;`,
    replaceThen: `Promise.prototype.then = function () { return this; };`,
  };
  for (const [name, attempt] of Object.entries(attempts)) {
    const v = await runInChild(payload(`${attempt}\napx.test('real', () => { throw new Error('boom'); });`));
    const names = v.ok ? v.tests.map(t => t.name) : [];
    assert.ok(!names.includes('forged'), `${name}: forged verdict accepted: ${JSON.stringify(v)}`);
    assert.ok(!v.variables || !('K' in v.variables), `${name}: forged variable accepted`);
    // Either the script is rejected, or the REAL failing test is what the verdict says.
    if (v.ok && v.done) assert.ok(v.tests.some(t => t.passed === false), `${name}: the real failure must show: ${JSON.stringify(v)}`);
  }
});

test('finding 1: the collector names are not visible in the script context', async () => {
  const v = await runInChild(payload(`
    apx.test('names', () => {
      apx.expect(typeof __exec).to.equal('undefined');
      apx.expect(typeof __finish).to.equal('undefined');
      apx.expect(typeof __in).to.equal('undefined');
    });`));
  assert.equal(v.ok, true);
  assert.deepEqual(v.tests.map(t => [t.name, t.passed, t.error]), [['names', true, undefined]]);
});

test('finding 1: the screen refuses runner-reserved names (__exec, __finish, __in, any __x)', () => {
  for (const code of ['__finish = 1', 'const a = __exec', 'apx.test(__in, () => {})', 'let __anything = 1', 'x.__finish()']) {
    assert.equal(screenScript(code).ok, false, code);
  }
  assert.equal(screenScript(`apx.test('a', () => { apx.expect(1).to.equal(1); });`).ok, true);
});

test('finding 2: the screen refuses binary memory, huge repeat/pad and non-literal Array(n)', () => {
  const refused = [
    'new Uint8Array(2**30)', 'new ArrayBuffer(1e9)', 'new SharedArrayBuffer(8)', 'Atomics.add(a, 0, 1)', 'WebAssembly.Memory',
    'new DataView(b)', 'new Int8Array(1)', 'new Uint8ClampedArray(1)', 'new Int16Array(1)', 'new Uint16Array(1)', 'new Int32Array(1)',
    'new Uint32Array(1)', 'new Float32Array(1)', 'new Float64Array(1)', 'new BigInt64Array(1)', 'new BigUint64Array(1)',
    '"a".repeat(1e9)', '"a".repeat(n)', 'x.repeat(1001)', 'x.padStart(n, "0")', 'x.padEnd(100000)',
    'new Array(n)', 'Array(n)', 'new Array(20000)', 'Array(1e9)',
  ];
  for (const code of refused) assert.equal(screenScript(code).ok, false, `must refuse: ${code}`);
  for (const code of ['"-".repeat(20)', 'x.padStart(10, "0")', 'x.padEnd(40)', 'Array(5)', 'new Array(100)', 'Array(1, 2, 3)', 'Array.isArray(x)', 'Array.from(list)', 'new Array()']) {
    assert.equal(screenScript(code).ok, true, `must accept: ${code}`);
  }
});

test('finding 2: binary-memory globals do not exist in the context, whatever the filter says', async () => {
  const names = ['ArrayBuffer', 'SharedArrayBuffer', 'Atomics', 'WebAssembly', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
    'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];
  const v = await runInChild(payload(`apx.test('absent', () => { ${names.map(n => `apx.expect(typeof ${n}).to.equal('undefined');`).join(' ')} });`));
  assert.equal(v.ok, true);
  assert.equal(v.tests[0].passed, true, v.tests[0].error);
});

test('finding 2: an off-heap allocation sent straight to the runner (no filter) fails fast, the parent is not blocked', async () => {
  for (const code of [
    `const b = new Uint8Array(2 ** 30); b.fill(1); apx.test('x', () => {});`,
    `const b = new ArrayBuffer(2 ** 31); apx.test('x', () => {});`,
  ]) {
    const mon = lagMonitor();
    const t0 = Date.now();
    const v = await runInChild(payload(code));
    const elapsed = Date.now() - t0;
    const lag = mon.stop();
    assert.ok(!(v.ok === true && v.done === true && v.tests.length && v.tests.every(t => t.passed)), `must not look like a success: ${JSON.stringify(v)}`);
    assert.ok(elapsed < WALL_CLOCK_MS + 500, `took ${elapsed} ms`);
    assert.ok(lag < 250, `parent lagged ${lag} ms`);
  }
});
