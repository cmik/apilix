'use strict';

/**
 * JSON Schema (draft-07 compatible) inference from sample values.
 *
 * Privacy / determinism rules:
 *  - Output never contains sample values, unless the caller opts in to `enums` AND the field is
 *    neither volatile- nor secret-looking (ids, tokens, timestamps, passwords… never get enums or bounds).
 *  - Same input => byte-identical output: property names are sorted, keywords are emitted in a fixed order.
 *  - Depth, array-length and sample-count are capped so a huge payload stays bounded.
 */

const { isVolatileKey, isSecretKey, FORMATS } = require('./schema-rules');

const SCHEMA_URI = 'http://json-schema.org/draft-07/schema#';

const DEFAULTS = Object.freeze({
  requiredThreshold: 1,
  enums: false,
  bounds: false,
  formats: true,
  maxDepth: 8,
  maxArrayItems: 20,
  maxProperties: 200,
  maxSamples: 200,
  additionalProperties: undefined,
});

const ENUM_MAX_VALUES = 8;
const ENUM_MAX_LEN = 40;

function resolveOptions(o) {
  const out = { ...DEFAULTS };
  if (o && typeof o === 'object') {
    for (const k of Object.keys(DEFAULTS)) if (o[k] !== undefined) out[k] = o[k];
  }
  let t = Number(out.requiredThreshold);
  if (!Number.isFinite(t)) t = 1;
  out.requiredThreshold = Math.min(1, Math.max(0, t));
  for (const k of ['maxDepth', 'maxArrayItems', 'maxProperties', 'maxSamples']) {
    const n = Math.floor(Number(out[k]));
    out[k] = Number.isFinite(n) && n > 0 ? n : DEFAULTS[k];
  }
  return out;
}

// ─── Value classification ────────────────────────────────────────────────────

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'string': return 'string';
    case 'boolean': return 'boolean';
    case 'number': return Number.isFinite(v) ? (Number.isInteger(v) ? 'integer' : 'number') : null;
    case 'object': return 'object';
    default: return null; // undefined, function, symbol, bigint: not JSON
  }
}

const RFC3339_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** JSON Schema `format` for a string value, or null. Only formats Ajv (ajv-formats) validates identically. */
function detectFormat(s) {
  if (typeof s !== 'string' || s.length > 2048) return null;
  const f = FORMATS.find(x => x.re.test(s));
  if (!f) return null;
  switch (f.name) {
    case 'uuid': return 'uuid';
    case 'email': return 'email';
    case 'url': return 'uri';
    case 'iso-date':
      if (DATE_ONLY_RE.test(s)) return 'date';
      if (RFC3339_DATE_TIME_RE.test(s)) return 'date-time';
      return null; // loose ISO variants (no timezone…) get no format rather than a wrong one
    default: return null;
  }
}

// ─── Accumulator ─────────────────────────────────────────────────────────────

function newNode(blocked) {
  return {
    blocked,
    n: 0,
    kinds: new Map(),
    props: new Map(),
    items: null,
    strCount: 0,
    formatCounts: new Map(),
    strVals: new Set(),
    strOverflow: false,
    strMin: Infinity, strMax: -Infinity,
    numMin: Infinity, numMax: -Infinity,
    arrMin: Infinity, arrMax: -Infinity,
  };
}

function observe(node, value, depth, opts) {
  const kind = kindOf(value);
  if (kind === null) return;
  node.n++;
  node.kinds.set(kind, (node.kinds.get(kind) || 0) + 1);
  if (depth >= opts.maxDepth) return;

  if (kind === 'object') {
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      if (kindOf(value[key]) === null) continue;
      let child = node.props.get(key);
      if (!child) {
        if (node.props.size >= opts.maxProperties) continue;
        child = newNode(node.blocked || isVolatileKey(key) || isSecretKey(key));
        node.props.set(key, child);
      }
      observe(child, value[key], depth + 1, opts);
    }
  } else if (kind === 'array') {
    if (!node.items) node.items = newNode(node.blocked);
    const len = value.length;
    node.arrMin = Math.min(node.arrMin, len);
    node.arrMax = Math.max(node.arrMax, len);
    const upTo = Math.min(len, opts.maxArrayItems);
    for (let i = 0; i < upTo; i++) observe(node.items, value[i], depth + 1, opts);
  } else if (kind === 'string') {
    node.strCount++;
    const f = detectFormat(value);
    const fk = f || '';
    node.formatCounts.set(fk, (node.formatCounts.get(fk) || 0) + 1);
    node.strMin = Math.min(node.strMin, value.length);
    node.strMax = Math.max(node.strMax, value.length);
    if (opts.enums && !node.blocked && !node.strOverflow) {
      if (value.length > ENUM_MAX_LEN) node.strOverflow = true;
      else {
        node.strVals.add(value);
        if (node.strVals.size > ENUM_MAX_VALUES) node.strOverflow = true;
      }
    }
  } else if (kind === 'integer' || kind === 'number') {
    node.numMin = Math.min(node.numMin, value);
    node.numMax = Math.max(node.numMax, value);
  }
}

