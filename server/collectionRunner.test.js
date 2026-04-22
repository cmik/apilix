'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { InputError, prepareCollectionRun } = require('./collectionRunner');

// ─── Minimal valid collection fixture ─────────────────────────────────────────

function makeValidPayload(overrides = {}) {
  return {
    collection: {
      info: { name: 'Test Collection' },
      item: [
        {
          id: 'req-1',
          name: 'Ping',
          request: { method: 'GET', url: 'http://localhost/ping' },
        },
      ],
    },
    environment: {},
    collectionVariables: {},
    globals: {},
    cookies: {},
    delay: 0,
    iterations: 1,
    ...overrides,
  };
}

// ─── InputError ───────────────────────────────────────────────────────────────

describe('InputError', () => {
  it('is an instance of Error', () => {
    const err = new InputError('boom');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof InputError);
  });

  it('has name "InputError"', () => {
    const err = new InputError('boom');
    assert.equal(err.name, 'InputError');
  });

  it('carries the message', () => {
    const err = new InputError('missing collection');
    assert.equal(err.message, 'missing collection');
  });
});

// ─── prepareCollectionRun — validation ───────────────────────────────────────

describe('prepareCollectionRun — input validation', () => {
  it('throws InputError when payload is null', () => {
    assert.throws(
      () => prepareCollectionRun(null),
      (err) => err instanceof InputError && /missing collection/i.test(err.message),
    );
  });

  it('throws InputError when payload has no collection key', () => {
    assert.throws(
      () => prepareCollectionRun({}),
      (err) => err instanceof InputError,
    );
  });

  it('throws InputError when collection has no item array', () => {
    assert.throws(
      () => prepareCollectionRun({ collection: { info: { name: 'X' } } }),
      (err) => err instanceof InputError,
    );
  });

  it('does NOT throw for a valid collection', () => {
    const result = prepareCollectionRun(makeValidPayload());
    assert.ok(result.runId);
    assert.ok(Array.isArray(result.requests));
    assert.ok(Array.isArray(result.dataRows));
  });
});

// ─── prepareCollectionRun — CSV handling ─────────────────────────────────────

describe('prepareCollectionRun — CSV handling', () => {
  it('produces a single empty-object row when no csvText is provided', () => {
    const result = prepareCollectionRun(makeValidPayload());
    assert.deepEqual(result.dataRows, [{}]);
  });

  it('produces empty dataRows when csvText is an empty string (header-only treated as no data)', () => {
    // Empty CSV string is now parsed (not silently ignored).
    // csv-parse with an empty string returns an empty array (no rows).
    const result = prepareCollectionRun(makeValidPayload(), { csvText: '' });
    assert.ok(Array.isArray(result.dataRows));
    assert.equal(result.dataRows.length, 0);
  });

  it('parses rows when csvText is a valid CSV string', () => {
    const csv = 'name,age\nAlice,30\nBob,25\n';
    const result = prepareCollectionRun(makeValidPayload(), { csvText: csv });
    assert.equal(result.dataRows.length, 2);
    assert.equal(result.dataRows[0].name, 'Alice');
    assert.equal(result.dataRows[1].name, 'Bob');
  });

  it('uses iteration count from payload when csvText is null', () => {
    const result = prepareCollectionRun(makeValidPayload({ iterations: 3 }), { csvText: null });
    assert.equal(result.dataRows.length, 3);
  });

  it('throws InputError for a malformed CSV', () => {
    // Use a CSV with mismatched quoting to trigger a parse error.
    const badCsv = 'name\n"unclosed';
    assert.throws(
      () => prepareCollectionRun(makeValidPayload(), { csvText: badCsv }),
      (err) => err instanceof InputError && /invalid csv/i.test(err.message),
    );
  });

  it('does NOT throw InputError for malformed CSV — thrown error is InputError, not generic Error', () => {
    // Verify the error class specifically so the route can safely use instanceof InputError → 400.
    const badCsv = 'name\n"unclosed';
    let thrown = null;
    try {
      prepareCollectionRun(makeValidPayload(), { csvText: badCsv });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown !== null, 'should have thrown');
    assert.ok(thrown instanceof InputError, 'should be InputError, not a generic Error');
  });
});

// ─── prepareCollectionRun — runId ─────────────────────────────────────────────

describe('prepareCollectionRun — runId', () => {
  it('generates a unique runId when none is provided', () => {
    const r1 = prepareCollectionRun(makeValidPayload());
    const r2 = prepareCollectionRun(makeValidPayload());
    assert.ok(r1.runId);
    assert.notEqual(r1.runId, r2.runId);
  });

  it('uses a provided runId', () => {
    const result = prepareCollectionRun(makeValidPayload(), { runId: 'my-fixed-id' });
    assert.equal(result.runId, 'my-fixed-id');
  });
});
