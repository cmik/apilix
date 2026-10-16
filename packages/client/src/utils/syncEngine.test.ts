import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceData, SyncConfig } from '../types';

vi.mock('./sync/s3Adapter', () => ({
  s3Adapter: {
    push: vi.fn(),
    pull: vi.fn(),
    getRemoteTimestamp: vi.fn(),
    getRemoteState: vi.fn(),
    pullWithMeta: vi.fn(),
    applyMerged: vi.fn(),
  },
}));
vi.mock('./sync/gitAdapter', () => ({ gitAdapter: {} }));
vi.mock('./sync/httpAdapter', () => ({ httpAdapter: {} }));
vi.mock('./sync/teamAdapter', () => ({ teamAdapter: {} }));
vi.mock('./snapshotEngine', () => ({ loadSnapshot: vi.fn(), listHistory: vi.fn() }));

import { s3Adapter } from './sync/s3Adapter';
import { applyMerged, applyScopedLocalOverrides, push } from './syncEngine';

function makeData(overrides: Partial<WorkspaceData> = {}): WorkspaceData {
  return {
    collections: [],
    environments: [{ _id: 'env-1', name: 'Environment', values: [] }],
    activeEnvironmentId: 'env-1',
    collectionVariables: {},
    globalVariables: { TOKEN: 'local-token' },
    globalVariableMeta: { TOKEN: { secret: true } },
    cookieJar: {},
    mockCollections: [],
    mockRoutes: [],
    mockPort: 3001,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    workspaceId: 'workspace-1',
    provider: 's3',
    config: {},
    syncEnvironments: false,
    syncGlobalVariables: false,
    ...overrides,
  };
}

describe('sync option scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves disabled local fields when applying pulled data', () => {
    const local = makeData();
    const remote = makeData({
      environments: [{ _id: 'env-2', name: 'Remote', values: [] }],
      activeEnvironmentId: 'env-2',
      globalVariables: { TOKEN: 'remote-token' },
      globalVariableMeta: {},
    });

    const applied = applyScopedLocalOverrides(remote, local, makeConfig());

    expect(applied.environments).toEqual(local.environments);
    expect(applied.activeEnvironmentId).toBe(local.activeEnvironmentId);
    expect(applied.globalVariables).toEqual(local.globalVariables);
    expect(applied.globalVariableMeta).toEqual(local.globalVariableMeta);
  });

  it('pushes remote values for disabled fields and local values for enabled fields', async () => {
    const local = makeData({
      environments: [{ _id: 'env-local', name: 'Local', values: [] }],
      activeEnvironmentId: 'env-local',
      globalVariables: { TOKEN: 'local-token' },
    });
    const remote = makeData({
      environments: [{ _id: 'env-remote', name: 'Remote', values: [] }],
      activeEnvironmentId: 'env-remote',
      globalVariables: { TOKEN: 'remote-token' },
    });
    vi.mocked(s3Adapter.pullWithMeta).mockResolvedValue({
      data: remote,
      remoteState: { timestamp: null, version: null },
    });
    vi.mocked(s3Adapter.push).mockResolvedValue(undefined);

    await push(makeConfig({ syncGlobalVariables: true }), local);

    const pushed = vi.mocked(s3Adapter.push).mock.calls[0][1] as WorkspaceData;
    expect(pushed.environments).toEqual(remote.environments);
    expect(pushed.activeEnvironmentId).toBe(remote.activeEnvironmentId);
    expect(pushed.globalVariables).toEqual(local.globalVariables);
  });

  it('keeps disabled fields local when applying a merged write', async () => {
    const local = makeData({
      environments: [{ _id: 'env-local', name: 'Local', values: [] }],
      activeEnvironmentId: 'env-local',
      globalVariables: { TOKEN: 'local-token' },
    });
    const remote = makeData({
      environments: [{ _id: 'env-remote', name: 'Remote', values: [] }],
      activeEnvironmentId: 'env-remote',
      globalVariables: { TOKEN: 'remote-token' },
    });
    vi.mocked(s3Adapter.pullWithMeta).mockResolvedValue({
      data: remote,
      remoteState: { timestamp: null, version: null },
    });
    vi.mocked(s3Adapter.applyMerged).mockResolvedValue(undefined);

    await applyMerged(makeConfig({ syncEnvironments: true }), local, 'remote-version');

    const written = vi.mocked(s3Adapter.applyMerged).mock.calls[0][1] as WorkspaceData;
    expect(written.environments).toEqual(local.environments);
    expect(written.activeEnvironmentId).toBe(local.activeEnvironmentId);
    expect(written.globalVariables).toEqual(remote.globalVariables);
  });
});