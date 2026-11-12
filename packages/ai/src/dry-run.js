'use strict';

/**
 * Dry-run model-written scripts, offline, in a DEDICATED CHILD PROCESS (dry-run-worker.js).
 *
 * A model-written script (possibly steered by a prompt injection in a response body) never runs in the
 * server process: the parent only sends JSON, reads back JSON, and enforces a SIGKILL deadline. The child
 * has an empty environment, a small heap and, when Node supports it, the permission model with no
 * fs / child_process / worker / addon grant. See startupOptions() for exactly what is applied where.
 *
 * Nothing here is ever applied: the result only says whether a script is fit to be shown. Two modes:
 *  - strict  (assertion suggestions): the script ran on the very response that inspired it, so every
 *            test must pass and a test must exist (a capture must set a variable);
 *  - lenient (generated requests): the response is a stand-in, so assertion mismatches and "cannot
 *            read property of undefined" are expected and tolerated; syntax errors, unknown
 *            identifiers and API misuse are not.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork } = require('child_process');
const vm = require('vm');
const { screenScript } = require('./script-screen');
const { resolveDryRunMode } = require('./dry-run-mode');

const WORKER_PATH = path.join(__dirname, 'dry-run-worker.js');
const WALL_CLOCK_MS = 3000;       // SIGKILL deadline for the child (startup included)
const SYNC_TIMEOUT_MS = 1000;     // vm timeout inside the child, per phase
const MAX_OUTPUT_BYTES = 256 * 1024;
const HEAP_LIMIT_MB = 64;
const MAX_CONCURRENT_CHILDREN = 2; // process-wide; a request itself validates scripts one after the other
const MAX_WAITING = 8;             // runs allowed to queue behind the live children; beyond: immediate "busy"

// Errors that say "the script itself is wrong" (as opposed to "the stand-in response is not what it expects").
const STRUCTURAL_ERROR_RE = /is not defined|is not a function|is not a constructor|is not iterable|Unexpected (?:token|identifier|end|string|number)|Invalid or unexpected token|Invalid regular expression|Missing initializer|has already been declared|Assignment to constant|Illegal (?:return|break|continue)|await is only valid|offline \(dry-run\) mode|Cannot (?:set|assign|define)|is not allowed in a validated script|Unexpected strict mode|SyntaxError|Script execution timed out|ReferenceError/i;
// On a stand-in response these are expected, not bugs.
const TOLERATED_ERROR_RE = /^(?:AssertionError|expected|Expected|assert)|Cannot read propert|Cannot destructure|of undefined|of null|undefined|is not valid JSON|Unexpected token .* in JSON/;

function buildSandboxResponse(res) {
  const body = typeof res.body === 'string' ? res.body : '';
  let jsonData = body;
  try { jsonData = JSON.parse(body); } catch { /* keep text */ }
  return {
    code: Number.isInteger(res.status) ? res.status : 200,
    status: typeof res.statusText === 'string' ? res.statusText : '',
    responseTime: Number.isFinite(res.responseTime) ? res.responseTime : 100,
    headers: res.headers && typeof res.headers === 'object' ? res.headers : {},
    body,
    jsonData,
  };
}

function realWorkerPath() {
  try { return fs.realpathSync(WORKER_PATH); } catch { return WORKER_PATH; }
}

/**
 * Flags and env of the child. Honest about what is requested (whether it is ENFORCED is decided by the
 * capability probe in dry-run-mode.js, never assumed here):
 *  - always: empty env (Electron: ELECTRON_RUN_AS_NODE only), --max-old-space-size, --disallow-code-generation-from-strings;
 *  - when the runtime knows the permission model (>= 23.5 `--permission`, 22.x `--experimental-permission`;
 *    Electron included, its embedded Node is asked the same way): no fs read except the worker file itself,
 *    no fs write, no child_process, no worker threads, no native addons. Node's permission model has NO
 *    network restriction in these versions: the barrier against the network is that the script has no
 *    reference to any host object;
 *  - otherwise `permission` is 'none' and the mode resolves to 'parse-only'.
 * Not applied anywhere: an RSS / off-heap cap. --max-old-space-size bounds the V8 heap only; ulimit / job
 * object limits are not portable, so binary memory is handled by refusing and deleting its globals.
 * @returns {{ execArgv: string[], env: Record<string,string>, permission: 'permission'|'experimental-permission'|'none' }}
 */
