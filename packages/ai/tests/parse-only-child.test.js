'use strict';

// Parse-only mode must compile in the dedicated child process, never in the server process (CodeQL js/code-injection).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { dryRunScript, parseOnlyCheck, parseOnlyVerdict, startupOptions, liveChildren, MAX_CONCURRENT_CHILDREN, MAX_WAITING, WALL_CLOCK_MS } = require('../src/dry-run');

const RESPONSE = { status: 200, statusText: 'OK', headers: {}, body: '{}', responseTime: 1 };
const GOOD = "apx.test('ok', () => { apx.expect(apx.response.code).to.equal(200); });";

function withEnv(value, fn) {
  const prev = process.env.APILIX_AI_DRY_RUN;
  process.env.APILIX_AI_DRY_RUN = value;
  return Promise.resolve().then(fn).finally(() => { if (prev === undefined) delete process.env.APILIX_AI_DRY_RUN; else process.env.APILIX_AI_DRY_RUN = prev; });
}

/** Child startup options WITHOUT the permission flags (so a preload file can be read), with the real env. */
function startupWith(preloadSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apilix-parse-only-'));
  const file = path.join(dir, 'preload.js');
  fs.writeFileSync(file, preloadSource);
  const real = startupOptions();
  return { dir, startup: () => ({ execArgv: ['--max-old-space-size=64', '-r', file], env: real.env, permission: 'none' }) };
}

