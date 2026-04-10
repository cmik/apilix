/**
 * StorageDriver — disk-first persistence with localStorage write-through fallback.
 *
 * When running inside Electron, all reads/writes go to
 * `app.getPath('userData')` via IPC and are mirrored to localStorage as a
 * hot-reload / browser-dev-mode fallback.
 *
 * When `window.electronAPI` is absent (browser dev mode), only localStorage
 * is used, and the module remains crash-free.
 */

import type { WorkspaceData, Workspace, SyncMetadata, SyncActivityEntry } from '../types';

// ─── Electron API shim ────────────────────────────────────────────────────────

interface ElectronAPI {
  getDataDir: () => Promise<string>;
  readJsonFile: (filePath: string) => Promise<unknown>;
  writeJsonFile: (filePath: string, data: unknown) => Promise<void>;
  deleteFile: (filePath: string) => Promise<void>;
  deleteDirectory: (dirPath: string) => Promise<void>;
  listDir: (dirPath: string) => Promise<string[]>;
  shellOpenPath: (dirPath: string) => Promise<void>;
  openFileDialog: (filters: Array<{ name: string; extensions: string[] }>) => Promise<string | null>;
  encryptString: (value: string) => Promise<string | null>;
  decryptString: (encrypted: string) => Promise<string | null>;
  onWillClose: (cb: () => void) => void;
  respondClose: (confirmed: boolean) => void;
}

function eAPI(): ElectronAPI | null {
  return (window as unknown as { electronAPI?: ElectronAPI }).electronAPI ?? null;
}

// ─── localStorage helpers ────────────────────────────────────────────────────

const LS_MANIFEST = 'apilix_workspaces';
const LS_WORKSPACE = (id: string) => `apilix_workspace_${id}`;
const LS_SETTINGS = 'apilix_settings';
const LS_SYNC_CONFIG = 'apilix_sync_config';
const LS_SYNC_ACTIVITY = 'apilix_sync_activity';

function lsRead<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function lsWrite(key: string, data: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // quota exceeded — fail silently
  }
}

