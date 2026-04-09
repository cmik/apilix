/**
 * syncEngine — provider-agnostic sync orchestrator.
 *
 * Each adapter implements the { push, pull, getRemoteTimestamp } interface.
 * The engine negotiates conflict resolution between local and remote state.
 */

import type {
  WorkspaceData,
  SyncConfig,
  SyncRemoteState,
  SyncPullResult,
} from '../types';

export type ConflictResolution = 'keep-local' | 'keep-remote';

export interface SyncConflict {
  workspaceId: string;
  localLastSaved: string;
  remoteLastModified: string;
}

export interface SyncAdapter {
  push(
    workspaceId: string,
    data: WorkspaceData,
    config: Record<string, string>,
    options?: { expectedVersion?: string },
  ): Promise<void>;
  pull(workspaceId: string, config: Record<string, string>): Promise<WorkspaceData | null>;
  getRemoteTimestamp(workspaceId: string, config: Record<string, string>): Promise<string | null>;
  getRemoteState?(workspaceId: string, config: Record<string, string>): Promise<SyncRemoteState>;
  pullWithMeta?(workspaceId: string, config: Record<string, string>): Promise<SyncPullResult>;
  applyMerged?(
    workspaceId: string,
    mergedData: WorkspaceData,
    config: Record<string, string>,
    expectedVersion: string,
  ): Promise<void>;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Push the active workspace data to the configured provider.
 * Throws on provider error; caller should dispatch SET_SYNC_STATUS accordingly.
 */
export async function push(syncConfig: SyncConfig, data: WorkspaceData): Promise<void> {
  const adapter = getAdapter(syncConfig.provider as string);
  await adapter.push(syncConfig.workspaceId, data, syncConfig.config);
}

export async function applyMerged(
  syncConfig: SyncConfig,
  mergedData: WorkspaceData,
  expectedVersion: string,
): Promise<void> {
  const adapter = getAdapter(syncConfig.provider as string);
  if (adapter.applyMerged) {
    await adapter.applyMerged(syncConfig.workspaceId, mergedData, syncConfig.config, expectedVersion);
    return;
  }
  // Fallback for providers that don't support optimistic conditional writes yet.
  await adapter.push(syncConfig.workspaceId, mergedData, syncConfig.config, { expectedVersion });
}

/**
 * Pull workspace data from the configured provider.
 * Returns null if no remote data exists yet.
 * Throws on provider or conflict — caller should handle ConflictError.
 */
export async function pull(
  syncConfig: SyncConfig,
  resolution?: ConflictResolution,
): Promise<WorkspaceData | null> {
  const result = await pullWithMeta(syncConfig, resolution);
  return result.data;
}

export async function pullWithMeta(
  syncConfig: SyncConfig,
  resolution?: ConflictResolution,
): Promise<SyncPullResult> {
  const adapter = getAdapter(syncConfig.provider as string);

  if (!resolution) {
    // Check for conflict before pulling
    const remoteState = await getAdapterRemoteState(adapter, syncConfig.workspaceId, syncConfig.config);
    const localTs = syncConfig.metadata?.lastSyncedAt ?? syncConfig.lastSynced ?? null;
    if (remoteState.timestamp && localTs && remoteState.timestamp > localTs) {
      const err = new ConflictError(syncConfig.workspaceId, localTs, remoteState.timestamp, remoteState.version);
      throw err;
    }
  }

  if (resolution === 'keep-local') {
    return { data: null, remoteState: await getAdapterRemoteState(adapter, syncConfig.workspaceId, syncConfig.config) };
  }

  if (adapter.pullWithMeta) {
    return adapter.pullWithMeta(syncConfig.workspaceId, syncConfig.config);
  }

  const [data, remoteState] = await Promise.all([
    adapter.pull(syncConfig.workspaceId, syncConfig.config),
    getAdapterRemoteState(adapter, syncConfig.workspaceId, syncConfig.config),
  ]);
  return { data, remoteState };
}

/**
 * Check whether the remote is newer than the local copy.
 * Returns null if no remote exists.
 */
export async function checkConflict(syncConfig: SyncConfig): Promise<SyncConflict | null> {
  const adapter = getAdapter(syncConfig.provider as string);
  const remoteState = await getAdapterRemoteState(adapter, syncConfig.workspaceId, syncConfig.config);
  const localTs = syncConfig.metadata?.lastSyncedAt ?? syncConfig.lastSynced ?? null;
  if (remoteState.timestamp && localTs && remoteState.timestamp > localTs) {
    return { workspaceId: syncConfig.workspaceId, localLastSaved: localTs, remoteLastModified: remoteState.timestamp };
  }
  return null;
}

export async function getRemoteSyncState(syncConfig: SyncConfig): Promise<SyncRemoteState> {
  const adapter = getAdapter(syncConfig.provider as string);
  return getAdapterRemoteState(adapter, syncConfig.workspaceId, syncConfig.config);
}

async function getAdapterRemoteState(
  adapter: SyncAdapter,
  workspaceId: string,
  config: Record<string, string>,
): Promise<SyncRemoteState> {
  if (adapter.getRemoteState) {
    return adapter.getRemoteState(workspaceId, config);
  }
  return {
    timestamp: await adapter.getRemoteTimestamp(workspaceId, config),
    version: null,
  };
}

// ─── ConflictError ────────────────────────────────────────────────────────────

export class ConflictError extends Error {
  constructor(
    public workspaceId: string,
    public localLastSaved: string,
    public remoteLastModified: string,
    public remoteVersion: string | null = null,
  ) {
    super(`Sync conflict for workspace ${workspaceId}: remote is newer`);
  }
}

// ─── Adapter registry ─────────────────────────────────────────────────────────

function getAdapter(provider: string): SyncAdapter {
  switch (provider) {
    case 's3': return s3Adapter;
    case 'git': return gitAdapter;
    case 'http': return httpAdapter;
    case 'team': return teamAdapter;
    default: throw new Error(`Unknown sync provider: ${provider}`);
  }
}

// ─── Lazy adapter imports (tree-shaken when unused) ───────────────────────────

import { s3Adapter } from './sync/s3Adapter';
import { gitAdapter } from './sync/gitAdapter';
import { httpAdapter } from './sync/httpAdapter';
import { teamAdapter } from './sync/teamAdapter';