function buildSchema(node, parentCount, depth, opts) {
  const s = {};
  const kindNames = [...node.kinds.keys()];
  const hasNum = node.kinds.has('number');
  const types = new Set();
  for (const k of kindNames) {
    if (k === 'integer') types.add(hasNum ? 'number' : 'integer');
    else types.add(k);
  }
  const sortedTypes = [...types].sort();
  if (sortedTypes.length === 1) s.type = sortedTypes[0];
  else if (sortedTypes.length > 1) s.type = sortedTypes;

  // string keywords
  if (node.strCount > 0) {
    if (opts.formats && node.formatCounts.size === 1) {
      const only = [...node.formatCounts.keys()][0];
      if (only) s.format = only;
    }
    const hasFormat = s.format !== undefined;
    if (opts.enums && !node.blocked && !node.strOverflow && !hasFormat
      && node.strVals.size > 0 && node.strCount > node.strVals.size) {
      s.enum = [...node.strVals].sort();
    }
    if (opts.bounds && !node.blocked && !hasFormat) {
      s.minLength = node.strMin;
      s.maxLength = node.strMax;
    }
  }
  if (opts.bounds && !node.blocked && (node.kinds.has('integer') || hasNum)) {
    s.minimum = node.numMin;
    s.maximum = node.numMax;
  }
  if (opts.bounds && !node.blocked && node.kinds.has('array') && Number.isFinite(node.arrMin)) {
    s.minItems = node.arrMin;
    s.maxItems = node.arrMax;
  }

  const objCount = node.kinds.get('object') || 0;
  if (objCount > 0 && node.props.size > 0) {
    const props = {};
    const required = [];
    for (const key of [...node.props.keys()].sort()) {
      const child = node.props.get(key);
      setOwn(props, key, buildSchema(child, objCount, depth + 1, opts));
      if (child.n / objCount >= opts.requiredThreshold && child.n > 0) required.push(key);
    }
    s.properties = props;
    if (required.length) s.required = required;
  }
  if (objCount > 0 && opts.additionalProperties === false && node.props.size > 0) s.additionalProperties = false;

  if (node.kinds.has('array') && node.items && node.items.n > 0) {
    s.items = buildSchema(node.items, node.items.n, depth + 1, opts);
  }
  return s;
}

/** Infer one schema from a list of samples (e.g. several responses of the same endpoint). */
function inferFromSamples(samples, options) {
  const opts = resolveOptions(options);
  const list = Array.isArray(samples) ? samples.slice(0, opts.maxSamples) : [];
  const root = newNode(false);
  for (const v of list) observe(root, v, 0, opts);
  const body = buildSchema(root, root.n, 0, opts);
  return { $schema: SCHEMA_URI, ...body };
}

/** Infer a schema from a single value. */
function inferSchema(value, options) {
  return inferFromSamples([value], options);
}

// ─── Schema-level merge ──────────────────────────────────────────────────────

const KEY_ORDER = ['$schema', 'type', 'format', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'properties', 'required', 'items', 'additionalProperties'];

function toTypeSet(t) {
  if (t === undefined) return null;
  return new Set(Array.isArray(t) ? t : [t]);
}

function mergeTypes(a, b) {
  const ta = toTypeSet(a);
  const tb = toTypeSet(b);
  if (!ta || !tb) return undefined; // one side unconstrained => unconstrained
  const u = new Set([...ta, ...tb]);
  if (u.has('integer') && u.has('number')) u.delete('integer');
  const arr = [...u].sort();
  return arr.length === 1 ? arr[0] : arr;
}

/**
 * Merge two inferred schemas into one that accepts both. Properties are unioned and `required`
 * becomes the intersection; differing formats/enum-vs-open fields are relaxed. Pure and deterministic.
 */
function mergeSchemas(a, b) {
  if (a === undefined || a === null) return b === undefined ? {} : clone(b);
  if (b === undefined || b === null) return clone(a);
  const out = {};
  if (a.$schema || b.$schema) out.$schema = a.$schema || b.$schema;
  const type = mergeTypes(a.type, b.type);
  if (type !== undefined) out.type = type;
  if (a.format !== undefined && a.format === b.format) out.format = a.format;
  if (Array.isArray(a.enum) && Array.isArray(b.enum)) out.enum = [...new Set([...a.enum, ...b.enum])].sort();
  for (const [k, fn] of [['minimum', Math.min], ['maximum', Math.max], ['minLength', Math.min], ['maxLength', Math.max], ['minItems', Math.min], ['maxItems', Math.max]]) {
    if (typeof a[k] === 'number' && typeof b[k] === 'number') out[k] = fn(a[k], b[k]);
  }
  if (a.properties || b.properties) {
    const pa = a.properties || {};
    const pb = b.properties || {};
    const props = {};
    for (const key of [...new Set([...Object.keys(pa), ...Object.keys(pb)])].sort()) {
      const inA = Object.hasOwn(pa, key);
      const inB = Object.hasOwn(pb, key);
      setOwn(props, key, inA && inB ? mergeSchemas(pa[key], pb[key]) : clone(inA ? pa[key] : pb[key]));
    }
    out.properties = props;
    const ra = new Set(a.required || []);
    const required = (b.required || []).filter(k => ra.has(k) && Object.hasOwn(pa, k) && Object.hasOwn(pb, k)).sort();
    if (required.length) out.required = required;
  }
  if (a.items || b.items) out.items = mergeSchemas(a.items, b.items);
  if (a.additionalProperties === false && b.additionalProperties === false) out.additionalProperties = false;
  return orderKeys(out);
}

function orderKeys(s) {
  const o = {};
  for (const k of KEY_ORDER) if (s[k] !== undefined) o[k] = s[k];
  return o;
}

/** Define an own data property (safe for keys like `__proto__`, `constructor`, `toString`). */
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

module.exports = {
  SCHEMA_URI,
  DEFAULTS,
  inferSchema,
  inferFromSamples,
  mergeSchemas,
  detectFormat,
  isVolatileKey,
  isSecretKey,
};
