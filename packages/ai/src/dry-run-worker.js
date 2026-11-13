'use strict';

/**
 * Child-process runner for model-written scripts (see dry-run.js, which forks this file).
 *
 * THIS FILE MUST NEVER BE `require`d by the server process: it is an entry point. It is started with an
 * empty environment, a low heap limit and, when the Node version supports it, the permission model with
 * no fs/child_process/worker/addon grant. It reads ONE message from the parent over IPC
 * ({ code, response, variables, timeoutMs }), runs the script, writes ONE JSON line on stdout and exits.
 *
 * The script runs in a fresh `vm` context that is built defensively:
 *  - the context global is a null-prototype object, so no property lookup can fall back to a host
 *    prototype (`this.constructor` resolves inside the context, never to the worker's `Object`);
 *  - every intrinsic the script sees (`Object`, `Array`, `JSON`...) is the context's OWN one, there is no
 *    Buffer / process / require / crypto / timer in the context;
 *  - code generation from strings (`eval`, `new Function`) and WebAssembly are disabled for the context;
 *  - the host hands over data as ONE JSON string and reads back ONE string. No host function or host object
 *    is ever visible to the script, so there is no host constructor to reach;
 *  - `microtaskMode: 'afterEvaluate'` drains promise jobs inside `runInContext`, where the vm `timeout`
 *    applies: an endless promise chain / `await` loop is interrupted, and nothing can stay pending
 *    because the context has no timers or I/O.
 * Plain `while(true){}` and catastrophic regexes are bounded by the vm timeout and, as a last resort, by
 * the parent's SIGKILL deadline. None of this is a claim of a perfect sandbox: see wiki/AI-Features.md.
 */

const vm = require('vm');

const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_TESTS = 100;
const MAX_VARIABLES = 50;
const MAX_STRING = 2000;

/**
 * Evaluated INSIDE the context (its source is extracted with Function.prototype.toString), so it cannot
 * close over anything of this file. Takes the input as ONE JSON string, defines the non-writable globals
 * `apx`, `pm` and `console`, and RETURNS the collector `{ exec, finish }`. The collector is only ever held
 * by the host (the return value of runInContext): it is not a global of the context, so a script has no
 * name through which it could read or overwrite it, and cannot forge the verdict.
 */
