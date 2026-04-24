'use strict';

const vm = require('vm');
const axios = require('axios');
const https = require('https');
const xpathLib = require('xpath');
const { DOMParser } = require('@xmldom/xmldom');
const { webcrypto } = require('crypto');

// Lazy-initialised Ajv instance for matchSchema assertions
let _ajv = null;
function getAjv() {
  if (!_ajv) {
    const AjvModule = require('ajv');
    const Ajv = AjvModule.default || AjvModule;
    const addFormatsModule = require('ajv-formats');
    const addFormats = addFormatsModule.default || addFormatsModule;
    _ajv = new Ajv({ allErrors: false });
    addFormats(_ajv);
  }
  return _ajv;
}

const httpClient = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  maxRedirects: 10,
  timeout: 30000,
  validateStatus: null,
});

// ─── Sandbox helpers shared between runScript and createScriptContext ─────────

function _xpImpl(html, expr) {
  try {
    const parser = new DOMParser({ onError: () => {} });
    const doc = parser.parseFromString(html, 'text/xml');
    const result = xpathLib.select(expr, doc);
    if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') return result;
    if (Array.isArray(result)) {
      if (result.length === 0) return null;
      const val = result[0];
      return val.textContent !== undefined ? val.textContent : (val.nodeValue !== undefined ? val.nodeValue : String(val));
    }
    return result;
  } catch (_) { return null; }
}

const _xpathApi = {
  select(expr, doc) { return xpathLib.select(expr, doc); },
  select1(expr, doc) { return xpathLib.select1(expr, doc); },
  value(expr, doc) {
    const result = xpathLib.select(expr, doc);
    if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') return result;
    if (Array.isArray(result) && result.length > 0) {
      const val = result[0];
      return val.textContent !== undefined ? val.textContent : (val.nodeValue !== undefined ? val.nodeValue : String(val));
    }
    return null;
  },
};

// Property names always present in a pre-built script context.
// Used to identify and remove user-added globals between sequential reuses.
const STATIC_CONTEXT_KEYS = new Set([
  'JSON', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'Number', 'String', 'Boolean',
  'Array', 'Object', 'Math', 'Date', 'RegExp', 'Error', 'Buffer',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'btoa', 'atob', 'unescape', 'escape', 'crypto',
  'TextEncoder', 'TextDecoder',
  'Uint8Array', 'Uint8ClampedArray', 'Int8Array', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'ArrayBuffer',
  'XMLHttpRequest', 'fetch', '_xp', 'xpath',
]);

// Compiled vm.Script cache for the reused-context path (keyed by IIFE-wrapped source).
// Capped at 500 entries to bound memory usage.
const _scriptCache = new Map();

/**
 * Pre-allocate a VM context loaded with all static (non-per-run) sandbox globals.
 * Pass the returned object as the 5th argument to runScript() to avoid re-creating
 * a V8 context on each script call — useful for collection runs with many iterations.
 *
 * The same object MUST NOT be used concurrently. Sequential reuse is safe.
 */
function createScriptContext() {
  const shell = {
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Math,
    Date,
    RegExp,
    Error,
    Buffer,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    setTimeout() {},
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    btoa: (s) => Buffer.from(s).toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('utf8'),
    unescape,
    escape,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Uint8ClampedArray,
    Int8Array,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    ArrayBuffer,
    XMLHttpRequest: undefined,
    fetch: undefined,
    _xp: _xpImpl,
    xpath: _xpathApi,
  };
  return vm.createContext(shell);
}

// ─── Chainable expect ────────────────────────────────────────────────────────

