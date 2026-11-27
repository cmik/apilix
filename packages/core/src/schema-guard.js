'use strict';

/**
 * Time-bounded schema validation.
 *
 * A user-supplied `pattern` can backtrack catastrophically and a synchronous regex cannot be interrupted,
 * so validation runs in a persistent worker thread. The caller stays synchronous (the script sandbox needs
 * that): it blocks on Atomics.wait with the time limit and terminates the worker when the limit is hit
 * (a fresh worker is spawned lazily for the next call).
 *
 * Where worker threads are unavailable (the pkg-compiled CLI binary cannot load a worker script from its
 * snapshot filesystem) validation runs in-process after a static pre-check that rejects patterns prone to
 * catastrophic backtracking. That fallback cannot enforce the time limit; see `mode()`.
 */

const path = require('node:path');
const { validateAgainstSchema } = require('./schema-validator');

const DEFAULT_TIMEOUT_MS = 2000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10000;
const STARTUP_TIMEOUT_MS = 15000;
const MAX_PATTERN_LENGTH = 1000;
const MAX_REGISTRIES = 20;

let defaultTimeoutMs = DEFAULT_TIMEOUT_MS;

/** Clamp to [MIN, MAX]; non-numeric input yields the default. */
function clampTimeoutMs(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)));
}

function setSchemaValidationTimeoutMs(v) { defaultTimeoutMs = clampTimeoutMs(v); return defaultTimeoutMs; }
function getSchemaValidationTimeoutMs() { return defaultTimeoutMs; }

// ─── Static pre-check (fallback only) ────────────────────────────────────────

/**
 * Heuristic detection of catastrophic-backtracking shapes. Flags:
 *  - a quantified group that itself contains an unbounded quantifier or an alternation (`(a+)+`, `(a|a)*`, `(.*)*`)
 *  - a group with a large counted quantifier (>= 10) whose body is optional/unbounded/alternating (`(a?){30}a{30}`)
 *  - a group repeated 2+ times by a bounded/open counted quantifier whose body holds an unbounded quantifier (`(a+){2,9}`, `(a*){3}`)
 *  - three or more adjacent unbounded quantifiers over the same atom (`a*a*a*a*b`, polynomial blow-up)
 *  - backreferences and over-long patterns.
 * Conservative on purpose: it may reject a harmless pattern (e.g. `(X+sep)*` shapes such as `^(\d+\.)+\d+$`),
 * never the common `^[a-z]+$` / `^(\d{3})-\d+$` forms. Polynomial shapes like `a+a+b` are not flagged.
 */
const COUNTED_GROUP_LIMIT = 10;
const ADJACENT_UNBOUNDED_LIMIT = 3;

/** Parse the quantifier starting at p[i]; returns { kind, max, len } (kind: none|optional|unbounded|counted). */
function readQuantifier(p, i) {
  const c = p[i];
  let q = null;
  if (c === '*' || c === '+') q = { kind: 'unbounded', max: Infinity, optional: c === '*', len: 1 };
  else if (c === '?') q = { kind: 'optional', max: 1, optional: true, len: 1 };
  else if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i, i + 24));
    if (m) {
      const min = Number(m[1]);
      const hasComma = m[2] !== undefined;
      const max = !hasComma ? min : (m[3] === '' ? Infinity : Number(m[3]));
      q = { kind: max === Infinity ? 'unbounded' : 'counted', max, optional: min === 0, len: m[0].length };
    }
  }
  if (!q) return { kind: 'none', max: 1, optional: false, len: 0 };
  if (p[i + q.len] === '?' || p[i + q.len] === '+') q.len++; // lazy / possessive suffix
  return q;
}

function isRiskyPattern(p) {
  if (typeof p !== 'string') return false;
  if (p.length > MAX_PATTERN_LENGTH) return true;
  if (/\\[1-9]|\\k</.test(p)) return true;
  const newFrame = (start) => ({ start, unbounded: false, alt: false, optional: false, run: null });
  const stack = [];
  let cur = newFrame(0);
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    let atom = null;
    let group = null;
    if (c === '\\') { atom = p.slice(i, i + 2); i++; }
    else if (c === '[') {
      let j = i + 1;
      while (j < p.length && p[j] !== ']') { if (p[j] === '\\') j++; j++; }
      atom = p.slice(i, j + 1);
      i = Math.min(j, p.length - 1);
    } else if (c === '(') {
      stack.push(cur);
      cur = newFrame(i);
      const prefix = /^\(\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(p.slice(i, i + 40));
      if (prefix) i += prefix[0].length - 1;
      continue;
    } else if (c === ')') {
      if (!stack.length) continue;
      group = cur;
      atom = p.slice(group.start, i + 1);
      cur = stack.pop();
    } else if (c === '|') { cur.alt = true; cur.run = null; continue; }
    else if (c === '^' || c === '$') { cur.run = null; continue; }
    else atom = c;

    const q = readQuantifier(p, i + 1);
    i += q.len;

    if (group) {
      const inner = group.unbounded || group.alt;
      if (q.kind === 'unbounded' && inner) return true;
      // bounded outer repeat ({2,9}, {3}, {2,}) around an unbounded body: `(a+){2,9}`, `(a*){3}` is exponential/high-degree
      if ((q.kind === 'counted' || q.kind === 'unbounded') && q.max >= 2 && group.unbounded) return true;
      if ((q.kind === 'counted' || q.kind === 'unbounded') && q.max >= COUNTED_GROUP_LIMIT && (inner || group.optional)) return true;
      if (group.unbounded || q.kind === 'unbounded') cur.unbounded = true;
      if (group.optional || q.optional) cur.optional = true;
    } else {
      if (q.kind === 'unbounded') cur.unbounded = true;
      if (q.optional) cur.optional = true;
    }

    if (q.kind === 'unbounded') {
      cur.run = cur.run && cur.run.atom === atom ? { atom, count: cur.run.count + 1 } : { atom, count: 1 };
      if (cur.run.count >= ADJACENT_UNBOUNDED_LIMIT) return true;
    } else {
      cur.run = null;
    }
  }
  return false;
}

