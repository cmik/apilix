import { useState, useEffect, useCallback } from 'react';
import type { Workspace, WorkspaceData, SyncConfig, SyncProvider, HistoryEntry, SyncMetadata, ConflictPackage, SyncActivityEntry, SyncActivityLevel } from '../types';
import { useApp, generateId } from '../store';
import * as StorageDriver from '../utils/storageDriver';
import {
  requestWorkspaceSwitchGuard,
  saveExistingRequestTabs,
  buildUnsavedRequestTabsConfirmMessage,
  getUnsavedRequestTabSummary,
} from '../utils/requestTabSyncGuard';
import {
  push as syncPush,
  pullWithMeta as syncPullWithMeta,
  getRemoteSyncState,
  applyMerged as syncApplyMerged,
  pullForMerge,
  rebaseAfterStale,
  ConflictError,
  StaleVersionError,
} from '../utils/syncEngine';
import * as SnapshotEngine from '../utils/snapshotEngine';
import ConflictMergeModal from './ConflictMergeModal';

type Tab = 'workspaces' | 'sync' | 'team' | 'history';

const PRESET_COLORS = ['#f97316', '#3b82f6', '#22c55e', '#a855f7', '#ef4444', '#eab308'];

const PROVIDER_CAPABILITIES: Record<SyncProvider, Array<{ label: string; tone: 'success' | 'warning' }>> = {
  git: [
    { label: 'Versioned writes', tone: 'success' },
    { label: 'Remote state metadata', tone: 'success' },
    { label: 'Three-way merge recovery', tone: 'success' },
  ],
  http: [
    { label: 'Versioned writes', tone: 'success' },
    { label: 'Remote state metadata', tone: 'success' },
    { label: 'Three-way merge recovery', tone: 'success' },
  ],
  team: [
    { label: 'Versioned writes', tone: 'success' },
    { label: 'Remote state metadata', tone: 'success' },
    { label: 'Three-way merge recovery', tone: 'success' },
  ],
  s3: [
    { label: 'Remote state metadata', tone: 'success' },
    { label: 'Three-way merge recovery', tone: 'success' },
    { label: 'Conditional writes depend on backend support', tone: 'warning' },
  ],
};

interface Props {
  onClose: () => void;
}