function bootstrap(inputJson) {
  'use strict';
  const input = JSON.parse(inputJson);
  const thenOf = Promise.prototype.then; // captured before any script runs: a patched `then` cannot hijack the collector
  const callThen = Function.prototype.call;
  // Defence in depth against off-heap memory (--max-old-space-size does not bound ArrayBuffers): none of the
  // binary-memory globals exist for the script. The static screen refuses their names as well.
  for (const name of ['ArrayBuffer', 'SharedArrayBuffer', 'Atomics', 'WebAssembly', 'DataView', 'Int8Array', 'Uint8Array',
    'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array',
    'Float64Array', 'BigInt64Array', 'BigUint64Array', 'WeakRef', 'FinalizationRegistry']) {
    try { delete globalThis[name]; } catch (e) { /* already absent */ }
  }
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const keysOf = Object.keys;
  const has = Object.prototype.hasOwnProperty;
  const arrayIs = Array.isArray;
  const tests = [];
  const vars = {};
  const state = { done: false };
  const resp = input.response;
  const headersSrc = resp.headers || {};

  function createExpect(value, negated) {
    const n = negated ? 'not ' : '';
    const assert = (cond, message) => { if (negated ? cond : !cond) throw new Error(message); };
    const show = (v) => { try { const s = stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); } };
    const obj = {
      get not() { return createExpect(value, !negated); },
      get to() { return obj; }, get be() { return obj; }, get been() { return obj; }, get is() { return obj; },
      get that() { return obj; }, get which() { return obj; }, get and() { return obj; }, get has() { return obj; },
      get have() { return obj; }, get with() { return obj; }, get at() { return obj; }, get of() { return obj; },
      get same() { return obj; }, get does() { return obj; }, get still() { return obj; }, get also() { return obj; },
      get ok() { assert(value != null && value !== false && value !== 0 && value !== '', `Expected value to be ${n}truthy, got ${show(value)}`); return obj; },
      get true() { assert(value === true, `Expected ${show(value)} to ${n}be true`); return obj; },
      get false() { assert(value === false, `Expected ${show(value)} to ${n}be false`); return obj; },
      get null() { assert(value === null, `Expected ${show(value)} to ${n}be null`); return obj; },
      get undefined() { assert(value === undefined, `Expected ${show(value)} to ${n}be undefined`); return obj; },
      get NaN() { assert(Number.isNaN(value), `Expected ${show(value)} to ${n}be NaN`); return obj; },
      get exist() { assert(value != null, `Expected value to ${n}exist`); return obj; },
      get empty() {
        if (typeof value === 'string' || arrayIs(value)) assert(value.length === 0, `Expected value to ${n}be empty`);
        else if (value !== null && typeof value === 'object') assert(keysOf(value).length === 0, `Expected object to ${n}be empty`);
        else assert(!value, `Expected value to ${n}be empty`);
        return obj;
      },
      get positive() { assert(typeof value === 'number' && value > 0, `Expected ${value} to ${n}be positive`); return obj; },
      get negative() { assert(typeof value === 'number' && value < 0, `Expected ${value} to ${n}be negative`); return obj; },
      get integer() { assert(Number.isInteger(value), `Expected ${value} to ${n}be an integer`); return obj; },
      get finite() { assert(Number.isFinite(value), `Expected ${value} to ${n}be finite`); return obj; },
      equal(x) { assert(value === x, `Expected ${show(value)} to ${n}equal ${show(x)}`); return obj; },
      eql(x) { assert(show(value) === show(x), `Expected ${show(value)} to ${n}deep equal ${show(x)}`); return obj; },
      include(x) {
        if (typeof value === 'string') assert(value.includes(x), `Expected "${value}" to ${n}include "${x}"`);
        else if (arrayIs(value)) assert(value.includes(x), `Expected array to ${n}include ${show(x)}`);
        else throw new Error(`Cannot check include on ${typeof value}`);
        return obj;
      },
      above(x) { assert(value > x, `Expected ${value} to ${n}be above ${x}`); return obj; },
      below(x) { assert(value < x, `Expected ${value} to ${n}be below ${x}`); return obj; },
      least(x) { assert(value >= x, `Expected ${value} to ${n}be at least ${x}`); return obj; },
      most(x) { assert(value <= x, `Expected ${value} to ${n}be at most ${x}`); return obj; },
      within(lo, hi) { assert(value >= lo && value <= hi, `Expected ${value} to ${n}be within ${lo}..${hi}`); return obj; },
      closeTo(x, d) { assert(Math.abs(value - x) <= d, `Expected ${value} to be close to ${x} (+/- ${d})`); return obj; },
      lengthOf(len) { assert(value != null && value.length === len, `Expected length ${value == null ? undefined : value.length} to ${n}equal ${len}`); return obj; },
      property(name, val) {
        assert(name in Object(value), `Expected object to ${n}have property "${name}"`);
        if (val !== undefined) assert(value[name] === val, `Expected property "${name}" to equal ${show(val)}`);
        return obj;
      },
      a(type) {
        const actual = arrayIs(value) ? 'array' : typeof value;
        assert(actual === type, `Expected ${show(value)} to ${n}be a ${type}`);
        return obj;
      },
      an(type) { return obj.a(type); },
      instanceOf(ctor) { assert(value instanceof ctor, `Expected value to ${n}be instance of ${ctor && ctor.name}`); return obj; },
      match(re) { assert(re.test(value), `Expected "${value}" to ${n}match ${re}`); return obj; },
      keys(list) {
        const v = Object(value);
        const ks = arrayIs(list) ? list : [list];
        assert(ks.every(k => k in v), `Expected object to ${n}have all keys: ${ks.join(', ')}`);
        return obj;
      },
      key(k) { return obj.keys([k]); },
      string(x) { assert(typeof value === 'string' && value.includes(x), `Expected string to contain "${x}"`); return obj; },
      startWith(s) { assert(typeof value === 'string' && value.startsWith(s), `Expected "${value}" to ${n}start with "${s}"`); return obj; },
      endWith(s) { assert(typeof value === 'string' && value.endsWith(s), `Expected "${value}" to ${n}end with "${s}"`); return obj; },
      oneOf(list) { assert(arrayIs(list) && list.includes(value), `Expected ${show(value)} to ${n}be one of ${show(list)}`); return obj; },
      members(list) {
        if (!arrayIs(value) || !arrayIs(list)) throw new Error('members() requires both values to be arrays');
        const a = value.map(show).sort(); const b = list.map(show).sort();
        assert(a.length === b.length && a.every((v, i) => v === b[i]), `Expected arrays to ${n}have the same members`);
        return obj;
      },
      includeMembers(list) {
        if (!arrayIs(value) || !arrayIs(list)) throw new Error('includeMembers() requires both values to be arrays');
        const a = value.map(show);
        assert(list.every(x => a.includes(show(x))), `Expected array to ${n}include all members ${show(list)}`);
        return obj;
      },
      everyItem(fn) { assert(arrayIs(value) && value.every(fn), `Expected every item to ${n}satisfy predicate`); return obj; },
      someItem(fn) { assert(arrayIs(value) && value.some(fn), `Expected some item to ${n}satisfy predicate`); return obj; },
      subset(expected) {
        const sub = (act, exp) => {
          if (typeof exp !== 'object' || exp === null) return show(act) === show(exp);
          if (typeof act !== 'object' || act === null) return false;
          return keysOf(exp).every(k => k in act && sub(act[k], exp[k]));
        };
        assert(sub(value, expected), `Expected object to ${n}contain subset ${show(expected)}`);
        return obj;
      },
      satisfy(fn) { assert(!!fn(value), `Expected value to ${n}satisfy predicate`); return obj; },
    };
    obj.equals = obj.equal; obj.eq = obj.equal; obj.eqls = obj.eql;
    obj.includes = obj.include; obj.contain = obj.include; obj.contains = obj.include;
    obj.gt = obj.above; obj.greaterThan = obj.above; obj.lt = obj.below; obj.lessThan = obj.below;
    obj.gte = obj.least; obj.lte = obj.most; obj.satisfies = obj.satisfy;
    obj.deep = { equal: obj.eql };
    return obj;
  }

  const findHeader = (name) => keysOf(headersSrc).find(k => k.toLowerCase() === String(name).toLowerCase());
  const store = {
    get(k) { k = String(k).trim(); return has.call(vars, k) ? vars[k] : (has.call(input.variables, k) ? input.variables[k] : undefined); },
    set(k, v) { vars[String(k).trim()] = String(v); },
    unset(k) { delete vars[String(k).trim()]; },
    has(k) { k = String(k).trim(); return has.call(vars, k) || has.call(input.variables, k); },
    clear() { keysOf(vars).forEach(k => { delete vars[k]; }); },
    toObject() { return Object.assign({}, input.variables, vars); },
  };
  const response = {
    code: resp.code,
    status: resp.status,
    responseTime: resp.responseTime,
    json() { return typeof resp.jsonData === 'string' ? (() => { try { return parse(resp.jsonData); } catch (e) { return null; } })() : resp.jsonData; },
    text() { return resp.body; },
    headers: {
      get(name) { const k = findHeader(name); return k ? headersSrc[k] : undefined; },
      has(name) { return findHeader(name) !== undefined; },
      toObject() { return Object.assign({}, headersSrc); },
    },
    to: {
      have: {
        status(c) { if (resp.code !== c) throw new Error(`Expected response status to be ${c} but got ${resp.code}`); },
        header(name, val) {
          const k = findHeader(name);
          if (!k) throw new Error(`Expected response to have header "${name}"`);
          if (val !== undefined && headersSrc[k] !== val) throw new Error(`Expected header "${name}" to equal "${val}" but got "${headersSrc[k]}"`);
        },
        body(text) { if (!resp.body.includes(text)) throw new Error(`Expected response body to include "${text}"`); },
        jsonBody() { try { parse(resp.body); } catch (e) { throw new Error('Expected response to have valid JSON body'); } },
      },
      be: { ok() { if (resp.code < 200 || resp.code >= 300) throw new Error(`Expected response to be OK (2xx) but got ${resp.code}`); } },
    },
    get size() { return resp.body ? resp.body.length : 0; },
  };
  const test = (name, fn) => {
    try { fn(); tests.push({ name: String(name), passed: true, error: null }); } catch (e) {
      tests.push({ name: String(name), passed: false, error: String(e && e.message) });
    }
  };
  test.skip = (name) => { tests.push({ name: String(name), passed: null, error: null, skipped: true }); };
  const apx = {
    test,
    expect: (v) => createExpect(v, false),
    environment: store, collection: store, collectionVariables: store, globals: store, variables: store,
    iterationData: { get: (k) => input.variables[k], has: (k) => has.call(input.variables, k) },
    info: { requestId: '', iteration: 1, eventName: 'test' },
    response,
    sendRequest() { throw new Error('apx.sendRequest is disabled in offline (dry-run) mode'); },
  };
  const noop = () => {};
  const lock = (name, value) => Object.defineProperty(globalThis, name, { value, writable: false, configurable: false, enumerable: false });
  lock('apx', apx);
  lock('pm', apx);
  lock('console', { log: noop, warn: noop, error: noop, info: noop });
  return {
    // `promise` is the (native) promise of the script's async wrapper, handed over by the host.
    exec(promise) {
      callThen.call(thenOf, promise,
        () => { state.done = true; },
        (e) => { tests.push({ name: '__ScriptError__', passed: false, error: String(e && e.message) }); state.done = true; });
    },
    finish() { return stringify({ done: state.done, tests, variables: vars }); },
  };
}

