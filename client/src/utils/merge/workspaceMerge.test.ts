import { describe, it, expect } from 'vitest';
import type { WorkspaceData, AppCollection, AppEnvironment, CollectionItem } from '../../types';
import { mergeWorkspaces } from './workspaceMerge';

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

// ─── Identity merge (all equal) ───────────────────────────────────────────────

describe('mergeWorkspaces — all three snapshots equal', () => {
  it('produces no conflicts when base, local, and remote are identical', () => {
    const ws = makeWorkspace({ globalVariables: { HOST: 'http://localhost' } });
    const result = mergeWorkspaces(ws, ws, ws);
    expect(result.conflicts).toHaveLength(0);
  });

  it('preserves collections unchanged', () => {
    const col = makeCollection('c1', 'API');
    const ws = makeWorkspace({ collections: [col] });
    const result = mergeWorkspaces(ws, ws, ws);
    expect(result.merged.collections).toHaveLength(1);
    expect(result.merged.collections[0]._id).toBe('c1');
  });
});

// ─── Clean (non-conflicting) merges ──────────────────────────────────────────

describe('mergeWorkspaces — non-conflicting adds', () => {
  it('includes a collection added only by local', () => {
    const base = makeWorkspace();
    const local = makeWorkspace({ collections: [makeCollection('c1', 'Local Coll')] });
    const remote = makeWorkspace();
    const result = mergeWorkspaces(base, local, remote);
    expect(result.merged.collections.some(c => c._id === 'c1')).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it('includes an environment added only by remote', () => {
    const base = makeWorkspace();
    const local = makeWorkspace();
    const remote = makeWorkspace({ environments: [makeEnv('e1', 'Remote Env')] });
    const result = mergeWorkspaces(base, local, remote);
    expect(result.merged.environments.some(e => e._id === 'e1')).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it('merges collections from both sides when different ids', () => {
    const base = makeWorkspace();
    const local = makeWorkspace({ collections: [makeCollection('c1', 'From Local')] });
    const remote = makeWorkspace({ collections: [makeCollection('c2', 'From Remote')] });
    const result = mergeWorkspaces(base, local, remote);
    expect(result.merged.collections).toHaveLength(2);
    expect(result.conflicts).toHaveLength(0);
  });

  it('increments autoMergedCount for auto-resolved changes', () => {
    const base = makeWorkspace();
    const local = makeWorkspace({ collections: [makeCollection('c1', 'L')] });
    const remote = makeWorkspace({ environments: [makeEnv('e1', 'R')] });
    const result = mergeWorkspaces(base, local, remote);
    expect(result.autoMergedCount).toBeGreaterThan(0);
  });
});

// ─── Global variables merge ───────────────────────────────────────────────────

describe('mergeWorkspaces — globalVariables', () => {
  it('merges non-overlapping global variable changes', () => {
    const base = makeWorkspace({ globalVariables: {} });
    const local = makeWorkspace({ globalVariables: { LOCAL_KEY: 'lv' } });
    const remote = makeWorkspace({ globalVariables: { REMOTE_KEY: 'rv' } });
    const result = mergeWorkspaces(base, local, remote);
    expect(result.merged.globalVariables['LOCAL_KEY']).toBe('lv');
    expect(result.merged.globalVariables['REMOTE_KEY']).toBe('rv');
    expect(result.conflicts).toHaveLength(0);
  });

  it('reports a conflict when both sides change the same key to different values', () => {
    const base = makeWorkspace({ globalVariables: { HOST: 'base' } });
    const local = makeWorkspace({ globalVariables: { HOST: 'local' } });
    const remote = makeWorkspace({ globalVariables: { HOST: 'remote' } });
    const result = mergeWorkspaces(base, local, remote);
    expect(result.conflicts.some(c => c.domain === 'globalVariables')).toBe(true);
  });

  it('no conflict when both sides set the same key to the same new value', () => {
    const base = makeWorkspace({ globalVariables: { KEY: 'old' } });
    const local = makeWorkspace({ globalVariables: { KEY: 'new' } });
    const remote = makeWorkspace({ globalVariables: { KEY: 'new' } });
    const result = mergeWorkspaces(base, local, remote);
    expect(result.merged.globalVariables['KEY']).toBe('new');
    expect(result.conflicts.filter(c => c.domain === 'globalVariables')).toHaveLength(0);
  });
});

// ─── Conflict scenarios ───────────────────────────────────────────────────────

describe('mergeWorkspaces — conflicts', () => {
  it('reports a rename-vs-rename conflict when both sides rename differently', () => {
    const col = makeCollection('c1', 'Original');
    const base = makeWorkspace({ collections: [col] });
    const local = makeWorkspace({ collections: [makeCollection('c1', 'Name By Local')] });
    const remote = makeWorkspace({ collections: [makeCollection('c1', 'Name By Remote')] });
    const result = mergeWorkspaces(base, local, remote);
    expect(result.conflicts.some(c => c.id === 'c1')).toBe(true);
  });

  it('reports a delete-vs-edit conflict when a request is modified locally but deleted remotely', () => {
    const req = { id: 'req1', name: 'List Users', request: { method: 'GET', url: 'https://api.example.com/users' } };
    const reqModified = { id: 'req1', name: 'List Users', request: { method: 'POST', url: 'https://api.example.com/users' } };
    const base = makeWorkspace({ collections: [makeCollection('c1', 'API', [req])] });
    const local = makeWorkspace({ collections: [makeCollection('c1', 'API', [reqModified])] });
    const remote = makeWorkspace({ collections: [makeCollection('c1', 'API', [])] });
    const result = mergeWorkspaces(base, local, remote);
    expect(result.conflicts.some(c => c.id === 'req1' && c.kind === 'delete-vs-edit')).toBe(true);
  });
});

// ─── mockPort ─────────────────────────────────────────────────────────────────

describe('mergeWorkspaces — mockPort', () => {
  it('uses local mockPort when local changed it', () => {
    const base = makeWorkspace({ mockPort: 3001 });
    const local = makeWorkspace({ mockPort: 3100 });
    const remote = makeWorkspace({ mockPort: 3001 });
    const result = mergeWorkspaces(base, local, remote);
    expect(result.merged.mockPort).toBe(3100);
  });

  it('falls back to remote mockPort when only remote changed it', () => {
    const base = makeWorkspace({ mockPort: 3001 });
    const local = makeWorkspace({ mockPort: 3001 });
    const remote = makeWorkspace({ mockPort: 3200 });
    const result = mergeWorkspaces(base, local, remote);
    expect(result.merged.mockPort).toBe(3200);
  });
});