export default function WorkspaceManagerModal({ onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('workspaces');
  const isBrowserMode = !(window as { electronAPI?: unknown }).electronAPI;
  const visibleTabs: Tab[] = isBrowserMode
    ? ['workspaces', 'history']
    : ['workspaces', 'sync', 'team', 'history'];

  useEffect(() => {
    if (!visibleTabs.includes(activeTab)) {
      setActiveTab('workspaces');
    }
  }, [activeTab, visibleTabs]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-[640px] max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <h2 className="text-sm font-semibold text-slate-200">Manage Workspaces</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-lg leading-none px-1">✕</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-800 px-4">
          {visibleTabs.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-2 text-xs font-medium capitalize transition-colors border-b-2 -mb-px ${
                activeTab === tab
                  ? 'border-orange-400 text-orange-400'
                  : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-4">
          {activeTab === 'workspaces' && <WorkspacesTab onClose={onClose} />}
          {!isBrowserMode && activeTab === 'sync' && <SyncTab />}
          {!isBrowserMode && activeTab === 'team' && <TeamTab />}
          {activeTab === 'history' && <HistoryTab />}
        </div>
      </div>
    </div>
  );
}

// ─── Workspaces Tab ───────────────────────────────────────────────────────────

function WorkspacesTab({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useApp();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [syncedIds, setSyncedIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    StorageDriver.readSyncConfigStore().then(store => {
      setSyncedIds(new Set(Object.keys(store).filter(id => !!store[id]?.provider)));
    });
  }, [state.workspaces, state.syncConfigVersion]);

  async function handleSwitch(workspace: Workspace) {
    if (workspace.id === state.activeWorkspaceId) return;
    const { decision, summary } = await requestWorkspaceSwitchGuard();
    if (decision === 'cancel') return;
    if (decision === 'save-and-switch') {
      const saveResult = await saveExistingRequestTabs(summary.existingDirtyTabIds);
      // Flush updated collections to disk immediately — the debounced persist effect
      // fires after SWITCH_WORKSPACE changes activeWorkspaceId, so without this write
      // the saved data would be written to the new workspace's slot instead.
      await StorageDriver.writeWorkspace(state.activeWorkspaceId, {
        collections: saveResult.updatedCollections,
        environments: state.environments,
        activeEnvironmentId: state.activeEnvironmentId,
        collectionVariables: state.collectionVariables,
        globalVariables: state.globalVariables,
        cookieJar: state.cookieJar,
        mockCollections: state.mockCollections,
        mockRoutes: state.mockRoutes,
        mockPort: state.mockPort,
      });
    }
    const data = await StorageDriver.readWorkspace(workspace.id) ?? emptyWorkspaceData();
    dispatch({ type: 'SWITCH_WORKSPACE', payload: { workspace, data } });
    onClose();
  }

  function startRename(w: Workspace) {
    setEditingId(w.id);
    setEditName(w.name);
  }

  async function commitRename(id: string) {
    const name = editName.trim();
    if (!name) { setEditingId(null); return; }
    dispatch({ type: 'RENAME_WORKSPACE', payload: { id, name } });
    // Persist manifest immediately (the debounced effect will also catch it)
    const updated = state.workspaces.map(w => w.id === id ? { ...w, name } : w);
    await StorageDriver.writeManifest({ workspaces: updated, activeWorkspaceId: state.activeWorkspaceId });
    setEditingId(null);
  }

  async function handleDelete(id: string) {
    if (state.workspaces.length <= 1) return; // guard: cannot delete last
    const remaining = state.workspaces.filter(w => w.id !== id);
    const fallback = remaining.find(w => w.id !== id)!;
    const fallbackData = await StorageDriver.readWorkspace(fallback.id) ?? emptyWorkspaceData();
    await StorageDriver.deleteWorkspace(id);
    dispatch({ type: 'DELETE_WORKSPACE', payload: { id, fallbackId: fallback.id } });
    if (state.activeWorkspaceId === id) {
      dispatch({ type: 'SWITCH_WORKSPACE', payload: { workspace: fallback, data: fallbackData } });
    }
    await StorageDriver.writeManifest({ workspaces: remaining, activeWorkspaceId: state.activeWorkspaceId === id ? fallback.id : state.activeWorkspaceId });
    setConfirmDelete(null);
  }

  async function handleDuplicate(w: Workspace) {
    const srcData = await StorageDriver.readWorkspace(w.id) ?? emptyWorkspaceData();
    const newId = generateId();
    const newWorkspace: Workspace = {
      ...w,
      id: newId,
      name: `${w.name} (Copy)`,
      createdAt: new Date().toISOString(),
    };
    // Deep-clone ids to avoid shared references
    const clonedData: WorkspaceData = JSON.parse(JSON.stringify(srcData));
    await StorageDriver.writeWorkspace(newId, clonedData);
    dispatch({ type: 'DUPLICATE_WORKSPACE', payload: { workspace: newWorkspace, data: clonedData } });
    await StorageDriver.writeManifest({
      workspaces: [...state.workspaces, newWorkspace],
      activeWorkspaceId: newId,
    });
  }

  function setColor(id: string, color: string) {
    dispatch({ type: 'SET_WORKSPACE_COLOR', payload: { id, color } });
    const updated = state.workspaces.map(w => w.id === id ? { ...w, color } : w);
    StorageDriver.writeManifest({ workspaces: updated, activeWorkspaceId: state.activeWorkspaceId });
  }

  async function handleCreate() {
    const name = newName.trim() || 'New Workspace';
    const newWorkspace: Workspace = {
      id: generateId(),
      name,
      color: PRESET_COLORS[state.workspaces.length % PRESET_COLORS.length],
      createdAt: new Date().toISOString(),
      type: 'local',
    };
    const emptyData = emptyWorkspaceData();
    await StorageDriver.writeWorkspace(newWorkspace.id, emptyData);
    dispatch({ type: 'CREATE_WORKSPACE', payload: newWorkspace });
    await StorageDriver.writeManifest({ workspaces: [...state.workspaces, newWorkspace], activeWorkspaceId: state.activeWorkspaceId });
    setCreating(false);
    setNewName('');
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center mb-3">
        <p className="text-xs text-slate-400">{state.workspaces.length} workspace{state.workspaces.length !== 1 ? 's' : ''}</p>
        <button
          onClick={() => StorageDriver.openDataFolder()}
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
        >
          Open data folder ↗
        </button>
      </div>

      {state.workspaces.map(w => (
        <div
          key={w.id}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
            w.id === state.activeWorkspaceId
              ? 'border-orange-500/40 bg-slate-800/60'
              : 'border-slate-800 bg-slate-800/20 hover:bg-slate-800/40'
          }`}
        >
          {/* Color picker */}
          <div className="flex gap-0.5">
            {PRESET_COLORS.map(c => (
              <button
                key={c}
                onClick={() => setColor(w.id, c)}
                className={`w-3 h-3 rounded-full border transition-transform hover:scale-125 ${(w.color ?? '#f97316') === c ? 'border-white scale-110' : 'border-transparent'}`}
                style={{ background: c }}
              />
            ))}
          </div>

          {/* Name / rename input */}
          <div className="flex-1 min-w-0">
            {editingId === w.id ? (
              <input
                autoFocus
                value={editName}
                onChange={e => setEditName(e.target.value)}
                onBlur={() => commitRename(w.id)}
                onKeyDown={e => { if (e.key === 'Enter') commitRename(w.id); if (e.key === 'Escape') setEditingId(null); }}
                className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-0.5 text-sm text-slate-200 outline-none focus:border-orange-500"
              />
            ) : (
              <button
                onClick={() => handleSwitch(w)}
                className="text-sm font-medium text-slate-200 truncate text-left w-full hover:text-orange-400 transition-colors flex items-center gap-1.5"
              >
                <span className="truncate">{w.name}</span>
                {syncedIds.has(w.id) && (
                  <svg className="w-3.5 h-3.5 text-slate-500 shrink-0" viewBox="0 0 16 16" fill="currentColor" aria-label="Sync configured">
                    <path d="M5 3.5a.5.5 0 1 0-1 0v6.793L2.354 8.646a.5.5 0 1 0-.708.708l2 2a.5.5 0 0 0 .708 0l2-2a.5.5 0 0 0-.708-.708L5 10.293V3.5zM11.5 2a.5.5 0 0 0-.5.5v6.793l-1.646-1.647a.5.5 0 0 0-.708.708l2 2a.5.5 0 0 0 .708 0l2-2a.5.5 0 0 0-.708-.708L12 9.293V2.5a.5.5 0 0 0-.5-.5zM3 1a2 2 0 1 1 4 0A2 2 0 0 1 3 1zm8.5 7a2 2 0 1 1 0 4 2 2 0 0 1 0-4z" />
                  </svg>
                )}
                {w.id === state.activeWorkspaceId && <span className="ml-1 text-[10px] text-orange-400 font-normal shrink-0">active</span>}
                {w.type === 'team' && w.role && <span className="ml-1 text-[10px] text-slate-500 shrink-0">{w.role}</span>}
              </button>
            )}
            <p className="text-[10px] text-slate-600 mt-0.5">{new Date(w.createdAt).toLocaleDateString()}</p>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={() => startRename(w)} title="Rename" className="text-slate-500 hover:text-slate-300 px-1 text-xs transition-colors">✏</button>
            <button onClick={() => handleDuplicate(w)} title="Duplicate" className="text-slate-500 hover:text-slate-300 px-1 text-xs transition-colors">⧉</button>
            <button
              onClick={() => setConfirmDelete(w.id)}
              title="Delete"
              disabled={state.workspaces.length <= 1}
              className="text-slate-500 hover:text-red-400 px-1 text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              🗑
            </button>
          </div>
        </div>
      ))}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="mt-3 p-3 bg-red-950/40 border border-red-800/50 rounded-lg text-xs text-slate-300">
          <p className="mb-2">Delete <strong>{state.workspaces.find(w => w.id === confirmDelete)?.name}</strong>? This cannot be undone.</p>
          <div className="flex gap-2">
            <button onClick={() => handleDelete(confirmDelete)} className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white rounded transition-colors">Delete</button>
            <button onClick={() => setConfirmDelete(null)} className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition-colors">Cancel</button>
          </div>
        </div>
      )}

      {/* New workspace */}
      <div className="pt-1">
        {creating ? (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-orange-500/40 bg-slate-800/40">
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCreate();
                if (e.key === 'Escape') { setCreating(false); setNewName(''); }
              }}
              placeholder="Workspace name"
              className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-0.5 text-sm text-slate-200 outline-none focus:border-orange-500"
            />
            <button onClick={handleCreate} className="px-3 py-1 text-xs bg-orange-500 hover:bg-orange-400 text-white rounded transition-colors font-medium">Create</button>
            <button onClick={() => { setCreating(false); setNewName(''); }} className="text-slate-500 hover:text-slate-300 text-xs px-1 transition-colors">✕</button>
          </div>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-slate-700 text-slate-500 hover:text-slate-300 hover:border-slate-500 transition-colors text-sm"
          >
            <span className="text-base leading-none">+</span>
            New workspace
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Sync Tab ─────────────────────────────────────────────────────────────────

const PROVIDER_LABELS: Record<SyncProvider, string> = {
  s3: 'Amazon S3',
  git: 'Git Repository',
  http: 'HTTP Endpoint',
  team: 'Team Server',
};

const PROVIDER_FIELDS: Record<SyncProvider, { key: string; label: string; placeholder: string; secret?: boolean }[]> = {
  s3: [
    { key: 'bucket', label: 'Bucket', placeholder: 'my-apilix-bucket' },
    { key: 'region', label: 'Region', placeholder: 'us-east-1' },
    { key: 'prefix', label: 'Prefix (optional)', placeholder: 'workspaces/' },
    { key: 'accessKeyId', label: 'Access Key ID', placeholder: 'AKIA...', secret: true },
    { key: 'secretAccessKey', label: 'Secret Access Key', placeholder: '••••••••', secret: true },
  ],
  git: [
    { key: 'remote', label: 'Remote URL', placeholder: 'https://github.com/user/repo.git' },
    { key: 'branch', label: 'Branch', placeholder: 'main' },
    { key: 'username', label: 'Username', placeholder: 'git-user' },
    { key: 'token', label: 'Token / Password', placeholder: 'ghp_...', secret: true },
    { key: 'authorName', label: 'Author Name', placeholder: 'Your Name' },
    { key: 'authorEmail', label: 'Author Email', placeholder: 'you@example.com' },
  ],
  http: [
    { key: 'endpoint', label: 'Endpoint URL', placeholder: 'https://api.example.com/workspaces/prod' },
    { key: 'token', label: 'Bearer Token (optional)', placeholder: 'sk-...', secret: true },
  ],
  team: [
    { key: 'serverUrl', label: 'Server URL', placeholder: 'https://apilix.example.com' },
    { key: 'workspaceServerId', label: 'Server Workspace ID', placeholder: 'ws_...' },
    { key: 'token', label: 'JWT Token', placeholder: 'eyJ...', secret: true },
  ],
};

function SyncTab() {
  const { state, dispatch } = useApp();
  const workspaceId = state.activeWorkspaceId;

  const [provider, setProvider] = useState<SyncProvider>('s3');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [providerDrafts, setProviderDrafts] = useState<Record<SyncProvider, Record<string, string>>>(
    () => ({ s3: {}, git: {}, http: {}, team: {} })
  );
  const [syncMetadata, setSyncMetadata] = useState<SyncMetadata | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [conflict, setConflict] = useState<null | { remoteTimestamp: string; localTimestamp: string | null }>(null);
  const [conflictPackage, setConflictPackage] = useState<ConflictPackage | null>(null);
  const [activity, setActivity] = useState<SyncActivityEntry[]>([]);

  // Load persisted sync config on mount / workspace change
  useEffect(() => {
    let active = true;
    Promise.all([
      StorageDriver.readSyncConfig(workspaceId),
      StorageDriver.readSyncActivity(workspaceId),
    ]).then(([cfg, entries]) => {
      if (!active) return;
      if (cfg) {
        const loadedProvider = cfg.provider as SyncProvider;
        const loadedConfig = cfg.config;
        setProvider(loadedProvider);
        setFields(loadedConfig);
        setProviderDrafts(prev => ({
          ...prev,
          [loadedProvider]: loadedConfig,
        }));
        setSyncMetadata(cfg.metadata ?? (cfg.lastSynced ? { lastSyncedAt: cfg.lastSynced } : undefined));
        setReadOnly(cfg.readOnly === true);
      } else {
        setFields({});
        setSyncMetadata(undefined);
        setReadOnly(false);
      }
      setActivity(entries);
      setLoaded(true);
    });
    return () => { active = false; };
  }, [workspaceId]);

  async function logActivity(action: SyncActivityEntry['action'], level: SyncActivityLevel, message: string, detail?: string) {
    const entry: SyncActivityEntry = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      provider,
      action,
      level,
      message,
      detail,
    };
    setActivity(prev => [entry, ...prev].slice(0, 100));
    await StorageDriver.appendSyncActivity(workspaceId, entry);
  }

  async function saveConfig() {
    await StorageDriver.writeSyncConfig(workspaceId, provider, fields, syncMetadata, readOnly);
    await logActivity('save-config', 'info', 'Sync configuration saved');
    dispatch({ type: 'BUMP_SYNC_CONFIG_VERSION' });
  }

  function getCurrentWorkspaceData(): WorkspaceData {
    return {
      collections: state.collections,
      environments: state.environments,
      activeEnvironmentId: state.activeEnvironmentId,
      collectionVariables: state.collectionVariables,
      globalVariables: state.globalVariables,
      cookieJar: state.cookieJar,
      mockCollections: state.mockCollections,
      mockRoutes: state.mockRoutes,
      mockPort: state.mockPort,
    };
  }

  async function prepareCollectionsForPush(): Promise<typeof state.collections | null> {
    const summary = await getUnsavedRequestTabSummary();
    if (summary.dirtyTabIds.length === 0) return state.collections;

    const confirmed = window.confirm(buildUnsavedRequestTabsConfirmMessage('push', summary));
    if (!confirmed) {
      setStatus('idle');
      setMsg('Push canceled');
      return null;
    }

    const result = await saveExistingRequestTabs(summary.existingDirtyTabIds);
    return result.updatedCollections;
  }

  function setField(key: string, value: string) {
    setFields(prev => {
      const next = { ...prev, [key]: value };
      setProviderDrafts(drafts => ({ ...drafts, [provider]: next }));
      return next;
    });
  }

  function switchProvider(nextProvider: SyncProvider) {
    setProvider(prevProvider => {
      if (prevProvider === nextProvider) return prevProvider;
      setProviderDrafts(drafts => {
        const nextDrafts = {
          ...drafts,
          [prevProvider]: fields,
        };
        setFields(nextDrafts[nextProvider] ?? {});
        return nextDrafts;
      });
      setConflict(null);
      setConflictPackage(null);
      setMsg('');
      setStatus('idle');
      return nextProvider;
    });
  }

  async function handlePush() {
    if (readOnly) return;
    setStatus('busy'); setMsg('Pushing…'); setConflict(null);
    try {
      const syncedCollections = await prepareCollectionsForPush();
      if (!syncedCollections) return;

      await saveConfig();
      const data = { ...getCurrentWorkspaceData(), collections: syncedCollections };
      const cfg: SyncConfig = { workspaceId, provider, config: fields, metadata: syncMetadata };
      await syncPush(cfg, data);
      const remoteState = await getRemoteSyncState(cfg);
      const mergeBaseSnapshotId = await SnapshotEngine.createSnapshot(workspaceId, data, 'sync base after push');
      const nextMetadata: SyncMetadata = {
        ...(syncMetadata ?? {}),
        lastSyncedAt: remoteState.timestamp ?? new Date().toISOString(),
        lastSyncedVersion: remoteState.version ?? syncMetadata?.lastSyncedVersion,
        lastMergeBaseSnapshotId: mergeBaseSnapshotId,
      };
      setSyncMetadata(nextMetadata);
      await StorageDriver.writeSyncConfig(workspaceId, provider, fields, nextMetadata, readOnly);
      await StorageDriver.writeWorkspace(workspaceId, data);
      dispatch({ type: 'SET_SYNC_STATUS', payload: { workspaceId, status: 'idle' } });
      await logActivity('push', 'success', 'Push completed', remoteState.version ? `Version ${remoteState.version.slice(0, 8)}` : undefined);
      setStatus('ok'); setMsg('Pushed successfully');
    } catch (err: unknown) {
      dispatch({ type: 'SET_SYNC_STATUS', payload: { workspaceId, status: 'error' } });
      await logActivity('push', 'error', 'Push failed', (err as Error).message);
      setStatus('error'); setMsg((err as Error).message);
    }
  }

  async function handlePull(resolution?: 'keep-local' | 'keep-remote') {
    setStatus('busy'); setMsg('Pulling…'); setConflict(null); setConflictPackage(null);
    try {
      await saveConfig();
      const cfg: SyncConfig = { workspaceId, provider, config: fields, metadata: syncMetadata };
      const result = await syncPullWithMeta(cfg, resolution);
      const data = result.data;
      if (data) {
        dispatch({ type: 'HYDRATE_WORKSPACE', payload: { ...data, workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId } });
        await StorageDriver.writeWorkspace(workspaceId, data);
        const mergeBaseSnapshotId = await SnapshotEngine.createSnapshot(workspaceId, data, 'sync base after pull');
        const nextMetadata: SyncMetadata = {
          ...(syncMetadata ?? {}),
          lastSyncedAt: result.remoteState.timestamp ?? new Date().toISOString(),
          lastSyncedVersion: result.remoteState.version ?? syncMetadata?.lastSyncedVersion,
          lastMergeBaseSnapshotId: mergeBaseSnapshotId,
        };
        setSyncMetadata(nextMetadata);
        await StorageDriver.writeSyncConfig(workspaceId, provider, fields, nextMetadata, readOnly);
        await logActivity('pull', 'success', 'Pull completed', result.remoteState.version ? `Version ${result.remoteState.version.slice(0, 8)}` : undefined);
        setStatus('ok'); setMsg('Pulled successfully');
      } else {
        await logActivity('pull', 'info', 'Pull completed', 'Remote is empty');
        setStatus('ok'); setMsg('Remote is empty — nothing to pull');
      }
    } catch (err: unknown) {
      if (err instanceof ConflictError) {
        await logActivity('conflict-detected', 'warning', 'Remote conflict detected', err.remoteVersion ? `Version ${err.remoteVersion.slice(0, 8)}` : undefined);
        setStatus('busy'); setMsg('Loading merge data…');
        try {
          const localData = getCurrentWorkspaceData();
          const cfg: SyncConfig = { workspaceId, provider, config: fields, metadata: syncMetadata };
          const pkg = await pullForMerge(cfg, localData);
          await logActivity('merge-opened', 'warning', 'Opened merge review', `${pkg.mergeResult.conflicts.length} conflict(s)`);
          if (pkg.mergeResult.conflicts.length === 0) {
            // No real conflicts — apply the auto-merged result immediately.
            const mergedData = pkg.mergeResult.merged;
            if (localData) await SnapshotEngine.createSnapshot(workspaceId, localData, 'pre-merge backup');
            if (pkg.remoteVersion) {
              await syncApplyMerged(cfg, mergedData, pkg.remoteVersion);
            } else {
              await syncPush(cfg, mergedData);
            }
            const remoteState = await getRemoteSyncState(cfg);
            const mergeBaseSnapshotId = await SnapshotEngine.createSnapshot(workspaceId, mergedData, 'sync base after auto-merge');
            const nextMetadata: SyncMetadata = {
              ...(syncMetadata ?? {}),
              lastSyncedAt: remoteState.timestamp ?? new Date().toISOString(),
              lastSyncedVersion: remoteState.version ?? syncMetadata?.lastSyncedVersion,
              lastMergeBaseSnapshotId: mergeBaseSnapshotId,
            };
            setSyncMetadata(nextMetadata);
            await StorageDriver.writeSyncConfig(workspaceId, provider, fields, nextMetadata, readOnly);
            dispatch({ type: 'HYDRATE_WORKSPACE', payload: { ...mergedData, workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId } });
            await StorageDriver.writeWorkspace(workspaceId, mergedData);
            await logActivity('merge-applied', 'success', 'Auto-merge applied (no manual conflicts)');
            setStatus('ok'); setMsg('Pulled and auto-merged successfully');
          } else {
            setConflictPackage(pkg);
            setStatus('idle'); setMsg('');
          }
        } catch {
          setConflict({ remoteTimestamp: err.remoteLastModified, localTimestamp: err.localLastSaved });
          setStatus('idle'); setMsg('');
        }
      } else {
        dispatch({ type: 'SET_SYNC_STATUS', payload: { workspaceId, status: 'error' } });
        await logActivity('pull', 'error', 'Pull failed', (err as Error).message);
        setStatus('error'); setMsg((err as Error).message);
      }
    }
  }

  async function handleMergeResolved(mergedData: WorkspaceData) {
    if (!conflictPackage) return;
    const currentConflictPackage = conflictPackage;
    setConflictPackage(null);
    setStatus('busy'); setMsg('Applying merge…');
    try {
      const cfg: SyncConfig = { workspaceId, provider, config: fields, metadata: syncMetadata };
      const localData = getCurrentWorkspaceData();
      if (localData) await SnapshotEngine.createSnapshot(workspaceId, localData, 'pre-merge backup');
      if (currentConflictPackage.remoteVersion) {
        await syncApplyMerged(cfg, mergedData, currentConflictPackage.remoteVersion);
      } else {
        await syncPush(cfg, mergedData);
      }
      const remoteState = await getRemoteSyncState(cfg);
      const mergeBaseSnapshotId = await SnapshotEngine.createSnapshot(workspaceId, mergedData, 'sync base after merge apply');
      const nextMetadata: SyncMetadata = {
        ...(syncMetadata ?? {}),
        lastSyncedAt: remoteState.timestamp ?? new Date().toISOString(),
        lastSyncedVersion: remoteState.version ?? syncMetadata?.lastSyncedVersion,
        lastMergeBaseSnapshotId: mergeBaseSnapshotId,
      };
      setSyncMetadata(nextMetadata);
      await StorageDriver.writeSyncConfig(workspaceId, provider, fields, nextMetadata, readOnly);
      dispatch({ type: 'HYDRATE_WORKSPACE', payload: { ...mergedData, workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId } });
      await StorageDriver.writeWorkspace(workspaceId, mergedData);
      await logActivity('merge-applied', 'success', 'Merged workspace applied', remoteState.version ? `Version ${remoteState.version.slice(0, 8)}` : undefined);
      setStatus('ok'); setMsg('Merge applied successfully');
    } catch (err: unknown) {
      if (err instanceof StaleVersionError) {
        setStatus('busy'); setMsg('Remote changed during apply. Rebuilding merge…');
        try {
          const cfg: SyncConfig = { workspaceId, provider, config: fields, metadata: syncMetadata };
          const nextPackage = await rebaseAfterStale(cfg, mergedData, currentConflictPackage.remoteData);
          setConflictPackage(nextPackage);
          await logActivity('merge-stale-rebase', 'warning', 'Remote changed during merge apply', `${nextPackage.mergeResult.conflicts.length} conflict(s) after rebase`);
          setStatus('idle');
          setMsg('Remote changed during apply. Review the updated merge.');
        } catch (rebaseErr: unknown) {
          await logActivity('merge-stale-rebase', 'error', 'Failed to rebuild merge after remote change', (rebaseErr as Error).message);
          setStatus('error');
          setMsg((rebaseErr as Error).message);
        }
        return;
      }
      await logActivity('merge-applied', 'error', 'Merge apply failed', (err as Error).message);
      setStatus('error'); setMsg((err as Error).message);
    }
  }

  async function handleCloneOnce() {
    setStatus('busy'); setMsg('Importing…'); setConflict(null); setConflictPackage(null);
    try {
      const cfg: SyncConfig = { workspaceId, provider, config: fields, metadata: syncMetadata };
      const result = await syncPullWithMeta(cfg);
      const data = result.data;
      if (data) {
        dispatch({ type: 'HYDRATE_WORKSPACE', payload: { ...data, workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId } });
        await StorageDriver.writeWorkspace(workspaceId, data);
        await logActivity('import', 'success', 'Imported remote workspace once');
        setStatus('ok'); setMsg('Imported successfully — config was not saved');
      } else {
        await logActivity('import', 'info', 'Import completed', 'Remote is empty');
        setStatus('ok'); setMsg('Remote is empty — nothing to import');
      }
    } catch (err: unknown) {
      if (err instanceof ConflictError) {
        await logActivity('conflict-detected', 'warning', 'Conflict detected during import');
        setConflict({ remoteTimestamp: err.remoteLastModified, localTimestamp: err.localLastSaved });
        setStatus('idle'); setMsg('');
      } else {
        await logActivity('import', 'error', 'Import failed', (err as Error).message);
        setStatus('error'); setMsg((err as Error).message);
      }
    }
  }

  if (!loaded) return <div className="py-8 text-center text-xs text-slate-500">Loading…</div>;

  return (
    <>
      <div className="space-y-4">
      {/* Provider selector */}
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1.5">Provider</label>
        <div className="flex gap-2 flex-wrap">
          {(Object.keys(PROVIDER_LABELS) as SyncProvider[]).map(p => (
            <button
              key={p}
              onClick={() => switchProvider(p)}
              className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                provider === p
                  ? 'bg-orange-500/20 border-orange-500/50 text-orange-300'
                  : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'
              }`}
            >
              {PROVIDER_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {/* Provider-specific fields */}
      <div className="space-y-2.5">
        {PROVIDER_FIELDS[provider].map(f => (
          <div key={f.key}>
            <label className="block text-[11px] text-slate-500 mb-1">{f.label}</label>
            <input
              type={f.secret ? 'password' : 'text'}
              value={fields[f.key] ?? ''}
              onChange={e => setField(f.key, e.target.value)}
              placeholder={f.placeholder}
              className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-orange-500 placeholder:text-slate-600"
            />
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-slate-500">Provider capabilities</span>
          {syncMetadata?.lastSyncedVersion && (
            <span className="text-[10px] font-mono text-slate-500">
              last version {syncMetadata.lastSyncedVersion.slice(0, 8)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {PROVIDER_CAPABILITIES[provider].map(cap => (
            <span
              key={cap.label}
              className={`px-2 py-1 rounded text-[10px] border ${
                cap.tone === 'success'
                  ? 'bg-green-950/30 border-green-800/40 text-green-300'
                  : 'bg-yellow-950/30 border-yellow-800/40 text-yellow-300'
              }`}
            >
              {cap.label}
            </span>
          ))}
        </div>
      </div>

      {/* Conflict resolution */}
      {conflict && (
        <div className="p-3 bg-yellow-950/40 border border-yellow-700/50 rounded-lg text-xs text-slate-300 space-y-2">
          <p className="font-medium text-yellow-300">Conflict detected</p>
          <p>Remote was last modified: <strong>{new Date(conflict.remoteTimestamp).toLocaleString()}</strong></p>
          {conflict.localTimestamp && <p>Local last synced: <strong>{new Date(conflict.localTimestamp).toLocaleString()}</strong></p>}
          <p className="text-slate-400">Merge data could not be loaded. Choose how to proceed:</p>
          <div className="flex gap-2 pt-1">
            <button onClick={() => handlePull('keep-remote')} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors">Use Remote</button>
            <button onClick={() => handlePull('keep-local')} className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition-colors">Keep Local</button>
          </div>
        </div>
      )}

      {/* Status message */}
      {msg && (
        <p className={`text-xs px-3 py-2 rounded border ${
          status === 'ok' ? 'text-green-300 bg-green-950/30 border-green-800/40' :
          status === 'error' ? 'text-red-300 bg-red-950/30 border-red-800/40' :
          'text-slate-400 bg-slate-800/40 border-slate-700'
        }`}>{msg}</p>
      )}

      {/* Read-only mode */}
      <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-slate-800/40 border border-slate-800">
        <div className="min-w-0">
          <p id="read-only-mode-label" className="text-xs font-medium text-slate-300">Read-only mode</p>
          <p className="text-[10px] text-slate-500 mt-0.5">Pull only — push operations are disabled for this workspace</p>
        </div>
        <button
          type="button"
          onClick={() => setReadOnly(v => !v)}
          className={`relative shrink-0 ml-4 w-9 h-5 rounded-full transition-colors ${readOnly ? 'bg-orange-500' : 'bg-slate-700'}`}
          role="switch"
          aria-checked={readOnly}
          aria-labelledby="read-only-mode-label"
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${readOnly ? 'translate-x-4' : 'translate-x-0'}`} />
        </button>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={handlePush}
          disabled={status === 'busy' || readOnly}
          title={readOnly ? 'Push is disabled in read-only mode' : undefined}
          className="flex-1 py-1.5 text-xs font-medium bg-orange-500 hover:bg-orange-400 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded transition-colors"
        >
          Push ↑
        </button>
        <button
          onClick={() => handlePull()}
          disabled={status === 'busy'}
          className="flex-1 py-1.5 text-xs font-medium bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-200 rounded transition-colors"
        >
          Pull ↓
        </button>
        <button
          onClick={saveConfig}
          disabled={status === 'busy'}
          className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 border border-slate-700 rounded transition-colors"
        >
          Save config
        </button>
      </div>
      {/* One-time import without persisting sync config */}
      <button
        onClick={handleCloneOnce}
        disabled={status === 'busy'}
        className="w-full py-1.5 text-xs text-slate-500 hover:text-slate-300 border border-dashed border-slate-700 hover:border-slate-600 rounded transition-colors disabled:opacity-50"
      >
        Import once (don't save config) ↓
      </button>

      <div className="space-y-2 pt-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-slate-300">Recent sync activity</span>
          <span className="text-[10px] text-slate-500">local telemetry</span>
        </div>
        <div className="max-h-44 overflow-auto rounded-lg border border-slate-800 bg-slate-950/40 divide-y divide-slate-800">
          {activity.length === 0 ? (
            <div className="px-3 py-4 text-xs text-slate-500">No sync activity yet.</div>
          ) : (
            activity.slice(0, 12).map(entry => (
              <div key={entry.id} className="px-3 py-2.5 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      entry.level === 'success' ? 'bg-green-500' :
                      entry.level === 'warning' ? 'bg-yellow-400' :
                      entry.level === 'error' ? 'bg-red-500' :
                      'bg-slate-500'
                    }`} />
                    <span className="text-slate-200 truncate">{entry.message}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-500 shrink-0">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-500">
                  <span className="uppercase tracking-wide">{entry.provider}</span>
                  <span>{entry.action}</span>
                  {entry.detail && <span className="truncate text-slate-400">{entry.detail}</span>}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      </div>

      {conflictPackage && (
        <ConflictMergeModal
          conflictPackage={conflictPackage}
          onResolved={(merged) => handleMergeResolved(merged)}
          onKeepLocal={() => { setConflictPackage(null); handlePull('keep-local'); }}
          onKeepRemote={() => { setConflictPackage(null); handlePull('keep-remote'); }}
          onClose={() => { setConflictPackage(null); }}
        />
      )}
    </>
  );
}

// ─── Team Tab ─────────────────────────────────────────────────────────────────

function TeamTab() {
  const { state, dispatch } = useApp();

  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle');
  const [msg, setMsg] = useState('');

  const activeWorkspace = state.workspaces.find(w => w.id === state.activeWorkspaceId);
  const isTeam = activeWorkspace?.type === 'team';

  useEffect(() => {
    if (isTeam && activeWorkspace.teamServerUrl) {
      setServerUrl(activeWorkspace.teamServerUrl);
    }
  }, [isTeam, activeWorkspace?.teamServerUrl]);

  async function connectTeam() {
    setStatus('busy'); setMsg('Connecting…');
    try {
      const res = await fetch(`${serverUrl}/workspaces`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const body = await res.json() as { workspaces?: unknown[] };
      const count = Array.isArray(body.workspaces) ? body.workspaces.length : 0;
      setStatus('ok');
      setMsg(`Connected — ${count} workspace(s) found on server`);
    } catch (err: unknown) {
      setStatus('error');
      setMsg((err as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs text-slate-400 mb-3">
          Connect to a self-hosted Apilix team server to share collections with role-based access control.
        </p>

        <div className="space-y-2.5">
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Server URL</label>
            <input
              type="text"
              value={serverUrl}
              onChange={e => setServerUrl(e.target.value)}
              placeholder="https://apilix.yourcompany.com"
              className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-orange-500 placeholder:text-slate-600"
            />
          </div>
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">JWT Token</label>
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="eyJ…"
              className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-orange-500 placeholder:text-slate-600"
            />
          </div>
        </div>
      </div>

      {msg && (
        <p className={`text-xs px-3 py-2 rounded border ${
          status === 'ok' ? 'text-green-300 bg-green-950/30 border-green-800/40' :
          status === 'error' ? 'text-red-300 bg-red-950/30 border-red-800/40' :
          'text-slate-400 bg-slate-800/40 border-slate-700'
        }`}>{msg}</p>
      )}

      <button
        onClick={connectTeam}
        disabled={status === 'busy' || !serverUrl || !token}
        className="w-full py-1.5 text-xs font-medium bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-200 rounded transition-colors"
      >
        Test connection
      </button>

      <div className="pt-2 border-t border-slate-800">
        <p className="text-[11px] text-slate-600">
          To start your own team server, deploy the standalone{' '}
          <code className="text-slate-400">apilix-team-server</code> project.
        </p>
      </div>
    </div>
  );
}

// ─── History Tab ──────────────────────────────────────────────────────────────

function HistoryTab() {
  const { state, dispatch } = useApp();
  const workspaceId = state.activeWorkspaceId;

  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const idx = await SnapshotEngine.listHistory(workspaceId);
    setEntries(idx);
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  async function handleRestore(snapshotId: string) {
    setRestoring(snapshotId);
    const snap = await SnapshotEngine.loadSnapshot(workspaceId, snapshotId);
    if (snap) {
      dispatch({ type: 'RESTORE_SNAPSHOT', payload: snap.data });
      await StorageDriver.writeWorkspace(workspaceId, snap.data);
    }
    setRestoring(null);
  }

  if (loading) return <div className="py-8 text-center text-xs text-slate-500">Loading history…</div>;

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center text-slate-500 gap-2">
        <span className="text-3xl">🕑</span>
        <p className="text-sm font-medium text-slate-400">No history yet</p>
        <p className="text-xs max-w-xs">Snapshots are created automatically every time you save. Make a change to the active workspace to start tracking.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-center mb-2">
        <p className="text-xs text-slate-400">{entries.length} snapshot{entries.length !== 1 ? 's' : ''}</p>
        <button onClick={load} className="text-xs text-slate-500 hover:text-slate-300 transition-colors">Refresh</button>
      </div>
      {entries.map(entry => (
        <div key={entry.snapshotId} className="border border-slate-800 rounded-lg overflow-hidden">
          <button
            onClick={() => setExpanded(expanded === entry.snapshotId ? null : entry.snapshotId)}
            className="w-full flex items-center justify-between px-3 py-2 hover:bg-slate-800/40 transition-colors text-left"
          >
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-slate-200 truncate">{entry.summary}</p>
              <p className="text-[10px] text-slate-500 mt-0.5">{new Date(entry.timestamp).toLocaleString()} · {entry.collectionsCount} collection{entry.collectionsCount !== 1 ? 's' : ''}</p>
            </div>
            <span className="text-slate-600 text-xs ml-2">{expanded === entry.snapshotId ? '▲' : '▼'}</span>
          </button>

          {expanded === entry.snapshotId && (
            <div className="px-3 pb-3 pt-0 border-t border-slate-800 bg-slate-900/40">
              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => handleRestore(entry.snapshotId)}
                  disabled={restoring === entry.snapshotId}
                  className="px-3 py-1 text-xs bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-white rounded transition-colors"
                >
                  {restoring === entry.snapshotId ? 'Restoring…' : 'Restore this snapshot'}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptyWorkspaceData(): WorkspaceData {
  return {
    collections: [],
    environments: [],
    activeEnvironmentId: null,
    collectionVariables: {},
    globalVariables: {},
    cookieJar: {},
    mockCollections: [],
    mockRoutes: [],
    mockPort: 3002,
  };
}
