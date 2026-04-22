import { describe, it, expect } from 'vitest';
import {
  getQuickSyncInitialPhase,
  getQuickSyncMergeAction,
  getQuickSyncSuccessMessage,
} from './quickSyncFlow';

describe('getQuickSyncInitialPhase', () => {
  it('chooses merge-before-push when local changes exist and workspace is writable', () => {
    expect(getQuickSyncInitialPhase({ hasLocalUnpushed: true, readOnly: false })).toBe('merge-before-push');
  });

  it('chooses pull-only when there are no local changes', () => {
    expect(getQuickSyncInitialPhase({ hasLocalUnpushed: false, readOnly: false })).toBe('pull-only');
  });

  it('chooses pull-only for read-only workspaces even with local changes', () => {
    expect(getQuickSyncInitialPhase({ hasLocalUnpushed: true, readOnly: true })).toBe('pull-only');
  });
});

describe('getQuickSyncMergeAction', () => {
  it('opens merge review when conflicts are present', () => {
    expect(getQuickSyncMergeAction({ conflictCount: 2, readOnly: false })).toBe('open-merge-review');
  });

  it('applies merged locally when read-only and conflict-free', () => {
    expect(getQuickSyncMergeAction({ conflictCount: 0, readOnly: true })).toBe('apply-merged-locally');
  });

  it('applies merged and pushes when writable and conflict-free', () => {
    expect(getQuickSyncMergeAction({ conflictCount: 0, readOnly: false })).toBe('apply-merged-and-push');
  });
});

describe('getQuickSyncSuccessMessage', () => {
  it('returns pulled + pushed for writable merge path', () => {
    expect(getQuickSyncSuccessMessage({
      readOnly: false,
      pulledData: true,
      pushed: true,
      remoteEmpty: false,
      usedMergePath: true,
    })).toBe('Synced (pulled + pushed)');
  });

  it('returns auto-merged locally for read-only merge path', () => {
    expect(getQuickSyncSuccessMessage({
      readOnly: true,
      pulledData: true,
      pushed: false,
      remoteEmpty: false,
      usedMergePath: true,
    })).toBe('Synced (auto-merged locally)');
  });

  it('returns remote-empty then pushed when pull found no remote data and push happened', () => {
    expect(getQuickSyncSuccessMessage({
      readOnly: false,
      pulledData: false,
      pushed: true,
      remoteEmpty: true,
      usedMergePath: false,
    })).toBe('Synced (remote empty, then pushed)');
  });
});
