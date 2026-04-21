import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Workspace, WorkspaceData, SyncConfig, SyncProvider, HistoryEntry, SyncMetadata, ConflictPackage, SyncActivityEntry, SyncActivityLevel, SyncExportPackage, SyncSharePolicy, WorkspaceExportPackage } from '../types';
import {
  buildSyncExportPackage,
  parseSyncExportPackage,
  decryptSyncExportConfig,
  downloadJsonFile,
  verifyIntegrityHash as verifySyncIntegrityHash,
} from '../utils/syncExportUtils';
import {
  buildWorkspaceExportPackage,
  parseWorkspaceExportPackage,
  isWorkspaceExportPackage,
} from '../utils/workspaceExportUtils';
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
  testConnection as syncTestConnection,
} from '../utils/syncEngine';
import * as SnapshotEngine from '../utils/snapshotEngine';
import ConflictMergeModal from './ConflictMergeModal';
import ConfirmModal from './ConfirmModal';

type Tab = 'workspaces' | 'sync' | 'history';

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
  minio: [
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
  const visibleTabs: Tab[] = ['workspaces', 'sync', 'history'];
  const [modalDragging, setModalDragging] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);

  useEffect(() => {
    if (!visibleTabs.includes(activeTab)) {
      setActiveTab('workspaces');
    }
  }, [activeTab, visibleTabs]);

  function handleModalDragOver(e: React.DragEvent) {
    if (activeTab !== 'workspaces') return;
    e.preventDefault();
    setModalDragging(true);
  }

  function handleModalDragLeave(e: React.DragEvent) {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setModalDragging(false);
  }

  function handleModalDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setModalDragging(false);
    if (activeTab !== 'workspaces') return;
    const file = e.dataTransfer.files[0];
    if (file) setDroppedFile(file);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        className="relative bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-[640px] max-h-[80vh] flex flex-col overflow-hidden"
        onDragOver={handleModalDragOver}
        onDragLeave={handleModalDragLeave}
        onDrop={handleModalDrop}
      >
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
        <div className="flex-1 overflow-y-auto p-4" data-workspaces-scroll>
          {activeTab === 'workspaces' && <WorkspacesTab onClose={onClose} />}
          {activeTab === 'sync' && <SyncTab />}
          {activeTab === 'history' && <HistoryTab />}
        </div>
        {activeTab === 'workspaces' && (
          <ImportPanel
            droppedFile={droppedFile}
            onDropConsumed={() => setDroppedFile(null)}
          />
        )}

        {/* Full-modal drag overlay */}
        {activeTab === 'workspaces' && modalDragging && (
          <div className="absolute inset-0 rounded-xl z-50 flex flex-col items-center justify-center gap-3 bg-slate-900/90 border-2 border-dashed border-orange-500/60 pointer-events-none">
            <span className="text-4xl leading-none text-orange-400">↓</span>
            <p className="text-sm font-medium text-orange-300">Drop to import</p>
            <p className="text-xs text-slate-400">Workspace export or sync config</p>
          </div>
        )}
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
  const [confirmClear, setConfirmClear] = useState<string | null>(null);
  const [syncedIds, setSyncedIds] = useState<Set<string>>(new Set());
  const [sharingLockedExportIds, setSharingLockedExportIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [exportError, setExportError] = useState('');
  const [confirmExportSecrets, setConfirmExportSecrets] = useState<Workspace | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    StorageDriver.readSyncConfigStore().then(store => {
      const nextSyncedIds = new Set<string>();
      const nextSharingLockedExportIds = new Set<string>();
      Object.keys(store).forEach(id => {
        const cfg = store[id];
        if (cfg?.provider) nextSyncedIds.add(id);
        if (cfg?.isShared === true && cfg?.sharePolicy?.sharingEnabled === false) {
          nextSharingLockedExportIds.add(id);
        }
      });
      setSyncedIds(nextSyncedIds);
      setSharingLockedExportIds(nextSharingLockedExportIds);
    });
  }, [state.workspaces, state.syncConfigVersion]);

  useEffect(() => {
    if (!openMenuId) return;
    function closeMenu() { setOpenMenuId(null); setMenuRect(null); }
    function handleOutside(e: MouseEvent) {
      const target = e.target as Node;
      const menus = document.querySelectorAll('[data-workspace-menu]');
      for (const el of menus) {
        if (el.contains(target)) return;
      }
      closeMenu();
    }
    document.addEventListener('mousedown', handleOutside);
    // Close if the scroll container scrolls (menu would drift from anchor)
    const scrollEl = document.querySelector('[data-workspaces-scroll]');
    scrollEl?.addEventListener('scroll', closeMenu);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      scrollEl?.removeEventListener('scroll', closeMenu);
    };
  }, [openMenuId]);

  async function doSwitch(workspace: Workspace): Promise<boolean> {
    if (workspace.id === state.activeWorkspaceId) return false;
    const { decision, summary } = await requestWorkspaceSwitchGuard();
    if (decision === 'cancel') return false;
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
    return true;
  }

  async function handleSwitch(workspace: Workspace) {
    await doSwitch(workspace);
  }

  async function handleSwitchAndClose(workspace: Workspace) {
    const switched = await doSwitch(workspace);
    if (switched) onClose();
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

  async function handleClearCollections(id: string) {
    const existing = await StorageDriver.readWorkspace(id) ?? emptyWorkspaceData();
    const cleared: WorkspaceData = {
      ...existing,
      collections: [],
      collectionVariables: {},
    };
    await StorageDriver.writeWorkspace(id, cleared);
    if (state.activeWorkspaceId === id) {
      dispatch({ type: 'CLEAR_WORKSPACE_COLLECTIONS' });
    }
    setConfirmClear(null);
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
    // Deep-clone data to avoid shared references
    const clonedData: WorkspaceData = JSON.parse(JSON.stringify(srcData));
    await StorageDriver.writeWorkspace(newId, clonedData);

    const copiedSyncConfig = await cloneWorkspaceSyncConfig(w.id, newId);

    dispatch({ type: 'DUPLICATE_WORKSPACE', payload: { workspace: newWorkspace, data: clonedData } });
    if (copiedSyncConfig) {
      dispatch({ type: 'BUMP_SYNC_CONFIG_VERSION' });
    }
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

  async function doExportWorkspace(w: Workspace) {
    let data: WorkspaceData;
    if (w.id === state.activeWorkspaceId) {
      data = {
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
    } else {
      try {
        data = await StorageDriver.readWorkspace(w.id) ?? {
          collections: [], environments: [], activeEnvironmentId: null,
          collectionVariables: {}, globalVariables: {}, cookieJar: {},
          mockCollections: [], mockRoutes: [], mockPort: 3002,
        };
      } catch (err: unknown) {
        setExportError(`Failed to read workspace data: ${(err as Error).message}`);
        return;
      }
    }
    const pkg = buildWorkspaceExportPackage(w.name, w.id, data);
    const safeName = w.name.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    downloadJsonFile(`apilix-workspace-${safeName}.json`, pkg);
  }

  async function handleExportWorkspace(w: Workspace) {
    // Check whether this workspace contains any secret-flagged env variables.
    // If so, ask the user to confirm — the exported file will contain plaintext values.
    let envs: WorkspaceData['environments'];
    if (w.id === state.activeWorkspaceId) {
      envs = state.environments;
    } else {
      try {
        const data = await StorageDriver.readWorkspace(w.id);
        envs = data?.environments ?? [];
      } catch {
        envs = [];
      }
    }
    const hasSecrets = envs.some(env => env.values.some(v => v.secret));
    if (hasSecrets) {
      setConfirmExportSecrets(w);
      return;
    }
    await doExportWorkspace(w);
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
          role="button"
          tabIndex={0}
          onClick={() => handleSwitch(w)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSwitch(w); } }}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors cursor-pointer ${
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
                onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commitRename(w.id); if (e.key === 'Escape') setEditingId(null); }}
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
            <p className="text-[10px] text-slate-600 mt-0.5">
              {new Date(w.createdAt).toLocaleDateString()}
              {w.id === state.activeWorkspaceId && (
                <span className="ml-2 font-mono text-slate-600 select-all">{w.id}</span>
              )}
            </p>
          </div>

          {/* Actions dropdown */}
          <div
            className="relative shrink-0"
            data-workspace-menu="true"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={e => {
                if (openMenuId === w.id) { setOpenMenuId(null); setMenuRect(null); return; }
                setMenuRect((e.currentTarget as HTMLElement).getBoundingClientRect());
                setOpenMenuId(w.id);
              }}
              aria-label="Workspace actions"
              aria-expanded={openMenuId === w.id}
              aria-haspopup="menu"
              onKeyDown={e => { if (e.key === 'Escape') { setOpenMenuId(null); setMenuRect(null); } }}
              className="flex items-center justify-center w-7 h-7 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700/60 transition-colors text-sm font-bold tracking-widest"
            >
              ···
            </button>

            {openMenuId === w.id && menuRect && createPortal(
              <div
                data-workspace-menu="true"
                role="menu"
                style={{
                  position: 'fixed',
                  right: window.innerWidth - menuRect.right,
                  ...(window.innerHeight - menuRect.bottom >= 220
                    ? { top: menuRect.bottom + 4 }
                    : { bottom: window.innerHeight - menuRect.top + 4 }),
                  zIndex: 9999,
                }}
                className="min-w-[210px] bg-slate-800 border border-slate-700 rounded-lg shadow-2xl py-1 text-xs"
                onKeyDown={e => { if (e.key === 'Escape') { setOpenMenuId(null); setMenuRect(null); } }}
              >
                {w.id !== state.activeWorkspaceId && (
                  <button
                    role="menuitem"
                    onClick={() => { setOpenMenuId(null); handleSwitchAndClose(w); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-slate-300 hover:bg-slate-700/60 hover:text-orange-300 transition-colors"
                  >
                    <span className="w-4 shrink-0 text-center">↵</span>
                    Switch to workspace and close
                  </button>
                )}

                <button
                  role="menuitem"
                  onClick={() => { setOpenMenuId(null); startRename(w); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-slate-300 hover:bg-slate-700/60 hover:text-slate-100 transition-colors"
                >
                  <span className="w-4 shrink-0 text-center">✏</span>
                  Rename
                </button>

                <button
                  role="menuitem"
                  onClick={() => { setOpenMenuId(null); handleDuplicate(w); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-slate-300 hover:bg-slate-700/60 hover:text-slate-100 transition-colors"
                >
                  <span className="w-4 shrink-0 text-center">⧉</span>
                  Duplicate
                </button>

                {!sharingLockedExportIds.has(w.id) && (
                  <button
                    role="menuitem"
                    onClick={() => { setOpenMenuId(null); handleExportWorkspace(w); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-slate-300 hover:bg-slate-700/60 hover:text-slate-100 transition-colors"
                  >
                    <span className="w-4 shrink-0 text-center">⬇</span>
                    Export workspace data
                  </button>
                )}

                <div className="border-t border-slate-700 my-1" />

                <button
                  role="menuitem"
                  onClick={() => { setOpenMenuId(null); setConfirmDelete(null); setConfirmClear(w.id); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-slate-300 hover:bg-slate-700/60 hover:text-orange-400 transition-colors"
                >
                  <span className="w-4 shrink-0 text-center">⊘</span>
                  Delete all collections
                </button>

                <button
                  role="menuitem"
                  onClick={() => { setOpenMenuId(null); setConfirmClear(null); setConfirmDelete(w.id); }}
                  disabled={state.workspaces.length <= 1}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-slate-300 hover:bg-slate-700/60 hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <span className="w-4 shrink-0 text-center">🗑</span>
                  Delete workspace
                </button>
              </div>,
              document.body
            )}
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

      {/* Empty workspace confirmation */}
      {confirmClear && (
        <div className="mt-3 p-3 bg-red-950/40 border border-red-800/50 rounded-lg text-xs text-slate-300">
          <p className="mb-2">Remove all collections from <strong>{state.workspaces.find(w => w.id === confirmClear)?.name}</strong>? This cannot be undone.</p>
          <div className="flex gap-2">
            <button onClick={() => handleClearCollections(confirmClear)} className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white rounded transition-colors">Empty workspace</button>
            <button onClick={() => setConfirmClear(null)} className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition-colors">Cancel</button>
          </div>
        </div>
      )}

      {/* Export secret-variables confirmation */}
      {confirmExportSecrets && (
        <div className="mt-3 p-3 bg-yellow-950/40 border border-yellow-700/50 rounded-lg text-xs text-slate-300">
          <p className="mb-1 font-medium text-yellow-400">⚠ Export contains secret variables</p>
          <p className="mb-2 text-slate-400">
            This workspace has environment variables marked as secret. The exported file will contain their values in <strong>plain text</strong> — anyone with the file can read them.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => { const w = confirmExportSecrets; setConfirmExportSecrets(null); doExportWorkspace(w); }}
              className="px-3 py-1 bg-yellow-600 hover:bg-yellow-500 text-white rounded transition-colors"
            >
              Export anyway
            </button>
            <button
              onClick={() => setConfirmExportSecrets(null)}
              className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Export error */}
      {exportError && (
        <div className="mt-2 flex items-start gap-2 px-3 py-2 bg-red-950/40 border border-red-800/50 rounded-lg text-xs text-red-400">
          <span className="flex-1">{exportError}</span>
          <button onClick={() => setExportError('')} className="text-red-400/60 hover:text-red-300 shrink-0 leading-none" aria-label="Dismiss">✕</button>
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

// ─── Import Panel (fixed footer of the workspaces tab) ───────────────────────

type ImportCandidate =
  | { kind: 'workspace'; pkg: WorkspaceExportPackage }
  | { kind: 'sync';      pkg: SyncExportPackage };

interface ImportPanelProps {
  droppedFile: File | null;
  onDropConsumed: () => void;
}

function ImportPanel({ droppedFile, onDropConsumed }: ImportPanelProps) {
  const { state, dispatch } = useApp();
  const [candidate, setCandidate] = useState<ImportCandidate | null>(null);
  const [importPassphrase, setImportPassphrase] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setError('');
    setSuccess('');
    setCandidate(null);
    setImportPassphrase('');
    try {
      const raw = JSON.parse(await file.text());
      if (isWorkspaceExportPackage(raw)) {
        setCandidate({ kind: 'workspace', pkg: parseWorkspaceExportPackage(raw) });
      } else if (
        raw &&
        typeof raw === 'object' &&
        !Array.isArray(raw) &&
        (raw as Record<string, unknown>).apilixSyncExport !== undefined
      ) {
        setCandidate({ kind: 'sync', pkg: parseSyncExportPackage(raw) });
      } else {
        throw new Error('Unrecognized file format. Select a file exported from Apilix (workspace data or sync config).');
      }
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    if (droppedFile) {
      handleFile(droppedFile);
      onDropConsumed();
    }
  }, [droppedFile]);

  async function handleWorkspaceImportConfirm() {
    if (!candidate || candidate.kind !== 'workspace') return;
    const pkg = candidate.pkg;
    setError('');
    if (state.workspaces.some(w => w.id === pkg.workspaceId)) {
      setError('A workspace with this ID already exists.');
      return;
    }
    const newWorkspace: Workspace = {
      id: pkg.workspaceId,
      name: pkg.workspaceName,
      color: PRESET_COLORS[state.workspaces.length % PRESET_COLORS.length],
      createdAt: new Date().toISOString(),
      type: 'local',
    };
    await StorageDriver.writeWorkspace(newWorkspace.id, pkg.data);
    dispatch({ type: 'DUPLICATE_WORKSPACE', payload: { workspace: newWorkspace, data: pkg.data } });
    await StorageDriver.writeManifest({ workspaces: [...state.workspaces, newWorkspace], activeWorkspaceId: state.activeWorkspaceId });
    const colCount = pkg.data.collections.length;
    const envCount = pkg.data.environments.length;
    setCandidate(null);
    setSuccess(`Workspace "${newWorkspace.name}" imported with ${colCount} collection(s) and ${envCount} environment(s).`);
  }

  async function handleSyncImportConfirm() {
    if (!candidate || candidate.kind !== 'sync') return;
    const pkg = candidate.pkg;
    setError('');

    // Verify HMAC integrity of the sharing policy (if present)
    let config: Record<string, string>;
    try {
      config = pkg.encrypted
        ? await decryptSyncExportConfig(pkg, importPassphrase)
        : { ...pkg.config };
    } catch (err: unknown) {
      setError((err as Error).message);
      return;
    }

    if (pkg.integrityHash && pkg.sharePolicy && pkg.salt) {
      const passphrase = importPassphrase || config._remotePassphrase || '';
      try {
        const valid = await verifySyncIntegrityHash(
          pkg.sharePolicy,
          pkg.remoteWorkspaceId,
          passphrase,
          pkg.salt,
          pkg.integrityHash,
        );
        if (!valid) {
          setError('Integrity check failed — the sharing policy may have been tampered with.');
          return;
        }
      } catch {
        setError('Integrity check failed — could not verify the package.');
        return;
      }
    }

    // Extract the embedded remote passphrase (if any)
    const remotePassphrase = config._remotePassphrase;
    delete config._remotePassphrase;

    // Enforce forceReadOnly from the package's sharing policy
    const isShared = !!(pkg.sharePolicy);
    const sharePolicy = pkg.sharePolicy;
    const forceReadOnly = sharePolicy?.forceReadOnly === true;

    const newWorkspace: Workspace = {
      id: generateId(),
      name: pkg.workspaceName,
      color: PRESET_COLORS[state.workspaces.length % PRESET_COLORS.length],
      createdAt: new Date().toISOString(),
      type: 'local',
    };
    const emptyData = emptyWorkspaceData();
    await StorageDriver.writeWorkspace(newWorkspace.id, emptyData);
    await StorageDriver.writeSyncConfig(newWorkspace.id, pkg.provider, config, undefined, forceReadOnly, {
      encryptRemote: pkg.remoteEncryption?.enabled,
      remotePassphrase,
      isShared,
      sharePolicy,
      importedEncrypted: pkg.encrypted || undefined,
    });
    dispatch({ type: 'CREATE_WORKSPACE', payload: newWorkspace });
    await StorageDriver.writeManifest({ workspaces: [...state.workspaces, newWorkspace], activeWorkspaceId: state.activeWorkspaceId });
    dispatch({ type: 'BUMP_SYNC_CONFIG_VERSION' });
    setCandidate(null);
    setImportPassphrase('');
    setSuccess(`Workspace "${newWorkspace.name}" created. Switch to it, then open the Sync tab and click Pull ↓ to load data from ${pkg.provider.toUpperCase()}.`);
  }

  return (
    <div className="px-4 pb-4 border-t border-slate-800 bg-slate-900">
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (fileRef.current) fileRef.current.value = ''; if (f) handleFile(f); }}
      />

      {!candidate ? (
        <div
          role="button"
          tabIndex={0}
          aria-label="Import workspace file — click to browse or drag a file here"
          onClick={() => { setError(''); fileRef.current?.click(); }}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
          className="mt-3 flex items-center justify-center gap-2 px-3 py-3 rounded-lg border border-dashed border-slate-700 text-slate-500 hover:text-slate-300 hover:border-slate-500 transition-colors cursor-pointer select-none"
        >
          <span className="text-base leading-none">↑</span>
          <span className="text-sm">Import workspace file</span>
        </div>
      ) : candidate.kind === 'workspace' ? (
        <div className="mt-3 p-3 bg-slate-800/60 border border-slate-700 rounded-lg space-y-3">
          <div className="space-y-1">
            <p className="text-xs font-medium text-slate-200">{candidate.pkg.workspaceName}</p>
            <p className="text-[10px] text-slate-500">
              Exported: <span className="text-slate-300">{new Date(candidate.pkg.exportedAt).toLocaleString()}</span>
              {' · '}
              <span className="text-slate-300">{candidate.pkg.data.collections.length}</span> collections
              {' · '}
              <span className="text-slate-300">{candidate.pkg.data.environments.length}</span> environments
            </p>
          </div>
          {error && <p className="text-xs text-red-400 bg-red-950/30 border border-red-800/40 rounded px-2 py-1.5">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleWorkspaceImportConfirm}
              className="flex-1 py-1.5 text-xs font-medium bg-orange-600 hover:bg-orange-500 text-white rounded transition-colors"
            >
              Import workspace
            </button>
            <button
              onClick={() => { setCandidate(null); setError(''); }}
              className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 p-3 bg-slate-800/60 border border-slate-700 rounded-lg space-y-3">
          <div className="space-y-1">
            <p className="text-xs font-medium text-slate-200">{candidate.pkg.workspaceName}</p>
            <p className="text-[10px] text-slate-500">
              Provider: <span className="text-slate-300">{candidate.pkg.provider.toUpperCase()}</span>
              {' · '}Remote ID: <span className="font-mono text-slate-400">{candidate.pkg.remoteWorkspaceId.slice(0, 12)}…</span>
              {candidate.pkg.encrypted && <span className="ml-1 text-yellow-400"> 🔒 encrypted</span>}
            </p>
          </div>
          {candidate.pkg.encrypted && (
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Passphrase</label>
              <input
                type="password"
                autoFocus
                value={importPassphrase}
                onChange={e => setImportPassphrase(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSyncImportConfirm(); }}
                placeholder="Enter the passphrase used during export"
                className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-orange-500 placeholder:text-slate-600"
              />
            </div>
          )}
          {error && <p className="text-xs text-red-400 bg-red-950/30 border border-red-800/40 rounded px-2 py-1.5">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleSyncImportConfirm}
              className="flex-1 py-1.5 text-xs font-medium bg-orange-600 hover:bg-orange-500 text-white rounded transition-colors"
            >
              Create workspace
            </button>
            <button
              onClick={() => { setCandidate(null); setImportPassphrase(''); setError(''); }}
              className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && !candidate && (
        <p className="mt-2 text-xs text-red-400 bg-red-950/30 border border-red-800/40 rounded px-3 py-2">{error}</p>
      )}
      {success && (
        <p className="mt-2 text-xs text-green-300 bg-green-950/30 border border-green-800/40 rounded px-3 py-2">{success}</p>
      )}
    </div>
  );
}

export async function cloneWorkspaceSyncConfig(sourceWorkspaceId: string, targetWorkspaceId: string): Promise<boolean> {
  // Carry over provider, credentials, and readOnly — but omit metadata:
  // lastMergeBaseSnapshotId references snapshots owned by the source workspace,
  // and lastSyncedAt/lastSyncedVersion would be misleading on a brand-new copy.
  const srcSync = await StorageDriver.readSyncConfig(sourceWorkspaceId);
  if (!srcSync) return false;

  await StorageDriver.writeSyncConfig(
    targetWorkspaceId,
    srcSync.provider,
    srcSync.config,
    undefined,
    srcSync.readOnly,
    {
      encryptRemote: srcSync.encryptRemote,
      remotePassphrase: srcSync.remotePassphrase,
      isShared: srcSync.isShared,
      sharePolicy: srcSync.sharePolicy,
      importedEncrypted: srcSync.importedEncrypted,
    },
  );
  return true;
}

// ─── Export Panel (sub-component used by SyncTab) ────────────────────────────

interface ExportPanelProps {
  workspaceId: string;
  provider: SyncProvider;
  fields: Record<string, string>;
  workspaceName: string;
  exportEncrypt: boolean;
  setExportEncrypt: (v: boolean) => void;
  exportPassphrase: string;
  setExportPassphrase: (v: string) => void;
  exportStatus: string;
  setExportStatus: (v: string) => void;
  // Sharing policy options
  encryptRemote: boolean;
  inheritedPassphrase: string;
  isShared: boolean;
  /** Sharing policy from the original import. forceReadOnly is locked when present and true. */
  inheritedSharePolicy?: SyncSharePolicy;
  /** True when this workspace was imported from a passphrase-encrypted share package. */
  importedEncrypted: boolean;
}

function ExportPanel({
  workspaceId, provider, fields, workspaceName,
  exportEncrypt, setExportEncrypt,
  exportPassphrase, setExportPassphrase,
  exportStatus, setExportStatus,
  encryptRemote, inheritedPassphrase, isShared, inheritedSharePolicy, importedEncrypted,
}: ExportPanelProps) {
  const [forceReadOnly, setForceReadOnly] = useState(false);
  const [sharingEnabled, setSharingEnabled] = useState(true);

  // Package encryption is mandatory when the original import was encrypted.
  const requiresEncryption = importedEncrypted;
  const effectiveEncrypt = requiresEncryption || exportEncrypt;

  // forceReadOnly is locked when the inherited policy requires it.
  const forcedReadOnly = isShared && inheritedSharePolicy?.forceReadOnly === true;

  async function handleDownload() {
    setExportStatus('');
    const passphrase = effectiveEncrypt ? exportPassphrase.trim() : undefined;
    if (effectiveEncrypt && !passphrase) {
      setExportStatus(requiresEncryption
        ? 'A passphrase is required — credentials were encrypted when imported.'
        : 'Enter a passphrase, or uncheck the encryption option.');
      return;
    }

    const sharePolicy: SyncSharePolicy | undefined = { forceReadOnly: forcedReadOnly ? true : forceReadOnly, sharingEnabled };

    // Always embed the remote passphrase when remote encryption is configured
    const remotePassphrase = (encryptRemote && inheritedPassphrase) ? inheritedPassphrase : undefined;

    const configWithId = { ...fields, remoteWorkspaceId: workspaceId };
    const pkg = await buildSyncExportPackage(workspaceName, provider, configWithId, passphrase, {
      sharePolicy,
      remotePassphrase,
    });
    const safeName = workspaceName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    downloadJsonFile(`apilix-sync-${safeName}.json`, pkg);
    setExportPassphrase('');
    setExportStatus('Downloaded.');
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          id={`export-encrypt-${workspaceId}`}
          type="checkbox"
          checked={requiresEncryption ? true : exportEncrypt}
          onChange={e => { if (!requiresEncryption) setExportEncrypt(e.target.checked); }}
          disabled={requiresEncryption}
          className="accent-orange-500 cursor-pointer disabled:cursor-not-allowed"
        />
        <label htmlFor={`export-encrypt-${workspaceId}`} className="text-xs text-slate-300 cursor-pointer">
          Encrypt credentials with a passphrase{' '}
          {requiresEncryption
            ? <span className="text-orange-400">(required — credentials were encrypted when imported)</span>
            : <span className="text-slate-500">(recommended)</span>}
        </label>
      </div>

      {effectiveEncrypt && (
        <div>
          <label className="block text-[11px] text-slate-500 mb-1">Passphrase</label>
          <input
            type="password"
            value={exportPassphrase}
            onChange={e => setExportPassphrase(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleDownload(); }}
            placeholder="Secret passphrase for the recipient"
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-orange-500 placeholder:text-slate-600"
          />
        </div>
      )}
      {!effectiveEncrypt && (
        <p className="text-[10px] text-yellow-400 bg-yellow-950/30 border border-yellow-800/40 rounded px-2 py-1.5">
          ⚠ Credentials will be stored in plaintext in the exported file.
        </p>
      )}

      {/* Sharing policy */}
      <div className="border-t border-slate-700 pt-2.5 space-y-2">
        <p className="text-[11px] text-slate-400 font-medium">Sharing policy</p>
        <div className="flex items-center gap-2">
          <input
            id={`export-readonly-${workspaceId}`}
            type="checkbox"
            checked={forcedReadOnly ? true : forceReadOnly}
            onChange={e => { if (!forcedReadOnly) setForceReadOnly(e.target.checked); }}
            disabled={forcedReadOnly}
            className="accent-orange-500 cursor-pointer disabled:cursor-not-allowed"
          />
          <label htmlFor={`export-readonly-${workspaceId}`} className="text-xs text-slate-300 cursor-pointer">
            Force read-only{' '}
            {forcedReadOnly
              ? <span className="text-orange-400">(required — inherited from original owner)</span>
              : <span className="text-slate-500">(recipient can only pull)</span>}
          </label>
        </div>
        <div className="flex items-center gap-2">
          <input
            id={`export-sharing-${workspaceId}`}
            type="checkbox"
            checked={sharingEnabled}
            onChange={e => setSharingEnabled(e.target.checked)}
            className="accent-orange-500 cursor-pointer"
          />
          <label htmlFor={`export-sharing-${workspaceId}`} className="text-xs text-slate-300 cursor-pointer">
            Sharing enabled <span className="text-slate-500">(un-check to revoke future shares)</span>
          </label>
        </div>
      </div>

      {/* Remote passphrase is always embedded when remote encryption is configured */}
      {encryptRemote && inheritedPassphrase && (
        <div className="border-t border-slate-700 pt-2.5">
          <p className="text-[10px] text-slate-400 bg-slate-800/60 border border-slate-700 rounded px-2 py-1.5">
            Remote encryption passphrase will be embedded in this package.
          </p>
          {!exportEncrypt && (
            <p className="text-[10px] text-red-400 bg-red-950/30 border border-red-800/40 rounded px-2 py-1.5 mt-1.5">
              ⚠ Enable package encryption — otherwise the remote passphrase will be stored in plaintext.
            </p>
          )}
        </div>
      )}

      {isShared && (
        <p className="text-[10px] text-sky-400 bg-sky-950/20 border border-sky-800/30 rounded px-2 py-1">
          This workspace was imported from a share package. Settings are managed by the original owner.
        </p>
      )}

      {exportStatus && (
        <p className="text-[10px] text-green-400">{exportStatus}</p>
      )}
      <button
        onClick={handleDownload}
        disabled={effectiveEncrypt && !exportPassphrase.trim()}
        className="w-full py-1.5 text-xs font-medium bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed text-slate-200 rounded transition-colors"
      >
        Download JSON ↓
      </button>
    </div>
  );
}

// ─── Sync Tab ─────────────────────────────────────────────────────────────────

const PROVIDER_LABELS: Record<SyncProvider, string> = {
  s3: 'S3 Storage',
  minio: 'MinIO (legacy)', // not shown in UI; kept for Record<SyncProvider,…> type coverage
  git: 'Git Repository',
  http: 'HTTP Endpoint',
  team: 'Team Server',
};

// All providers shown in Electron. Browser mode hides providers that require
// Electron IPC (S3/MinIO presigned URLs) or a local git binary (Git).
const ELECTRON_ONLY_PROVIDERS: SyncProvider[] = ['s3', 'git'];
const VISIBLE_PROVIDERS: SyncProvider[] = ['s3', 'git', 'http', 'team'];

const PROVIDER_FIELDS: Record<SyncProvider, { key: string; label: string; placeholder: string; secret?: boolean }[]> = {
  s3: [
    { key: 'endpoint', label: 'Endpoint URL (optional — leave blank for AWS S3)', placeholder: 'http://localhost:9000' },
    { key: 'bucket', label: 'Bucket', placeholder: 'my-apilix-bucket' },
    { key: 'region', label: 'Region (optional)', placeholder: 'us-east-1' },
    { key: 'prefix', label: 'Prefix (optional)', placeholder: 'workspaces/' },
    { key: 'accessKeyId', label: 'Access Key ID', placeholder: 'AKIA...', secret: true },
    { key: 'secretAccessKey', label: 'Secret Access Key', placeholder: '••••••••', secret: true },
  ],
  // minio fields kept for type coverage; minio configs are migrated to s3 on load.
  minio: [
    { key: 'endpoint', label: 'Endpoint URL', placeholder: 'http://localhost:9000' },
    { key: 'bucket', label: 'Bucket', placeholder: 'apilix' },
    { key: 'region', label: 'Region (optional)', placeholder: 'us-east-1' },
    { key: 'prefix', label: 'Prefix (optional)', placeholder: 'workspaces/' },
    { key: 'accessKeyId', label: 'Access Key', placeholder: 'minioadmin', secret: true },
    { key: 'secretAccessKey', label: 'Secret Key', placeholder: '••••••••', secret: true },
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
  const isBrowserMode = !(window as { electronAPI?: unknown }).electronAPI;

  const [provider, setProvider] = useState<SyncProvider>(isBrowserMode ? 'http' : 's3');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [providerDrafts, setProviderDrafts] = useState<Record<SyncProvider, Record<string, string>>>(
    () => ({ s3: {}, minio: {}, git: {}, http: {}, team: {} })
  );
  const [syncMetadata, setSyncMetadata] = useState<SyncMetadata | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [encryptRemote, setEncryptRemote] = useState(false);
  const [remotePassphrase, setRemotePassphrase] = useState('');
  const [showRemotePassphrase, setShowRemotePassphrase] = useState(false);
  const [isShared, setIsShared] = useState(false);
  const [sharePolicy, setSharePolicy] = useState<SyncSharePolicy | undefined>(undefined);
  const [importedEncrypted, setImportedEncrypted] = useState(false);
  const [conflict, setConflict] = useState<null | { remoteTimestamp: string; localTimestamp: string | null }>(null);
  const [conflictPackage, setConflictPackage] = useState<ConflictPackage | null>(null);
  const [activity, setActivity] = useState<SyncActivityEntry[]>([]);
  const [pendingPushConfirm, setPendingPushConfirm] = useState<{ message: string; resolve: (v: boolean) => void } | null>(null);
  const [pendingEmptyPushConfirm, setPendingEmptyPushConfirm] = useState<{ resolve: (v: boolean) => void } | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [exportEncrypt, setExportEncrypt] = useState(true);
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [exportStatus, setExportStatus] = useState('');

  // Reset export panel when active workspace changes
  useEffect(() => { setShowExport(false); setExportPassphrase(''); setExportStatus(''); }, [workspaceId]);

  // Load persisted sync config on mount / workspace change
  useEffect(() => {
    let active = true;
    Promise.all([
      StorageDriver.readSyncConfig(workspaceId),
      StorageDriver.readSyncActivity(workspaceId),
    ]).then(([cfg, entries]) => {
      if (!active) return;
      if (cfg) {
        // Migrate legacy 'minio' provider to 's3' — the unified adapter accepts
        // the 'endpoint' field for S3-compatible services.
        const loadedProvider: SyncProvider = cfg.provider === 'minio' ? 's3' : cfg.provider as SyncProvider;
        const loadedConfig = cfg.config;
        setProvider(loadedProvider);
        setFields(loadedConfig);
        setProviderDrafts(prev => ({
          ...prev,
          [loadedProvider]: loadedConfig,
        }));
        setSyncMetadata(cfg.metadata ?? (cfg.lastSynced ? { lastSyncedAt: cfg.lastSynced } : undefined));
        setReadOnly(cfg.readOnly === true);
        setEncryptRemote(cfg.encryptRemote === true);
        setRemotePassphrase(cfg.remotePassphrase ?? '');
        setIsShared(cfg.isShared === true);
        setSharePolicy(cfg.sharePolicy);
        setImportedEncrypted(cfg.importedEncrypted === true);
      } else {
        setFields({});
        setSyncMetadata(undefined);
        setReadOnly(false);
        setEncryptRemote(false);
        setRemotePassphrase('');
        setIsShared(false);
        setSharePolicy(undefined);
        setImportedEncrypted(false);
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
    await StorageDriver.writeSyncConfig(workspaceId, provider, fields, syncMetadata, readOnly, {
      encryptRemote,
      remotePassphrase: remotePassphrase || undefined,
      isShared,
      sharePolicy,
      importedEncrypted: importedEncrypted || undefined,
    });
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

    const confirmed = await new Promise<boolean>(resolve =>
      setPendingPushConfirm({ message: buildUnsavedRequestTabsConfirmMessage('push', summary), resolve })
    );

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
      if (!syncedCollections) {
        dispatch({ type: 'SET_SYNC_STATUS', payload: { workspaceId, status: 'idle' } });
        setStatus('idle');
        return;
      }

      await saveConfig();
      const data = { ...getCurrentWorkspaceData(), collections: syncedCollections };
      const cfg: SyncConfig = { workspaceId, provider, config: fields, metadata: syncMetadata, encryptRemote, remotePassphrase: remotePassphrase || undefined, isShared: isShared || undefined, sharePolicy };

      if (data.collections.length === 0) {
        const confirmed = await new Promise<boolean>(resolve =>
          setPendingEmptyPushConfirm({ resolve })
        );
        if (!confirmed) {
          dispatch({ type: 'SET_SYNC_STATUS', payload: { workspaceId, status: 'idle' } });
          setStatus('idle');
          setMsg('Push canceled');
          return;
        }
      }

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
      await StorageDriver.writeSyncConfig(workspaceId, provider, fields, nextMetadata, readOnly, {
        encryptRemote,
        remotePassphrase: remotePassphrase || undefined,
        isShared,
        sharePolicy,
      });
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
      const cfg: SyncConfig = { workspaceId, provider, config: fields, metadata: syncMetadata, encryptRemote, remotePassphrase: remotePassphrase || undefined, isShared: isShared || undefined, sharePolicy };
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
        await StorageDriver.writeSyncConfig(workspaceId, provider, fields, nextMetadata, readOnly, { encryptRemote, remotePassphrase: remotePassphrase || undefined, isShared, sharePolicy });
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
          const cfg: SyncConfig = { workspaceId, provider, config: fields, metadata: syncMetadata, encryptRemote, remotePassphrase: remotePassphrase || undefined, isShared: isShared || undefined, sharePolicy };
          const pkg = await pullForMerge(cfg, localData);
          await logActivity('merge-opened', 'warning', 'Opened merge review', `${pkg.mergeResult.conflicts.length} conflict(s)`);
          if (pkg.mergeResult.conflicts.length === 0) {
            // No real conflicts — apply the auto-merged result immediately.
            const mergedData = pkg.mergeResult.merged;
            if (localData) await SnapshotEngine.createSnapshot(workspaceId, localData, 'pre-merge backup');
            if (!readOnly) {
              if (pkg.remoteVersion) {
                await syncApplyMerged(cfg, mergedData, pkg.remoteVersion);
              } else {
                await syncPush(cfg, mergedData);
              }
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
            await StorageDriver.writeSyncConfig(workspaceId, provider, fields, nextMetadata, readOnly, { encryptRemote, remotePassphrase: remotePassphrase || undefined, isShared, sharePolicy });
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
      const cfg: SyncConfig = { workspaceId, provider, config: fields, metadata: syncMetadata, encryptRemote, remotePassphrase: remotePassphrase || undefined, isShared: isShared || undefined, sharePolicy };
      const localData = getCurrentWorkspaceData();
      if (localData) await SnapshotEngine.createSnapshot(workspaceId, localData, 'pre-merge backup');
      if (!readOnly) {
        if (currentConflictPackage.remoteVersion) {
          await syncApplyMerged(cfg, mergedData, currentConflictPackage.remoteVersion);
        } else {
          await syncPush(cfg, mergedData);
        }
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
      await StorageDriver.writeSyncConfig(workspaceId, provider, fields, nextMetadata, readOnly, { encryptRemote, remotePassphrase: remotePassphrase || undefined, isShared, sharePolicy });
      dispatch({ type: 'HYDRATE_WORKSPACE', payload: { ...mergedData, workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId } });
      await StorageDriver.writeWorkspace(workspaceId, mergedData);
      await logActivity('merge-applied', 'success', 'Merged workspace applied', readOnly ? 'local only (read-only)' : remoteState.version ? `Version ${remoteState.version.slice(0, 8)}` : undefined);
      setStatus('ok'); setMsg(readOnly ? 'Merge applied locally (read-only — remote not updated)' : 'Merge applied successfully');
    } catch (err: unknown) {
      if (err instanceof StaleVersionError) {
        setStatus('busy'); setMsg('Remote changed during apply. Rebuilding merge…');
        try {
          const cfg: SyncConfig = { workspaceId, provider, config: fields, metadata: syncMetadata, encryptRemote, remotePassphrase: remotePassphrase || undefined, isShared: isShared || undefined, sharePolicy };
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
      const cfg: SyncConfig = { workspaceId, provider, config: fields, metadata: syncMetadata, encryptRemote, remotePassphrase: remotePassphrase || undefined, isShared: isShared || undefined, sharePolicy };
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

  async function handleTestConnection() {
    setStatus('busy'); setMsg('Testing connection…');
    try {
      const cfg: SyncConfig = { workspaceId, provider, config: fields, metadata: syncMetadata, encryptRemote, remotePassphrase: remotePassphrase || undefined, isShared: isShared || undefined, sharePolicy };
      const result = await syncTestConnection(cfg);
      if (result.ok) {
        setStatus('ok'); setMsg(result.message);
      } else {
        setStatus('error'); setMsg(result.message);
      }
    } catch (err: unknown) {
      setStatus('error'); setMsg((err as Error).message);
    }
  }

  if (!loaded) return <div className="py-8 text-center text-xs text-slate-500">Loading…</div>;

  return (
    <>
      <div className="space-y-4">
      {/* Provider selector — hidden for shared workspaces */}
      {!isShared && (
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">Provider</label>
          <div className="flex gap-2 flex-wrap">
            {VISIBLE_PROVIDERS.filter(p => !isBrowserMode || !ELECTRON_ONLY_PROVIDERS.includes(p)).map(p => (
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
      )}

      {/* Provider-specific fields — hidden for shared workspaces */}
      {!isShared && (
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
      )}

      <button
        onClick={handleTestConnection}
        disabled={status === 'busy'}
        className="w-full py-1.5 text-xs font-medium bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed text-slate-200 rounded transition-colors"
      >
        Test connection
      </button>

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
          onClick={() => !isShared && setReadOnly(v => !v)}
          disabled={isShared}
          className={`relative shrink-0 ml-4 w-9 h-5 rounded-full transition-colors ${readOnly ? 'bg-orange-500' : 'bg-slate-700'}`}
          role="switch"
          aria-checked={readOnly}
          aria-labelledby="read-only-mode-label"
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${readOnly ? 'translate-x-4' : 'translate-x-0'}`} />
        </button>
      </div>

      {/* Remote data encryption */}
      {!isBrowserMode ? (
        <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-slate-800/40 border border-slate-800">
          <div className="min-w-0 flex-1">
            <p id="encrypt-remote-label" className="text-xs font-medium text-slate-300">Encrypt remote data</p>
            <p className="text-[10px] text-slate-500 mt-0.5">Data is encrypted before upload and decrypted after download</p>
          </div>
          <button
            type="button"
            onClick={() => !isShared && setEncryptRemote(v => !v)}
            disabled={isShared}
            className={`relative shrink-0 ml-4 w-9 h-5 rounded-full transition-colors ${encryptRemote ? 'bg-orange-500' : 'bg-slate-700'}`}
            role="switch"
            aria-checked={encryptRemote}
            aria-labelledby="encrypt-remote-label"
          >
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${encryptRemote ? 'translate-x-4' : 'translate-x-0'}`} />
          </button>
        </div>
      ) : (
        <p className="text-[10px] text-slate-500 bg-slate-800/40 border border-slate-800 rounded px-3 py-2">
          Remote data encryption requires the desktop app (Electron).
        </p>
      )}
      {!isShared && encryptRemote && (
        <div>
          <label className="block text-[11px] text-slate-500 mb-1">Remote encryption passphrase</label>
          <div className="flex gap-2">
            <input
              type={showRemotePassphrase ? 'text' : 'password'}
              value={remotePassphrase}
              onChange={e => setRemotePassphrase(e.target.value)}
              placeholder="Passphrase for remote data encryption"
              className="flex-1 bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-orange-500 placeholder:text-slate-600"
            />
            <button
              type="button"
              onClick={() => setShowRemotePassphrase(v => !v)}
              className="px-2 text-xs text-slate-400 hover:text-slate-200 border border-slate-700 rounded transition-colors"
            >
              {showRemotePassphrase ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="text-[10px] text-slate-500 mt-1">Stored securely via Electron safeStorage.</p>
        </div>
      )}
      {isShared && (
        <div className="px-3 py-2 rounded-lg bg-sky-950/20 border border-sky-800/30 text-[10px] text-sky-400">
          This workspace was imported from a share package. Sync settings are managed by the original owner and cannot be changed here.
        </div>
      )}

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
        {!isShared && (
          <button
            onClick={saveConfig}
            disabled={status === 'busy'}
            className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 border border-slate-700 rounded transition-colors"
          >
            Save config
          </button>
        )}
      </div>
      {/* One-time import — hidden for shared workspaces */}
      {!isShared && (
        <button
          onClick={handleCloneOnce}
          disabled={status === 'busy'}
          className="w-full py-1.5 text-xs text-slate-500 hover:text-slate-300 border border-dashed border-slate-700 hover:border-slate-600 rounded transition-colors disabled:opacity-50"
        >
          Import once (don't save config) ↓
        </button>
      )}

      {/* Export sync config — S3 / MinIO only, hidden when sharing is disabled */}
      {(provider === 's3' || provider === 'minio') && sharePolicy?.sharingEnabled !== false && (
        <div className="space-y-2 pt-1 border-t border-slate-800">
          <button
            onClick={() => { setShowExport(v => !v); setExportStatus(''); }}
            className="w-full text-left text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            {showExport ? '▲' : '▶'} Share sync config with a teammate
          </button>
          {showExport && (
            <ExportPanel
              workspaceId={workspaceId}
              provider={provider}
              fields={fields}
              workspaceName={state.workspaces.find(w => w.id === workspaceId)?.name ?? 'workspace'}
              exportEncrypt={exportEncrypt}
              setExportEncrypt={setExportEncrypt}
              exportPassphrase={exportPassphrase}
              setExportPassphrase={setExportPassphrase}
              exportStatus={exportStatus}
              setExportStatus={setExportStatus}
              encryptRemote={encryptRemote}
              inheritedPassphrase={remotePassphrase}
              isShared={isShared}
              inheritedSharePolicy={sharePolicy}
              importedEncrypted={importedEncrypted}
            />
          )}
        </div>
      )}

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

      {conflictPackage && (
        <ConflictMergeModal
          conflictPackage={conflictPackage}
          onResolved={(merged) => handleMergeResolved(merged)}
          onKeepLocal={() => { setConflictPackage(null); handlePull('keep-local'); }}
          onKeepRemote={() => { setConflictPackage(null); handlePull('keep-remote'); }}
          onClose={() => { setConflictPackage(null); }}
        />
      )}

      {pendingPushConfirm && (
        <ConfirmModal
          title="Unsaved changes"
          message={pendingPushConfirm.message}
          confirmLabel="Save & Push"
          danger={false}
          onConfirm={() => { setPendingPushConfirm(null); pendingPushConfirm.resolve(true); }}
          onCancel={() => { setPendingPushConfirm(null); pendingPushConfirm.resolve(false); }}
        />
      )}

      {pendingEmptyPushConfirm && (
        <ConfirmModal
          title="Push empty workspace"
          message="You are about to push an empty workspace. This will overwrite the remote workspace and may cause data loss. Are you sure you want to continue?"
          confirmLabel="Push anyway"
          danger={true}
          onConfirm={() => { setPendingEmptyPushConfirm(null); pendingEmptyPushConfirm.resolve(true); }}
          onCancel={() => { setPendingEmptyPushConfirm(null); pendingEmptyPushConfirm.resolve(false); }}
        />
      )}
    </>
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
