import { useState, useRef, useEffect } from 'react';
import type { Workspace, WorkspaceData } from '../types';
import { useApp } from '../store';
import { generateId } from '../store';
import * as StorageDriver from '../utils/storageDriver';
import { requestWorkspaceSwitchGuard, saveExistingRequestTabs } from '../utils/requestTabSyncGuard';

const PRESET_COLORS = ['#f97316', '#3b82f6', '#22c55e', '#a855f7', '#ef4444', '#eab308'];

interface Props {
  onManage: () => void;
}

export default function WorkspaceSwitcher({ onManage }: Props) {
  const { state, dispatch } = useApp();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeWorkspace = state.workspaces.find(w => w.id === state.activeWorkspaceId);

  // Close popover on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setNewName('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  useEffect(() => {
    if (creating && inputRef.current) inputRef.current.focus();
  }, [creating]);

  async function handleSwitch(workspace: Workspace) {
    if (workspace.id === state.activeWorkspaceId) {
      setOpen(false);
      return;
    }
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
    setOpen(false);
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
    setCreating(false);
    setNewName('');
    setOpen(false);
  }

  const dotColor = activeWorkspace?.color ?? '#f97316';
  const local = state.workspaces.filter(w => w.type === 'local');
  const team = state.workspaces.filter(w => w.type === 'team');

  return (
    <div className="relative w-full" ref={popoverRef}>
      {/* Trigger pill */}
      <button
        onClick={() => setOpen(o => !o)}
        title="Switch workspace"
        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded bg-slate-800/70 hover:bg-slate-700/80 transition-colors"
      >
        <span className="shrink-0 w-2 h-2 rounded-full" style={{ background: dotColor }} />
        <span className="text-[10px] font-semibold text-slate-300 truncate leading-none flex-1 text-left">
          {activeWorkspace?.name ?? '…'}
        </span>
        <svg className="w-2.5 h-2.5 text-slate-500 shrink-0" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 10.5 3 5.5h10L8 10.5z" />
        </svg>
      </button>

      {/* Popover */}
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-50 py-1 text-[12px]">
          {/* Local workspaces */}
          {local.length > 0 && (
            <>
              <p className="px-3 pt-1 pb-0.5 text-[10px] text-slate-500 font-semibold uppercase tracking-wider">Local</p>
              {local.map(w => (
                <WorkspaceRow
                  key={w.id}
                  workspace={w}
                  active={w.id === state.activeWorkspaceId}
                  onSelect={() => handleSwitch(w)}
                />
              ))}
            </>
          )}

          {/* Team workspaces */}
          {team.length > 0 && (
            <>
              <p className="px-3 pt-2 pb-0.5 text-[10px] text-slate-500 font-semibold uppercase tracking-wider">Team</p>
              {team.map(w => (
                <WorkspaceRow
                  key={w.id}
                  workspace={w}
                  active={w.id === state.activeWorkspaceId}
                  onSelect={() => handleSwitch(w)}
                />
              ))}
            </>
          )}

          <div className="my-1 border-t border-slate-800" />

          {/* New workspace inline form */}
          {creating ? (
            <div className="px-2 py-1 flex items-center gap-1">
              <input
                ref={inputRef}
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCreate();
                  if (e.key === 'Escape') { setCreating(false); setNewName(''); }
                }}
                placeholder="Workspace name"
                className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-0.5 text-slate-200 text-[11px] outline-none focus:border-orange-500"
              />
              <button onClick={handleCreate} className="text-orange-400 hover:text-orange-300 px-1 font-semibold">✓</button>
              <button onClick={() => { setCreating(false); setNewName(''); }} className="text-slate-500 hover:text-slate-300 px-1">✕</button>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="w-full text-left px-3 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition-colors"
            >
              + New workspace
            </button>
          )}

          <button
            onClick={() => { setOpen(false); onManage(); }}
            className="w-full text-left px-3 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition-colors"
          >
            Manage workspaces…
          </button>
        </div>
      )}
    </div>
  );
}

function WorkspaceRow({ workspace, active, onSelect }: { workspace: Workspace; active: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-1.5 flex items-center gap-2 transition-colors ${active ? 'text-orange-400 bg-slate-800/60' : 'text-slate-300 hover:bg-slate-800/60'}`}
    >
      <span className="shrink-0 w-2 h-2 rounded-full" style={{ background: workspace.color ?? '#94a3b8' }} />
      <span className="flex-1 truncate">{workspace.name}</span>
      {workspace.role && workspace.type === 'team' && (
        <span className="text-[9px] text-slate-500 font-medium uppercase">{workspace.role}</span>
      )}
      {active && <span className="text-orange-400 text-[10px]">✓</span>}
    </button>
  );
}

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
