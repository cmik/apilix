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

// ─── Environment variable metadata preservation ───────────────────────────────
//
// The merge engine must carry per-row metadata (secret, enabled, type) through
// all merge branches.  Previously only `value` was extracted and the row was
// reconstructed bare ({ key, value, enabled: true }), silently dropping
// `secret` and resetting `enabled`.

describe('mergeWorkspaces — environment value metadata (secret, enabled)', () => {
  it('preserves secret:true when neither side changed the value', () => {
    const env = { _id: 'e1', name: 'Prod', values: [{ key: 'TOKEN', value: 'abc', enabled: true, secret: true }] };
    const ws = makeWorkspace({ environments: [env] });
    const result = mergeWorkspaces(ws, ws, ws);
    const row = result.merged.environments[0].values.find(v => v.key === 'TOKEN');
    expect(row?.secret).toBe(true);
  });

  it('preserves secret:true when only local changed the value', () => {
    const base = makeWorkspace({ environments: [{ _id: 'e1', name: 'Prod', values: [{ key: 'TOKEN', value: 'old', enabled: true, secret: true }] }] });
    const local = makeWorkspace({ environments: [{ _id: 'e1', name: 'Prod', values: [{ key: 'TOKEN', value: 'new-local', enabled: true, secret: true }] }] });
    const remote = makeWorkspace({ environments: [{ _id: 'e1', name: 'Prod', values: [{ key: 'TOKEN', value: 'old', enabled: true, secret: true }] }] });

    const result = mergeWorkspaces(base, local, remote);
    const row = result.merged.environments[0].values.find(v => v.key === 'TOKEN');
    expect(row?.secret).toBe(true);
    expect(row?.value).toBe('new-local');
  });

  it('preserves secret:true when only remote changed the value', () => {
    const base = makeWorkspace({ environments: [{ _id: 'e1', name: 'Prod', values: [{ key: 'TOKEN', value: 'old', enabled: true, secret: true }] }] });
    const local = makeWorkspace({ environments: [{ _id: 'e1', name: 'Prod', values: [{ key: 'TOKEN', value: 'old', enabled: true, secret: true }] }] });
    const remote = makeWorkspace({ environments: [{ _id: 'e1', name: 'Prod', values: [{ key: 'TOKEN', value: 'new-remote', enabled: true, secret: true }] }] });

    const result = mergeWorkspaces(base, local, remote);
    const row = result.merged.environments[0].values.find(v => v.key === 'TOKEN');
    expect(row?.secret).toBe(true);
    expect(row?.value).toBe('new-remote');
  });

  it('uses local row metadata (secret, enabled) on conflict', () => {
    const base = makeWorkspace({ environments: [{ _id: 'e1', name: 'Prod', values: [{ key: 'TOKEN', value: 'old', enabled: true, secret: false }] }] });
    const local = makeWorkspace({ environments: [{ _id: 'e1', name: 'Prod', values: [{ key: 'TOKEN', value: 'local-val', enabled: true, secret: true }] }] });
    const remote = makeWorkspace({ environments: [{ _id: 'e1', name: 'Prod', values: [{ key: 'TOKEN', value: 'remote-val', enabled: true, secret: false }] }] });

    const result = mergeWorkspaces(base, local, remote);
    const row = result.merged.environments[0].values.find(v => v.key === 'TOKEN');
    // Local wins on conflict: local set secret:true
    expect(row?.secret).toBe(true);
    expect(row?.value).toBe('local-val');
    expect(result.conflicts.some(c => c.id === 'e1#TOKEN')).toBe(true);
  });

  it('preserves enabled:false when neither side changed the value', () => {
    const env = { _id: 'e1', name: 'Prod', values: [{ key: 'DISABLED', value: 'x', enabled: false }] };
    const ws = makeWorkspace({ environments: [env] });
    const result = mergeWorkspaces(ws, ws, ws);
    const row = result.merged.environments[0].values.find(v => v.key === 'DISABLED');
    expect(row?.enabled).toBe(false);
  });

  it('preserves enabled:false when only local changed the value', () => {
    const base = makeWorkspace({ environments: [{ _id: 'e1', name: 'Prod', values: [{ key: 'K', value: 'old', enabled: false }] }] });
    const local = makeWorkspace({ environments: [{ _id: 'e1', name: 'Prod', values: [{ key: 'K', value: 'new', enabled: false }] }] });
    const remote = makeWorkspace({ environments: [{ _id: 'e1', name: 'Prod', values: [{ key: 'K', value: 'old', enabled: false }] }] });

    const result = mergeWorkspaces(base, local, remote);
    const row = result.merged.environments[0].values.find(v => v.key === 'K');
    expect(row?.enabled).toBe(false);
    expect(row?.value).toBe('new');
  });

  it('does not strip secret:false (explicit false is preserved)', () => {
    const env = { _id: 'e1', name: 'Prod', values: [{ key: 'HOST', value: 'https://example.com', enabled: true, secret: false }] };
    const ws = makeWorkspace({ environments: [env] });
    const result = mergeWorkspaces(ws, ws, ws);
    const row = result.merged.environments[0].values.find(v => v.key === 'HOST');
    // false is preserved (not dropped to undefined)
    expect(row?.secret).toBe(false);
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

// ─── Environment variable metadata preservation ───────────────────────────────
//
// After the secret-flag fix, mergeWorkspaces must carry all per-row metadata
// (secret, enabled, type) through every merge path so that `secret: true`
// rows are not silently downgraded to plain-text on the next disk write.

describe('mergeWorkspaces — env value metadata (secret, enabled) preservation', () => {
  function makeEnvWithVars(id: string, name: string, values: AppEnvironment['values']): AppEnvironment {
    return { _id: id, name, values };
  }

  // Helper: find the merged env value by key
  function findVal(result: ReturnType<typeof mergeWorkspaces>, envId: string, key: string) {
    const env = result.merged.environments.find(e => e._id === envId);
    return env?.values.find(v => v.key === key);
  }

  it('preserves secret:true on an unchanged row (no-change path)', () => {
    const env: AppEnvironment = makeEnvWithVars('e1', 'Prod', [
      { key: 'TOKEN', value: 'abc', enabled: true, secret: true },
    ]);
    const ws = makeWorkspace({ environments: [env] });
    const result = mergeWorkspaces(ws, ws, ws);
    expect(findVal(result, 'e1', 'TOKEN')?.secret).toBe(true);
  });

  it('preserves secret:true when only local changed the value', () => {
    const base = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'TOKEN', value: 'old', enabled: true, secret: true }])],
    });
    const local = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'TOKEN', value: 'new', enabled: true, secret: true }])],
    });
    const remote = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'TOKEN', value: 'old', enabled: true, secret: true }])],
    });
    const result = mergeWorkspaces(base, local, remote);
    const val = findVal(result, 'e1', 'TOKEN');
    expect(val?.value).toBe('new');
    expect(val?.secret).toBe(true);
  });

  it('preserves secret:true when only remote changed the value', () => {
    const base = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'TOKEN', value: 'old', enabled: true, secret: true }])],
    });
    const local = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'TOKEN', value: 'old', enabled: true, secret: true }])],
    });
    const remote = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'TOKEN', value: 'remote-new', enabled: true, secret: true }])],
    });
    const result = mergeWorkspaces(base, local, remote);
    const val = findVal(result, 'e1', 'TOKEN');
    expect(val?.value).toBe('remote-new');
    expect(val?.secret).toBe(true);
  });

  it('preserves secret:true when both sides converged on the same new value', () => {
    const base = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'TOKEN', value: 'old', enabled: true, secret: true }])],
    });
    const local = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'TOKEN', value: 'same-new', enabled: true, secret: true }])],
    });
    const remote = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'TOKEN', value: 'same-new', enabled: true, secret: true }])],
    });
    const result = mergeWorkspaces(base, local, remote);
    const val = findVal(result, 'e1', 'TOKEN');
    expect(val?.value).toBe('same-new');
    expect(val?.secret).toBe(true);
    expect(result.conflicts.filter(c => c.domain === 'environment')).toHaveLength(0);
  });

  it('preserves secret:true (local metadata) in a field-overlap conflict', () => {
    const base = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'TOKEN', value: 'old', enabled: true, secret: true }])],
    });
    const local = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'TOKEN', value: 'local-val', enabled: true, secret: true }])],
    });
    const remote = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'TOKEN', value: 'remote-val', enabled: true, secret: false }])],
    });
    const result = mergeWorkspaces(base, local, remote);
    const val = findVal(result, 'e1', 'TOKEN');
    // Local wins by default in conflicts
    expect(val?.value).toBe('local-val');
    expect(val?.secret).toBe(true);
    expect(result.conflicts.some(c => c.id === 'e1#TOKEN')).toBe(true);
  });

  it('preserves enabled:false on an unchanged row', () => {
    const env: AppEnvironment = makeEnvWithVars('e1', 'Prod', [
      { key: 'DISABLED', value: 'x', enabled: false, secret: false },
    ]);
    const ws = makeWorkspace({ environments: [env] });
    const result = mergeWorkspaces(ws, ws, ws);
    expect(findVal(result, 'e1', 'DISABLED')?.enabled).toBe(false);
  });

  it('preserves enabled:false when only local changed the value', () => {
    const base = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'HOST', value: 'old', enabled: false }])],
    });
    const local = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'HOST', value: 'new', enabled: false }])],
    });
    const remote = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'HOST', value: 'old', enabled: false }])],
    });
    const result = mergeWorkspaces(base, local, remote);
    const val = findVal(result, 'e1', 'HOST');
    expect(val?.value).toBe('new');
    expect(val?.enabled).toBe(false);
  });

  it('does not affect plain (non-secret) rows', () => {
    const base = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'HOST', value: 'old', enabled: true }])],
    });
    const local = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'HOST', value: 'new', enabled: true }])],
    });
    const remote = makeWorkspace({
      environments: [makeEnvWithVars('e1', 'Prod', [{ key: 'HOST', value: 'old', enabled: true }])],
    });
    const result = mergeWorkspaces(base, local, remote);
    const val = findVal(result, 'e1', 'HOST');
    expect(val?.value).toBe('new');
    expect(val?.secret).toBeFalsy();
  });
});
