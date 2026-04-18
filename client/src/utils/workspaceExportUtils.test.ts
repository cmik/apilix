import { describe, it, expect } from 'vitest';
import type { WorkspaceData } from '../types';
import {
  buildWorkspaceExportPackage,
  isWorkspaceExportPackage,
  parseWorkspaceExportPackage,
} from './workspaceExportUtils';

// ─── Factories ────────────────────────────────────────────────────────────────

function makeData(overrides: Partial<WorkspaceData> = {}): WorkspaceData {
  return {
    collections: [],
    environments: [],
    activeEnvironmentId: null,
    collectionVariables: {},
    globalVariables: {},
    cookieJar: {},
    mockCollections: [],
    mockRoutes: [],
    mockPort: 3002,
    ...overrides,
  };
}

// ─── buildWorkspaceExportPackage ─────────────────────────────────────────────

describe('buildWorkspaceExportPackage', () => {
  it('sets apilixWorkspaceExport to "1"', () => {
    const pkg = buildWorkspaceExportPackage('My WS', 'ws-1', makeData());
    expect(pkg.apilixWorkspaceExport).toBe('1');
  });

  it('preserves workspaceName and workspaceId', () => {
    const pkg = buildWorkspaceExportPackage('My WS', 'ws-abc', makeData());
    expect(pkg.workspaceName).toBe('My WS');
    expect(pkg.workspaceId).toBe('ws-abc');
  });

  it('includes a valid ISO-8601 exportedAt timestamp', () => {
    const before = Date.now();
    const pkg = buildWorkspaceExportPackage('Test', 'id1', makeData());
    const after = Date.now();
    const ts = new Date(pkg.exportedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('data is the same reference passed in', () => {
    const data = makeData({ globalVariables: { host: 'http://api' } });
    const pkg = buildWorkspaceExportPackage('Test', 'id1', data);
    expect(pkg.data).toBe(data);
  });
});

// ─── isWorkspaceExportPackage ─────────────────────────────────────────────────

describe('isWorkspaceExportPackage', () => {
  it('returns true for a minimal valid package', () => {
    const pkg = buildWorkspaceExportPackage('My WS', 'ws-1', makeData());
    expect(isWorkspaceExportPackage(pkg)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isWorkspaceExportPackage(null)).toBe(false);
  });

  it('returns false for a plain Postman collection', () => {
    const postman = {
      info: { name: 'Col', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [],
    };
    expect(isWorkspaceExportPackage(postman)).toBe(false);
  });

  it('returns false for a sync export package (different sentinel)', () => {
    const syncPkg = {
      apilixSyncExport: '1',
      workspaceId: 'ws-1',
      workspaceName: 'Test',
      provider: 's3',
      config: {},
      encrypted: false,
      encryptedFields: [],
    };
    expect(isWorkspaceExportPackage(syncPkg)).toBe(false);
  });

  it('returns false when apilixWorkspaceExport has wrong version', () => {
    expect(isWorkspaceExportPackage({ apilixWorkspaceExport: '2', workspaceName: 'X', workspaceId: 'y', data: {} })).toBe(false);
  });

  it('returns false when workspaceName is missing', () => {
    expect(isWorkspaceExportPackage({ apilixWorkspaceExport: '1', workspaceId: 'y', data: {} })).toBe(false);
  });

  it('returns false when data is not an object', () => {
    expect(isWorkspaceExportPackage({ apilixWorkspaceExport: '1', workspaceName: 'X', workspaceId: 'y', data: 'bad' })).toBe(false);
  });
});

// ─── parseWorkspaceExportPackage — happy path ────────────────────────────────

describe('parseWorkspaceExportPackage — happy path', () => {
  it('returns the package unchanged when all fields are present', () => {
    const data = makeData({ globalVariables: { base: 'https://api.example.com' } });
    const pkg = buildWorkspaceExportPackage('My WS', 'ws-1', data);
    const parsed = parseWorkspaceExportPackage(pkg);
    expect(parsed.workspaceName).toBe('My WS');
    expect(parsed.data.globalVariables).toEqual({ base: 'https://api.example.com' });
  });

  it('backfills missing mockCollections with an empty array', () => {
    const raw = {
      apilixWorkspaceExport: '1',
      exportedAt: new Date().toISOString(),
      workspaceName: 'WS',
      workspaceId: 'id',
      data: {
        collections: [],
        environments: [],
        activeEnvironmentId: null,
        collectionVariables: {},
        globalVariables: {},
        cookieJar: {},
        mockRoutes: [],
        mockPort: 3002,
        // mockCollections intentionally omitted
      },
    };
    const parsed = parseWorkspaceExportPackage(raw);
    expect(parsed.data.mockCollections).toEqual([]);
  });

  it('backfills missing mockRoutes with an empty array', () => {
    const raw = {
      apilixWorkspaceExport: '1',
      exportedAt: new Date().toISOString(),
      workspaceName: 'WS',
      workspaceId: 'id',
      data: {
        collections: [],
        environments: [],
        activeEnvironmentId: null,
        collectionVariables: {},
        globalVariables: {},
        cookieJar: {},
        mockCollections: [],
        mockPort: 3002,
        // mockRoutes intentionally omitted
      },
    };
    const parsed = parseWorkspaceExportPackage(raw);
    expect(parsed.data.mockRoutes).toEqual([]);
  });

  it('backfills missing mockPort with 3002', () => {
    const raw = {
      apilixWorkspaceExport: '1',
      exportedAt: new Date().toISOString(),
      workspaceName: 'WS',
      workspaceId: 'id',
      data: {
        collections: [],
        environments: [],
        activeEnvironmentId: null,
        collectionVariables: {},
        globalVariables: {},
        cookieJar: {},
        mockCollections: [],
        mockRoutes: [],
        // mockPort intentionally omitted
      },
    };
    const parsed = parseWorkspaceExportPackage(raw);
    expect(parsed.data.mockPort).toBe(3002);
  });
});

// ─── parseWorkspaceExportPackage — error cases ───────────────────────────────

describe('parseWorkspaceExportPackage — error cases', () => {
  it('throws for null input', () => {
    expect(() => parseWorkspaceExportPackage(null)).toThrow('Not a valid Apilix workspace export file');
  });

  it('throws for a plain object without apilixWorkspaceExport', () => {
    expect(() => parseWorkspaceExportPackage({ foo: 'bar' })).toThrow('Not a valid Apilix workspace export file');
  });

  it('throws with a hint when a sync export package is passed', () => {
    const syncPkg = {
      apilixSyncExport: '1',
      workspaceId: 'ws-1',
      workspaceName: 'Test',
      provider: 's3',
      config: {},
      encrypted: false,
      encryptedFields: [],
    };
    expect(() => parseWorkspaceExportPackage(syncPkg)).toThrow('sync configuration export');
  });

  it('throws for wrong version string', () => {
    expect(() =>
      parseWorkspaceExportPackage({
        apilixWorkspaceExport: '99',
        workspaceName: 'X',
        workspaceId: 'y',
        data: {},
      })
    ).toThrow('Not a valid Apilix workspace export file');
  });
});

// ─── Version sentinel consistency ────────────────────────────────────────────
//
// Pins the contract that isWorkspaceExportPackage accepts exactly the version
// produced by buildWorkspaceExportPackage.  If CURRENT_VERSION is ever bumped
// the guard must be updated in lockstep.

describe('version sentinel consistency', () => {
  it('isWorkspaceExportPackage accepts the version buildWorkspaceExportPackage produces', () => {
    const pkg = buildWorkspaceExportPackage('WS', 'id', makeData());
    expect(isWorkspaceExportPackage(pkg)).toBe(true);
  });

  it('parseWorkspaceExportPackage accepts the package buildWorkspaceExportPackage produces', () => {
    const pkg = buildWorkspaceExportPackage('WS', 'id', makeData());
    expect(() => parseWorkspaceExportPackage(pkg)).not.toThrow();
  });

  it('isWorkspaceExportPackage rejects version "0" (never issued)', () => {
    expect(isWorkspaceExportPackage({ apilixWorkspaceExport: '0', workspaceName: 'X', workspaceId: 'y', data: {} })).toBe(false);
  });

  it('isWorkspaceExportPackage rejects a numeric version field', () => {
    expect(isWorkspaceExportPackage({ apilixWorkspaceExport: 1, workspaceName: 'X', workspaceId: 'y', data: {} })).toBe(false);
  });

  it('isWorkspaceExportPackage rejects an empty string version', () => {
    expect(isWorkspaceExportPackage({ apilixWorkspaceExport: '', workspaceName: 'X', workspaceId: 'y', data: {} })).toBe(false);
  });
});

// ─── Build → detect → parse round-trip ───────────────────────────────────────

describe('build → detect → parse round-trip', () => {
  it('a package survives a JSON serialisation round-trip', () => {
    const data = makeData({
      globalVariables: { HOST: 'https://api.example.com' },
      environments: [{ _id: 'env-1', name: 'Staging', values: [{ key: 'TOKEN', value: 'secret', enabled: true }] }],
      mockPort: 8080,
    });
    const pkg = buildWorkspaceExportPackage('Staging WS', 'ws-staging', data);
    const json = JSON.stringify(pkg);
    const restored = JSON.parse(json) as unknown;

    expect(isWorkspaceExportPackage(restored)).toBe(true);
    const parsed = parseWorkspaceExportPackage(restored);
    expect(parsed.workspaceName).toBe('Staging WS');
    expect(parsed.workspaceId).toBe('ws-staging');
    expect(parsed.data.globalVariables).toEqual({ HOST: 'https://api.example.com' });
    expect(parsed.data.environments).toHaveLength(1);
    expect(parsed.data.mockPort).toBe(8080);
  });

  it('re-importing a package produces an equivalent WorkspaceData shape', () => {
    const original = makeData({
      collectionVariables: { 'col-1': { version: 'v2' } },
      cookieJar: { 'example.com': [{ name: 'sid', value: '123', domain: 'example.com', path: '/', expires: null, httpOnly: false, secure: false, sameSite: 'Lax', enabled: true }] },
    });
    const pkg = buildWorkspaceExportPackage('My WS', 'ws-id', original);
    const parsed = parseWorkspaceExportPackage(JSON.parse(JSON.stringify(pkg)));

    expect(parsed.data.collectionVariables).toEqual(original.collectionVariables);
    expect(parsed.data.cookieJar).toEqual(original.cookieJar);
    expect(parsed.data.mockCollections).toEqual([]);
    expect(parsed.data.mockRoutes).toEqual([]);
  });
});

// ─── buildWorkspaceExportPackage mutation safety ──────────────────────────────
//
// buildWorkspaceExportPackage passes `data` by reference; the caller must not
// mutate data after building the package if they still hold a reference.
// downloadJsonFile serialises immediately so in practice this is safe, but
// this test documents the current (reference-sharing) behaviour so any future
// deep-clone change is visible in the test diff.

describe('buildWorkspaceExportPackage — data reference behaviour', () => {
  it('pkg.data is the same reference as the data argument (no deep clone)', () => {
    const data = makeData();
    const pkg = buildWorkspaceExportPackage('WS', 'id', data);
    expect(pkg.data).toBe(data);
  });

  it('mutating data after build affects pkg.data (documents reference sharing)', () => {
    const data = makeData({ globalVariables: {} });
    const pkg = buildWorkspaceExportPackage('WS', 'id', data);
    // Mutate the original reference
    (data.globalVariables as Record<string, string>)['NEW_KEY'] = 'NEW_VALUE';
    // pkg.data reflects the mutation because it shares the reference
    expect(pkg.data.globalVariables).toHaveProperty('NEW_KEY', 'NEW_VALUE');
  });
});

// ─── parseWorkspaceExportPackage — malformed data fields ─────────────────────

describe('parseWorkspaceExportPackage — malformed data fields', () => {
  function makeRaw(dataOverrides: Record<string, unknown>) {
    return {
      apilixWorkspaceExport: '1',
      exportedAt: new Date().toISOString(),
      workspaceName: 'WS',
      workspaceId: 'id',
      data: {
        collections: [],
        environments: [],
        activeEnvironmentId: null,
        collectionVariables: {},
        globalVariables: {},
        cookieJar: {},
        mockCollections: [],
        mockRoutes: [],
        mockPort: 3002,
        ...dataOverrides,
      },
    };
  }

  it('backfills collections when value is not an array', () => {
    const parsed = parseWorkspaceExportPackage(makeRaw({ collections: 'bad' }));
    expect(parsed.data.collections).toEqual([]);
  });

  it('backfills environments when value is not an array', () => {
    const parsed = parseWorkspaceExportPackage(makeRaw({ environments: null }));
    expect(parsed.data.environments).toEqual([]);
  });

  it('backfills activeEnvironmentId when value is a number', () => {
    const parsed = parseWorkspaceExportPackage(makeRaw({ activeEnvironmentId: 42 }));
    expect(parsed.data.activeEnvironmentId).toBeNull();
  });

  it('preserves activeEnvironmentId when it is a valid string', () => {
    const parsed = parseWorkspaceExportPackage(makeRaw({ activeEnvironmentId: 'env-xyz' }));
    expect(parsed.data.activeEnvironmentId).toBe('env-xyz');
  });

  it('treats activeEnvironmentId of null as null (not a string)', () => {
    const parsed = parseWorkspaceExportPackage(makeRaw({ activeEnvironmentId: null }));
    expect(parsed.data.activeEnvironmentId).toBeNull();
  });

  it('backfills collectionVariables when value is an array', () => {
    const parsed = parseWorkspaceExportPackage(makeRaw({ collectionVariables: ['oops'] }));
    expect(parsed.data.collectionVariables).toEqual({});
  });

  it('backfills globalVariables when value is a string', () => {
    const parsed = parseWorkspaceExportPackage(makeRaw({ globalVariables: 'bad' }));
    expect(parsed.data.globalVariables).toEqual({});
  });

  it('backfills cookieJar when value is an array', () => {
    const parsed = parseWorkspaceExportPackage(makeRaw({ cookieJar: [] }));
    expect(parsed.data.cookieJar).toEqual({});
  });

  it('backfills mockPort when value is a string', () => {
    const parsed = parseWorkspaceExportPackage(makeRaw({ mockPort: '3000' }));
    expect(parsed.data.mockPort).toBe(3002);
  });

  it('preserves a custom numeric mockPort', () => {
    const parsed = parseWorkspaceExportPackage(makeRaw({ mockPort: 9999 }));
    expect(parsed.data.mockPort).toBe(9999);
  });
});
