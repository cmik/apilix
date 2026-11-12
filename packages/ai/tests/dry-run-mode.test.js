'use strict';

/**
 * Option 2: a model-written script is executed ONLY when the child is proven (by a capability probe) to run
 * under the Node permission model. Otherwise "parse-only": screened + compiled, never run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideDryRunMode, resolveDryRunMode, probeIsolation, resetDryRunModeCache } = require('../src/dry-run-mode');
const { dryRunScript, startupOptions, runInChild, buildSandboxResponse, liveChildren } = require('../src/dry-run');
const { suggestAssertions } = require('../src/assert-suggest');
const { generateRequest } = require('../src/nl-generate');

const RESPONSE = { status: 200, headers: {}, body: '{"id":"a"}' };
const GOOD = `apx.test('ok', () => { apx.expect(apx.response.code).to.equal(200); });`;

function withEnv(value, fn) {
  const prev = process.env.APILIX_AI_DRY_RUN;
  if (value === undefined) delete process.env.APILIX_AI_DRY_RUN; else process.env.APILIX_AI_DRY_RUN = value;
  return Promise.resolve().then(fn).finally(() => { if (prev === undefined) delete process.env.APILIX_AI_DRY_RUN; else process.env.APILIX_AI_DRY_RUN = prev; });
}
const heapOnly = () => ({ ...startupOptions(), execArgv: startupOptions().execArgv.filter(a => !/permission|allow-fs/.test(a)), permission: 'permission' });

test('probe succeeds on the running Node when it enforces the permission model', async () => {
  await withEnv(undefined, async () => {
    const opts = startupOptions();
    const r = await probeIsolation();
    if (opts.permission === 'none') { assert.equal(r.ok, false); return; }
    assert.equal(r.ok, true, r.reason);
    assert.equal((await decideDryRunMode({ fresh: true })).mode, 'isolated');
  });
});

test('probe fails -> parse-only: flags absent, flags ignored by the child, child cannot start, startup throws', async () => {
  await withEnv(undefined, async () => {
    const none = await decideDryRunMode({ fresh: true, startup: () => ({ execArgv: [], env: {}, permission: 'none' }) });
    assert.equal(none.mode, 'parse-only');
    assert.match(none.reason, /no Node permission model flag/);

    // The child runs but does NOT refuse anything (flags missing): the probe sees fs / child_process "allowed".
    const ignored = await decideDryRunMode({ fresh: true, startup: heapOnly });
    assert.equal(ignored.mode, 'parse-only');
    assert.match(ignored.reason, /permissions are not enforced/);
    assert.equal(ignored.transient, false, 'a definitive refusal is memoised');

    const broken = await decideDryRunMode({ fresh: true, startup: () => ({ ...startupOptions(), execArgv: ['--no-such-node-flag'], permission: 'permission' }) });
    assert.equal(broken.mode, 'parse-only');
    assert.match(broken.reason, /probe child did not run/);
    assert.equal(broken.transient, true, 'a probe that could not run is retried later');

    const throwing = await decideDryRunMode({ fresh: true, startup: () => { throw new Error('boom'); } });
    assert.equal(throwing.mode, 'parse-only');
  });
});

test('APILIX_AI_DRY_RUN=off forces parse-only; =force is isolated without a probe (tests / CI)', async () => {
  await withEnv('off', async () => {
    assert.equal(await resolveDryRunMode(), 'parse-only');
    assert.equal((await decideDryRunMode()).reason, 'APILIX_AI_DRY_RUN=off');
  });
  await withEnv('force', async () => {
    let probed = false;
    const d = await decideDryRunMode({ fresh: true, startup: () => { probed = true; return {}; } });
    assert.equal(d.mode, 'isolated');
    assert.equal(probed, false, 'force must not probe');
  });
  await withEnv('OFF ', async () => assert.equal(await resolveDryRunMode(), 'parse-only'));
});

test('the probe is fixed code: model text in the probe payload is never run', async () => {
  const v = await runInChild({ probe: true, code: `apx.test('x', () => {}); throw new Error('ran');`, response: buildSandboxResponse(RESPONSE) });
  assert.equal(v.ok, true);
  assert.ok(v.probe && typeof v.probe.fs === 'string');
  assert.equal(v.tests, undefined);
});

test('the decision is memoised for definitive answers', async () => {
  await withEnv(undefined, async () => {
    resetDryRunModeCache();
    const a = await decideDryRunMode();
    const t0 = Date.now();
    const b = await decideDryRunMode();
    assert.deepEqual(a, b);
    assert.ok(Date.now() - t0 < 20, 'second call must not probe again');
    resetDryRunModeCache();
  });
});

test('parse-only: a valid script spawns NO child and is never executed (canary)', async () => {
  await withEnv('off', async () => {
    const spawned = [];
    const onSpawn = (pid) => spawned.push(pid);
    const ok = await dryRunScript(GOOD, { response: RESPONSE, onSpawn });
    assert.deepEqual([ok.ok, ok.executed, ok.mode], [true, false, 'parse-only']);
    assert.deepEqual(ok.tests, []);
    // A script that would throw, and one that would take long, if they were run: they are only compiled.
    const t0 = Date.now();
    const boom = await dryRunScript(`throw new Error('boom');`, { response: RESPONSE, onSpawn });
    const long = await dryRunScript(`let n = 0; for (let i = 0; i < 1e12; i++) { n = n + i; }`, { response: RESPONSE, onSpawn });
    assert.equal(boom.ok, true);
    assert.equal(long.ok, true);
    assert.ok(Date.now() - t0 < 500, 'nothing was run');
    assert.equal(spawned.length, 0, 'no execution child in parse-only mode');
    assert.equal(liveChildren(), 0);
    // Syntax errors and refused scripts are still rejected.
    const bad = await dryRunScript(`apx.test('x', () => {`, { response: RESPONSE, onSpawn });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /^syntax error/);
    const refused = await dryRunScript(`Object['constructor']('x')()`, { response: RESPONSE, onSpawn });
    assert.equal(refused.ok, false);
    assert.equal(refused.screened, false);
    assert.equal(spawned.length, 0);
  });
});

test('isolated mode still executes, and says so (canary for the parse-only test above)', async () => {
  await withEnv('force', async () => {
    const spawned = [];
    const r = await dryRunScript(GOOD, { response: RESPONSE, onSpawn: (p) => spawned.push(p) });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.executed, true);
    assert.equal(spawned.length, 1);
    const wrong = await dryRunScript(`apx.test('wrong', () => { apx.expect(apx.response.code).to.equal(500); });`, { response: RESPONSE });
    assert.equal(wrong.ok, false, 'strict mode: a failing assertion is discarded when the script is really run');
  });
});

const provider = (data) => ({ complete: async () => ({ data, usage: { inputTokens: 1, outputTokens: 1 }, model: 'm', latencyMs: 1 }) });

test('assert-suggest in parse-only: suggestions carry executed:false, even those that would fail on the response', async () => {
  await withEnv('off', async () => {
    const r = await suggestAssertions({
      provider: provider({ suggestions: [
        { title: 'Status is 200', kind: 'status', confidence: 'high', script: GOOD },
        { title: 'Wrong', kind: 'status', confidence: 'high', script: `apx.test('wrong', () => { apx.expect(apx.response.code).to.equal(500); });` },
      ] }),
      response: RESPONSE,
    });
    assert.equal(r.executed, false);
    assert.equal(r.suggestions.length, 2);
    assert.ok(r.suggestions.every(s => s.executed === false));
  });
});

test('nl-generate in parse-only: executed:false, not "validated", a clear warning, no child spawned, retry only for syntax errors', async () => {
  await withEnv('off', async () => {
    let calls = 0;
    const p = { complete: async () => { calls++; return { data: { name: 'n', method: 'GET', url: 'https://a.test', tests: GOOD }, usage: { inputTokens: 1, outputTokens: 1 } }; } };
    const r = await generateRequest({ provider: p, instruction: 'get a' });
    assert.equal(calls, 1);
    assert.deepEqual([r.validation.validated, r.validation.executed, r.validation.errors.length], [false, false, 0]);
    assert.ok(r.warnings.some(w => /NOT executed/.test(w)));
    assert.equal(r.draft.tests, GOOD);

    // A draft with no script has nothing to run: validated.
    const none = await generateRequest({ provider: { complete: async () => ({ data: { name: 'n', method: 'GET', url: 'https://a.test' }, usage: { inputTokens: 1, outputTokens: 1 } }) }, instruction: 'get a' });
    assert.deepEqual([none.validation.validated, none.validation.executed], [true, true]);

    // A syntax error is still caught (and retried once).
    let n = 0;
    const syn = { complete: async () => { n++; return { data: { name: 'n', method: 'GET', url: 'https://a.test', tests: n === 1 ? `apx.test('x', () => {` : GOOD }, usage: { inputTokens: 1, outputTokens: 1 } }; } };
    const fixed = await generateRequest({ provider: syn, instruction: 'get a' });
    assert.equal(fixed.retried, true);
    assert.equal(fixed.draft.tests, GOOD);
    assert.equal(fixed.validation.executed, false);
  });
});