function createExpect(value, negated, onFail) {
  if (negated === undefined) negated = false;

  function assert(condition, message) {
    if (negated ? condition : !condition) {
      if (onFail) { onFail(message); return; }
      throw new Error(message);
    }
  }

  const n = negated ? 'not ' : '';

  const obj = {
    // Negation
    get not() {
      return createExpect(value, !negated, onFail);
    },

    // Chainable words (no-op getters)
    get to() { return obj; },
    get be() { return obj; },
    get been() { return obj; },
    get is() { return obj; },
    get that() { return obj; },
    get which() { return obj; },
    get and() { return obj; },
    get has() { return obj; },
    get have() { return obj; },
    get with() { return obj; },
    get at() { return obj; },
    get of() { return obj; },
    get same() { return obj; },
    get does() { return obj; },
    get still() { return obj; },
    get also() { return obj; },

    // Asserting getters
    get ok() {
      assert(value != null && value !== false && value !== 0 && value !== '', `Expected value to be ${n}truthy, got ${JSON.stringify(value)}`);
      return obj;
    },
    get true() {
      assert(value === true, `Expected ${JSON.stringify(value)} to ${n}be true`);
      return obj;
    },
    get false() {
      assert(value === false, `Expected ${JSON.stringify(value)} to ${n}be false`);
      return obj;
    },
    get null() {
      assert(value === null, `Expected ${JSON.stringify(value)} to ${n}be null`);
      return obj;
    },
    get undefined() {
      assert(value === undefined, `Expected ${JSON.stringify(value)} to ${n}be undefined`);
      return obj;
    },
    get NaN() {
      assert(Number.isNaN(value), `Expected ${JSON.stringify(value)} to ${n}be NaN`);
      return obj;
    },
    get exist() {
      assert(value != null, `Expected value to ${n}exist`);
      return obj;
    },
    get empty() {
      if (typeof value === 'string' || Array.isArray(value)) {
        assert(value.length === 0, `Expected value to ${n}be empty`);
      } else if (value !== null && typeof value === 'object') {
        assert(Object.keys(value).length === 0, `Expected object to ${n}be empty`);
      } else {
        assert(!value, `Expected value to ${n}be empty`);
      }
      return obj;
    },

    // Methods
    equal(expected) {
      assert(value === expected, `Expected ${JSON.stringify(value)} to ${n}equal ${JSON.stringify(expected)}`);
      return obj;
    },
    equals(expected) { return obj.equal(expected); },
    eq(expected) { return obj.equal(expected); },

    eql(expected) {
      assert(JSON.stringify(value) === JSON.stringify(expected), `Expected ${JSON.stringify(value)} to ${n}deep equal ${JSON.stringify(expected)}`);
      return obj;
    },
    eqls(expected) { return obj.eql(expected); },
    deep: {
      equal(expected) { return obj.eql(expected); },
    },

    include(expected) {
      if (typeof value === 'string') {
        assert(value.includes(expected), `Expected "${value}" to ${n}include "${expected}"`);
      } else if (Array.isArray(value)) {
        assert(value.includes(expected), `Expected array to ${n}include ${JSON.stringify(expected)}`);
      } else {
        throw new Error(`Cannot check include on ${typeof value}`);
      }
      return obj;
    },
    includes(expected) { return obj.include(expected); },
    contain(expected) { return obj.include(expected); },
    contains(expected) { return obj.include(expected); },

    above(n2) {
      assert(value > n2, `Expected ${value} to ${n}be above ${n2}`);
      return obj;
    },
    gt(n2) { return obj.above(n2); },
    greaterThan(n2) { return obj.above(n2); },

    below(n2) {
      assert(value < n2, `Expected ${value} to ${n}be below ${n2}`);
      return obj;
    },
    lt(n2) { return obj.below(n2); },
    lessThan(n2) { return obj.below(n2); },

    least(n2) {
      assert(value >= n2, `Expected ${value} to ${n}be at least ${n2}`);
      return obj;
    },
    gte(n2) { return obj.least(n2); },

    most(n2) {
      assert(value <= n2, `Expected ${value} to ${n}be at most ${n2}`);
      return obj;
    },
    lte(n2) { return obj.most(n2); },

    within(lo, hi) {
      assert(value >= lo && value <= hi, `Expected ${value} to ${n}be within ${lo}..${hi}`);
      return obj;
    },

    closeTo(expected, delta) {
      assert(Math.abs(value - expected) <= delta, `Expected ${value} to be close to ${expected} (+/- ${delta})`);
      return obj;
    },

    lengthOf(len) {
      assert((value != null && value.length === len), `Expected length ${value?.length} to ${n}equal ${len}`);
      return obj;
    },

    property(name, val) {
      assert(name in Object(value), `Expected object to ${n}have property "${name}"`);
      if (val !== undefined) {
        assert(value[name] === val, `Expected property "${name}" to equal ${JSON.stringify(val)}`);
      }
      return obj;
    },

    a(type) {
      const actual = Array.isArray(value) ? 'array' : typeof value;
      assert(actual === type || (type === 'array' && Array.isArray(value)), `Expected ${JSON.stringify(value)} to ${n}be a ${type}`);
      return obj;
    },
    an(type) { return obj.a(type); },

    instanceOf(ctor) {
      assert(value instanceof ctor, `Expected value to ${n}be instance of ${ctor.name}`);
      return obj;
    },

    match(regex) {
      assert(regex.test(value), `Expected "${value}" to ${n}match ${regex}`);
      return obj;
    },

    keys(keysArr) {
      const v = Object(value);
      const hasAll = (Array.isArray(keysArr) ? keysArr : [keysArr]).every(k => k in v);
      assert(hasAll, `Expected object to ${n}have all keys: ${(Array.isArray(keysArr) ? keysArr : [keysArr]).join(', ')}`);
      return obj;
    },
    key(k) { return obj.keys([k]); },

    string(expected) {
      assert(typeof value === 'string' && value.includes(expected), `Expected string to contain "${expected}"`);
      return obj;
    },

    // ── Number guards ────────────────────────────────────────────────────
    get positive() {
      assert(typeof value === 'number' && value > 0, `Expected ${value} to ${n}be positive`);
      return obj;
    },
    get negative() {
      assert(typeof value === 'number' && value < 0, `Expected ${value} to ${n}be negative`);
      return obj;
    },
    get integer() {
      assert(Number.isInteger(value), `Expected ${value} to ${n}be an integer`);
      return obj;
    },
    get finite() {
      assert(Number.isFinite(value), `Expected ${value} to ${n}be finite`);
      return obj;
    },

    // ── String boundaries ────────────────────────────────────────────────
    startWith(str) {
      assert(typeof value === 'string' && value.startsWith(str), `Expected "${value}" to ${n}start with "${str}"`);
      return obj;
    },
    endWith(str) {
      assert(typeof value === 'string' && value.endsWith(str), `Expected "${value}" to ${n}end with "${str}"`);
      return obj;
    },

    // ── Array membership ────────────────────────────────────────────────
    members(arr) {
      if (!Array.isArray(value) || !Array.isArray(arr)) {
        throw new Error('members() requires both values to be arrays');
      }
      const vSorted = [...value].map(x => JSON.stringify(x)).sort();
      const aSorted = [...arr].map(x => JSON.stringify(x)).sort();
      const equal = vSorted.length === aSorted.length && vSorted.every((v, i) => v === aSorted[i]);
      assert(equal, `Expected arrays to ${n}have the same members`);
      return obj;
    },
    includeMembers(arr) {
      if (!Array.isArray(value) || !Array.isArray(arr)) {
        throw new Error('includeMembers() requires both values to be arrays');
      }
      const vSet = value.map(x => JSON.stringify(x));
      const allPresent = arr.every(a => vSet.includes(JSON.stringify(a)));
      assert(allPresent, `Expected array to ${n}include all members ${JSON.stringify(arr)}`);
      return obj;
    },
    oneOf(arr) {
      assert(Array.isArray(arr) && arr.includes(value), `Expected ${JSON.stringify(value)} to ${n}be one of ${JSON.stringify(arr)}`);
      return obj;
    },
    everyItem(fn) {
      assert(Array.isArray(value) && value.every(fn), `Expected every item to ${n}satisfy predicate`);
      return obj;
    },
    someItem(fn) {
      assert(Array.isArray(value) && value.some(fn), `Expected some item to ${n}satisfy predicate`);
      return obj;
    },

    // ── Partial object match ─────────────────────────────────────────────
    subset(expected) {
      function isSubset(actual, exp) {
        if (typeof exp !== 'object' || exp === null) return JSON.stringify(actual) === JSON.stringify(exp);
        if (typeof actual !== 'object' || actual === null) return false;
        return Object.keys(exp).every(k => k in actual && isSubset(actual[k], exp[k]));
      }
      assert(isSubset(value, expected), `Expected object to ${n}contain subset ${JSON.stringify(expected)}`);
      return obj;
    },

    // ── Dot-path property ────────────────────────────────────────────────
    deepProperty(path, val) {
      const parts = String(path).split('.');
      let cursor = value;
      for (const part of parts) {
        if (cursor == null || !Object.prototype.hasOwnProperty.call(Object(cursor), part)) {
          assert(false, `Expected object to ${n}have deep property "${path}"`);
          return obj;
        }
        cursor = cursor[part];
      }
      if (val !== undefined) {
        assert(JSON.stringify(cursor) === JSON.stringify(val), `Expected deep property "${path}" to ${n}equal ${JSON.stringify(val)}`);
      }
      return obj;
    },

    // ── Custom predicate ─────────────────────────────────────────────────
    satisfy(fn) {
      const result = fn(value);
      assert(!!result, `Expected value to ${n}satisfy predicate`);
      return obj;
    },
    satisfies(fn) { return obj.satisfy(fn); },

    // ── JSON Schema validation ───────────────────────────────────────────
    matchSchema(schema) {
      const ajv = getAjv();
      const valid = ajv.validate(schema, value);
      const err = ajv.errors && ajv.errors[0];
      const loc = err && err.instancePath ? err.instancePath : '(root)';
      const message = `Expected value to ${n}match schema${valid ? '' : `: ${loc} ${err && err.message ? err.message : 'validation failed'}`}`;
      assert(valid, message);
      return obj;
    },
  };

  return obj;
}

