import { describe, it, expect } from 'vitest';
import { validatePostmanCollection } from './postmanValidator';

// ─── Invalid input types ──────────────────────────────────────────────────────

describe('validatePostmanCollection — non-object inputs', () => {
  it('returns invalid for null', () => {
    const result = validatePostmanCollection(null);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns invalid for an array', () => {
    const result = validatePostmanCollection([]);
    expect(result.valid).toBe(false);
  });

  it('returns invalid for a string', () => {
    const result = validatePostmanCollection('not-an-object');
    expect(result.valid).toBe(false);
  });

  it('returns invalid for a number', () => {
    const result = validatePostmanCollection(42);
    expect(result.valid).toBe(false);
  });
});

// ─── Version detection ────────────────────────────────────────────────────────

describe('validatePostmanCollection — version detection', () => {
  it('detects v2.0 from schema URL containing v2.0', () => {
    const col = {
      info: { name: 'Test', schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' },
      item: [],
    };
    const result = validatePostmanCollection(col);
    expect(result.version).toBe('2.0');
  });

  it('detects v2.1 from schema URL containing v2.1', () => {
    const col = {
      info: { name: 'Test', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [],
    };
    const result = validatePostmanCollection(col);
    expect(result.version).toBe('2.1');
  });

  it('defaults to v2.1 when schema URL is absent', () => {
    const result = validatePostmanCollection({ info: { name: 'No Schema' }, item: [] });
    expect(result.version).toBe('2.1');
  });
});

// ─── Valid collections ────────────────────────────────────────────────────────

describe('validatePostmanCollection — valid collections', () => {
  it('accepts a minimal v2.1 collection with info and item array', () => {
    const col = {
      info: {
        name: 'My API',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [],
    };
    const result = validatePostmanCollection(col);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a v2.1 collection with a simple GET request item', () => {
    const col = {
      info: {
        name: 'My API',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'Get Users',
          request: {
            method: 'GET',
            url: { raw: 'https://api.example.com/users', host: ['api', 'example', 'com'], path: ['users'] },
          },
        },
      ],
    };
    const result = validatePostmanCollection(col);
    expect(result.valid).toBe(true);
  });
});

// ─── Invalid collections ──────────────────────────────────────────────────────

describe('validatePostmanCollection — invalid collections', () => {
  it('returns errors for empty object', () => {
    const result = validatePostmanCollection({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns errors when info is missing', () => {
    const col = { item: [] };
    const result = validatePostmanCollection(col);
    expect(result.valid).toBe(false);
  });

  it('returns errors when item array is missing', () => {
    const col = {
      info: {
        name: 'Test',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
    };
    const result = validatePostmanCollection(col);
    expect(result.valid).toBe(false);
  });
});

// ─── Error cap ────────────────────────────────────────────────────────────────

describe('validatePostmanCollection — error list', () => {
  it('caps errors at 10 for a heavily invalid document', () => {
    // Passing an object with many wrong types per field stresses the error list
    const result = validatePostmanCollection({
      info: 42,
      item: 'not-array',
      variable: 'bad',
      auth: 'bad',
      event: 'bad',
    });
    expect(result.errors.length).toBeLessThanOrEqual(10);
  });

  it('returns version even when collection is invalid', () => {
    const result = validatePostmanCollection({
      info: {
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
    });
    expect(result.version).toBe('2.1');
  });
});
