import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../store', () => ({
  useApp: vi.fn(),
  generateId: vi.fn(() => 'generated-id'),
}));

vi.mock('../utils/requestTabSyncGuard', () => ({
  requestWorkspaceSwitchGuard: vi.fn(),
  saveExistingRequestTabs: vi.fn(),
  buildUnsavedRequestTabsConfirmMessage: vi.fn(),
  getUnsavedRequestTabSummary: vi.fn(),
}));

vi.mock('../utils/syncEngine', () => ({
  push: vi.fn(),
  pullWithMeta: vi.fn(),
  getRemoteSyncState: vi.fn(),
  applyMerged: vi.fn(),
  pullForMerge: vi.fn(),
  rebaseAfterStale: vi.fn(),
  ConflictError: class extends Error {},
  StaleVersionError: class extends Error {},
  testConnection: vi.fn(),
}));

vi.mock('../utils/snapshotEngine', () => ({}));
vi.mock('./ConflictMergeModal', () => ({ default: () => null }));
vi.mock('./ConfirmModal', () => ({ default: () => null }));

vi.mock('../utils/storageDriver', () => ({
  readSyncConfig: vi.fn(),
  writeSyncConfig: vi.fn(),
}));

import { cloneWorkspaceSyncConfig } from './WorkspaceManagerModal';
import * as StorageDriver from '../utils/storageDriver';

const mockedReadSyncConfig = vi.mocked(StorageDriver.readSyncConfig);
const mockedWriteSyncConfig = vi.mocked(StorageDriver.writeSyncConfig);

describe('cloneWorkspaceSyncConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('copies provider/config/readOnly and clears metadata', async () => {
    mockedReadSyncConfig.mockResolvedValue({
      provider: 'git',
      config: { remote: 'https://github.com/org/repo.git', branch: 'main', token: 'secret' },
      metadata: {
        lastSyncedAt: '2026-04-10T00:00:00.000Z',
        lastSyncedVersion: 'abc123',
        lastMergeBaseSnapshotId: 'snap-1',
      },
      lastSynced: '2026-04-10T00:00:00.000Z',
      readOnly: true,
    });

    const copied = await cloneWorkspaceSyncConfig('ws-source', 'ws-copy');

    expect(copied).toBe(true);
    expect(mockedReadSyncConfig).toHaveBeenCalledWith('ws-source');
    expect(mockedWriteSyncConfig).toHaveBeenCalledWith(
      'ws-copy',
      'git',
      { remote: 'https://github.com/org/repo.git', branch: 'main', token: 'secret' },
      undefined,
      true,
    );
  });

  it('returns false and does not write when source has no sync config', async () => {
    mockedReadSyncConfig.mockResolvedValue(null);

    const copied = await cloneWorkspaceSyncConfig('ws-source', 'ws-copy');

    expect(copied).toBe(false);
    expect(mockedReadSyncConfig).toHaveBeenCalledWith('ws-source');
    expect(mockedWriteSyncConfig).not.toHaveBeenCalled();
  });
});
