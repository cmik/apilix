import { useState, useRef, useEffect, useCallback, lazy, Suspense } from 'react';
import { API_BASE } from './api';
import { useApp, generateId } from './store';
import type { AppEnvironment, CollectionItem, WorkspaceData, SyncConfig, SyncMetadata, ConflictPackage } from './types';
import Sidebar from './components/Sidebar';
import ActivityBar from './components/ActivityBar';
import RequestBuilder from './components/RequestBuilder';
import ResponseViewer from './components/ResponseViewer';
import EnvironmentPanel from './components/EnvironmentPanel';
import ConsolePanel from './components/ConsolePanel';
import StatusBar from './components/StatusBar';
import TabBar from './components/TabBar';
import GlobalVariablesPanel from './components/GlobalVariablesPanel';
import ConfirmModal from './components/ConfirmModal';

const RunnerPanel = lazy(() => import('./components/RunnerPanel'));
const MockServerPanel = lazy(() => import('./components/MockServerPanel'));
const BrowserCapturePanel = lazy(() => import('./components/BrowserCapturePanel'));
const CookieManagerModal = lazy(() => import('./components/CookieManagerModal'));
const ConflictMergeModal = lazy(() => import('./components/ConflictMergeModal'));
const SettingsModal = lazy(() => import('./components/SettingsModal'));
const VariableScopeInspector = lazy(() => import('./components/VariableScopeInspector'));
import type { SettingsTab } from './components/SettingsModal';
import * as StorageDriver from './utils/storageDriver';
import * as SnapshotEngine from './utils/snapshotEngine';
import {
  push as syncPush,
  pullWithMeta as syncPullWithMeta,
  pullForMerge,
  applyMerged as syncApplyMerged,
  rebaseAfterStale,
  getRemoteSyncState,
  checkConflict,
  hasLocalUnpushedChanges,
  ConflictError,
  StaleVersionError,
} from './utils/syncEngine';
import {
  buildUnsavedRequestTabsConfirmMessage,
  getUnsavedRequestTabSummary,
  saveExistingRequestTabs,
  requestWorkspaceSwitchGuard,
  type WorkspaceSwitchDecision,
  type UnsavedRequestTabSummary,
} from './utils/requestTabSyncGuard';

// --- Env Quick Panel ---

