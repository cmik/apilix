'use strict';

const vm = require('vm');
const axios = require('axios');
const https = require('https');
const xpathLib = require('xpath');
const { DOMParser } = require('@xmldom/xmldom');

const httpClient = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  maxRedirects: 10,
  timeout: 30000,
  validateStatus: null,
});

// ─── Chainable expect ────────────────────────────────────────────────────────

function createExpect(value, negated) {
  if (negated === undefined) negated = false;

  function assert(condition, message) {
    if (negated ? condition : !condition) {
      throw new Error(message);
    }
  }

  const n = negated ? 'not ' : '';

  const obj = {
    // Negation
    get not() {
      return createExpect(value, !negated);
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
  };

  return obj;
}

// ─── apx object factory ─────────────────────────────────────────────────────
// apx is the primary API; pm is an alias for Postman compatibility

function createApx(response, variables, updatedVariables, tests, pendingRequests, deps, childRequests) {
  // deps = { collectionItems, executeRequestFn, context }
  const collectionItems = (deps && deps.collectionItems) || [];
  const executeRequestFn = (deps && deps.executeRequestFn) || null;
  const execContext = (deps && deps.context) || {};

  // Per-namespace write buckets — track which scope each mutation targets so
  // apx.executeRequest() can forward mutations to the correct child scope instead
  // of collapsing everything into the child's environment.
  const updatedEnvMutations = {};
  const updatedCollVarMutations = {};
  const updatedGlobalMutations = {};

  const makeVarStore = (namespaceBucket) => ({
    get(key) { return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : (updatedVariables[key] !== undefined ? updatedVariables[key] : undefined); },
    set(key, value) {
      updatedVariables[key] = String(value);     // flat copy keeps same-script resolution working
      if (namespaceBucket) namespaceBucket[key] = String(value);
    },
    unset(key) {
      delete updatedVariables[key];
      if (namespaceBucket) delete namespaceBucket[key];
    },
    has(key) { return key in variables || key in updatedVariables; },
    clear() {},
  });

  const apx = {
    test(name, fn) {
      try {
        fn();
        tests.push({ name, passed: true, error: null });
      } catch (err) {
        tests.push({ name, passed: false, error: err.message });
      }
    },

    expect(value) {
      return createExpect(value);
    },

    environment: makeVarStore(updatedEnvMutations),
    collection: makeVarStore(updatedCollVarMutations),
    get collectionVariables() { return this.collection; }, // Postman compatibility alias
    globals: (() => {
      const globalStore = makeVarStore(updatedGlobalMutations);
      const unsupportedGlobalsMutation = () => {
        throw new Error('apx.globals mutations are not supported in this sandbox because global changes are not persisted.');
      };

      return {
        get(key) { return globalStore.get(key); },
        has(key) { return globalStore.has(key); },
        toObject() {
          return typeof globalStore.toObject === 'function' ? globalStore.toObject() : {};
        },
        set: unsupportedGlobalsMutation,
        unset: unsupportedGlobalsMutation,
        clear: unsupportedGlobalsMutation,
      };
    })(),
    variables: makeVarStore(null), // generic store — falls back to flat routing in executeRequest
    iterationData: {
      get(key) { return variables[key]; },
      has(key) { return key in variables; },
    },

    info: {
      requestId: '',
      iteration: 1,
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
          });

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
    headers: {
      get(name) {
        const key = Object.keys(r.headers || {}).find(k => k.toLowerCase() === name.toLowerCase());
        return key ? r.headers[key] : undefined;
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

async function runScript(code, response, variables, deps) {
  const tests = [];
  const updatedVariables = {};
  const consoleLogs = [];
  const pendingRequests = [];
  const childRequests = [];

  const apx = createApx(response, variables || {}, updatedVariables, tests, pendingRequests, deps, childRequests);
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
    XMLHttpRequest: undefined,
    fetch: undefined,
    _xp(html, expr) {
      try {
        const parser = new DOMParser({ errorHandler: { warning() {}, error() {}, fatalError() {} } });
        const doc = parser.parseFromString(html, 'text/html');
        const result = xpathLib.select(expr, doc);
        if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') return result;
        if (Array.isArray(result)) {
          if (result.length === 0) return null;
          const val = result[0];
          return val.textContent !== undefined ? val.textContent : (val.nodeValue !== undefined ? val.nodeValue : String(val));
        }
        return result;
      } catch (_) { return null; }
    },
  };

  try {
    const script = new vm.Script(code, { filename: 'apilix-script.js' });
    const ctx = vm.createContext(sandbox);
    script.runInContext(ctx, { timeout: 5000 });

    // Wait for all pm.sendRequest async callbacks to complete
    if (pendingRequests.length > 0) {
      await Promise.all(pendingRequests);
    }
  } catch (err) {
    tests.push({ name: '__ScriptError__', passed: false, error: err.message });
  }

  return { tests, updatedVariables, consoleLogs, childRequests };
}

module.exports = { runScript };
