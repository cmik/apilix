import { useState, useEffect, useCallback } from 'react';
import type { Workspace, WorkspaceData, SyncConfig, SyncProvider, HistoryEntry } from '../types';
import { useApp, generateId } from '../store';
import * as StorageDriver from '../utils/storageDriver';
import { push as syncPush, pull as syncPull, ConflictError } from '../utils/syncEngine';
import * as SnapshotEngine from '../utils/snapshotEngine';

type Tab = 'workspaces' | 'sync' | 'team' | 'history';

const PRESET_COLORS = ['#f97316', '#3b82f6', '#22c55e', '#a855f7', '#ef4444', '#eab308'];

interface Props {
  onClose: () => void;
}

export default function WorkspaceManagerModal({ onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('workspaces');

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
          {(['workspaces', 'sync', 'team', 'history'] as Tab[]).map(tab => (
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
          {activeTab === 'sync' && <SyncTab />}
          {activeTab === 'team' && <TeamTab />}
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

  async function handleSwitch(workspace: Workspace) {
    if (workspace.id === state.activeWorkspaceId) return;
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
                className="text-sm font-medium text-slate-200 truncate text-left w-full hover:text-orange-400 transition-colors"
              >
                {w.name}
                {w.id === state.activeWorkspaceId && <span className="ml-2 text-[10px] text-orange-400 font-normal">active</span>}
                {w.type === 'team' && w.role && <span className="ml-2 text-[10px] text-slate-500">{w.role}</span>}
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
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [conflict, setConflict] = useState<null | { remoteTimestamp: string; localTimestamp: string | null }>(null);

  // Load persisted sync config on mount / workspace change
  useEffect(() => {
    let active = true;
    StorageDriver.readSyncConfig(workspaceId).then(cfg => {
      if (!active) return;
      if (cfg) {
        setProvider(cfg.provider as SyncProvider);
        setFields(cfg.config);
      } else {
        setFields({});
      }
      setLoaded(true);
    });
    return () => { active = false; };
  }, [workspaceId]);

  async function saveConfig() {
    await StorageDriver.writeSyncConfig(workspaceId, provider, fields);
  }

  function setField(key: string, value: string) {
    setFields(prev => ({ ...prev, [key]: value }));
  }

  async function handlePush() {
    setStatus('busy'); setMsg('Pushing…'); setConflict(null);
    try {
      await saveConfig();
      const data = await StorageDriver.readWorkspace(workspaceId);
      if (!data) throw new Error('No workspace data to push');
      const cfg: SyncConfig = { workspaceId, provider, config: fields };
      await syncPush(cfg, data);
      dispatch({ type: 'SET_SYNC_STATUS', payload: { workspaceId, status: 'idle' } });
      setStatus('ok'); setMsg('Pushed successfully');
    } catch (err: unknown) {
      setStatus('error'); setMsg((err as Error).message);
    }
  }

  async function handlePull(resolution?: 'keep-local' | 'keep-remote') {
    setStatus('busy'); setMsg('Pulling…'); setConflict(null);
    try {
      await saveConfig();
      const cfg: SyncConfig = { workspaceId, provider, config: fields };
      const data = await syncPull(cfg, resolution);
      if (data) {
        dispatch({ type: 'HYDRATE_WORKSPACE', payload: { ...data, workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId } });
        await StorageDriver.writeWorkspace(workspaceId, data);
        setStatus('ok'); setMsg('Pulled successfully');
      } else {
        setStatus('ok'); setMsg('Remote is empty — nothing to pull');
      }
    } catch (err: unknown) {
      if (err instanceof ConflictError) {
        setConflict({ remoteTimestamp: err.remoteLastModified, localTimestamp: err.localLastSaved });
        setStatus('idle'); setMsg('');
      } else {
        setStatus('error'); setMsg((err as Error).message);
      }
    }
  }

  async function handleCloneOnce() {
    setStatus('busy'); setMsg('Importing…'); setConflict(null);
    try {
      const cfg: SyncConfig = { workspaceId, provider, config: fields };
      const data = await syncPull(cfg);
      if (data) {
        dispatch({ type: 'HYDRATE_WORKSPACE', payload: { ...data, workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId } });
        await StorageDriver.writeWorkspace(workspaceId, data);
        setStatus('ok'); setMsg('Imported successfully — config was not saved');
      } else {
        setStatus('ok'); setMsg('Remote is empty — nothing to import');
      }
    } catch (err: unknown) {
      if (err instanceof ConflictError) {
        setConflict({ remoteTimestamp: err.remoteLastModified, localTimestamp: err.localLastSaved });
        setStatus('idle'); setMsg('');
      } else {
        setStatus('error'); setMsg((err as Error).message);
      }
    }
  }

  if (!loaded) return <div className="py-8 text-center text-xs text-slate-500">Loading…</div>;

  return (
    <div className="space-y-4">
      {/* Provider selector */}
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1.5">Provider</label>
        <div className="flex gap-2 flex-wrap">
          {(Object.keys(PROVIDER_LABELS) as SyncProvider[]).map(p => (
            <button
              key={p}
              onClick={() => { setProvider(p); setFields({}); }}
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

      {/* Conflict resolution */}
      {conflict && (
        <div className="p-3 bg-yellow-950/40 border border-yellow-700/50 rounded-lg text-xs text-slate-300 space-y-2">
          <p className="font-medium text-yellow-300">Conflict detected</p>
          <p>Remote was last modified: <strong>{new Date(conflict.remoteTimestamp).toLocaleString()}</strong></p>
          {conflict.localTimestamp && <p>Local last synced: <strong>{new Date(conflict.localTimestamp).toLocaleString()}</strong></p>}
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

      {/* Action buttons */}
      <div className="flex gap-2 pt-1">
        <button
          onClick={handlePush}
          disabled={status === 'busy'}
          className="flex-1 py-1.5 text-xs font-medium bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-white rounded transition-colors"
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
    </div>
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
          To start your own team server, see <code className="text-slate-400">server/team/</code> and run{' '}
          <code className="text-slate-400">npm start</code> in that directory.
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
