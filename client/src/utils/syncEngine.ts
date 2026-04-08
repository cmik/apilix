/**
 * syncEngine — provider-agnostic sync orchestrator.
 *
 * Each adapter implements the { push, pull, getRemoteTimestamp } interface.
 * The engine negotiates conflict resolution between local and remote state.
 */

import type { WorkspaceData, SyncConfig } from '../types';

export type ConflictResolution = 'keep-local' | 'keep-remote';

export interface SyncConflict {
  workspaceId: string;
  localLastSaved: string;
  remoteLastModified: string;
}

export interface SyncAdapter {
  push(workspaceId: string, data: WorkspaceData, config: Record<string, string>): Promise<void>;
  pull(workspaceId: string, config: Record<string, string>): Promise<WorkspaceData | null>;
  getRemoteTimestamp(workspaceId: string, config: Record<string, string>): Promise<string | null>;
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

/**
 * Pull workspace data from the configured provider.
 * Returns null if no remote data exists yet.
 * Throws on provider or conflict — caller should handle ConflictError.
 */
export async function pull(
  syncConfig: SyncConfig,
  resolution?: ConflictResolution,
): Promise<WorkspaceData | null> {
  const adapter = getAdapter(syncConfig.provider as string);

  if (!resolution) {
    // Check for conflict before pulling
    const remoteTs = await adapter.getRemoteTimestamp(syncConfig.workspaceId, syncConfig.config);
    const localTs = syncConfig.lastSynced ?? null;
    if (remoteTs && localTs && remoteTs > localTs) {
      const err = new ConflictError(syncConfig.workspaceId, localTs, remoteTs);
      throw err;
    }
  }

  if (resolution === 'keep-local') return null; // caller will push instead

  return adapter.pull(syncConfig.workspaceId, syncConfig.config);
}

/**
 * Check whether the remote is newer than the local copy.
 * Returns null if no remote exists.
 */
export async function checkConflict(syncConfig: SyncConfig): Promise<SyncConflict | null> {
  const adapter = getAdapter(syncConfig.provider as string);
  const remoteTs = await adapter.getRemoteTimestamp(syncConfig.workspaceId, syncConfig.config);
  const localTs = syncConfig.lastSynced ?? null;
  if (remoteTs && localTs && remoteTs > localTs) {
    return { workspaceId: syncConfig.workspaceId, localLastSaved: localTs, remoteLastModified: remoteTs };
  }
  return null;
}

// ─── ConflictError ────────────────────────────────────────────────────────────

export class ConflictError extends Error {
  constructor(
    public workspaceId: string,
    public localLastSaved: string,
    public remoteLastModified: string,
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