function EnvQuickPanel({ env, onClose }: { env: AppEnvironment; onClose: () => void }) {
  const { dispatch } = useApp();
  const [rows, setRows] = useState(env.values.map(v => ({ ...v })));

  useEffect(() => {
    setRows(env.values.map(v => ({ ...v })));
  }, [env._id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function update(i: number, field: 'key' | 'value', val: string) {
    setRows(r => r.map((row, idx) => idx === i ? { ...row, [field]: val } : row));
  }
  function toggle(i: number) {
    setRows(r => r.map((row, idx) => idx === i ? { ...row, enabled: !row.enabled } : row));
  }
  function remove(i: number) {
    setRows(r => r.filter((_, idx) => idx !== i));
  }
  function addRow() {
    setRows(r => [...r, { key: '', value: '', enabled: true }]);
  }
  function save() {
    dispatch({ type: 'UPDATE_ENVIRONMENT', payload: { ...env, values: rows.filter(r => r.key) } });
    onClose();
  }

  return (
    <>
      {/* backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      {/* panel */}
      <div className="fixed inset-y-0 right-0 z-50 w-96 bg-slate-900 border-l border-slate-700 shadow-2xl flex flex-col">
        {/* header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 shrink-0">
          <div className="min-w-0">
            <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">Environment</p>
            <p className="text-sm font-semibold text-white truncate">{env.name}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={save}
              className="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded font-medium transition-colors"
            >
              Save
            </button>
            <button
              onClick={onClose}
              className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1"
            >
              ×
            </button>
          </div>
        </div>

        {/* variables list */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {rows.length === 0 && (
            <p className="text-slate-600 text-xs text-center py-6 italic">No variables yet</p>
          )}
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-1.5 mb-1.5 group">
              <input
                type="checkbox"
                checked={row.enabled}
                onChange={() => toggle(i)}
                className="accent-orange-500 shrink-0"
              />
              <input
                value={row.key}
                onChange={e => update(i, 'key', e.target.value)}
                placeholder="key"
                className={`flex-1 min-w-0 bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none ${!row.enabled ? 'opacity-40' : ''}`}
              />
              <input
                value={row.value}
                onChange={e => update(i, 'value', e.target.value)}
                placeholder="value"
                className={`flex-1 min-w-0 bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none ${!row.enabled ? 'opacity-40' : ''}`}
              />
              <button
                onClick={() => remove(i)}
                className="text-slate-600 hover:text-red-400 text-base leading-none opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {/* footer */}
        <div className="px-3 py-2 border-t border-slate-700 shrink-0">
          <button
            onClick={addRow}
            className="text-xs text-slate-500 hover:text-orange-400 transition-colors"
          >
            + Add variable
          </button>
        </div>
      </div>
    </>
  );
}

// --- Environment selector ---

function EnvironmentSelector() {
  const { state, dispatch } = useApp();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  const sorted = [...state.environments].sort((a, b) => a.name.localeCompare(b.name));
  const filtered = query.trim()
    ? sorted.filter(e => e.name.toLowerCase().includes(query.trim().toLowerCase()))
    : sorted;

  const activeEnv = state.environments.find(e => e._id === state.activeEnvironmentId);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
        setCreating(false);
        setNewName('');
      }
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  function select(id: string | null) {
    dispatch({ type: 'SET_ACTIVE_ENV', payload: id });
    setOpen(false);
    setQuery('');
    setCreating(false);
    setNewName('');
  }

  function createEnv() {
    const id = generateId();
    dispatch({ type: 'ADD_ENVIRONMENT', payload: { _id: id, name: newName.trim() || 'New Environment', values: [] } });
    dispatch({ type: 'SET_ACTIVE_ENV', payload: id });
    setCreating(false);
    setNewName('');
    setOpen(false);
    setQuery('');
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => { setOpen(o => !o); setQuery(''); setCreating(false); setNewName(''); }}
        className="flex items-center gap-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-300 hover:border-orange-500 focus:outline-none focus:border-orange-500 min-w-[140px] max-w-[220px]"
      >
        <span className="flex-1 text-left truncate">{activeEnv?.name ?? 'No environment'}</span>
        <span className="text-slate-500 ml-1">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-slate-800 border border-slate-600 rounded shadow-xl w-56">
          <div className="p-1 border-b border-slate-700">
            <input
              autoFocus={!creating}
              type="text"
              placeholder="Search environments…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="w-full bg-slate-700 text-xs text-slate-200 placeholder-slate-500 px-2 py-1 rounded focus:outline-none focus:ring-1 focus:ring-orange-500"
            />
          </div>
          <ul className="max-h-48 overflow-y-auto py-1">
            <li>
              <button
                onClick={() => select(null)}
                className={`w-full text-left px-3 py-1.5 text-xs truncate hover:bg-slate-700 ${
                  !state.activeEnvironmentId ? 'text-orange-400 font-medium' : 'text-slate-400'
                }`}
              >
                No environment
              </button>
            </li>
            {filtered.map(env => (
              <li key={env._id}>
                <button
                  onClick={() => select(env._id)}
                  className={`w-full text-left px-3 py-1.5 text-xs truncate hover:bg-slate-700 ${
                    state.activeEnvironmentId === env._id ? 'text-orange-400 font-medium' : 'text-slate-300'
                  }`}
                >
                  {env.name}
                </button>
              </li>
            ))}
            {state.environments.length === 0 && (
              <li className="px-3 py-2 text-xs text-slate-500 italic">No environments available</li>
            )}
            {state.environments.length > 0 && filtered.length === 0 && (
              <li className="px-3 py-2 text-xs text-slate-500 italic">No match</li>
            )}
          </ul>
          {/* Footer: create new environment */}
          <div className="border-t border-slate-700 p-1">
            {creating ? (
              <div className="flex items-center gap-1 p-1">
                <input
                  autoFocus
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') createEnv();
                    if (e.key === 'Escape') { setCreating(false); setNewName(''); }
                  }}
                  placeholder="Environment name… (Enter to create)"
                  className="flex-1 bg-slate-700 border border-slate-500 rounded px-2 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-orange-500"
                />
                <button
                  onClick={() => { setCreating(false); setNewName(''); }}
                  aria-label="Cancel new environment"
                  title="Cancel new environment"
                  className="px-2 py-1 bg-slate-600 hover:bg-slate-500 text-slate-300 text-xs rounded transition-colors"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full text-left px-3 py-1.5 text-xs text-orange-400 hover:bg-slate-700 rounded transition-colors"
              >
                + New environment
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const MIN_SIDEBAR = 160;
const MAX_SIDEBAR = 520;
const DEFAULT_SIDEBAR = 256;
const DEFAULT_CONSOLE_HEIGHT = 240;
const MIN_REQUEST_PANEL_HEIGHT = 220;
const MIN_RESPONSE_PANEL_HEIGHT = 160;
const DEFAULT_RESPONSE_PANEL_HEIGHT = 320;
const MIN_REQUEST_PANE_WIDTH = 300;
const MIN_RESPONSE_PANE_WIDTH = 300;
const DEFAULT_REQUEST_SPLIT_WIDTH = 500;

type ServerStatus = 'checking' | 'online' | 'offline';

// ─── Workspace switch guard modal ────────────────────────────────────────────

function WorkspaceSwitchGuardModal({
  summary,
  onDecide,
}: {
  summary: UnsavedRequestTabSummary;
  onDecide: (d: WorkspaceSwitchDecision) => void;
}) {
  const existingCount = summary.existingDirtyTabIds.length;
  const draftCount = summary.draftDirtyTabIds.length;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-[420px] p-5 space-y-4">
        <h3 className="text-sm font-semibold text-slate-200">Unsaved changes</h3>
        <div className="text-xs text-slate-400 space-y-1.5">
          {existingCount > 0 && (
            <p>
              You have{' '}
              <strong className="text-slate-200">
                {existingCount} unsaved request{existingCount !== 1 ? 's' : ''}
              </strong>{' '}
              in existing collection items.
            </p>
          )}
          {draftCount > 0 && (
            <p className="text-yellow-400/80">
              {draftCount} draft request{draftCount !== 1 ? 's' : ''} will always be lost when switching workspaces.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2 pt-1">
          {existingCount > 0 && (
            <button
              onClick={() => onDecide('save-and-switch')}
              className="w-full py-2 px-3 rounded text-xs font-medium bg-orange-600 hover:bg-orange-500 text-white transition-colors text-left"
            >
              Save &amp; Switch
              <span className="text-orange-200 font-normal">
                {' '}— save {existingCount} request{existingCount !== 1 ? 's' : ''} then switch
                {draftCount > 0 ? `, ${draftCount} draft${draftCount !== 1 ? 's' : ''} will be lost` : ''}
              </span>
            </button>
          )}
          <button
            onClick={() => onDecide('switch-anyway')}
            className="w-full py-2 px-3 rounded text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors text-left"
          >
            Switch anyway
            <span className="text-slate-400 font-normal"> — discard all unsaved changes</span>
          </button>
          <button
            onClick={() => onDecide('cancel')}
            className="w-full py-2 px-3 rounded text-xs font-medium border border-slate-700 hover:border-slate-600 text-slate-400 hover:text-slate-200 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { state, dispatch } = useApp();
  const isBrowserMode = !(window as { electronAPI?: unknown }).electronAPI;
  // ── Theme — derived from settings; systemDark tracks matchMedia for 'system' option
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  const settingsTheme: 'dark' | 'light' | 'system' = state.settings.theme ?? 'dark';
  const theme: 'dark' | 'light' =
    settingsTheme === 'light' ? 'light' :
    settingsTheme === 'system' ? (systemDark ? 'dark' : 'light') :
    'dark';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('appearance');
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR);
  const [envQuickOpen, setEnvQuickOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleHeight, setConsoleHeight] = useState(DEFAULT_CONSOLE_HEIGHT);
  const [responsePanelHeight, setResponsePanelHeight] = useState(() => {
    const saved = Number(localStorage.getItem('apilix_response_panel_height'));
    return Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_RESPONSE_PANEL_HEIGHT;
  });
  const [requestSplitWidth, setRequestSplitWidth] = useState(() => {
    const saved = Number(localStorage.getItem('apilix_request_split_width'));
    return Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_REQUEST_SPLIT_WIDTH;
  });
  const [urlBarPortalEl, setUrlBarPortalEl] = useState<HTMLElement | null>(null);
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [serverStatus, setServerStatus] = useState<ServerStatus>('checking');
  const [cookieManagerOpen, setCookieManagerOpen] = useState(false);
  const [syncConfigured, setSyncConfigured] = useState(false);
  const [syncReadOnly, setSyncReadOnly] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [quickSyncConflictPackage, setQuickSyncConflictPackage] = useState<ConflictPackage | null>(null);
  const [quickSyncConfig, setQuickSyncConfig] = useState<SyncConfig | null>(null);
  const [quickSyncMsg, setQuickSyncMsg] = useState<string>('');
  const [quickSyncStatus, setQuickSyncStatus] = useState<'ok' | 'warning' | 'error' | 'info'>('info');
  const [lastSuccessfulSyncAt, setLastSuccessfulSyncAt] = useState<string | null>(null);
  const [workspaceSwitchGuard, setWorkspaceSwitchGuard] = useState<{
    summary: UnsavedRequestTabSummary;
    resolve: (d: WorkspaceSwitchDecision) => void;
  } | null>(null);
  const [closeGuardOpen, setCloseGuardOpen] = useState(false);
  const closeGuardDirtyCountRef = useRef(0);
  const [pendingSyncConfirm, setPendingSyncConfirm] = useState<{ message: string; resolve: (v: boolean) => void } | null>(null);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const requestSplitRef = useRef<HTMLDivElement>(null);
  const responseDragging = useRef(false);
  const requestHDragging = useRef(false);
  const requestSplitStartX = useRef(0);
  const requestSplitStartWidth = useRef(0);

  const clampResponsePanelHeight = useCallback((value: number) => {
    const totalHeight = requestSplitRef.current?.clientHeight;
    if (!totalHeight || totalHeight <= 0) {
      return Math.max(MIN_RESPONSE_PANEL_HEIGHT, value);
    }
    const maxHeight = Math.max(MIN_RESPONSE_PANEL_HEIGHT, totalHeight - MIN_REQUEST_PANEL_HEIGHT);
    return Math.min(maxHeight, Math.max(MIN_RESPONSE_PANEL_HEIGHT, value));
  }, []);

  const clampRequestSplitWidth = useCallback((value: number) => {
    const totalWidth = requestSplitRef.current?.clientWidth;
    if (!totalWidth || totalWidth <= 0) {
      return Math.max(MIN_REQUEST_PANE_WIDTH, value);
    }
    const maxWidth = Math.max(0, totalWidth - MIN_RESPONSE_PANE_WIDTH);
    const minWidth = Math.min(MIN_REQUEST_PANE_WIDTH, maxWidth);
    return Math.min(maxWidth, Math.max(minWidth, value));
  }, []);

  // ── Theme ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const html = document.documentElement;
    if (theme === 'light') html.classList.add('light');
    else html.classList.remove('light');
    localStorage.setItem('apilix_theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('apilix_response_panel_height', String(Math.round(responsePanelHeight)));
  }, [responsePanelHeight]);

  useEffect(() => {
    localStorage.setItem('apilix_request_split_width', String(Math.round(requestSplitWidth)));
  }, [requestSplitWidth]);

  const openSettings = useCallback((tab: SettingsTab = 'appearance') => {
    setSettingsInitialTab(tab);
    setSettingsOpen(true);
  }, []);

  // ── Global keyboard shortcuts ──────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!e.metaKey && !e.ctrlKey) return;
      const target = e.target as HTMLElement;
      const inInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;

      switch (e.key.toLowerCase()) {
        case 'enter':
          if (state.view !== 'request') break;
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('apilix:send'));
          break;
        case 's':
          if (e.shiftKey) {
            if (inInput) return;
            if (!syncConfigured || syncBusy) return;
            e.preventDefault();
            void handleQuickSync();
            break;
          }
          if (state.view !== 'request') break;
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('apilix:save'));
          break;
        case 'l':
          if (state.view !== 'request') break;
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('apilix:focusUrl'));
          break;
        case 'n':
          if (inInput) return;
          e.preventDefault();
          {
            const newId = generateId();
            const newReq: CollectionItem = {
              id: newId,
              name: 'New Request',
              request: { method: 'GET', url: { raw: '' }, header: [] },
            };
            if (state.collections.length > 0) {
              const firstCol = state.collections[0];
              dispatch({
                type: 'UPDATE_COLLECTION',
                payload: { ...firstCol, item: [...firstCol.item, newReq] },
              });
              dispatch({ type: 'OPEN_TAB', payload: { collectionId: firstCol._id, item: newReq } });
            } else {
              const colId = generateId();
              dispatch({
                type: 'ADD_COLLECTION',
                payload: {
                  _id: colId,
                  info: {
                    name: 'My Requests',
                    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
                  },
                  item: [newReq],
                },
              });
              dispatch({ type: 'OPEN_TAB', payload: { collectionId: colId, item: newReq } });
            }
            dispatch({ type: 'SET_VIEW', payload: 'request' });
          }
          break;
        case 'e':
          if (inInput) return;
          e.preventDefault();
          dispatch({ type: 'SET_VIEW', payload: 'environments' });
          break;
        case 'm':
          if (e.shiftKey) {
            if (inInput) return;
            e.preventDefault();
            document.dispatchEvent(new CustomEvent('apilix:openWorkspaceManager'));
            break;
          }
          break;
        case 'w':
          if (inInput) return;
          e.preventDefault();
          if (state.activeTabId) {
            dispatch({ type: 'CLOSE_TAB', payload: state.activeTabId });
          }
          break;
        case 'k':
          if (!e.shiftKey) break;
          if (inInput) return;
          e.preventDefault();
          openSettings('shortcuts');
          break;
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [state.view, state.activeTabId, state.collections, dispatch, syncConfigured, syncBusy, openSettings]);

  useEffect(() => {
    function onGuardRequest(e: Event) {
      const detail = (e as CustomEvent<{
        summary: UnsavedRequestTabSummary;
        resolve: (d: WorkspaceSwitchDecision) => void;
      }>).detail;
      setWorkspaceSwitchGuard({ summary: detail.summary, resolve: detail.resolve });
    }
    document.addEventListener('apilix:workspace-switch-guard', onGuardRequest);
    return () => document.removeEventListener('apilix:workspace-switch-guard', onGuardRequest);
  }, []);

  function handleWorkspaceSwitchDecide(decision: WorkspaceSwitchDecision) {
    if (!workspaceSwitchGuard) return;
    workspaceSwitchGuard.resolve(decision);
    setWorkspaceSwitchGuard(null);
  }

  useEffect(() => {
    if (isBrowserMode) return;
    const api = (window as { electronAPI?: { onWillClose?: (cb: () => void) => void; respondClose?: (confirmed: boolean) => void } }).electronAPI;
    if (!api?.onWillClose || !api?.respondClose) return;
    api.onWillClose(async () => {
      const summary = await getUnsavedRequestTabSummary();
      if (summary.dirtyTabIds.length === 0) {
        api.respondClose!(true);
        return;
      }
      closeGuardDirtyCountRef.current = summary.dirtyTabIds.length;
      setCloseGuardOpen(true);
    });
  }, [isBrowserMode]);

  function handleCloseGuard(confirmed: boolean) {
    setCloseGuardOpen(false);
    const api = (window as { electronAPI?: { respondClose?: (confirmed: boolean) => void } }).electronAPI;
    api?.respondClose?.(confirmed);
  }

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(3000) });
        if (!cancelled) setServerStatus(res.ok ? 'online' : 'offline');
      } catch {
        if (!cancelled) setServerStatus('offline');
      }
    }
    check();
    const id = setInterval(check, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    let active = true;
    StorageDriver.readSyncConfig(state.activeWorkspaceId)
      .then(cfg => {
        if (!active) return;
        const configured = Boolean(cfg?.provider && cfg?.config && Object.keys(cfg.config).length > 0);
        setSyncConfigured(configured);
        setSyncReadOnly(cfg?.readOnly === true);
        setLastSuccessfulSyncAt(cfg?.metadata?.lastSyncedAt ?? cfg?.lastSynced ?? null);
      })
      .catch(() => {
        if (!active) return;
        setSyncConfigured(false);
        setSyncReadOnly(false);
        setLastSuccessfulSyncAt(null);
      });
    return () => { active = false; };
  }, [isBrowserMode, state.activeWorkspaceId, state.syncConfigVersion]);

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

  async function loadCurrentSyncConfig(): Promise<SyncConfig | null> {
    const stored = await StorageDriver.readSyncConfig(state.activeWorkspaceId);
    if (!stored?.provider || !stored?.config || Object.keys(stored.config).length === 0) return null;
    return {
      workspaceId: state.activeWorkspaceId,
      provider: stored.provider as SyncConfig['provider'],
      config: stored.config,
      metadata: stored.metadata ?? (stored.lastSynced ? { lastSyncedAt: stored.lastSynced } : undefined),
      readOnly: stored.readOnly === true ? true : undefined,
    };
  }

  async function persistSyncBase(cfg: SyncConfig, data: WorkspaceData, timestamp: string | null, version: string | null, summary: string): Promise<SyncMetadata> {
    const baseSnapshotId = await SnapshotEngine.createSnapshot(cfg.workspaceId, data, summary);
    const nextMetadata: SyncMetadata = {
      ...(cfg.metadata ?? {}),
      lastSyncedAt: timestamp ?? new Date().toISOString(),
      lastSyncedVersion: version ?? cfg.metadata?.lastSyncedVersion,
      lastMergeBaseSnapshotId: baseSnapshotId,
    };
    await StorageDriver.writeSyncConfig(cfg.workspaceId, cfg.provider, cfg.config, nextMetadata, cfg.readOnly);
    return nextMetadata;
  }

  function setQuickSyncFeedback(message: string, status: 'ok' | 'warning' | 'error' | 'info') {
    setQuickSyncMsg(message);
    setQuickSyncStatus(status);
  }

  async function prepareCollectionsForSync(): Promise<typeof state.collections | null> {
    const summary = await getUnsavedRequestTabSummary();
    if (summary.dirtyTabIds.length === 0) return state.collections;

    const confirmed = await new Promise<boolean>(resolve =>
      setPendingSyncConfirm({ message: buildUnsavedRequestTabsConfirmMessage('sync', summary), resolve })
    );

    if (!confirmed) {
      setQuickSyncFeedback('Sync canceled', 'info');
      return null;
    }

    const result = await saveExistingRequestTabs(summary.existingDirtyTabIds);
    return result.updatedCollections;
  }

  function getQuickSyncTooltip(): string {
    if (quickSyncStatus === 'ok' && lastSuccessfulSyncAt) {
      return `${quickSyncMsg || 'Synced successfully'}\nLast successful sync: ${new Date(lastSuccessfulSyncAt).toLocaleString()}`;
    }
    return quickSyncMsg || 'Ready to sync';
  }

  async function handleQuickSync() {
    if (syncBusy) return;
    setQuickSyncFeedback('', 'info');
    setSyncBusy(true);
    try {
      const syncedCollections = await prepareCollectionsForSync();
      if (!syncedCollections) return;

      const cfg = await loadCurrentSyncConfig();
      if (!cfg) {
        setQuickSyncFeedback('No sync provider configured for this workspace', 'warning');
        return;
      }
      setQuickSyncConfig(cfg);
      let currentCfg = cfg;
      const localData = { ...getCurrentWorkspaceData(), collections: syncedCollections };

      const hasUnpushed = await hasLocalUnpushedChanges(currentCfg, localData);
      if (hasUnpushed && !currentCfg.readOnly) {
        const remoteAhead = await checkConflict(currentCfg);
        if (remoteAhead) {
          const pkg = await pullForMerge(currentCfg, localData);
          if (pkg.mergeResult.conflicts.length === 0) {
            // No real conflicts — apply auto-merged result and continue.
            const mergedData = pkg.mergeResult.merged;
            await SnapshotEngine.createSnapshot(state.activeWorkspaceId, localData, 'pre-merge backup');
            if (pkg.remoteVersion) {
              await syncApplyMerged(currentCfg, mergedData, pkg.remoteVersion);
            } else {
              await syncPush(currentCfg, mergedData);
            }
            const pushedState = await getRemoteSyncState(currentCfg);
            const meta = await persistSyncBase(currentCfg, mergedData, pushedState.timestamp, pushedState.version, 'sync base after auto-merge push');
            currentCfg = { ...currentCfg, metadata: meta };
            dispatch({ type: 'HYDRATE_WORKSPACE', payload: { ...mergedData, workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId } });
            await StorageDriver.writeWorkspace(currentCfg.workspaceId, mergedData);
            setLastSuccessfulSyncAt(meta.lastSyncedAt ?? null);
            setQuickSyncFeedback('Synced (auto-merged)', 'ok');
            return;
          }
          setQuickSyncConflictPackage(pkg);
          setQuickSyncFeedback('Remote has newer changes — review merge before pushing', 'warning');
          return;
        }
        await syncPush(currentCfg, localData);
        const pushedState = await getRemoteSyncState(currentCfg);
        const meta = await persistSyncBase(currentCfg, localData, pushedState.timestamp, pushedState.version, 'sync base after quick-sync push');
        currentCfg = { ...currentCfg, metadata: meta };
      }

      try {
        const result = await syncPullWithMeta(currentCfg);
        if (result.data) {
          dispatch({ type: 'HYDRATE_WORKSPACE', payload: { ...result.data, workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId } });
          await StorageDriver.writeWorkspace(currentCfg.workspaceId, result.data);
          const meta = await persistSyncBase(currentCfg, result.data, result.remoteState.timestamp, result.remoteState.version, 'sync base after quick-sync pull');
          currentCfg = { ...currentCfg, metadata: meta };
          setLastSuccessfulSyncAt(meta.lastSyncedAt ?? null);
          setQuickSyncFeedback(hasUnpushed && !currentCfg.readOnly ? 'Synced (pushed + pulled)' : 'Synced (pulled)', 'ok');
        } else {
          setQuickSyncFeedback(hasUnpushed && !currentCfg.readOnly ? 'Pushed local changes (remote empty)' : 'Remote is empty — nothing to pull', 'info');
        }
      } catch (err: unknown) {
        if (err instanceof ConflictError) {
          const pkg = await pullForMerge(currentCfg, localData);
          if (pkg.mergeResult.conflicts.length === 0) {
            const mergedData = pkg.mergeResult.merged;
            await SnapshotEngine.createSnapshot(state.activeWorkspaceId, localData, 'pre-merge backup');
            if (pkg.remoteVersion) {
              await syncApplyMerged(currentCfg, mergedData, pkg.remoteVersion);
            } else {
              await syncPush(currentCfg, mergedData);
            }
            const remoteState = await getRemoteSyncState(currentCfg);
            const meta = await persistSyncBase(currentCfg, mergedData, remoteState.timestamp, remoteState.version, 'sync base after auto-merge');
            currentCfg = { ...currentCfg, metadata: meta };
            dispatch({ type: 'HYDRATE_WORKSPACE', payload: { ...mergedData, workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId } });
            await StorageDriver.writeWorkspace(currentCfg.workspaceId, mergedData);
            setLastSuccessfulSyncAt(meta.lastSyncedAt ?? null);
            setQuickSyncFeedback('Synced (auto-merged)', 'ok');
          } else {
            setQuickSyncConflictPackage(pkg);
            setQuickSyncFeedback('Conflict detected — review merge', 'warning');
          }
        } else {
          throw err;
        }
      }
    } catch (err: unknown) {
      setQuickSyncFeedback((err as Error).message, 'error');
    } finally {
      setSyncBusy(false);
    }
  }

  async function handleQuickSyncMergeResolved(mergedData: WorkspaceData) {
    if (!quickSyncConflictPackage || !quickSyncConfig) return;
    const currentPackage = quickSyncConflictPackage;
    let currentCfg = quickSyncConfig;
    setQuickSyncConflictPackage(null);
    setSyncBusy(true);
    setQuickSyncFeedback('Applying merge…', 'info');
    try {
      const preMergeLocal = getCurrentWorkspaceData();
      await SnapshotEngine.createSnapshot(state.activeWorkspaceId, preMergeLocal, 'pre-quick-sync-merge backup');

      if (currentPackage.remoteVersion) {
        await syncApplyMerged(currentCfg, mergedData, currentPackage.remoteVersion);
      } else {
        await syncPush(currentCfg, mergedData);
      }

      const remoteState = await getRemoteSyncState(currentCfg);
      const meta = await persistSyncBase(currentCfg, mergedData, remoteState.timestamp, remoteState.version, 'sync base after quick-sync merge apply');
      currentCfg = { ...currentCfg, metadata: meta };
      setQuickSyncConfig(currentCfg);
      setLastSuccessfulSyncAt(meta.lastSyncedAt ?? null);

      dispatch({ type: 'HYDRATE_WORKSPACE', payload: { ...mergedData, workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId } });
      await StorageDriver.writeWorkspace(state.activeWorkspaceId, mergedData);
      setQuickSyncFeedback('Sync merge applied successfully', 'ok');
    } catch (err: unknown) {
      if (err instanceof StaleVersionError) {
        setQuickSyncFeedback('Remote changed during apply. Rebuilding merge…', 'warning');
        try {
          const rebased = await rebaseAfterStale(currentCfg, mergedData, currentPackage.remoteData);
          setQuickSyncConflictPackage(rebased);
          setQuickSyncFeedback('Remote changed during apply. Review updated merge.', 'warning');
        } catch (rebaseErr: unknown) {
          setQuickSyncFeedback((rebaseErr as Error).message, 'error');
        }
      } else {
        setQuickSyncFeedback((err as Error).message, 'error');
      }
    } finally {
      setSyncBusy(false);
    }
  }

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth]);

  const onResponseHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    responseDragging.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const onRequestSplitHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    requestHDragging.current = true;
    requestSplitStartX.current = e.clientX;
    requestSplitStartWidth.current = requestSplitWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [requestSplitWidth]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (dragging.current) {
        const delta = e.clientX - startX.current;
        const next = Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, startWidth.current + delta));
        setSidebarWidth(next);
      }

      if (responseDragging.current) {
        const rect = requestSplitRef.current?.getBoundingClientRect();
        if (!rect) return;
        const nextHeight = clampResponsePanelHeight(rect.bottom - e.clientY);
        setResponsePanelHeight(nextHeight);
      }

      if (requestHDragging.current) {
        const delta = e.clientX - requestSplitStartX.current;
        const nextWidth = clampRequestSplitWidth(requestSplitStartWidth.current + delta);
        setRequestSplitWidth(nextWidth);
      }
    }
    function onMouseUp() {
      if (dragging.current) dragging.current = false;
      if (responseDragging.current) responseDragging.current = false;
      if (requestHDragging.current) requestHDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [clampResponsePanelHeight, clampRequestSplitWidth]);

  useEffect(() => {
    function onResize() {
      setResponsePanelHeight(h => clampResponsePanelHeight(h));
      setRequestSplitWidth(w => clampRequestSplitWidth(w));
    }
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, [clampResponsePanelHeight, clampRequestSplitWidth]);

  const quickSyncTooltip = getQuickSyncTooltip();

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden">
      <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Activity bar – vertical main menu */}
      <ActivityBar
        settingsTheme={settingsTheme}
        onToggleTheme={() => {
          const next = settingsTheme === 'light' ? 'dark' : settingsTheme === 'dark' ? 'system' : 'light';
          dispatch({ type: 'UPDATE_SETTINGS', payload: { theme: next } });
        }}
        onOpenSettings={() => openSettings()}
      />

      {/* Left sidebar – width controlled by drag */}
      <div style={{ width: sidebarWidth, minWidth: sidebarWidth }} className="shrink-0 h-full overflow-hidden">
        <Sidebar />
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={onHandleMouseDown}
        className="w-0.5 shrink-0 cursor-col-resize bg-slate-700 hover:bg-orange-500 transition-colors"
        title="Drag to resize sidebar"
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-slate-700 bg-slate-900 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {syncConfigured && !syncReadOnly && (
              <div className="flex items-center gap-1.5" title={quickSyncTooltip}>
                <button
                  onClick={handleQuickSync}
                  disabled={syncBusy}
                  aria-label={`Sync workspace. Status: ${quickSyncTooltip}`}
                  title={quickSyncTooltip}
                  className={`px-3 py-1 rounded text-xs font-medium border transition-colors focus:outline-none focus:ring-2 focus:ring-orange-500 ${
                    syncBusy
                      ? 'bg-slate-700 border-slate-600 text-slate-400 cursor-not-allowed'
                      : 'bg-orange-600 border-orange-600 text-white hover:bg-orange-500'
                  }`}
                >
                  {syncBusy ? 'Syncing…' : 'Sync'}
                </button>
                <span
                  role="status"
                  aria-label={`Sync status: ${quickSyncTooltip}`}
                  title={quickSyncTooltip}
                  className={`inline-flex w-2.5 h-2.5 rounded-full ${
                    syncBusy ? 'bg-sky-400 animate-pulse' :
                    quickSyncStatus === 'ok' ? 'bg-green-500' :
                    quickSyncStatus === 'warning' ? 'bg-yellow-400' :
                    quickSyncStatus === 'error' ? 'bg-red-500' :
                    'bg-slate-500'
                  }`}
                />
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Cookie manager button */}
            <button
              onClick={() => setCookieManagerOpen(o => !o)}
              title="Cookie Manager"
              className={`px-2 py-1 rounded text-xs transition-colors border ${
                cookieManagerOpen
                  ? 'bg-orange-600 border-orange-600 text-white'
                  : 'bg-slate-700 border-slate-600 text-slate-400 hover:text-white hover:border-orange-500'
              }`}
            >
              🍪
            </button>
            <span className="text-slate-500 text-xs">Environment:</span>
            <EnvironmentSelector />
            {state.activeEnvironmentId && (
              <button
                onClick={() => setEnvQuickOpen(o => !o)}
                title="Quick view environment variables"
                className={`px-2 py-1 rounded text-xs transition-colors border ${
                  envQuickOpen
                    ? 'bg-orange-600 border-orange-600 text-white'
                    : 'bg-slate-700 border-slate-600 text-slate-400 hover:text-white hover:border-orange-500'
                }`}
              >
                👁
              </button>
            )}
          </div>
        </div>

        {/* Tab bar — shown in request and history views */}
        {(state.view === 'request' || state.view === 'history') && <TabBar dirtyIds={dirtyIds} />}

        {/* Content area */}
        {/* RequestBuilder is always mounted to preserve unsaved changes; hidden when not active */}
        <div
          ref={requestSplitRef}
          className={`flex-1 overflow-hidden flex flex-col ${(state.view === 'request' || state.view === 'history') ? '' : 'hidden'}`}
        >
          {(state.settings.requestLayout ?? 'stacked') === 'split' ? (
            <>
              <div ref={setUrlBarPortalEl} className="shrink-0" />
              <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
                <div
                  className="shrink-0 min-w-0 flex flex-col overflow-hidden"
                  style={{ width: clampRequestSplitWidth(requestSplitWidth) }}
                >
                  <RequestBuilder onDirtyChange={setDirtyIds} urlBarPortalTarget={urlBarPortalEl} />
                </div>
                <div
                  onMouseDown={onRequestSplitHandleMouseDown}
                  className="w-0.5 shrink-0 cursor-col-resize bg-slate-700 hover:bg-orange-500 transition-colors"
                  title="Drag to resize panels"
                />
                <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
                  <ResponseViewer />
                </div>
              </div>
            </>
          ) : (
            <>
              <RequestBuilder onDirtyChange={setDirtyIds} />
              <div
                onMouseDown={onResponseHandleMouseDown}
                className="h-0.5 shrink-0 cursor-row-resize bg-slate-700 hover:bg-orange-500 transition-colors"
                title="Drag to resize result panel"
              />
              <div
                className="shrink-0 min-h-0"
                style={{ height: clampResponsePanelHeight(responsePanelHeight) }}
              >
                <ResponseViewer />
              </div>
            </>
          )}
        </div>
        {/* RunnerPanel is always mounted to preserve form state; hidden when not active */}
        <div className={`flex-1 flex flex-col overflow-hidden ${state.view === 'runner' ? '' : 'hidden'}`}>
          <Suspense fallback={null}>
            <RunnerPanel />
          </Suspense>
        </div>
        {state.view === 'environments' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <EnvironmentPanel />
          </div>
        )}
        {state.view === 'globals' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <GlobalVariablesPanel />
          </div>
        )}
        {state.view === 'variables' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <Suspense fallback={null}>
              <VariableScopeInspector />
            </Suspense>
          </div>
        )}
        {state.view === 'mock' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <Suspense fallback={null}>
              <MockServerPanel />
            </Suspense>
          </div>
        )}
        {state.view === 'capture' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <Suspense fallback={null}>
              <BrowserCapturePanel />
            </Suspense>
          </div>
        )}

        {/* Console panel (above status bar) — always mounted so the BroadcastChannel
            keeps broadcasting to a detached window even when the inline panel is closed */}
        <div style={consoleOpen ? undefined : { display: 'none' }}>
          <ConsolePanel
            height={consoleHeight}
            onHeightChange={setConsoleHeight}
            onClose={() => setConsoleOpen(false)}
            theme={theme}
          />
        </div>
      </div>
      </div>

      {/* Status bar — full width at bottom */}
      <StatusBar
        consoleOpen={consoleOpen}
        onToggleConsole={() => setConsoleOpen(o => !o)}
        logCount={state.consoleLogs.length}
        lastEntry={state.consoleLogs[0] ?? null}
        serverStatus={serverStatus}
      />

      {/* Env quick panel */}
      {envQuickOpen && state.activeEnvironmentId && (() => {
        const activeEnv = state.environments.find(e => e._id === state.activeEnvironmentId);
        return activeEnv
          ? <EnvQuickPanel env={activeEnv} onClose={() => setEnvQuickOpen(false)} />
          : null;
      })()}

      {/* Cookie manager modal */}
      {cookieManagerOpen && (
        <Suspense fallback={null}>
          <CookieManagerModal onClose={() => setCookieManagerOpen(false)} />
        </Suspense>
      )}

      {/* App close guard */}
      {closeGuardOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70">
          <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-[380px] p-5 space-y-4">
            <h3 className="text-sm font-semibold text-slate-200">Unsaved changes</h3>
            <p className="text-xs text-slate-400">
              You have{' '}
              <strong className="text-slate-200">
                {closeGuardDirtyCountRef.current} unsaved request tab{closeGuardDirtyCountRef.current !== 1 ? 's' : ''}
              </strong>
              . Closing the app will discard all unsaved work.
            </p>
            <div className="flex flex-col gap-2 pt-1">
              <button
                onClick={() => handleCloseGuard(true)}
                className="w-full py-2 px-3 rounded text-xs font-medium bg-red-700 hover:bg-red-600 text-white transition-colors"
              >
                Close anyway
              </button>
              <button
                onClick={() => handleCloseGuard(false)}
                className="w-full py-2 px-3 rounded text-xs font-medium border border-slate-700 hover:border-slate-600 text-slate-400 hover:text-slate-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {workspaceSwitchGuard && (
        <WorkspaceSwitchGuardModal
          summary={workspaceSwitchGuard.summary}
          onDecide={handleWorkspaceSwitchDecide}
        />
      )}

      {quickSyncConflictPackage && (
        <Suspense fallback={null}>
          <ConflictMergeModal
            conflictPackage={quickSyncConflictPackage}
            onResolved={(merged) => handleQuickSyncMergeResolved(merged)}
            onKeepLocal={() => {
              setQuickSyncConflictPackage(null);
              setQuickSyncFeedback('Kept local changes', 'warning');
            }}
            onKeepRemote={async () => {
              if (!quickSyncConfig) {
                setQuickSyncConflictPackage(null);
                return;
              }
              setSyncBusy(true);
              try {
                const result = await syncPullWithMeta(quickSyncConfig, 'keep-remote');
                if (result.data) {
                  dispatch({ type: 'HYDRATE_WORKSPACE', payload: { ...result.data, workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId } });
                  await StorageDriver.writeWorkspace(state.activeWorkspaceId, result.data);
                  const meta = await persistSyncBase(quickSyncConfig, result.data, result.remoteState.timestamp, result.remoteState.version, 'sync base after keep-remote');
                  setQuickSyncConfig({ ...quickSyncConfig, metadata: meta });
                  setLastSuccessfulSyncAt(meta.lastSyncedAt ?? null);
                }
                setQuickSyncFeedback('Applied remote changes', 'ok');
              } catch (err: unknown) {
                setQuickSyncFeedback((err as Error).message, 'error');
              } finally {
                setSyncBusy(false);
                setQuickSyncConflictPackage(null);
              }
            }}
            onClose={() => setQuickSyncConflictPackage(null)}
          />
        </Suspense>
      )}

      {pendingSyncConfirm && (
        <ConfirmModal
          title="Unsaved changes"
          message={pendingSyncConfirm.message}
          confirmLabel="Save & Sync"
          danger={false}
          onConfirm={() => { setPendingSyncConfirm(null); pendingSyncConfirm.resolve(true); }}
          onCancel={() => { setPendingSyncConfirm(null); pendingSyncConfirm.resolve(false); }}
          zIndex="z-[65]"
        />
      )}

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal onClose={() => setSettingsOpen(false)} initialTab={settingsInitialTab} />
        </Suspense>
      )}
    </div>
  );
}