function lsDelete(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

// ─── Manifest ────────────────────────────────────────────────────────────────

export interface WorkspaceManifest {
  workspaces: Workspace[];
  activeWorkspaceId: string;
}

export async function readManifest(): Promise<WorkspaceManifest | null> {
  const api = eAPI();
  if (api) {
    try {
      const dir = await api.getDataDir();
      const data = await api.readJsonFile(`${dir}/workspaces.json`);
      if (data) return data as WorkspaceManifest;
    } catch {
      // fall through to localStorage
    }
  }
  return lsRead<WorkspaceManifest>(LS_MANIFEST);
}

export async function writeManifest(manifest: WorkspaceManifest): Promise<void> {
  lsWrite(LS_MANIFEST, manifest);
  const api = eAPI();
  if (api) {
    const dir = await api.getDataDir();
    await api.writeJsonFile(`${dir}/workspaces.json`, manifest);
  }
}

// ─── Workspace data ───────────────────────────────────────────────────────────

export async function readWorkspace(id: string): Promise<WorkspaceData | null> {
  const api = eAPI();
  if (api) {
    try {
      const dir = await api.getDataDir();
      const data = await api.readJsonFile(`${dir}/workspaces/${id}.json`);
      if (data) return data as WorkspaceData;
    } catch {
      // fall through to localStorage
    }
  }
  return lsRead<WorkspaceData>(LS_WORKSPACE(id));
}

export async function writeWorkspace(id: string, data: WorkspaceData): Promise<void> {
  lsWrite(LS_WORKSPACE(id), data);
  const api = eAPI();
  if (api) {
    const dir = await api.getDataDir();
    await api.writeJsonFile(`${dir}/workspaces/${id}.json`, data);
  }
}

export async function deleteWorkspace(id: string): Promise<void> {
  // ── localStorage ──────────────────────────────────────────────────────────
  lsDelete(LS_WORKSPACE(id));

  // Remove entry from sync-config store
  const lsSyncConfig = lsRead<SyncConfigStore>(LS_SYNC_CONFIG);
  if (lsSyncConfig) {
    delete lsSyncConfig[id];
    lsWrite(LS_SYNC_CONFIG, lsSyncConfig);
  }

  // Remove entry from sync-activity store
  const lsSyncActivity = lsRead<SyncActivityStore>(LS_SYNC_ACTIVITY);
  if (lsSyncActivity) {
    delete lsSyncActivity[id];
    lsWrite(LS_SYNC_ACTIVITY, lsSyncActivity);
  }

  // ── Electron (disk) ───────────────────────────────────────────────────────
  const api = eAPI();
  if (!api) return;
  const dir = await api.getDataDir();

  // Workspace data file
  await api.deleteFile(`${dir}/workspaces/${id}.json`).catch(() => {});

  // Snapshot / history directory: workspaces/{id}/
  await api.deleteDirectory(`${dir}/workspaces/${id}`).catch(() => {});

  // Remove entry from shared sync-config.json
  try {
    const syncCfg = (await api.readJsonFile(`${dir}/sync-config.json`) as SyncConfigStore | null) ?? {};
    delete syncCfg[id];
    await api.writeJsonFile(`${dir}/sync-config.json`, syncCfg);
  } catch { /* ignore */ }

  // Remove entry from shared sync-activity.json
  try {
    const syncAct = (await api.readJsonFile(`${dir}/sync-activity.json`) as SyncActivityStore | null) ?? {};
    delete syncAct[id];
    await api.writeJsonFile(`${dir}/sync-activity.json`, syncAct);
  } catch { /* ignore */ }

  // Remove local git-sync repository for this workspace
  await api.deleteDirectory(`${dir}/git-sync/workspaces/${id}`).catch(() => {});
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface AppSettings {
  theme?: 'dark' | 'light' | 'system';
  [key: string]: unknown;
}

export async function readSettings(): Promise<AppSettings | null> {
  const api = eAPI();
  if (api) {
    try {
      const dir = await api.getDataDir();
      const data = await api.readJsonFile(`${dir}/settings.json`);
      if (data) return data as AppSettings;
    } catch {
      // fall through
    }
  }
  return lsRead<AppSettings>(LS_SETTINGS);
}

export async function writeSettings(settings: AppSettings): Promise<void> {
  lsWrite(LS_SETTINGS, settings);
  const api = eAPI();
  if (api) {
    const dir = await api.getDataDir();
    await api.writeJsonFile(`${dir}/settings.json`, settings);
  }
}

// ─── Sync config (encrypted credentials) ────────────────────────────────────

export interface StoredSyncConfig {
  provider: string;
  config: Record<string, string>;
  metadata?: SyncMetadata;
  /** legacy key kept for backward compatibility */
  lastSynced?: string;
  /** When true, push operations are blocked — workspace syncs in pull-only mode */
  readOnly?: boolean;
}

export type SyncConfigStore = Record<string, StoredSyncConfig>;
export type SyncActivityStore = Record<string, SyncActivityEntry[]>;

/** Read the full sync config store (all workspaces). */
export async function readSyncConfigStore(): Promise<SyncConfigStore> {
  const api = eAPI();
  if (api) {
    try {
      const dir = await api.getDataDir();
      const store = await api.readJsonFile(`${dir}/sync-config.json`) as SyncConfigStore | null;
      if (store) return store;
    } catch { /* fall through */ }
  }
  return lsRead<SyncConfigStore>(LS_SYNC_CONFIG) ?? {};
}

/** Read the sync config for a specific workspace. */
export async function readSyncConfig(workspaceId: string): Promise<StoredSyncConfig | null> {
  const api = eAPI();
  let store: SyncConfigStore | null = null;
  if (api) {
    try {
      const dir = await api.getDataDir();
      store = await api.readJsonFile(`${dir}/sync-config.json`) as SyncConfigStore | null;
    } catch { /* fall through */ }
  }
  if (!store) store = lsRead<SyncConfigStore>(LS_SYNC_CONFIG);
  if (!store || !store[workspaceId]) return null;
  const raw = store[workspaceId] as unknown as Record<string, unknown>;
  const provider = typeof raw.provider === 'string' ? raw.provider : '';
  const config = (raw.config && typeof raw.config === 'object') ? raw.config as Record<string, string> : {};
  const metadata = (raw.metadata && typeof raw.metadata === 'object') ? raw.metadata as SyncMetadata : undefined;
  const lastSynced = typeof raw.lastSynced === 'string' ? raw.lastSynced : undefined;
  const readOnly = raw.readOnly === true ? true : undefined;
  if (!provider) return null;
  return { provider, config, metadata, lastSynced, readOnly };
}

/** Write the sync config for a specific workspace (merges into the store file). */
export async function writeSyncConfig(
  workspaceId: string,
  provider: string,
  config: Record<string, string>,
  metadata?: SyncMetadata,
  readOnly?: boolean,
): Promise<void> {
  const api = eAPI();
  let store: SyncConfigStore = {};
  const entry: StoredSyncConfig = {
    provider,
    config,
    metadata,
    lastSynced: metadata?.lastSyncedAt,
    ...(readOnly ? { readOnly: true } : {}),
  };
  if (api) {
    try {
      const dir = await api.getDataDir();
      store = (await api.readJsonFile(`${dir}/sync-config.json`) as SyncConfigStore | null) ?? {};
      store[workspaceId] = entry;
      await api.writeJsonFile(`${dir}/sync-config.json`, store);
    } catch { /* fall through */ }
  }
  lsWrite(LS_SYNC_CONFIG, { ...store, [workspaceId]: entry });
}

export async function readSyncActivity(workspaceId: string): Promise<SyncActivityEntry[]> {
  const api = eAPI();
  let store: SyncActivityStore | null = null;
  if (api) {
    try {
      const dir = await api.getDataDir();
      store = await api.readJsonFile(`${dir}/sync-activity.json`) as SyncActivityStore | null;
    } catch {
      // fall through
    }
  }
  if (!store) store = lsRead<SyncActivityStore>(LS_SYNC_ACTIVITY);
  return Array.isArray(store?.[workspaceId]) ? store![workspaceId] : [];
}

export async function appendSyncActivity(workspaceId: string, entry: SyncActivityEntry): Promise<void> {
  const api = eAPI();
  let diskStore: SyncActivityStore = {};
  if (api) {
    try {
      const dir = await api.getDataDir();
      diskStore = (await api.readJsonFile(`${dir}/sync-activity.json`) as SyncActivityStore | null) ?? {};
      diskStore[workspaceId] = [entry, ...(diskStore[workspaceId] ?? [])].slice(0, 100);
      await api.writeJsonFile(`${dir}/sync-activity.json`, diskStore);
    } catch {
      // fall through
    }
  }

  const localStore = lsRead<SyncActivityStore>(LS_SYNC_ACTIVITY) ?? {};
  localStore[workspaceId] = [entry, ...(localStore[workspaceId] ?? [])].slice(0, 100);
  lsWrite(LS_SYNC_ACTIVITY, localStore);
}

// ─── Encryption helpers ───────────────────────────────────────────────────────

export async function encryptValue(value: string): Promise<string> {
  const api = eAPI();
  if (api) {
    const encrypted = await api.encryptString(value);
    if (encrypted) return encrypted;
  }
  // Browser fallback: store as-is (no encryption available)
  return value;
}

export async function decryptValue(encrypted: string): Promise<string> {
  const api = eAPI();
  if (api) {
    const decrypted = await api.decryptString(encrypted);
    if (decrypted !== null) return decrypted;
  }
  return encrypted;
}

// ─── Snapshot helpers ─────────────────────────────────────────────────────────

export async function readHistoryIndex(workspaceId: string): Promise<unknown[] | null> {
  const api = eAPI();
  if (!api) return null;
  const dir = await api.getDataDir();
  return api.readJsonFile(`${dir}/workspaces/${workspaceId}/history.json`) as Promise<unknown[] | null>;
}

export async function writeHistoryIndex(workspaceId: string, index: unknown[]): Promise<void> {
  const api = eAPI();
  if (!api) return;
  const dir = await api.getDataDir();
  await api.writeJsonFile(`${dir}/workspaces/${workspaceId}/history.json`, index);
}

export async function readSnapshot(workspaceId: string, snapshotId: string): Promise<unknown | null> {
  const api = eAPI();
  if (!api) return null;
  const dir = await api.getDataDir();
  return api.readJsonFile(`${dir}/workspaces/${workspaceId}/snapshots/${snapshotId}.json`);
}

export async function writeSnapshot(workspaceId: string, snapshotId: string, data: unknown): Promise<void> {
  const api = eAPI();
  if (!api) return;
  const dir = await api.getDataDir();
  await api.writeJsonFile(`${dir}/workspaces/${workspaceId}/snapshots/${snapshotId}.json`, data);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Opens the workspace data folder in Finder / Explorer. */
export async function openDataFolder(workspaceId?: string): Promise<void> {
  const api = eAPI();
  if (!api) return;
  const dir = await api.getDataDir();
  const target = workspaceId ? `${dir}/workspaces/${workspaceId}` : dir;
  await api.shellOpenPath(target);
}

/** Opens a native file picker and returns the selected file path, or null. */
export async function pickFile(filters?: Array<{ name: string; extensions: string[] }>): Promise<string | null> {
  const api = eAPI();
  if (!api) return null;
  return api.openFileDialog(filters ?? [{ name: 'All Files', extensions: ['*'] }]);
}

/** Returns the Electron userData directory, or null in browser mode. */
export async function getDataDir(): Promise<string | null> {
  const api = eAPI();
  if (!api) return null;
  return api.getDataDir();
}
