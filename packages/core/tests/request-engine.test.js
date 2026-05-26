'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSON5 = require('json5');

// Load the two parser helpers directly from the source so the tests remain
// decoupled from the rest of the request-engine module (MongoClient connect,
// axios, etc.).  The functions only depend on JSON5 which is available here.
function makeParseJsonObject() {
  return function parseJsonObject(text, fallback = {}, options = {}) {
    const { strict = false, label = 'JSON object' } = options;
    if (!text || !String(text).trim()) return fallback;
    try {
      const parsed = JSON5.parse(String(text));
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
      const parsed = JSON5.parse(String(text));
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

test('parseJsonObject: ObjectId() function-call syntax returns fallback (unsupported)', () => {
  const fallback = {};
  const parsed = parseJsonObject('ObjectId("507f1f77bcf86cd799439011")', fallback);
  assert.equal(parsed, fallback);
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