// ─── apx object factory ─────────────────────────────────────────────────────
// apx is the primary API; pm is an alias for Postman compatibility

function createApx(response, variables, updatedVariables, updatedGlobalMutations, updatedEnvMutations, updatedCollVarMutations, tests, pendingRequests, deps, childRequests, executionSignals) {
  // deps = { collectionItems, executeRequestFn, context, requestId, iteration }
  const collectionItems = (deps && deps.collectionItems) || [];
  const executeRequestFn = (deps && deps.executeRequestFn) || null;
  const execContext = (deps && deps.context) || {};
  const requestId = (deps && deps.requestId) || '';
  const iteration = (deps && deps.iteration) || 1;

  const makeVarStore = (namespaceBucket, namespaceSrc) => {
    const isNamespaced = namespaceSrc !== undefined;
    const deletedKeys = new Set();
    return {
      get(key) {
        if (isNamespaced) {
          if (deletedKeys.has(key)) return undefined;
          if (namespaceBucket && Object.prototype.hasOwnProperty.call(namespaceBucket, key)) return namespaceBucket[key];
          if (namespaceSrc && Object.prototype.hasOwnProperty.call(namespaceSrc, key)) return namespaceSrc[key];
          return undefined;
        }
        // Generic (apx.variables): mutations overlay takes priority over original flat
        if (updatedVariables[key] !== undefined) return updatedVariables[key];
        return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : undefined;
      },
      set(key, value) {
        updatedVariables[key] = String(value);
        deletedKeys.delete(key);
        if (namespaceBucket) namespaceBucket[key] = String(value);
      },
      unset(key) {
        delete updatedVariables[key];
        if (namespaceBucket) delete namespaceBucket[key];
        if (isNamespaced) deletedKeys.add(key);
      },
      has(key) {
        if (isNamespaced) {
          if (deletedKeys.has(key)) return false;
          if (namespaceBucket && Object.prototype.hasOwnProperty.call(namespaceBucket, key)) return true;
          return !!(namespaceSrc && Object.prototype.hasOwnProperty.call(namespaceSrc, key));
        }
        return key in variables || key in updatedVariables;
      },
      clear() {
        if (isNamespaced) {
          Object.keys(namespaceSrc || {}).forEach(k => deletedKeys.add(k));
          Object.keys(namespaceBucket || {}).forEach(k => {
            delete updatedVariables[k];
            delete namespaceBucket[k];
            deletedKeys.add(k);
          });
        }
      },
      toObject() {
        if (isNamespaced) {
          const result = { ...(namespaceSrc || {}) };
          Object.assign(result, namespaceBucket || {});
          deletedKeys.forEach(k => delete result[k]);
          return result;
        }
        return {};
      },
    };
  };

  let softFailures = [];

  function testFn(name, fn) {
    const previousSoftFailures = softFailures;
    softFailures = [];
    try {
      fn();
      tests.push({ name, passed: true, error: null, skipped: false });
    } catch (err) {
      tests.push({ name, passed: false, error: err.message, skipped: false });
    } finally {
      softFailures = previousSoftFailures;
    }
  }
  testFn.skip = function skipTest(name) {
    tests.push({ name, passed: null, error: null, skipped: true });
  };

  const apx = {
    test: testFn,

    expect(value) {
      return createExpect(value);
    },

    softExpect(value) {
      return createExpect(value, false, (msg) => softFailures.push(msg));
    },

    assertAll(label) {
      if (softFailures.length > 0) {
        const msgs = softFailures.splice(0);
        const prefix = label ? `${label}: ` : '';
        throw new Error(`${prefix}${msgs.length} soft assertion(s) failed:\n  - ${msgs.join('\n  - ')}`);
      }
    },

    environment: makeVarStore(updatedEnvMutations, execContext.environment || {}),
    collection: makeVarStore(updatedCollVarMutations, execContext.collectionVariables || {}),
    get collectionVariables() { return this.collection; }, // Postman compatibility alias
    globals: (() => {
      const globalStore = makeVarStore(updatedGlobalMutations, execContext.globals || {});
      return {
        get(key) { return globalStore.get(key); },
        has(key) { return globalStore.has(key); },
        toObject() { return globalStore.toObject(); },
        set(key, value) { globalStore.set(key, value); },
        unset(key) { globalStore.unset(key); },
        clear() { globalStore.clear(); },
      };
    })(),
    variables: makeVarStore(null), // generic store — falls back to flat routing in executeRequest
    iterationData: {
      get(key) { return variables[key]; },
      has(key) { return key in variables; },
    },

    info: {
      requestId,
      iteration,
      eventName: 'test',
    },

    response: response ? buildResponse(response) : null,

    request: {
      headers: {
        upsert({ key, value }) { execContext.headers = execContext.headers || {}; execContext.headers[key] = value; },
      },
      url: (execContext && execContext.url) || '',
      method: (execContext && execContext.method) || '',
    },

    execution: {
      skipRequest() {
        if (executionSignals) executionSignals.skipRequest = true;
      },
      setNextRequest(name) {
        if (executionSignals) executionSignals.nextRequest = name === null ? null : String(name);
      },
      setNextRequestById(id) {
        if (!executionSignals || id === undefined) return;
        executionSignals.nextRequestById = id === null ? null : String(id);
      },
    },

    sendRequest(opts, callback) {
      const promise = (async () => {
        try {
          let url, method, reqHeaders, body;

          if (typeof opts === 'string') {
            url = opts;
            method = 'GET';
            reqHeaders = {};
            body = undefined;
          } else {
            url = typeof opts.url === 'object' && opts.url.raw ? opts.url.raw : String(opts.url || '');
            method = (opts.method || 'GET').toUpperCase();
            reqHeaders = {};
            (opts.header || []).forEach(h => {
              if (h && h.key && !h.disabled) reqHeaders[h.key] = h.value;
            });
            // Body: handle Postman-style { mode, raw } or plain string/object
            if (opts.body) {
              if (typeof opts.body === 'string') {
                body = opts.body;
              } else if (opts.body.mode === 'raw') {
                body = opts.body.raw || '';
              } else if (opts.body.mode === 'urlencoded') {
                const params = new URLSearchParams();
                (opts.body.urlencoded || []).forEach(p => {
                  if (!p.disabled) params.append(p.key, p.value);
                });
                body = params.toString();
                if (!reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
                  reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
                }
              } else {
                body = undefined;
              }
            }
          }

          const axiosRes = await httpClient.request({ method, url, headers: reqHeaders, data: body });
          const bodyStr = typeof axiosRes.data === 'string' ? axiosRes.data : JSON.stringify(axiosRes.data);

          const pmRes = {
            code: axiosRes.status,
            status: axiosRes.statusText,
            responseTime: 0,
            headers: {
              get(name) {
                const key = Object.keys(axiosRes.headers || {}).find(k => k.toLowerCase() === name.toLowerCase());
                return key ? String(axiosRes.headers[key]) : undefined;
              },
            },
            json() {
              try {
                return typeof axiosRes.data === 'string' ? JSON.parse(axiosRes.data) : axiosRes.data;
              } catch (_) { return null; }
            },
            text() { return bodyStr; },
          };

          if (typeof callback === 'function') callback(null, pmRes);
        } catch (err) {
          if (typeof callback === 'function') callback(err, null);
        }
      })();

      pendingRequests.push(promise);
    },

    executeRequest(requestName, callback) {
      const promise = (async () => {
        try {
          // Find the request by name (case-sensitive) in the collection items
          function findByName(items, name) {
            for (const it of (items || [])) {
              if (it.name === name && it.request) return it;
              if (it.item) {
                const found = findByName(it.item, name);
                if (found) return found;
              }
            }
            return null;
          }

          const item = findByName(collectionItems, requestName);
          if (!item) {
            const err = new Error(`apx.executeRequest: request "${requestName}" not found in collection`);
            if (typeof callback === 'function') callback(err, null);
            return;
          }

          if (!executeRequestFn) {
            const err = new Error('apx.executeRequest: executor not available');
            if (typeof callback === 'function') callback(err, null);
            return;
          }

          // Build per-namespace child contexts from the tracked mutation buckets.
          // Mutations via the generic `variables` store (no namespace bucket) are
          // routed to collectionVariables, mirroring executor.js unknown-key handling.
          const trackedKeys = new Set([
            ...Object.keys(updatedEnvMutations),
            ...Object.keys(updatedCollVarMutations),
            ...Object.keys(updatedGlobalMutations),
          ]);
          const untrackedCollVarMutations = {};
          Object.keys(updatedVariables).forEach(k => {
            if (!trackedKeys.has(k)) untrackedCollVarMutations[k] = updatedVariables[k];
          });

          const childEnv      = { ...(execContext.environment || {}),        ...updatedEnvMutations };
          const childCollVars = { ...(execContext.collectionVariables || {}), ...updatedCollVarMutations, ...untrackedCollVarMutations };
          const childGlobals  = { ...(execContext.globals || {}),             ...updatedGlobalMutations };

          const result = await executeRequestFn(item, {
            environment: childEnv,
            collectionVariables: childCollVars,
            globals: childGlobals,
            dataRow: execContext.dataRow || {},
            collVars: execContext.collVars || [],
            cookies: execContext.cookies || {},
            collectionItems,
            mockBase: execContext.mockBase || null,
          });

          // Propagate mutations made by the child request (env/collVars/globals set
          // inside its test/pre-request scripts) back into this sandbox's tracking
          // buckets. Without this, variables set by a child request (e.g. storing a
          // token after "Get token") are lost and the parent request cannot use them.
          if (result) {
            const envDiff = {};
            const collVarDiff = {};
            const globalDiff = {};

            Object.entries(result.updatedEnvironment || {}).forEach(([k, v]) => {
              if (childEnv[k] !== v) envDiff[k] = v;
            });
            Object.entries(result.updatedCollectionVariables || {}).forEach(([k, v]) => {
              if (childCollVars[k] !== v) collVarDiff[k] = v;
            });
            Object.entries(result.updatedGlobals || {}).forEach(([k, v]) => {
              if (childGlobals[k] !== v) globalDiff[k] = v;
            });

            Object.assign(updatedEnvMutations, envDiff);
            Object.assign(updatedCollVarMutations, collVarDiff);
            Object.assign(updatedGlobalMutations, globalDiff);
            // Mirror what apx.environment.set() / apx.collectionVariables.set() do:
            // also write into updatedVariables so that executor.js rebuilds `vars`
            // correctly (vars = { ...vars, ...preUpdatedVars }) and {{token}}-style
            // placeholders in the parent request's headers/body are resolved.
            // Env diff has highest priority, so it overwrites collVar conflicts.
            Object.assign(updatedVariables, collVarDiff, globalDiff, envDiff);
          }

          // Record the child request so it appears in the console
          if (Array.isArray(childRequests)) {
            childRequests.push({
              name: requestName,
              method: (item.request && item.request.method) || 'GET',
              result,
            });
          }

          if (typeof callback === 'function') callback(null, result);
        } catch (err) {
          if (typeof callback === 'function') callback(err, null);
        }
      })();

      pendingRequests.push(promise);
    },
  };

  return apx;
}