function startupOptions() {
  const execArgv = [`--max-old-space-size=${HEAP_LIMIT_MB}`, '--disallow-code-generation-from-strings'];
  const env = {};
  let permission = 'none';
  if (process.versions && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const known = process.allowedNodeEnvironmentFlags;
  if (known.has('--permission')) permission = 'permission';
  else if (known.has('--experimental-permission')) permission = 'experimental-permission';
  if (permission !== 'none') {
    // Node resolves the entry point's real path before running it, so the grant must be the real path.
    execArgv.push(`--${permission}`, `--allow-fs-read=${realWorkerPath()}`);
  }
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return { execArgv, env, permission };
}

// Process-wide ceiling on live children, with a bounded FIFO queue (a request never holds more than one).
let activeChildren = 0;
const waiters = [];
function acquireSlot(signal) {
  if (activeChildren < MAX_CONCURRENT_CHILDREN) { activeChildren++; return Promise.resolve(); }
  if (waiters.length >= MAX_WAITING) return Promise.reject(Object.assign(new Error('busy'), { busy: true }));
  return new Promise((resolve, reject) => {
    const entry = { resolve: () => { cleanup(); activeChildren++; resolve(); } };
    const onAbort = () => { const i = waiters.indexOf(entry); if (i !== -1) waiters.splice(i, 1); cleanup(); reject(new Error('aborted')); };
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    waiters.push(entry);
  });
}
function releaseSlot() {
  activeChildren--;
  const next = waiters.shift();
  if (next) next.resolve();
}

/**
 * Run one script in a fresh child. Resolves with the child's JSON verdict, or { ok: false, error } when the
 * child died, timed out, produced too much output or was cancelled. Never rejects, never leaves a child alive.
 */
async function runInChild(payload, signal, hooks = {}) {
  if (process.pkg) return { ok: false, error: 'unavailable' }; // the worker file is not forkable from a pkg snapshot
  if (signal && signal.aborted) return { ok: false, error: 'aborted' };
  // The (single, fixed-code) capability probe skips the queue: being busy must not be read as "no isolation".
  const counted = hooks.bypassQueue !== true;
  if (counted) try { await acquireSlot(signal); } catch (e) { return { ok: false, error: e && e.busy ? 'busy' : 'aborted' }; }
  let child = null;
  let timer = null;
  let onAbort = null;
  try {
    const { execArgv, env } = (typeof hooks.startupOptions === 'function' ? hooks.startupOptions : startupOptions)();
    return await new Promise((resolve) => {
      let out = '';
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        child = fork(realWorkerPath(), [], {
          env, execArgv, cwd: os.tmpdir(), serialization: 'json', windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore', 'ipc'],
        });
      } catch { finish({ ok: false, error: 'spawn failed' }); return; }
      if (typeof hooks.onSpawn === 'function') { try { hooks.onSpawn(child.pid); } catch { /* observer only */ } }
      timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ ok: false, error: 'timeout' }); }, WALL_CLOCK_MS);
      if (signal) {
        onAbort = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ ok: false, error: 'aborted' }); };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        out += chunk;
        if (out.length > MAX_OUTPUT_BYTES) { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ ok: false, error: 'output too large' }); }
      });
      child.on('error', () => finish({ ok: false, error: 'child error' }));
      child.on('exit', () => {
        // stdout may still hold the last chunk: let the stream end first.
        setImmediate(() => {
          try { finish(JSON.parse(out.trim().split('\n').pop() || '')); } catch { finish({ ok: false, error: 'child crashed' }); }
        });
      });
      try { child.send(payload, (err) => { if (err) finish({ ok: false, error: 'child error' }); }); } catch { finish({ ok: false, error: 'child error' }); }
    });
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    if (child) {
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* gone */ }
      try { child.stdout && child.stdout.destroy(); } catch { /* closed */ }
      try { if (child.connected) child.disconnect(); } catch { /* closed */ }
      child.unref();
    }
    if (counted) releaseSlot();
  }
}

/**
 * Syntax check WITHOUT execution: `new vm.Script` only parses and compiles. No `run*` method is ever called on
 * the result and nothing is evaluated, so compiling in the server process cannot run the model's code (a
 * pathological nesting is a caught RangeError; the length is already capped by the screen).
 * @returns {string | null} the syntax error message, or null when the script compiles.
 */
