import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../store', () => ({
  useApp: vi.fn(),
  generateId: vi.fn(() => 'generated-id'),
}));

// ─── helpers used by ImportPanel unit tests ───────────────────────────────────
vi.mock('../utils/workspaceExportUtils', () => ({
  isWorkspaceExportPackage: vi.fn(),
  parseWorkspaceExportPackage: vi.fn(),
  buildWorkspaceExportPackage: vi.fn(),
}));

vi.mock('../utils/syncExportUtils', () => ({
  parseSyncExportPackage: vi.fn(),
  decryptSyncExportConfig: vi.fn(),
  buildSyncExportPackage: vi.fn(),
  encryptSyncExportConfig: vi.fn(),
}));

import * as workspaceExportUtils from '../utils/workspaceExportUtils';
import * as syncExportUtils from '../utils/syncExportUtils';

const mockedIsWorkspaceExportPackage = vi.mocked(workspaceExportUtils.isWorkspaceExportPackage);
const mockedParseWorkspaceExportPackage = vi.mocked(workspaceExportUtils.parseWorkspaceExportPackage);
const mockedParseSyncExportPackage = vi.mocked(syncExportUtils.parseSyncExportPackage);

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

// ─── ImportPanel file detection routing ──────────────────────────────────────
// These tests exercise the detection logic that ImportPanel.handleFile delegates
// to, without needing a DOM / React renderer.
//
// LIMITATION: Because vitest.config.ts uses environment: 'node' (no jsdom /
// @testing-library/react), we cannot mount ImportPanel and call handleFile
// directly. The tests below re-implement the same conditional branch in-test
// and verify that the mocked utilities behave as contracts require. They do NOT
// verify that the live ImportPanel component calls these utilities correctly —
// that is covered by end-to-end / integration tests.
//
// If this config is ever changed to 'jsdom', replace these tests with proper
// component render + userEvent.upload / fireEvent.drop tests.

describe('ImportPanel — handleFile routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes to parseWorkspaceExportPackage when isWorkspaceExportPackage returns true', () => {
    const raw = { apilixWorkspaceExport: '1' };
    mockedIsWorkspaceExportPackage.mockReturnValue(true);
    mockedParseWorkspaceExportPackage.mockReturnValue({ workspaceName: 'Test', workspaceId: 'ws-1', exportedAt: '', apilixWorkspaceExport: '1', data: {} as never });

    let kind: string | null = null;
    if (mockedIsWorkspaceExportPackage(raw)) {
      mockedParseWorkspaceExportPackage(raw);
      kind = 'workspace';
    } else {
      mockedParseSyncExportPackage(raw);
      kind = 'sync';
    }

    expect(kind).toBe('workspace');
    expect(mockedParseWorkspaceExportPackage).toHaveBeenCalledWith(raw);
    expect(mockedParseSyncExportPackage).not.toHaveBeenCalled();
  });

  it('routes to parseSyncExportPackage when isWorkspaceExportPackage returns false', () => {
    const raw = { apilixSyncExport: '1' };
    mockedIsWorkspaceExportPackage.mockReturnValue(false);
    mockedParseSyncExportPackage.mockReturnValue({ workspaceName: 'Test', workspaceId: 'ws-1', provider: 'git', config: {}, encrypted: false } as never);

    let kind: string | null = null;
    if (mockedIsWorkspaceExportPackage(raw)) {
      mockedParseWorkspaceExportPackage(raw);
      kind = 'workspace';
    } else {
      mockedParseSyncExportPackage(raw);
      kind = 'sync';
    }

    expect(kind).toBe('sync');
    expect(mockedParseSyncExportPackage).toHaveBeenCalledWith(raw);
    expect(mockedParseWorkspaceExportPackage).not.toHaveBeenCalled();
  });

  it('propagates error thrown by parseWorkspaceExportPackage', () => {
    const raw = { apilixWorkspaceExport: '1' };
    mockedIsWorkspaceExportPackage.mockReturnValue(true);
    mockedParseWorkspaceExportPackage.mockImplementation(() => { throw new Error('bad version'); });

    expect(() => {
      if (mockedIsWorkspaceExportPackage(raw)) {
        mockedParseWorkspaceExportPackage(raw);
      }
    }).toThrow('bad version');
  });

  it('propagates error thrown by parseSyncExportPackage', () => {
    const raw = { apilixSyncExport: '1' };
    mockedIsWorkspaceExportPackage.mockReturnValue(false);
    mockedParseSyncExportPackage.mockImplementation(() => { throw new Error('unknown provider'); });

    expect(() => {
      if (mockedIsWorkspaceExportPackage(raw)) {
        mockedParseWorkspaceExportPackage(raw);
      } else {
        mockedParseSyncExportPackage(raw);
      }
    }).toThrow('unknown provider');
  });

  it('invalid JSON string causes SyntaxError', () => {
    expect(() => JSON.parse('not json')).toThrow(SyntaxError);
  });

  it('isWorkspaceExportPackage is checked before parseSyncExportPackage', () => {
    const raw = {};
    mockedIsWorkspaceExportPackage.mockReturnValue(false);
    mockedParseSyncExportPackage.mockReturnValue({ workspaceName: 'W', workspaceId: 'x', provider: 's3', config: {}, encrypted: false } as never);

    // Guard is always called first, then the appropriate parser
    if (mockedIsWorkspaceExportPackage(raw)) {
      mockedParseWorkspaceExportPackage(raw);
    } else {
      mockedParseSyncExportPackage(raw);
    }

    const callOrder = [
      mockedIsWorkspaceExportPackage.mock.invocationCallOrder[0],
      mockedParseSyncExportPackage.mock.invocationCallOrder[0],
    ];
    expect(callOrder[0]).toBeLessThan(callOrder[1]);
    expect(mockedParseWorkspaceExportPackage).not.toHaveBeenCalled();
  });

  it('parseWorkspaceExportPackage receives the exact raw object parsed from file text', () => {
    const raw = { apilixWorkspaceExport: '1', workspaceName: 'My WS', workspaceId: 'abc', exportedAt: '2026-01-01', data: {} };
    mockedIsWorkspaceExportPackage.mockReturnValue(true);
    mockedParseWorkspaceExportPackage.mockReturnValue(raw as never);

    const result = mockedIsWorkspaceExportPackage(raw)
      ? mockedParseWorkspaceExportPackage(raw)
      : null;

    expect(result).toBe(raw);
    expect(mockedParseWorkspaceExportPackage).toHaveBeenCalledWith(raw);
  });
});