function buildResponse(r) {
  const obj = {
    code: r.code,
    status: r.status,
    responseTime: r.responseTime,
    json() {
      if (typeof r.jsonData === 'string') {
        try { return JSON.parse(r.jsonData); } catch (_) { return null; }
      }
      return r.jsonData;
    },
    text() { return r.body; },
    xml() {
      try {
        // Parse the response body as XML.
        // Note: this method uses 'text/xml'; any older text/html workaround
        // for @xmldom/xmldom + xpath incompatibilities is not applied here.
        const parser = new DOMParser({ onError: () => {} });
        return parser.parseFromString(r.body || '', 'text/xml');
      } catch (_) { return null; }
    },
    /** One-liner: parse response body as XML and return the text value of the first XPath match. */
    xmlPath(expr) {
      try {
        const parser = new DOMParser({ onError: () => {} });
        const doc = parser.parseFromString(r.body || '', 'text/xml');
        const result = xpathLib.select(expr, doc);
        if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') return result;
        if (Array.isArray(result) && result.length > 0) {
          const val = result[0];
          return val.textContent !== undefined ? val.textContent : (val.nodeValue !== undefined ? val.nodeValue : String(val));
        }
        return null;
      } catch (_) { return null; }
    },
    /** One-liner: parse response body as XML and return text values of all XPath matches. */
    xmlPathAll(expr) {
      try {
        const parser = new DOMParser({ onError: () => {} });
        const doc = parser.parseFromString(r.body || '', 'text/xml');
        const result = xpathLib.select(expr, doc);
        if (!Array.isArray(result)) return result != null ? [String(result)] : [];
        return result.map(val =>
          val.textContent !== undefined ? val.textContent : (val.nodeValue !== undefined ? val.nodeValue : String(val))
        );
      } catch (_) { return []; }
    },
    headers: {
      get(name) {
        const key = Object.keys(r.headers || {}).find(k => k.toLowerCase() === name.toLowerCase());
        return key ? r.headers[key] : undefined;
      },
      has(name) {
        return Object.keys(r.headers || {}).some(k => k.toLowerCase() === name.toLowerCase());
      },
    },
    // Chai-like assertion sugar on response
    to: {
      have: {
        status(code) {
          if (r.code !== code) throw new Error(`Expected response status to be ${code} but got ${r.code}`);
        },
        header(name, val) {
          const key = Object.keys(r.headers || {}).find(k => k.toLowerCase() === name.toLowerCase());
          if (!key) throw new Error(`Expected response to have header "${name}"`);
          if (val !== undefined && r.headers[key] !== val) {
            throw new Error(`Expected header "${name}" to equal "${val}" but got "${r.headers[key]}"`);
          }
        },
        body(text) {
          if (!r.body.includes(text)) throw new Error(`Expected response body to include "${text}"`);
        },
        jsonBody() {
          try { JSON.parse(r.body); } catch (_) { throw new Error('Expected response to have valid JSON body'); }
        },
      },
      be: {
        ok() {
          if (r.code < 200 || r.code >= 300) throw new Error(`Expected response to be OK (2xx) but got ${r.code}`);
        },
      },
    },
    get size() {
      return r.body ? r.body.length : 0;
    },
  };
  return obj;
}

