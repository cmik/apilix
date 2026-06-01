import { describe, it, expect, vi } from 'vitest';

// MongoPanel imports ../api which references `window` at module-load time.
// Mock it so the pure utility functions can be tested in a node environment.
vi.mock('../api', () => ({
  listMongoDatabases: vi.fn(),
  listMongoCollections: vi.fn(),
}));

import { parseMongoConfig } from './MongoPanel';

// ─── parseMongoConfig ─────────────────────────────────────────────────────────

describe('parseMongoConfig', () => {
  it('returns null for an empty string', () => {
    expect(parseMongoConfig('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(parseMongoConfig('   ')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseMongoConfig('{not valid json')).toBeNull();
  });

  it('returns null for a JSON primitive (string)', () => {
    expect(parseMongoConfig('"hello"')).toBeNull();
  });

  it('returns null for a JSON primitive (number)', () => {
    expect(parseMongoConfig('42')).toBeNull();
  });

  it('returns null for a JSON null literal', () => {
    expect(parseMongoConfig('null')).toBeNull();
  });

  it('returns null for a JSON array (top-level array is not a config object)', () => {
    expect(parseMongoConfig('[]')).toBeNull();
  });

  it('returns an empty object for an empty JSON object', () => {
    expect(parseMongoConfig('{}')).toEqual({});
  });

  it('returns the parsed object for a valid minimal config', () => {
    const raw = JSON.stringify({ operation: 'find', collection: 'users' });
    const result = parseMongoConfig(raw);
    expect(result).not.toBeNull();
    expect(result?.operation).toBe('find');
    expect(result?.collection).toBe('users');
  });

  it('preserves nested connection object', () => {
    const raw = JSON.stringify({
      connection: { mode: 'direct', uri: 'mongodb://localhost:27017' },
      database: 'mydb',
    });
    const result = parseMongoConfig(raw);
    expect(result?.connection?.mode).toBe('direct');
    expect(result?.connection?.uri).toBe('mongodb://localhost:27017');
    expect(result?.database).toBe('mydb');
  });

  it('preserves named connection config', () => {
    const raw = JSON.stringify({
      connection: { mode: 'named', connectionId: 'atlas-prod' },
    });
    const result = parseMongoConfig(raw);
    expect(result?.connection?.mode).toBe('named');
    expect(result?.connection?.connectionId).toBe('atlas-prod');
  });

  it('preserves auth override fields', () => {
    const raw = JSON.stringify({
      auth: { mode: 'scram', username: 'admin', password: '{{mongoPass}}', authSource: 'admin' },
    });
    const result = parseMongoConfig(raw);
    expect(result?.auth?.mode).toBe('scram');
    expect(result?.auth?.username).toBe('admin');
    expect(result?.auth?.password).toBe('{{mongoPass}}');
    expect(result?.auth?.authSource).toBe('admin');
  });

  it('preserves pipeline and numeric fields', () => {
    const raw = JSON.stringify({
      operation: 'aggregate',
      pipeline: '[{"$match":{"active":true}}]',
      limit: 100,
      maxTimeMS: 5000,
    });
    const result = parseMongoConfig(raw);
    expect(result?.operation).toBe('aggregate');
    expect(result?.limit).toBe(100);
    expect(result?.maxTimeMS).toBe(5000);
  });

  it('round-trips a full config without data loss', () => {
    const config = {
      connection: { mode: 'direct', uri: '{{mongoUri}}' },
      database: '{{mongoDb}}',
      collection: 'orders',
      operation: 'find',
      filter: '{ "status": "active" }',
      projection: '{ "_id": 0 }',
      sort: '{ "createdAt": -1 }',
      limit: 25,
      skip: 0,
      maxTimeMS: 10000,
    };
    const result = parseMongoConfig(JSON.stringify(config));
    expect(result).toEqual(config);
  });

  it('handles extra unknown fields without dropping them', () => {
    const raw = JSON.stringify({ operation: 'find', _custom: 'extra', nested: { a: 1 } });
    const result = parseMongoConfig(raw);
    expect((result as Record<string, unknown>)['_custom']).toBe('extra');
  });
});

// ─── Pipeline stage insertion logic ──────────────────────────────────────────
//
// The handleInsertStage function in MongoPanel is an inline component callback,
// so we test its equivalent pure logic here to verify that:
//   - A stage is appended to an existing pipeline array
//   - A stage is appended when the pipeline is empty / invalid
//   - The resulting pipeline JSON is well-formed

function insertStageIntoPipeline(bodyRaw: string, stageJson: string): string {
  // Mirrors the handleInsertStage logic in MongoPanel
  const current = parseMongoConfig(bodyRaw) ?? {};
  const existingPipeline: unknown[] = (() => {
    try { return JSON.parse((current as Record<string, unknown>).pipeline as string ?? '[]'); } catch { return []; }
  })();
  const newStage = JSON.parse(stageJson);
  const updated = [...existingPipeline, newStage];
  return JSON.stringify({ ...current, pipeline: JSON.stringify(updated, null, 2) }, null, 2);
}

describe('pipeline stage insertion logic', () => {
  const matchTemplate = '{ "$match": { "field": "value" } }';

  it('appends a stage to an empty pipeline', () => {
    const raw = JSON.stringify({ operation: 'aggregate', pipeline: '[]' });
    const result = insertStageIntoPipeline(raw, matchTemplate);
    const parsed = JSON.parse(result);
    const pipeline = JSON.parse(parsed.pipeline);
    expect(pipeline).toHaveLength(1);
    expect(pipeline[0]).toHaveProperty('$match');
  });

  it('appends a stage to an existing pipeline', () => {
    const existing = [{ $match: { status: 'active' } }];
    const raw = JSON.stringify({ operation: 'aggregate', pipeline: JSON.stringify(existing) });
    const result = insertStageIntoPipeline(raw, '{ "$limit": 10 }');
    const parsed = JSON.parse(result);
    const pipeline = JSON.parse(parsed.pipeline);
    expect(pipeline).toHaveLength(2);
    expect(pipeline[1]).toEqual({ $limit: 10 });
  });

  it('appends a stage when pipeline is missing from config', () => {
    const raw = JSON.stringify({ operation: 'aggregate' });
    const result = insertStageIntoPipeline(raw, matchTemplate);
    const parsed = JSON.parse(result);
    const pipeline = JSON.parse(parsed.pipeline);
    expect(pipeline).toHaveLength(1);
  });

  it('recovers gracefully when existing pipeline is invalid JSON', () => {
    const raw = JSON.stringify({ operation: 'aggregate', pipeline: 'not-json' });
    const result = insertStageIntoPipeline(raw, matchTemplate);
    const parsed = JSON.parse(result);
    const pipeline = JSON.parse(parsed.pipeline);
    expect(pipeline).toHaveLength(1);
    expect(pipeline[0]).toHaveProperty('$match');
  });

  it('preserves other config fields when inserting a stage', () => {
    const raw = JSON.stringify({
      operation: 'aggregate',
      database: 'mydb',
      collection: 'orders',
      pipeline: '[]',
    });
    const result = insertStageIntoPipeline(raw, '{ "$count": "total" }');
    const parsed = JSON.parse(result);
    expect(parsed.database).toBe('mydb');
    expect(parsed.collection).toBe('orders');
    expect(parsed.operation).toBe('aggregate');
  });

  it('all 19 pipeline snippet templates are valid JSON', () => {
    const templates = [
      '{ "$match": { "field": "value" } }',
      '{ "$group": { "_id": "$field", "count": { "$sum": 1 } } }',
      '{ "$project": { "field": 1, "_id": 0 } }',
      '{ "$sort": { "field": 1 } }',
      '{ "$limit": 100 }',
      '{ "$skip": 0 }',
      '{ "$lookup": { "from": "otherCollection", "localField": "_id", "foreignField": "parentId", "as": "items" } }',
      '{ "$unwind": { "path": "$items", "preserveNullAndEmptyArrays": true } }',
      '{ "$addFields": { "computedField": { "$concat": ["$first", " ", "$last"] } } }',
      '{ "$set": { "updatedAt": "$$NOW" } }',
      '{ "$count": "total" }',
      '{ "$facet": { "byStatus": [{ "$group": { "_id": "$status", "count": { "$sum": 1 } } }], "total": [{ "$count": "count" }] } }',
      '{ "$bucket": { "groupBy": "$amount", "boundaries": [0, 100, 500, 1000], "default": "Other", "output": { "count": { "$sum": 1 } } } }',
      '{ "$replaceRoot": { "newRoot": "$nested" } }',
      '{ "$out": "outputCollection" }',
      '{ "$merge": { "into": "targetCollection", "on": "_id", "whenMatched": "merge", "whenNotMatched": "insert" } }',
      '{ "$sample": { "size": 10 } }',
      '{ "$sortByCount": "$category" }',
      '{ "$graphLookup": { "from": "employees", "startWith": "$managerId", "connectFromField": "managerId", "connectToField": "_id", "as": "reportingHierarchy" } }',
    ];

    expect(templates).toHaveLength(19);
    for (const t of templates) {
      expect(() => JSON.parse(t), `template should be valid JSON: ${t}`).not.toThrow();
      const obj = JSON.parse(t);
      expect(typeof obj).toBe('object');
      // Each template should have exactly one top-level key starting with $
      const keys = Object.keys(obj);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/^\$/);
    }
  });
});
