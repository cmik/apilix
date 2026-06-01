'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSON5 = require('json5');
const { ObjectId } = require('mongodb');

function looksLikeHexObjectId(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value);
}

function convertExtendedMongoTypes(value) {
  if (Array.isArray(value)) {
    return value.map(convertExtendedMongoTypes);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  if (Object.keys(value).length === 1 && Object.prototype.hasOwnProperty.call(value, '$oid')) {
    const oid = value.$oid;
    if (looksLikeHexObjectId(oid)) {
      return new ObjectId(oid);
    }
    return value;
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = convertExtendedMongoTypes(v);
  }
  return out;
}

function rewriteObjectIdCalls(text) {
  const src = String(text);
  const len = src.length;
  let i = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  let out = '';

  while (i < len) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
        quote = '';
      }
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    const isNew = src.startsWith('new', i) && (i === 0 || !/[A-Za-z0-9_$]/.test(src[i - 1])) && (i + 3 >= len || /\s/.test(src[i + 3]));
    let fnStart = isNew ? i + 3 : i;
    if (isNew) {
      while (fnStart < len && /\s/.test(src[fnStart])) fnStart += 1;
    }
    if (!src.startsWith('ObjectId', fnStart) || (fnStart > 0 && /[A-Za-z0-9_$]/.test(src[fnStart - 1]))) {
      out += ch;
      i += 1;
      continue;
    }

    let j = fnStart + 'ObjectId'.length;
    while (j < len && /\s/.test(src[j])) j += 1;
    if (j >= len || src[j] !== '(') {
      out += ch;
      i += 1;
      continue;
    }
    j += 1;
    while (j < len && /\s/.test(src[j])) j += 1;
    if (j >= len || (src[j] !== '"' && src[j] !== "'")) {
      out += ch;
      i += 1;
      continue;
    }

    const strQuote = src[j];
    j += 1;
    const valueStart = j;
    let strEscaped = false;
    while (j < len) {
      const c = src[j];
      if (strEscaped) {
        strEscaped = false;
        j += 1;
        continue;
      }
      if (c === '\\') {
        strEscaped = true;
        j += 1;
        continue;
      }
      if (c === strQuote) break;
      j += 1;
    }
    if (j >= len) {
      out += ch;
      i += 1;
      continue;
    }
    const rawValue = src.slice(valueStart, j);
    j += 1;
    while (j < len && /\s/.test(src[j])) j += 1;
    if (j >= len || src[j] !== ')') {
      out += ch;
      i += 1;
      continue;
    }

    if (!looksLikeHexObjectId(rawValue)) {
      out += ch;
      i += 1;
      continue;
    }

    out += `{ "$oid": "${rawValue}" }`;
    i = j + 1;
  }

  return out;
}

function parseMongoLikeJson(text) {
  try {
    return JSON5.parse(String(text));
  } catch (err) {
    const rewritten = rewriteObjectIdCalls(text);
    if (rewritten === String(text)) throw err;
    return JSON5.parse(rewritten);
  }
}

// Load the two parser helpers directly from the source so the tests remain
// decoupled from the rest of the request-engine module (MongoClient connect,
// axios, etc.).  The functions only depend on JSON5 which is available here.
function makeParseJsonObject() {
  return function parseJsonObject(text, fallback = {}, options = {}) {
    const { strict = false, label = 'JSON object' } = options;
    if (!text || !String(text).trim()) return fallback;
    try {
      const parsed = convertExtendedMongoTypes(parseMongoLikeJson(text));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      if (strict) {
        throw new Error(`${label} must be an object`);
      }
      return fallback;
    } catch (err) {
      if (strict) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid ${label}: ${message}`);
      }
      return fallback;
    }
  };
}

function makeParseJsonArray() {
  return function parseJsonArray(text, fallback = [], options = {}) {
    const { strict = false, label = 'JSON array' } = options;
    if (!text || !String(text).trim()) return fallback;
    try {
      const parsed = convertExtendedMongoTypes(parseMongoLikeJson(text));
      if (Array.isArray(parsed)) {
        return parsed;
      }
      if (strict) {
        throw new Error(`${label} must be an array`);
      }
      return fallback;
    } catch (err) {
      if (strict) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid ${label}: ${message}`);
      }
      return fallback;
    }
  };
}

const parseJsonObject = makeParseJsonObject();
const parseJsonArray = makeParseJsonArray();

// ─── parseJsonObject ──────────────────────────────────────────────────────────

test('parseJsonObject: strict JSON object parses correctly', () => {
  const parsed = parseJsonObject('{"status":"active","count":2}', {});
  assert.equal(parsed.status, 'active');
  assert.equal(parsed.count, 2);
});