/**
 * Collect `pattern` / `patternProperties` keys of a schema tree. Data keywords (enum/const/default/examples) are
 * skipped only as keywords: a property literally named "enum" under properties/$defs/... is still walked.
 */
const SCHEMA_MAP_KEYWORDS = new Set(['properties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);
const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples']);

function collectPatterns(node, out, refs, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 64) return;
  if (Array.isArray(node)) { for (const n of node) collectPatterns(n, out, refs, depth + 1); return; }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'pattern' && typeof v === 'string') out.push(v);
    else if (k === 'patternProperties' && v && typeof v === 'object') {
      out.push(...Object.keys(v));
      for (const sub of Object.values(v)) collectPatterns(sub, out, refs, depth + 1);
    }
    else if (k === '$ref' && typeof v === 'string') refs.add(v);
    else if (DATA_KEYWORDS.has(k)) continue;
    else if (SCHEMA_MAP_KEYWORDS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const sub of Object.values(v)) collectPatterns(sub, out, refs, depth + 1);
    }
    else collectPatterns(v, out, refs, depth + 1);
  }
}

/** True when the schema (or a registry schema it `$ref`s by name) holds a risky pattern. */
function schemaHasRiskyPattern(schema, registry) {
  const byName = new Map((registry || []).map(r => [r.name, r.schema]));
  const seen = new Set();
  const queue = [schema];
  while (queue.length) {
    const node = queue.shift();
    const patterns = [];
    const refs = new Set();
    collectPatterns(node, patterns, refs);
    if (patterns.some(isRiskyPattern)) return true;
    for (const r of refs) {
      if (byName.has(r) && !seen.has(r)) { seen.add(r); queue.push(byName.get(r)); }
    }
  }
  return false;
}

// ─── Worker management ───────────────────────────────────────────────────────

let wt;
try { wt = require('node:worker_threads'); } catch (_) { wt = null; }

/** Workers cannot load scripts from the pkg snapshot; opt out with APILIX_SCHEMA_NO_WORKER=1 (also used by tests). */
function workersAvailable() {
  return !!wt && typeof SharedArrayBuffer === 'function' && !process.pkg && process.env.APILIX_SCHEMA_NO_WORKER !== '1';
}

let state = null; // { worker, port, flag } while a worker is alive
let workerBroken = false; // spawning failed once -> stick to the in-process fallback

function dropWorker() {
  if (!state) return;
  const { worker, port } = state;
  state = null;
  try { port.close(); } catch (_) { /* ignore */ }
  try { worker.terminate().catch(() => {}); } catch (_) { /* ignore */ }
}

function waitReply(timeoutMs) {
  const { flag, port } = state;
  const r = Atomics.wait(flag, 0, 0, timeoutMs);
  if (r === 'timed-out') return null;
  const m = wt.receiveMessageOnPort(port);
  Atomics.store(flag, 0, 0);
  return m ? m.message : null;
}

function ensureWorker() {
  if (state) return true;
  if (workerBroken) return false;
  try {
    const sab = new SharedArrayBuffer(4);
    const { port1, port2 } = new wt.MessageChannel();
    const worker = new wt.Worker(path.join(__dirname, 'schema-guard-worker.js'), {
      workerData: { sab, port: port2 }, transferList: [port2], stdout: true, stderr: true,
    });
    worker.unref();
    worker.on('error', () => { if (state && state.worker === worker) dropWorker(); });
    worker.on('exit', () => { if (state && state.worker === worker) { state = null; } });
    state = { worker, port: port1, flag: new Int32Array(sab), sent: new Set() };
    state.worker.postMessage({ type: 'ping' });
    const m = waitReply(STARTUP_TIMEOUT_MS);
    if (!m || m.type !== 'ready') { dropWorker(); workerBroken = true; return false; }
    return true;
  } catch (_) {
    dropWorker();
    workerBroken = true;
    return false;
  }
}

