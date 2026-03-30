'use strict';

const vm = require('vm');

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

// ─── pm object factory ───────────────────────────────────────────────────────

function createPm(response, variables, updatedVariables, tests) {
  const makeVarStore = () => ({
    get(key) { return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : (updatedVariables[key] !== undefined ? updatedVariables[key] : undefined); },
    set(key, value) { updatedVariables[key] = String(value); },
    unset(key) { delete updatedVariables[key]; },
    has(key) { return key in variables || key in updatedVariables; },
    clear() {},
  });

  const pm = {
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

    environment: makeVarStore(),
    collectionVariables: makeVarStore(),
    globals: makeVarStore(),
    variables: makeVarStore(),
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

    sendRequest(opts, callback) {
      // Lightweight stub — real implementation would need async support
      if (typeof callback === 'function') {
        callback(new Error('pm.sendRequest not supported in APILIX sandbox'));
      }
    },
  };

  return pm;
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

async function runScript(code, response, variables) {
  const tests = [];
  const updatedVariables = {};
  const consoleLogs = [];

  const pm = createPm(response, variables || {}, updatedVariables, tests);

  const sandbox = {
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
  };

  try {
    const script = new vm.Script(code, { filename: 'apilix-script.js' });
    const ctx = vm.createContext(sandbox);
    script.runInContext(ctx, { timeout: 5000 });
  } catch (err) {
    tests.push({ name: '__ScriptError__', passed: false, error: err.message });
  }

  return { tests, updatedVariables, consoleLogs };
}

module.exports = { runScript };
