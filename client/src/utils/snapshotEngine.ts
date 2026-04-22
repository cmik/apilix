/**
 * Snapshot Engine
 *
 * Creates and manages point-in-time snapshots of workspace data.
 * Snapshots are stored via StorageDriver at:
 *   userData/workspaces/{workspaceId}/snapshots/{snapshotId}.json
 *   userData/workspaces/{workspaceId}/history.json  ← index
 *
 * A ring-buffer of MAX_SNAPSHOTS is maintained per workspace.
 * Oldest entries are pruned automatically.
 */

import type { WorkspaceData, HistoryEntry, WorkspaceSnapshot } from '../types';
import * as StorageDriver from './storageDriver';
import { generateId } from '../store';

const MAX_SNAPSHOTS = 50;

/**
 * Create a new snapshot for the given workspace.
 * Called automatically by store.tsx after every debounced save.
 */
export async function createSnapshot(
  workspaceId: string,
  data: WorkspaceData,
  summary?: string,
): Promise<string> {
  const snapshotId = generateId();
  const timestamp = new Date().toISOString();
  const autoSummary = summary ?? `${data.collections.length} collection(s), auto-save`;

  const encryptedData = await StorageDriver.encryptWorkspaceSecrets(data);
  const snapshot: WorkspaceSnapshot = { snapshotId, timestamp, summary: autoSummary, data: encryptedData };
  await StorageDriver.writeSnapshot(workspaceId, snapshotId, snapshot);

  // Update history index
  const idx = await StorageDriver.readHistoryIndex(workspaceId) ?? [];
  const entry: HistoryEntry = {
    snapshotId,
    timestamp,
    summary: autoSummary,
    collectionsCount: data.collections.length,
  };
  const updated = [entry, ...idx].slice(0, MAX_SNAPSHOTS);
  await StorageDriver.writeHistoryIndex(workspaceId, updated);
  return snapshotId;
}

/**
 * Retrieve the ordered history index (newest first).
 */
export async function listHistory(workspaceId: string): Promise<HistoryEntry[]> {
  const raw = await StorageDriver.readHistoryIndex(workspaceId);
  return (raw as HistoryEntry[] | null) ?? [];
}

/**
 * Load a specific snapshot by id.
 */
export async function loadSnapshot(
  workspaceId: string,
  snapshotId: string,
): Promise<WorkspaceSnapshot | null> {
  const raw = await StorageDriver.readSnapshot(workspaceId, snapshotId) as WorkspaceSnapshot | null;
  if (!raw) return null;
  return {
    ...raw,
    data: await StorageDriver.decryptWorkspaceSecrets(raw.data),
  };
}

/**
 * Produce a simple structural diff between two WorkspaceData instances.
 * Returns human-readable lines describing what changed.
 */
export function diffSnapshots(a: WorkspaceData, b: WorkspaceData): string[] {
  const lines: string[] = [];

  const aColIds = new Set(a.collections.map(c => c._id));
  const bColIds = new Set(b.collections.map(c => c._id));
  const aColMap = new Map(a.collections.map(c => [c._id, c]));
  const bColMap = new Map(b.collections.map(c => [c._id, c]));

  for (const id of bColIds) {
    if (!aColIds.has(id)) {
      lines.push(`+ Collection added: ${bColMap.get(id)!.info.name}`);
    }
  }
  for (const id of aColIds) {
    if (!bColIds.has(id)) {
      lines.push(`- Collection removed: ${aColMap.get(id)!.info.name}`);
    }
  }
  for (const id of aColIds) {
    if (bColIds.has(id)) {
      const ac = aColMap.get(id)!;
      const bc = bColMap.get(id)!;
      if (ac.info.name !== bc.info.name) lines.push(`~ Collection renamed: ${ac.info.name} → ${bc.info.name}`);
      const aItems = JSON.stringify(ac.item ?? []);
      const bItems = JSON.stringify(bc.item ?? []);
      if (aItems !== bItems) lines.push(`~ Collection modified: ${bc.info.name}`);
    }
  }

  const aEnvIds = new Set(a.environments.map(e => e._id));
  const bEnvMap = new Map(b.environments.map(e => [e._id, e]));
  for (const [id, env] of bEnvMap) {
    if (!aEnvIds.has(id)) lines.push(`+ Environment added: ${env.name}`);
  }
  for (const env of a.environments) {
    if (!bEnvMap.has(env._id)) lines.push(`- Environment removed: ${env.name}`);
  }

  if (lines.length === 0) lines.push('No structural changes detected');
  return lines;
}