test('the server module no longer compiles anything: no vm in dry-run.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/dry-run.js'), 'utf8');
  assert.ok(!/require\(['"](?:node:)?vm['"]\)/.test(src), 'dry-run.js must not require vm');
  assert.ok(!/vm\.Script|new Function|\beval\(|runIn(?:New|This)?Context/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'no compile or eval call in code');
});

test('parse-only: the check runs in a child; this process never calls vm.Script', async () => {
  const Orig = vm.Script;
  let inProcess = 0;
  vm.Script = function Spy(...args) { inProcess++; return new Orig(...args); };
  try {
    await withEnv('off', async () => {
      const spawned = [];
      const ok = await dryRunScript(GOOD, { response: RESPONSE, onSpawn: (pid) => spawned.push(pid) });
      assert.deepEqual([ok.ok, ok.executed, ok.mode], [true, false, 'parse-only']);
      assert.equal(spawned.length, 1, 'one compile-only child');
      assert.equal(await parseOnlyCheck('const x = ;'), "Unexpected token ';'");
    });
  } finally { vm.Script = Orig; }
  assert.equal(inProcess, 0, 'vm.Script was called in the server process');
  assert.equal(liveChildren(), 0);
});

test('compile-only child: syntax errors are reported (clipped), valid scripts pass, nothing is run', async () => {
  assert.equal(await parseOnlyCheck(GOOD), null);
  assert.equal(await parseOnlyCheck('const a = 1;'), null);
  const bad = await parseOnlyCheck("apx.test('x', () => {");
  assert.equal(typeof bad, 'string');
  assert.ok(bad.length > 0 && bad.length <= 160);
  assert.equal(await parseOnlyCheck(`let s = "${'a'.repeat(300)}`).then(m => m.length <= 160), true);
  // Would loop for ever or throw if it were run.
  const t = Date.now();
  assert.equal(await parseOnlyCheck('for (;;) {}'), null);
  assert.equal(await parseOnlyCheck("throw new Error('boom');"), null);
  assert.ok(Date.now() - t < WALL_CLOCK_MS, 'compiled, not run');
  // The wrapper is an async function body: `await` is valid, `import` is not.
  assert.equal(await parseOnlyCheck('await 1;'), null);
  assert.equal(typeof await parseOnlyCheck('import x from "y";'), 'string');
});

test('pathological nesting is reported as invalid, the server survives', async () => {
  for (const code of ['('.repeat(90000), '['.repeat(90000), '{'.repeat(90000), `${'('.repeat(40000)}1${')'.repeat(40000)}`]) {
    const m = await parseOnlyCheck(code);
    assert.equal(typeof m, 'string', 'never null for a script that does not compile');
    assert.ok(m.length <= 160);
  }
  assert.equal(liveChildren(), 0);
  assert.match(await parseOnlyCheck('x'.repeat(100001)), /longer than/);
  assert.equal(await parseOnlyCheck(GOOD), null, 'still working afterwards');
});

test('timeout is reported, not thrown, and fails closed', async () => {
  // A sleeping child (no CPU burn: other test files run in parallel and have timing-sensitive tests).
  const { dir, startup } = startupWith('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);');
  try {
    const t = Date.now();
    const v = await parseOnlyVerdict(GOOD, undefined, { startupOptions: startup });
    assert.deepEqual(v, { ok: false, error: 'timeout' });
    assert.ok(Date.now() - t >= WALL_CLOCK_MS - 200 && Date.now() - t < WALL_CLOCK_MS + 2500);
    assert.match(await parseOnlyCheck(GOOD, undefined, { startupOptions: startup }), /could not be checked \(timeout\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(liveChildren(), 0);
});

test('a child that cannot start or crashes fails closed: never "compiles", never "validated"', async () => {
  const broken = () => ({ execArgv: ['--no-such-node-flag-xyz'], env: {} });
  const v = await parseOnlyVerdict(GOOD, undefined, { startupOptions: broken });
  assert.equal(v.ok, false);
  assert.ok(typeof v.error === 'string');
  assert.match(await parseOnlyCheck(GOOD, undefined, { startupOptions: broken }), /could not be checked/);
  // Build where the worker cannot be forked at all (pkg): the script is reported not validated, with the infra flag.
  const prevPkg = process.pkg;
  process.pkg = {};
  try {
    await withEnv('off', async () => {
      const r = await dryRunScript(GOOD, { response: RESPONSE });
      assert.equal(r.ok, false);
      assert.equal(r.infra, true);
      assert.match(r.reason, /cannot be validated in this build/);
    });
  } finally { if (prevPkg === undefined) delete process.pkg; else process.pkg = prevPkg; }
});

test('dryRunScript in parse-only mode: a child that crashes gives "not validated" (infra), never ok', async () => {
  await withEnv('off', async () => {
    const r = await dryRunScript(GOOD, { response: RESPONSE, childHooks: { startupOptions: () => ({ execArgv: ['--no-such-node-flag-xyz'], env: {} }) } });
    assert.equal(r.ok, false);
    assert.equal(r.infra, true);
    assert.match(r.reason, /could not be checked: not validated/);
  });
});

test('the compile-only child gets an empty environment', async () => {
  process.env.APILIX_PARSE_ONLY_CANARY = 'leak-me';
  const out = path.join(os.tmpdir(), `apilix-env-${process.pid}.json`);
  const { dir, startup } = startupWith(`require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(process.env)));`);
  try {
    assert.equal(await parseOnlyCheck(GOOD, undefined, { startupOptions: startup }), null);
    const keys = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(!keys.includes('APILIX_PARSE_ONLY_CANARY'), `child saw ${keys.join(',')}`);
    assert.ok(!keys.includes('PATH') && !keys.includes('HOME'), 'no inherited variables');
    assert.deepEqual(startupOptions().env && Object.keys(startupOptions().env).filter(k => !['ELECTRON_RUN_AS_NODE', 'SystemRoot'].includes(k)), []);
  } finally { delete process.env.APILIX_PARSE_ONLY_CANARY; fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(out, { force: true }); }
});

test('the code travels over IPC, not argv', async () => {
  const out = path.join(os.tmpdir(), `apilix-argv-${process.pid}.json`);
  const { dir, startup } = startupWith(`require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv));`);
  try {
    assert.equal(await parseOnlyCheck("const secretMarker = 'XYZZY-42';", undefined, { startupOptions: startup }), null);
    assert.ok(!fs.readFileSync(out, 'utf8').includes('XYZZY'), 'the script text is not on the command line');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(out, { force: true }); }
});

test('compile-only checks respect the process-wide concurrency cap and queue; beyond it they are "busy", not validated', async () => {
  const { dir, startup } = startupWith('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);');
  try {
    let max = 0;
    const sampler = setInterval(() => { max = Math.max(max, liveChildren()); }, 10);
    const total = MAX_CONCURRENT_CHILDREN + MAX_WAITING + 4;
    const results = await Promise.all(Array.from({ length: total }, () => parseOnlyVerdict(GOOD, undefined, { startupOptions: startup })));
    clearInterval(sampler);
    assert.ok(max >= 1 && max <= MAX_CONCURRENT_CHILDREN, `live children peaked at ${max}`);
    assert.equal(results.filter(r => r.ok).length, MAX_CONCURRENT_CHILDREN + MAX_WAITING);
    assert.equal(results.filter(r => !r.ok && r.error === 'busy').length, 4);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(liveChildren(), 0);
});

test('cancelling a queued or running compile-only check reports "aborted"', async () => {
  const { dir, startup } = startupWith('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);');
  try {
    const ac = new AbortController();
    const p = parseOnlyVerdict(GOOD, ac.signal, { startupOptions: startup });
    setTimeout(() => ac.abort(), 50);
    assert.deepEqual(await p, { ok: false, error: 'aborted' });
    assert.deepEqual(await parseOnlyVerdict(GOOD, ac.signal), { ok: false, error: 'aborted' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(liveChildren(), 0);
});