function clip(s, n = MAX_STRING) { return typeof s === 'string' && s.length > n ? s.slice(0, n) : s; }

function sanitizeResult(raw) {
  const tests = (Array.isArray(raw.tests) ? raw.tests : []).slice(0, MAX_TESTS).map(t => ({
    name: clip(String(t.name)),
    passed: t.passed === true,
    ...(t.skipped ? { skipped: true } : {}),
    ...(t.error ? { error: clip(String(t.error), 300) } : {}),
  }));
  const variables = {};
  let count = 0;
  for (const k of Object.keys(raw.variables || {})) {
    if (count++ >= MAX_VARIABLES) break;
    variables[clip(k, 200)] = clip(String(raw.variables[k]));
  }
  return { ok: true, done: raw.done === true, tests, variables };
}

function run(msg) {
  const code = typeof msg.code === 'string' ? msg.code : '';
  const timeoutMs = Number.isFinite(msg.timeoutMs) && msg.timeoutMs > 0 ? Math.min(msg.timeoutMs, 5000) : 1500;
  const ctx = vm.createContext(Object.create(null), {
    name: 'apilix-ai-dry-run',
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });
  const inputJson = JSON.stringify({
    response: msg.response && typeof msg.response === 'object' ? msg.response : {},
    variables: msg.variables && typeof msg.variables === 'object' ? msg.variables : {},
  });
  // The bootstrap is a function expression: running it only creates the function (a context-realm object).
  // It is then called from the host with ONE string; it returns the collector, which stays in the host.
  const boot = vm.runInContext(`(${bootstrap.toString()})`, ctx, { timeout: timeoutMs, filename: 'apilix-bootstrap.js' });
  const collector = boot(inputJson);
  // The wrapper matches the syntax check done by the parent. Its completion value is the script's promise.
  let script;
  try {
    script = new vm.Script(`(async function(){\n'use strict';\n${code}\n})();`, { filename: 'apilix-dry-run.js' });
  } catch (e) {
    return { ok: false, syntaxError: String(e && e.message).slice(0, 160) };
  }
  const promise = script.runInContext(ctx, { timeout: timeoutMs });
  collector.exec(promise);
  vm.runInContext('0', ctx, { timeout: timeoutMs }); // drains the microtasks queued by exec (afterEvaluate)
  return sanitizeResult(JSON.parse(collector.finish()));
}

