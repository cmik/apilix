'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MongoClient, ObjectId } = require('mongodb');

const mongoEngine = require('../src/mongo-engine');

const TEST_URI = 'mongodb://127.0.0.1:27017/mongo-engine-test';

function mockMongoClient(t, { find, aggregate, countDocuments } = {}) {
  const col = {
    find: find || (() => ({ limit() { return this; }, toArray: async () => [] })),
    aggregate: aggregate || (() => ({ limit() { return this; }, toArray: async () => [] })),
    countDocuments: countDocuments || (async () => 0),
  };
  t.mock.method(MongoClient.prototype, 'connect', async function () { return this; });
  t.mock.method(MongoClient.prototype, 'close', async function () { return undefined; });
  t.mock.method(MongoClient.prototype, 'db', function () { return { collection() { return col; } }; });
  return col;
}

// ─── executeQuery ─────────────────────────────────────────────────────────────

test('executeQuery: relaxed JSON5 filter is parsed and passed to find()', async (t) => {
  let capturedFilter = null;
  mockMongoClient(t, {
    find: (filter) => {
      capturedFilter = filter;
      return { limit() { return this; }, toArray: async () => [] };
    },
  });

  const result = await mongoEngine.executeQuery(TEST_URI, 'testdb', 'users', '{ status: "active" }', 10);
  assert.equal(result.success, true);
  assert.deepEqual(capturedFilter, { status: 'active' });
});

test('executeQuery: {$oid} filter is converted to a real ObjectId before being passed to find()', async (t) => {
  let capturedFilter = null;
  mockMongoClient(t, {
    find: (filter) => {
      capturedFilter = filter;
      return { limit() { return this; }, toArray: async () => [] };
    },
  });

  const result = await mongoEngine.executeQuery(
    TEST_URI,
    'testdb',
    'users',
    '{ "_id": { "$oid": "507f1f77bcf86cd799439011" } }',
    10,
  );
  assert.equal(result.success, true);
  assert.ok(capturedFilter._id instanceof ObjectId);
  assert.equal(capturedFilter._id.toHexString(), '507f1f77bcf86cd799439011');
});

test('executeQuery: ObjectId(...) shell literal filter is converted before being passed to find()', async (t) => {
  let capturedFilter = null;
  mockMongoClient(t, {
    find: (filter) => {
      capturedFilter = filter;
      return { limit() { return this; }, toArray: async () => [] };
    },
  });

  const result = await mongoEngine.executeQuery(
    TEST_URI,
    'testdb',
    'users',
    '{ _id: ObjectId("507f1f77bcf86cd799439012") }',
    10,
  );
  assert.equal(result.success, true);
  assert.ok(capturedFilter._id instanceof ObjectId);
  assert.equal(capturedFilter._id.toHexString(), '507f1f77bcf86cd799439012');
});

test('executeQuery: {$date} filter is converted to a real Date before being passed to find()', async (t) => {
  let capturedFilter = null;
  mockMongoClient(t, {
    find: (filter) => {
      capturedFilter = filter;
      return { limit() { return this; }, toArray: async () => [] };
    },
  });

  const result = await mongoEngine.executeQuery(
    TEST_URI,
    'testdb',
    'users',
    '{ "createdAt": { "$gte": { "$date": "2024-01-01T00:00:00.000Z" } } }',
    10,
  );
  assert.equal(result.success, true);
  assert.ok(capturedFilter.createdAt.$gte instanceof Date);
  assert.equal(capturedFilter.createdAt.$gte.toISOString(), '2024-01-01T00:00:00.000Z');
});

test('executeQuery: ISODate(...) shell literal filter is converted before being passed to find()', async (t) => {
  let capturedFilter = null;
  mockMongoClient(t, {
    find: (filter) => {
      capturedFilter = filter;
      return { limit() { return this; }, toArray: async () => [] };
    },
  });

  const result = await mongoEngine.executeQuery(
    TEST_URI,
    'testdb',
    'users',
    '{ createdAt: { $gte: ISODate("2024-01-01T00:00:00.000Z") } }',
    10,
  );
  assert.equal(result.success, true);
  assert.ok(capturedFilter.createdAt.$gte instanceof Date);
  assert.equal(capturedFilter.createdAt.$gte.toISOString(), '2024-01-01T00:00:00.000Z');
});

test('executeQuery: invalid filter JSON returns a success:false error without touching find()', async (t) => {
  let findCalled = false;
  mockMongoClient(t, {
    find: () => {
      findCalled = true;
      return { limit() { return this; }, toArray: async () => [] };
    },
  });

  const result = await mongoEngine.executeQuery(TEST_URI, 'testdb', 'users', 'not valid {{ json', 10);
  assert.equal(result.success, false);
  assert.match(result.error, /^Invalid query JSON:/);
  assert.equal(findCalled, false);
});

// ─── executeAggregation ────────────────────────────────────────────────────────

test('executeAggregation: pipeline with $oid and $date stages is converted before being passed to aggregate()', async (t) => {
  let capturedPipeline = null;
  mockMongoClient(t, {
    aggregate: (pipeline) => {
      capturedPipeline = pipeline;
      return { limit() { return this; }, toArray: async () => [] };
    },
  });

  const result = await mongoEngine.executeAggregation(
    TEST_URI,
    'testdb',
    'users',
    '[{ "$match": { "_id": { "$oid": "507f1f77bcf86cd799439011" }, "createdAt": { "$gte": { "$date": "2024-01-01T00:00:00.000Z" } } } }]',
  );
  assert.equal(result.success, true);
  assert.ok(capturedPipeline[0].$match._id instanceof ObjectId);
  assert.ok(capturedPipeline[0].$match.createdAt.$gte instanceof Date);
});

test('executeAggregation: invalid pipeline JSON returns a success:false error without touching aggregate()', async (t) => {
  let aggregateCalled = false;
  mockMongoClient(t, {
    aggregate: () => {
      aggregateCalled = true;
      return { limit() { return this; }, toArray: async () => [] };
    },
  });

  const result = await mongoEngine.executeAggregation(TEST_URI, 'testdb', 'users', '[{ bad');
  assert.equal(result.success, false);
  assert.match(result.error, /^Invalid pipeline JSON:/);
  assert.equal(aggregateCalled, false);
});
