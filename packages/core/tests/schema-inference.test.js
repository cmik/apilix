'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inferSchema, inferFromSamples, mergeSchemas } = require('../src/schema-inference');
const { validateAgainstSchema } = require('../src/schema-validator');

const sample = {
  id: '3f2b8c9e-1a4d-4b6f-8c2e-9a1b2c3d4e5f',
  name: 'Ada',
  age: 36,
  score: 1.5,
  email: 'ada@example.com',
  createdAt: '2024-01-02T03:04:05Z',
  website: 'https://example.com/ada',
  tags: ['a', 'b'],
  address: { city: 'Paris', zip: '75001' },
  nothing: null,
};

test('inferSchema produces types, formats and required, sorted deterministically', () => {
  const s = inferSchema(sample);
  assert.equal(s.type, 'object');
  assert.equal(s.properties.id.format, 'uuid');
  assert.equal(s.properties.email.format, 'email');
  assert.equal(s.properties.createdAt.format, 'date-time');
  assert.equal(s.properties.website.format, 'uri');
  assert.equal(s.properties.age.type, 'integer');
  assert.equal(s.properties.score.type, 'number');
  assert.equal(s.properties.nothing.type, 'null');
  assert.deepEqual(s.properties.tags, { type: 'array', items: { type: 'string' } });
  assert.deepEqual(Object.keys(s.properties), Object.keys(s.properties).slice().sort());
  assert.ok(s.required.includes('address'));
  assert.equal(validateAgainstSchema(s, sample).valid, true);
});

test('output is deterministic regardless of key order', () => {
  const reordered = Object.fromEntries(Object.entries(sample).reverse());
  assert.equal(JSON.stringify(inferSchema(sample)), JSON.stringify(inferSchema(reordered)));
  assert.equal(JSON.stringify(inferSchema(sample)), JSON.stringify(inferSchema(sample)));
});

test('sentinel values never appear in the output (default options)', () => {
  const SENTINEL = 'SENTINEL_VALUE_9f8e7d';
  const data = { note: SENTINEL, list: [SENTINEL, 123456789], nested: { password: SENTINEL, status: SENTINEL }, count: 987654321 };
  const out = JSON.stringify(inferSchema(data));
  assert.ok(!out.includes(SENTINEL));
  assert.ok(!out.includes('987654321'));
  assert.ok(!out.includes('123456789'));
});

test('even with enums+bounds, volatile and secret keys get neither and no sentinel leaks from them', () => {
  const SENT = 'SENTINEL_SECRET_42';
  const rows = [0, 1, 2, 3].map(i => ({
    status: i % 2 ? 'open' : 'closed',
    password: SENT, apiKey: SENT, session_token: SENT,
    user_id: `u${i % 2}`, createdAt: `t${i % 2}`, retryCount: 7,
    nested: { secretNote: SENT, authorization: SENT },
  }));
  const s = inferFromSamples(rows, { enums: true, bounds: true });
  const json = JSON.stringify(s);
  assert.ok(!json.includes(SENT));
  assert.deepEqual(s.properties.status.enum, ['closed', 'open']);
  for (const k of ['password', 'apiKey', 'session_token', 'user_id', 'createdAt']) {
    assert.equal(s.properties[k].enum, undefined, k);
    assert.equal(s.properties[k].minLength, undefined, k);
  }
  assert.equal(s.properties.nested.properties.secretNote.enum, undefined);
  assert.equal(s.properties.retryCount.minimum, 7);
});

test('enums and bounds are off by default', () => {
  const s = inferFromSamples([{ status: 'a', n: 1 }, { status: 'a', n: 2 }]);
  assert.equal(s.properties.status.enum, undefined);
  assert.equal(s.properties.n.minimum, undefined);
});

test('requiredThreshold controls required keys', () => {
  const samples = [{ a: 1, b: 1 }, { a: 1 }, { a: 1 }, { a: 1, b: 2 }];
  assert.deepEqual(inferFromSamples(samples).required, ['a']);
  assert.deepEqual(inferFromSamples(samples, { requiredThreshold: 0.5 }).required, ['a', 'b']);
  assert.equal(inferFromSamples(samples, { requiredThreshold: 0 }).required.length, 2);
});

test('mixed types become a sorted union; integer+number collapses to number', () => {
  assert.deepEqual(inferFromSamples([{ v: 1 }, { v: 'x' }, { v: null }]).properties.v.type, ['integer', 'null', 'string']);
  assert.equal(inferFromSamples([{ v: 1 }, { v: 1.5 }]).properties.v.type, 'number');
});

test('differing formats drop the format', () => {
  const s = inferFromSamples([{ v: 'a@b.co' }, { v: 'plain' }]);
  assert.equal(s.properties.v.format, undefined);
});

test('depth and array caps', () => {
  const deep = { a: { b: { c: { d: 1 } } } };
  const s = inferSchema(deep, { maxDepth: 2 });
  assert.deepEqual(s.properties.a.properties.b, { type: 'object' });
  const big = { list: Array.from({ length: 100 }, (_, i) => (i < 20 ? 'x' : 1)) };
  assert.equal(inferSchema(big, { maxArrayItems: 20 }).properties.list.items.type, 'string');
});

test('mergeSchemas unions properties and intersects required', () => {
  const a = inferSchema({ a: 1, b: 'x' });
  const b = inferSchema({ a: 2, c: true });
  const m = mergeSchemas(a, b);
  assert.deepEqual(Object.keys(m.properties), ['a', 'b', 'c']);
  assert.deepEqual(m.required, ['a']);
  assert.equal(validateAgainstSchema(m, { a: 1, b: 'x' }).valid, true);
  assert.equal(validateAgainstSchema(m, { a: 1, c: false }).valid, true);
});

test('arrays of top-level values and scalars', () => {
  assert.equal(inferSchema([1, 2]).items.type, 'integer');
  assert.equal(inferSchema('x').type, 'string');
  assert.equal(inferSchema(null).type, 'null');
});

test('keys named like Object.prototype members and __proto__ are handled as plain properties', () => {
  const sample = JSON.parse('{"constructor":1,"toString":"x","hasOwnProperty":true,"__proto__":{"a":1},"valueOf":null}');
  const s = inferSchema(sample);
  const keys = Object.keys(s.properties).sort();
  assert.deepEqual(keys, ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf']);
  assert.equal(Object.getPrototypeOf(s.properties), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(s.properties, '__proto__').value.type, 'object');
  assert.deepEqual(Object.getOwnPropertyDescriptor(s.properties, 'constructor').value, { type: 'integer' });
  assert.deepEqual(s.required, ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf']);
});

test('mergeSchemas works with prototype-named keys present on one side only', () => {
  const a = inferSchema(JSON.parse('{"constructor":1,"id":1}'));
  const b = inferSchema(JSON.parse('{"id":2,"toString":"s","__proto__":{"z":1}}'));
  const m = mergeSchemas(a, b);
  assert.deepEqual(Object.keys(m.properties).sort(), ['__proto__', 'constructor', 'id', 'toString']);
  assert.deepEqual(Object.getOwnPropertyDescriptor(m.properties, 'constructor').value, { type: 'integer' });
  assert.equal(Object.getOwnPropertyDescriptor(m.properties, '__proto__').value.type, 'object');
  assert.deepEqual(m.required, ['id']);
  // merging two schemas that both have them
  const m2 = mergeSchemas(b, b);
  assert.deepEqual(Object.keys(m2.properties).sort(), ['__proto__', 'id', 'toString']);
  assert.deepEqual(m2.required, ['__proto__', 'id', 'toString']);
});