// ─── Script runner ───────────────────────────────────────────────────────────

async function runScript(code, response, variables, deps, vmContext) {
  const tests = [];
  const updatedVariables = {};
  const updatedGlobalMutations = {};
  const updatedEnvMutations = {};
  const updatedCollVarMutations = {};
  const consoleLogs = [];
  const pendingRequests = [];
  const childRequests = [];
  const executionSignals = { skipRequest: false, nextRequest: undefined, nextRequestById: undefined };

  const apx = createApx(response, variables || {}, updatedVariables, updatedGlobalMutations, updatedEnvMutations, updatedCollVarMutations, tests, pendingRequests, deps, childRequests, executionSignals);
  // pm is a full alias to apx for Postman script compatibility
  const pm = apx;

  const sandbox = {
    apx,
    pm,
    console: {
      log: (...a) => { consoleLogs.push({ level: 'log', args: a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)) }); console.log('[script]', ...a); },
      warn: (...a) => { consoleLogs.push({ level: 'warn', args: a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)) }); console.warn('[script]', ...a); },
      error: (...a) => { consoleLogs.push({ level: 'error', args: a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)) }); console.error('[script]', ...a); },
      info: (...a) => { consoleLogs.push({ level: 'info', args: a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)) }); console.info('[script]', ...a); },
    },
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Math,
    Date,
    RegExp,
    Error,
    Buffer,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    setTimeout() {},
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    btoa: (s) => Buffer.from(s).toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('utf8'),
    unescape,
    escape,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Uint8ClampedArray,
    Int8Array,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    ArrayBuffer,
    XMLHttpRequest: undefined,
    fetch: undefined,
    _xp: _xpImpl,
    xpath: _xpathApi,
  };

  if (vmContext) {
    // ─── Reused-context path (collection runs) ──────────────────────────
    // Assign per-run properties directly onto the pre-built contextified object,
    // wrap user code in an IIFE to scope var/function declarations, then clean up.
    vmContext.apx = apx;
    vmContext.pm = apx;
    vmContext.console = sandbox.console;
    const wrappedCode = `(function(){\n'use strict';\n${code}\n})();`;
    let script = _scriptCache.get(wrappedCode);
    if (!script) {
      if (_scriptCache.size >= 500) _scriptCache.delete(_scriptCache.keys().next().value);
      script = new vm.Script(wrappedCode, { filename: 'apilix-script.js' });
      _scriptCache.set(wrappedCode, script);
    }
    try {
      script.runInContext(vmContext, { timeout: 5000 });
      if (pendingRequests.length > 0) await Promise.all(pendingRequests);
    } catch (err) {
      tests.push({ name: '__ScriptError__', passed: false, error: err.message });
    } finally {
      // Remove per-run refs and any user-added globals so the next invocation
      // starts with a clean slate.
      delete vmContext.apx;
      delete vmContext.pm;
      delete vmContext.console;
      for (const k of Object.getOwnPropertyNames(vmContext)) {
        if (!STATIC_CONTEXT_KEYS.has(k)) delete vmContext[k];
      }
    }
  } else {
    // ─── Fresh-context path (single request sends, direct tests) ───────────
    try {
      const script = new vm.Script(code, { filename: 'apilix-script.js' });
      const ctx = vm.createContext(sandbox);
      script.runInContext(ctx, { timeout: 5000 });
      if (pendingRequests.length > 0) await Promise.all(pendingRequests);
    } catch (err) {
      tests.push({ name: '__ScriptError__', passed: false, error: err.message });
    }
  }

  return { tests, updatedVariables, updatedEnvMutations, updatedCollVarMutations, updatedGlobalMutations, consoleLogs, childRequests, skipRequest: executionSignals.skipRequest, nextRequest: executionSignals.nextRequest, nextRequestById: executionSignals.nextRequestById };
}

module.exports = { runScript, createScriptContext };