function timeoutResult(ms) {
  return {
    valid: false,
    timedOut: true,
    errors: [{ path: '', keyword: 'timeout', message: `Schema validation exceeded the ${ms} ms time limit` }],
  };
}

function unsafeResult() {
  return {
    valid: false,
    unsafePattern: true,
    errors: [{ path: '', keyword: 'unsafe-pattern', message: 'Schema contains a regular expression that may cause catastrophic backtracking; validation skipped' }],
  };
}

const TIMEOUT_NOT_ENFORCED_WARNING = 'Schema validation time limit is not enforced in this runtime (worker threads are unavailable); patterns prone to catastrophic backtracking are skipped instead.';

/** A warning string when the time limit cannot be enforced (static-check mode), otherwise null. */
function getTimeoutWarning() { return mode() === 'static-check' ? TIMEOUT_NOT_ENFORCED_WARNING : null; }

function serializationErrorResult() {
  return {
    valid: false,
    schemaError: 'Schema or data could not be serialised for time-bounded validation',
    errors: [{ path: '', keyword: 'schema', message: 'Schema or data could not be serialised for time-bounded validation' }],
  };
}

function inProcess(nameOrSchema, data, opts) {
  const registry = Array.isArray(opts.schemas) ? opts.schemas : [];
  let schema = nameOrSchema;
  if (typeof nameOrSchema === 'string') { const e = registry.find(r => r.name === nameOrSchema); schema = e ? e.schema : null; }
  if (schema && schemaHasRiskyPattern(schema, registry)) return unsafeResult();
  return validateAgainstSchema(nameOrSchema, data, opts);
}

// Registry fingerprints are memoised by array identity so a large registry is not re-stringified per validation.
const fingerprintCache = new WeakMap();
function registryFingerprint(registry) {
  let fp = fingerprintCache.get(registry);
  if (fp === undefined) {
    fp = JSON.stringify(registry.map(s => [s && s.name, s && s.schema]));
    fingerprintCache.set(registry, fp);
  }
  return fp;
}

function viaWorker(nameOrSchema, data, opts, timeoutMs) {
  const registry = Array.isArray(opts.schemas) ? opts.schemas : [];
  const fp = `${opts.allErrors ? 1 : 0}|${registryFingerprint(registry)}`;
  const known = state.sent.has(fp);
  let msg = { type: 'validate', fp, schema: nameOrSchema, data, allErrors: !!opts.allErrors };
  if (!known) msg.schemas = registry;
  try { state.worker.postMessage(msg); } catch (_) {
    // Not structured-cloneable: JSON round-trip once; if that fails too, report an error rather than
    // running the unbounded in-process path.
    try { msg = JSON.parse(JSON.stringify(msg)); } catch (__) { return serializationErrorResult(); }
    try { state.worker.postMessage(msg); } catch (__) { return serializationErrorResult(); }
  }
  if (!known) { state.sent.add(fp); if (state.sent.size > MAX_REGISTRIES) state.sent.delete(state.sent.values().next().value); }
  const m = waitReply(timeoutMs);
  if (!m) { dropWorker(); return timeoutResult(timeoutMs); }
  if (m.type === 'need-schemas') { state.sent.delete(fp); return viaWorker(nameOrSchema, data, opts, timeoutMs); }
  if (m.type === 'throw') throw new Error(m.message);
  return m.result;
}

/**
 * Validate with a time limit. Same contract as validateAgainstSchema (an unknown registry name throws), plus
 * on overrun `{ valid:false, timedOut:true, errors:[{keyword:'timeout'}] }` and, in the worker-less fallback,
 * `{ valid:false, unsafePattern:true, errors:[{keyword:'unsafe-pattern'}] }`. Never crashes the caller.
 *
 * @param {string|object} nameOrSchema
 * @param {unknown} data
 * @param {{ schemas?: Array<{name:string,schema:object}>, allErrors?: boolean, timeoutMs?: number }} [opts]
 */
function validateWithTimeout(nameOrSchema, data, opts = {}) {
  const timeoutMs = opts.timeoutMs === undefined ? defaultTimeoutMs : clampTimeoutMs(opts.timeoutMs);
  if (workersAvailable() && ensureWorker()) {
    return viaWorker(nameOrSchema, data, opts, timeoutMs);
  }
  return inProcess(nameOrSchema, data, opts);
}

/** 'worker' (time limit enforced) or 'static-check' (pre-check only, no time limit). */
function mode() { return workersAvailable() && !workerBroken ? 'worker' : 'static-check'; }

module.exports = {
  DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS,
  clampTimeoutMs, setSchemaValidationTimeoutMs, getSchemaValidationTimeoutMs,
  validateWithTimeout, isRiskyPattern, schemaHasRiskyPattern, mode, getTimeoutWarning, TIMEOUT_NOT_ENFORCED_WARNING,
  _shutdown: dropWorker,
};