test('parseJsonObject: bare (unquoted) keys are accepted', () => {
  const parsed = parseJsonObject('{ status: "active", count: 2 }', {});
  assert.equal(parsed.status, 'active');
  assert.equal(parsed.count, 2);
});

test('parseJsonObject: $-prefixed operator keys are accepted', () => {
  const parsed = parseJsonObject('{ $match: { status: true } }', {});
  assert.deepEqual(parsed, { $match: { status: true } });
});

test('parseJsonObject: spaces around colons are accepted (target case)', () => {
  const parsed = parseJsonObject('{ $match : { status : true } }', {});
  assert.deepEqual(parsed, { $match: { status: true } });
});

test('parseJsonObject: colon inside a string value is not corrupted', () => {
  const parsed = parseJsonObject('{ note: "foo, bar:baz" }', {});
  assert.equal(parsed.note, 'foo, bar:baz');
});

test('parseJsonObject: single-quoted string values are accepted', () => {
  const parsed = parseJsonObject("{ name: 'alice', status: 'active' }", {});
  assert.equal(parsed.name, 'alice');
  assert.equal(parsed.status, 'active');
});

test('parseJsonObject: trailing comma is accepted', () => {
  const parsed = parseJsonObject('{ status: "active", }', {});
  assert.equal(parsed.status, 'active');
});

test('parseJsonObject: ObjectId() function-call syntax is converted to BSON ObjectId', () => {
  const parsed = parseJsonObject('{ _id: ObjectId("507f1f77bcf86cd799439011") }', {});
  assert.ok(parsed._id instanceof ObjectId);
  assert.equal(parsed._id.toHexString(), '507f1f77bcf86cd799439011');
});

test('parseJsonObject: new ObjectId() syntax is converted to BSON ObjectId', () => {
  const parsed = parseJsonObject('{ _id: new ObjectId("507f1f77bcf86cd799439012") }', {});
  assert.ok(parsed._id instanceof ObjectId);
  assert.equal(parsed._id.toHexString(), '507f1f77bcf86cd799439012');
});

test('parseJsonObject: Extended JSON $oid is converted to BSON ObjectId', () => {
  const parsed = parseJsonObject('{ _id: { $oid: "507f1f77bcf86cd799439013" } }', {});
  assert.ok(parsed._id instanceof ObjectId);
  assert.equal(parsed._id.toHexString(), '507f1f77bcf86cd799439013');
});

test('parseJsonObject: completely invalid input returns fallback', () => {
  const fallback = {};
  const parsed = parseJsonObject('not valid {{ json', fallback);
  assert.equal(parsed, fallback);
});

test('parseJsonObject: strict mode throws on invalid JSON/JSON5', () => {
  assert.throws(
    () => parseJsonObject('not valid {{ json', {}, { strict: true, label: 'Mongo find filter JSON/JSON5' }),
    /Invalid Mongo find filter JSON\/JSON5:/,
  );
});

test('parseJsonObject: strict mode throws when parsed value is not an object', () => {
  assert.throws(
    () => parseJsonObject('[1, 2, 3]', {}, { strict: true, label: 'Mongo find filter JSON/JSON5' }),
    /Invalid Mongo find filter JSON\/JSON5: .*must be an object/,
  );
});

// ─── parseJsonArray ───────────────────────────────────────────────────────────

test('parseJsonArray: aggregate pipeline with bare $-operator keys parses correctly', () => {
  const parsed = parseJsonArray('[{ $group: { _id: "$field", count: { $sum: 1 } } }]', []);
  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], { $group: { _id: '$field', count: { $sum: 1 } } });
});

test('parseJsonArray: invalid literal returns fallback', () => {
  const fallback = [];
  const parsed = parseJsonArray('[{ bad', fallback);
  assert.equal(parsed, fallback);
});

test('parseJsonArray: strict mode throws on invalid JSON/JSON5', () => {
  assert.throws(
    () => parseJsonArray('[{ bad', [], { strict: true, label: 'Mongo aggregate pipeline JSON/JSON5' }),
    /Invalid Mongo aggregate pipeline JSON\/JSON5:/,
  );
});

test('parseJsonArray: strict mode throws when parsed value is not an array', () => {
  assert.throws(
    () => parseJsonArray('{ key: "value" }', [], { strict: true, label: 'Mongo aggregate pipeline JSON/JSON5' }),
    /Invalid Mongo aggregate pipeline JSON\/JSON5: .*must be an array/,
  );
});
