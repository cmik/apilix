'use strict';

/**
 * The single decision "may a model-written script be EXECUTED?".
 *
 *  - 'isolated'   : the script runs in the dedicated child (dry-run-worker.js) and the child is KNOWN to run
 *                   under the Node permission model (no fs read beyond its own file, no child_process): this is
 *                   proven by a capability probe, not assumed from a version number or a flag name;
 *  - 'parse-only' : the script is screened and syntax-checked (compiled, never run) and is reported as
 *                   "not executed". Nothing the model wrote runs anywhere.
 *
 * Decision, in order:
 *   1. APILIX_AI_DRY_RUN=off      -> 'parse-only' (operator switch, read at every call);
 *   2. APILIX_AI_DRY_RUN=force    -> 'isolated' WITHOUT a probe (tests / CI only: it trusts the runtime);
 *   3. packaged with pkg          -> 'parse-only' (the worker file cannot be forked from a pkg snapshot);
 *   4. no permission flag known to this runtime (Electron without it, Node < 22.?) -> 'parse-only';
 *   5. otherwise run the probe ONCE with exactly the startup options of a real run (memoised):
 *      the child must refuse an fs read outside its grant AND a child_process with ERR_ACCESS_DENIED.
 *      Probe failed (flags ignored, launch error, timeout, another error code) -> 'parse-only'. A refusal
 *      that is DEFINITIVE (flags ignored, wrong error code) is memoised for the life of the process; a probe
 *      that could not run at all (launch error, timeout) is retried after 30 s.
 *
 * The probe is fixed code (dry-run-worker.js `probe`): it never receives or runs model text. A failed
 * dry-run NEVER falls back to running a script in the server process.
 */

const DENIED = 'ERR_ACCESS_DENIED';
const TRANSIENT_RETRY_MS = 30 * 1000;

/** @type {Promise<{ mode: 'isolated'|'parse-only', reason: string }> | null} */
let cached = null;

function envSwitch() {
  const v = typeof process.env.APILIX_AI_DRY_RUN === 'string' ? process.env.APILIX_AI_DRY_RUN.trim().toLowerCase() : '';
  return v === 'off' || v === 'force' ? v : '';
}

/**
 * Runs the capability probe. `startup` is injectable so a test can simulate a runtime that ignores the flags.
 * @returns {Promise<{ ok: boolean, reason: string }>}
 */
async function probeIsolation(startup) {
  const dryRun = require('./dry-run'); // lazy: dry-run.js requires this module
  const opts = (startup || dryRun.startupOptions)();
  if (process.pkg) return { ok: false, reason: 'packaged with pkg: the worker cannot be started' };
  if (!opts || opts.permission === 'none') return { ok: false, reason: 'this runtime has no Node permission model flag' };
  const v = await dryRun.runInChild({ probe: true }, undefined, { startupOptions: () => opts, bypassQueue: true });
  // The child did not answer (launch error, timeout...): parse-only now, but retried later instead of being memoised for good.
  if (!v || v.ok !== true || !v.probe || typeof v.probe !== 'object') return { ok: false, transient: true, reason: `the probe child did not run (${(v && v.error) || 'no answer'})` };
  if (v.probe.fs !== DENIED || v.probe.cp !== DENIED) {
    return { ok: false, reason: `permissions are not enforced (fs read: ${String(v.probe.fs).slice(0, 40)}, child_process: ${String(v.probe.cp).slice(0, 40)})` };
  }
  return { ok: true, reason: 'permission model verified by probe' };
}

/**
 * @param {{ startup?: () => object, fresh?: boolean }} [opts] `startup`/`fresh` are for tests: a fresh decision is neither read from nor written to the cache.
 * @returns {Promise<{ mode: 'isolated'|'parse-only', reason: string }>}
 */
async function decideDryRunMode(opts = {}) {
  const sw = envSwitch();
  if (sw === 'off') return { mode: 'parse-only', reason: 'APILIX_AI_DRY_RUN=off' };
  if (sw === 'force') return { mode: 'isolated', reason: 'APILIX_AI_DRY_RUN=force (not probed)' };
  if (process.pkg) return { mode: 'parse-only', reason: 'packaged with pkg' };
  const decide = async () => {
    let r;
    try { r = await probeIsolation(opts.startup); } catch (e) { r = { ok: false, transient: true, reason: 'the probe failed' }; }
    return { mode: r.ok ? 'isolated' : 'parse-only', reason: r.reason, transient: r.transient === true };
  };
  if (opts.fresh) return decide();
  if (!cached) {
    const p = decide();
    cached = p;
    p.then((d) => { if (d.transient) { const t = setTimeout(() => { if (cached === p) cached = null; }, TRANSIENT_RETRY_MS); t.unref(); } });
  }
  return cached;
}

/** @returns {Promise<'isolated'|'parse-only'>} */
async function resolveDryRunMode(opts) {
  return (await decideDryRunMode(opts)).mode;
}

/** Test hook: forget the memoised probe result. */
function resetDryRunModeCache() { cached = null; }

module.exports = { resolveDryRunMode, decideDryRunMode, probeIsolation, resetDryRunModeCache, DENIED };