function parseOnlyCheck(code) {
  try {
    new vm.Script(`(async function(){\n'use strict';\n${code}\n})`, { filename: 'apilix-parse-only.js' }); // eslint-disable-line no-new
    return null;
  } catch (e) {
    return String((e && e.message) || 'invalid script').slice(0, 160);
  }
}

/**
 * @param {string} code
 * @param {{ response: { status?: number, statusText?: string, headers?: object, body?: string, responseTime?: number },
 *           mode?: 'strict'|'lenient', expects?: 'test'|'capture'|'any', variables?: Record<string,string>,
 *           signal?: AbortSignal, onSpawn?: (pid:number)=>void }} opts
 * @returns {Promise<{ ok: boolean, reason?: string, screened?: boolean, tests: Array<{name:string, passed:boolean, error?:string}>, variables: Record<string,string> }>}
 */
async function dryRunScript(code, opts = {}) {
  const { response, mode = 'strict', expects = 'any', variables = {}, signal, onSpawn } = opts;
  const fail = (reason, extra = {}) => ({ ok: false, reason, tests: [], variables: {}, ...extra });

  // Defence in depth only: a refused script is NEVER sent to the child either.
  const screened = screenScript(code);
  if (!screened.ok) return fail(screened.reason, { screened: false });

  // THE gate: a script is executed only when the child is proven to run under the permission model.
  // Otherwise it is only compiled (never run) and reported as not executed. Never an in-process fallback.
  const dryMode = await resolveDryRunMode();
  if (dryMode !== 'isolated') {
    const syntax = parseOnlyCheck(code);
    if (syntax) return fail(`syntax error: ${syntax}`);
    return { ok: true, executed: false, mode: dryMode, tests: [], variables: {} };
  }

  const verdict = await runInChild({ code, response: buildSandboxResponse(response || {}), variables: { ...variables }, timeoutMs: SYNC_TIMEOUT_MS }, signal, { onSpawn });
  if (verdict.ok !== true) {
    if (verdict.syntaxError) return fail(`syntax error: ${verdict.syntaxError}`);
    if (verdict.error === 'aborted') return fail('cancelled', { infra: true });
    if (verdict.error === 'busy') return fail('too many scripts are being validated right now: not validated', { infra: true });
    if (verdict.error === 'unavailable') return fail('scripts cannot be validated in this build', { infra: true });
    if (verdict.error === 'timeout') return fail('the script did not finish in time');
    return fail('the script could not be run');
  }
  if (verdict.done !== true) return fail('the script did not finish in time');
  const result = { tests: verdict.tests, variables: verdict.variables };

  const tests = (result.tests || []).map(t => ({ name: String(t.name), passed: t.passed === true, ...(t.error ? { error: String(t.error).slice(0, 300) } : {}) }));
  const vars = result.variables || {};
  const failed = tests.filter(t => !t.passed);

  if (mode === 'lenient') {
    const broken = failed.find(t => STRUCTURAL_ERROR_RE.test(t.error || '') || !TOLERATED_ERROR_RE.test(t.error || ''));
    if (broken) return { ok: false, reason: `${broken.name === '__ScriptError__' ? 'script error' : 'test error'}: ${broken.error || 'failed'}`.slice(0, 240), tests, variables: vars };
    return { ok: true, executed: true, tests, variables: vars };
  }

  if (failed.length) {
    const f = failed[0];
    return { ok: false, reason: `${f.name === '__ScriptError__' ? 'script error' : `"${f.name}" fails on the response`}: ${f.error || 'failed'}`.slice(0, 240), tests, variables: vars };
  }
  if (expects === 'test' && tests.length === 0) return { ok: false, reason: 'the script registers no test', tests, variables: vars };
  if (expects === 'capture') {
    const values = Object.values(vars);
    if (!values.length || values.every(v => v === 'undefined' || v === 'null' || v === '')) {
      return { ok: false, reason: 'the script does not save a value on this response', tests, variables: vars };
    }
  }
  return { ok: true, executed: true, tests, variables: vars };
}

function liveChildren() { return activeChildren; }
function waitingRuns() { return waiters.length; }

module.exports = { dryRunScript, parseOnlyCheck, buildSandboxResponse, STRUCTURAL_ERROR_RE, runInChild, startupOptions, liveChildren, waitingRuns, WALL_CLOCK_MS, MAX_CONCURRENT_CHILDREN, MAX_WAITING };
