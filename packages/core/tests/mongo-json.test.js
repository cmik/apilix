'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const { parseJsonObject, parseJsonArray } = require('../src/mongo-json');

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
  const parsed = parseJsonObject('{ _id: ObjectId("507f1f77bcf86cd799439011") }', {}, { extended: true });
  assert.ok(parsed._id instanceof ObjectId);
  assert.equal(parsed._id.toHexString(), '507f1f77bcf86cd799439011');
});

test('parseJsonObject: new ObjectId() syntax is converted to BSON ObjectId', () => {
  const parsed = parseJsonObject('{ _id: new ObjectId("507f1f77bcf86cd799439012") }', {}, { extended: true });
  assert.ok(parsed._id instanceof ObjectId);
  assert.equal(parsed._id.toHexString(), '507f1f77bcf86cd799439012');
});

test('parseJsonObject: Extended JSON $oid is converted to BSON ObjectId', () => {
  const parsed = parseJsonObject('{ _id: { $oid: "507f1f77bcf86cd799439013" } }', {}, { extended: true });
  assert.ok(parsed._id instanceof ObjectId);
  assert.equal(parsed._id.toHexString(), '507f1f77bcf86cd799439013');
});

test('parseJsonObject: $oid object with extra keys is left unconverted', () => {
  const parsed = parseJsonObject('{ _id: { $oid: "507f1f77bcf86cd799439013", extra: 1 } }', {});
  assert.equal(parsed._id instanceof ObjectId, false);
  assert.deepEqual(parsed._id, { $oid: '507f1f77bcf86cd799439013', extra: 1 });
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

// ─── parseJsonObject: $date ────────────────────────────────────────────────────

test('parseJsonObject: Extended JSON $date (ISO string) is converted to a real Date', () => {
  const parsed = parseJsonObject('{ createdAt: { $date: "2024-01-01T00:00:00.000Z" } }', {}, { extended: true });
  assert.ok(parsed.createdAt instanceof Date);
  assert.equal(parsed.createdAt.toISOString(), '2024-01-01T00:00:00.000Z');
});

test('parseJsonObject: Extended JSON $date (epoch millis) is converted to a real Date', () => {
  const parsed = parseJsonObject('{ createdAt: { $date: 1704067200000 } }', {}, { extended: true });
  assert.ok(parsed.createdAt instanceof Date);
  assert.equal(parsed.createdAt.getTime(), 1704067200000);
});

test('parseJsonObject: $date object with extra keys is left unconverted', () => {
  const parsed = parseJsonObject('{ createdAt: { $date: "2024-01-01T00:00:00.000Z", extra: 1 } }', {}, { extended: true });
  assert.equal(parsed.createdAt.$date, '2024-01-01T00:00:00.000Z');
  assert.equal(parsed.createdAt.extra, 1);
});

test('parseJsonObject: strict mode throws a clear error for an unparseable $date string', () => {
  assert.throws(
    () => parseJsonObject('{ createdAt: { $date: "not-a-date" } }', {}, { strict: true, label: 'Mongo find filter JSON/JSON5', extended: true }),
    /Invalid Mongo find filter JSON\/JSON5: .*Invalid \$date value/,
  );
});

test('parseJsonObject: strict mode throws a clear error for a non-string/non-number $date value', () => {
  assert.throws(
    () => parseJsonObject('{ createdAt: { $date: { nested: true } } }', {}, { strict: true, label: 'Mongo find filter JSON/JSON5', extended: true }),
    /Invalid Mongo find filter JSON\/JSON5: .*Invalid \$date value/,
  );
});

test('parseJsonObject: ISODate() function-call syntax is converted to a real Date', () => {
  const parsed = parseJsonObject('{ createdAt: ISODate("2024-01-01T00:00:00.000Z") }', {}, { extended: true });
  assert.ok(parsed.createdAt instanceof Date);
  assert.equal(parsed.createdAt.toISOString(), '2024-01-01T00:00:00.000Z');
});

test('parseJsonObject: new ISODate() syntax is converted to a real Date', () => {
  const parsed = parseJsonObject('{ createdAt: new ISODate("2024-02-01T00:00:00.000Z") }', {}, { extended: true });
  assert.ok(parsed.createdAt instanceof Date);
  assert.equal(parsed.createdAt.toISOString(), '2024-02-01T00:00:00.000Z');
});

test('parseJsonObject: ObjectId() and ISODate() together in the same filter both convert', () => {
  const parsed = parseJsonObject(
    '{ _id: ObjectId("507f1f77bcf86cd799439011"), createdAt: { $gte: ISODate("2024-01-01T00:00:00.000Z") } }',
    {},
    { extended: true },
  );
  assert.ok(parsed._id instanceof ObjectId);
  assert.equal(parsed._id.toHexString(), '507f1f77bcf86cd799439011');
  assert.ok(parsed.createdAt.$gte instanceof Date);
  assert.equal(parsed.createdAt.$gte.toISOString(), '2024-01-01T00:00:00.000Z');
});

test('parseJsonObject: $oid and $date nested inside $and both convert', () => {
  const parsed = parseJsonObject(
    '{ $and: [ { _id: { $oid: "507f1f77bcf86cd799439011" } }, { createdAt: { $date: "2024-01-01T00:00:00.000Z" } } ] }',
    {},
    { extended: true },
  );
  assert.ok(parsed.$and[0]._id instanceof ObjectId);
  assert.ok(parsed.$and[1].createdAt instanceof Date);
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

test('parseJsonArray: $date inside an aggregation $match stage converts correctly', () => {
  const parsed = parseJsonArray(
    '[{ $match: { createdAt: { $gte: { $date: "2024-01-01T00:00:00.000Z" } } } }]',
    [],
    { extended: true },
  );
  assert.ok(parsed[0].$match.createdAt.$gte instanceof Date);
  assert.equal(parsed[0].$match.createdAt.$gte.toISOString(), '2024-01-01T00:00:00.000Z');
});

// ─── Plain JSON preservation (non-Mongo) ──────────────────────────────────────

test('parseJsonArray: $date is preserved as a plain object when extended is not set', () => {
  const parsed = parseJsonArray('[{"$date":"2024-01-01"}]', []);
  assert.ok(Array.isArray(parsed));
  assert.ok(typeof parsed[0].$date === 'string');
  assert.equal(parsed[0].$date, '2024-01-01');
});

test('parseJsonObject: DynamoDB AttributeValue format is preserved when extended is not set', () => {
  const parsed = parseJsonObject('{"Item":{"$date":{"S":"x"}}}', {});
  assert.ok(parsed.Item);
  assert.ok(parsed.Item.$date);
  assert.equal(parsed.Item.$date.S, 'x');
});

test('parseJsonArray: $oid is preserved as a plain object when extended is not set', () => {
  const parsed = parseJsonArray('[{"id":{"$oid":"507f1f77bcf86cd799439011"}}]', []);
  assert.ok(typeof parsed[0].id.$oid === 'string');
});