/**
 * Fixed capability probe (NO model input). Run by dry-run-mode.js with exactly the flags of a real run: it
 * only reports whether an fs read outside the grant and a child_process are refused by the runtime.
 */
function probe() {
  const r = {};
  try { require('fs').readFileSync(require('path').join(__dirname, 'dry-run.js')); r.fs = 'allowed'; } catch (e) { r.fs = e && e.code ? String(e.code) : 'error'; }
  try { require('child_process').execFileSync(process.execPath, ['-e', '0'], { stdio: 'ignore', timeout: 2000 }); r.cp = 'allowed'; } catch (e) { r.cp = e && e.code ? String(e.code) : 'error'; }
  return { ok: true, probe: r };
}

function main() {
  // Last-resort self-destruct (the parent also SIGKILLs): fires only if the event loop is alive.
  setTimeout(() => process.exit(3), 6000).unref();
  process.once('message', (msg) => {
    let out;
    try {
      out = msg && msg.probe === true ? probe() : run(msg || {});
    } catch (e) {
      const m = String(e && e.message).slice(0, 300);
      out = { ok: false, error: /timed out/i.test(m) ? 'timeout' : m };
    }
    let line = JSON.stringify(out);
    if (Buffer.byteLength(line) > MAX_OUTPUT_BYTES) line = JSON.stringify({ ok: false, error: 'output too large' });
    process.stdout.write(`${line}\n`, () => process.exit(0));
  });
}

if (require.main === module) main();

module.exports = { run }; // exported for the unit tests of the runner only; never required by the server
