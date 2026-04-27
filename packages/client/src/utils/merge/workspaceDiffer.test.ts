import { describe, it, expect } from 'vitest';
import type { WorkspaceData, AppCollection, AppEnvironment, MockRoute, CollectionItem } from '../../types';
import { diffWorkspace, deepEqual } from './workspaceDiffer';

// ─── Factories ────────────────────────────────────────────────────────────────

function makeWorkspace(overrides: Partial<WorkspaceData> = {}): WorkspaceData {
  return {
    collections: [],
    environments: [],
    activeEnvironmentId: null,
    collectionVariables: {},
    globalVariables: {},
    cookieJar: {},
    mockCollections: [],
    mockRoutes: [],
    mockPort: 3001,
    ...overrides,
  };
}

function makeCollection(id: string, name: string, items: CollectionItem[] = []): AppCollection {
  return {
    _id: id,
    info: { name, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: items,
  };
}

function makeEnv(id: string, name: string): AppEnvironment {
  return { _id: id, name, values: [] };
}

function makeRoute(id: string, method: string, path: string): MockRoute {
  return {
    id,
    enabled: true,
    method,
    path,
    statusCode: 200,
    responseHeaders: [],
    responseBody: '',
    delay: 0,
    description: '',
  };
}

// ─── deepEqual ────────────────────────────────────────────────────────────────

describe('deepEqual', () => {
  it('returns true for identical primitives', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
  });

  it('returns false for different primitives', () => {
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual('a', 'b')).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });

  it('returns true for deeply equal objects', () => {
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
  });

  it('returns false for objects with different nested values', () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('returns true for equal arrays', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it('returns false for arrays with different elements', () => {
    expect(deepEqual([1, 2], [1, 3])).toBe(false);
  });

  it('returns false for arrays with different lengths', () => {
    expect(deepEqual([1], [1, 2])).toBe(false);
  });
});

// ─── diffWorkspace — collections ─────────────────────────────────────────────

describe('diffWorkspace collections', () => {
  it('detects an added collection', () => {
    const base = makeWorkspace();
    const changed = makeWorkspace({ collections: [makeCollection('c1', 'New')] });
    const diff = diffWorkspace(base, changed);
    expect(diff.collections).toHaveLength(1);
    expect(diff.collections[0].kind).toBe('added');
    expect(diff.collections[0].id).toBe('c1');
  });

  it('detects a removed collection', () => {
    const base = makeWorkspace({ collections: [makeCollection('c1', 'Exist')] });
    const changed = makeWorkspace();
    const diff = diffWorkspace(base, changed);
    expect(diff.collections[0].kind).toBe('removed');
  });

  it('detects a renamed collection', () => {
    const base = makeWorkspace({ collections: [makeCollection('c1', 'Old Name')] });
    const changed = makeWorkspace({ collections: [makeCollection('c1', 'New Name')] });
    const diff = diffWorkspace(base, changed);
    expect(diff.collections[0].kind).toBe('renamed');
  });

  it('emits no changes for identical collections', () => {
    const col = makeCollection('c1', 'Same');
    const ws = makeWorkspace({ collections: [col] });
    const diff = diffWorkspace(ws, ws);
    expect(diff.collections).toHaveLength(0);
  });
});

// ─── diffWorkspace — environments ────────────────────────────────────────────

describe('diffWorkspace environments', () => {
  it('detects an added environment', () => {
    const base = makeWorkspace();
    const changed = makeWorkspace({ environments: [makeEnv('e1', 'Staging')] });
    const diff = diffWorkspace(base, changed);
    expect(diff.environments[0].kind).toBe('added');
  });

  it('detects a removed environment', () => {
    const base = makeWorkspace({ environments: [makeEnv('e1', 'Staging')] });
    const changed = makeWorkspace();
    const diff = diffWorkspace(base, changed);
    expect(diff.environments[0].kind).toBe('removed');
  });

  it('detects a modified environment', () => {
    const base = makeWorkspace({ environments: [{ _id: 'e1', name: 'Env', values: [] }] });
    const changed = makeWorkspace({ environments: [{ _id: 'e1', name: 'Env', values: [{ key: 'HOST', value: 'prod', enabled: true }] }] });
    const diff = diffWorkspace(base, changed);
    expect(diff.environments[0].kind).toBe('modified');
  });

  it('detects a renamed environment', () => {
    const base = makeWorkspace({ environments: [makeEnv('e1', 'Dev')] });
    const changed = makeWorkspace({ environments: [makeEnv('e1', 'Development')] });
    const diff = diffWorkspace(base, changed);
    expect(diff.environments[0].kind).toBe('renamed');
  });
});

// ─── diffWorkspace — globalVariables ─────────────────────────────────────────

describe('diffWorkspace globalVariables', () => {
  it('emits a modified change when global vars differ', () => {
    const base = makeWorkspace({ globalVariables: { KEY: 'old' } });
    const changed = makeWorkspace({ globalVariables: { KEY: 'new' } });
    const diff = diffWorkspace(base, changed);
    expect(diff.globalVariables[0].kind).toBe('modified');
  });

  it('emits no changes when global vars are identical', () => {
    const ws = makeWorkspace({ globalVariables: { KEY: 'val' } });
    const diff = diffWorkspace(ws, ws);
    expect(diff.globalVariables).toHaveLength(0);
  });
});

// ─── diffWorkspace — mockRoutes ───────────────────────────────────────────────

describe('diffWorkspace mockRoutes', () => {
  it('detects an added mock route', () => {
    const base = makeWorkspace();
    const changed = makeWorkspace({ mockRoutes: [makeRoute('r1', 'GET', '/api/users')] });
    const diff = diffWorkspace(base, changed);
    expect(diff.mockRoutes[0].kind).toBe('added');
  });

  it('detects a removed mock route', () => {
    const base = makeWorkspace({ mockRoutes: [makeRoute('r1', 'GET', '/api/users')] });
    const changed = makeWorkspace();
    const diff = diffWorkspace(base, changed);
    expect(diff.mockRoutes[0].kind).toBe('removed');
  });

  it('detects a modified mock route', () => {
    const base = makeWorkspace({ mockRoutes: [makeRoute('r1', 'GET', '/api/users')] });
    const changed = makeWorkspace({ mockRoutes: [{ ...makeRoute('r1', 'GET', '/api/users'), statusCode: 404 }] });
    const diff = diffWorkspace(base, changed);
    expect(diff.mockRoutes[0].kind).toBe('modified');
  });

  it('emits no changes for identical routes', () => {
    const route = makeRoute('r1', 'GET', '/api');
    const ws = makeWorkspace({ mockRoutes: [route] });
    expect(diffWorkspace(ws, ws).mockRoutes).toHaveLength(0);
  });
});

// ─── diffWorkspace — requests ─────────────────────────────────────────────────

describe('diffWorkspace requests', () => {
  it('detects an added request', () => {
    const base = makeWorkspace({ collections: [makeCollection('c1', 'C')] });
    const changed = makeWorkspace({
      collections: [makeCollection('c1', 'C', [
        { id: 'req1', name: 'New Request', request: { method: 'GET', url: 'https://a.com' } },
      ])],
    });
    const diff = diffWorkspace(base, changed);
    expect(diff.requests.some(r => r.kind === 'added' && r.id === 'req1')).toBe(true);
  });

  it('detects a removed request', () => {
    const base = makeWorkspace({
      collections: [makeCollection('c1', 'C', [
        { id: 'req1', name: 'R', request: { method: 'GET', url: 'https://a.com' } },
      ])],
    });
    const changed = makeWorkspace({ collections: [makeCollection('c1', 'C')] });
    const diff = diffWorkspace(base, changed);
    expect(diff.requests.some(r => r.kind === 'removed' && r.id === 'req1')).toBe(true);
  });

  it('detects a modified request', () => {
    const base = makeWorkspace({
      collections: [makeCollection('c1', 'C', [
        { id: 'req1', name: 'R', request: { method: 'GET', url: 'https://a.com' } },
      ])],
    });
    const changed = makeWorkspace({
      collections: [makeCollection('c1', 'C', [
        { id: 'req1', name: 'R', request: { method: 'POST', url: 'https://a.com' } },
      ])],
    });
    const diff = diffWorkspace(base, changed);
    expect(diff.requests.some(r => r.kind === 'modified' && r.id === 'req1')).toBe(true);
  });
});
