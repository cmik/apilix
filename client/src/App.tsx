import { useState, useRef, useEffect, useCallback } from 'react';
import { API_BASE } from './api';
import { useApp, generateId } from './store';
import type { AppEnvironment, PostmanItem } from './types';
import Sidebar from './components/Sidebar';
import RequestBuilder from './components/RequestBuilder';
import ResponseViewer from './components/ResponseViewer';
import RunnerPanel from './components/RunnerPanel';
import EnvironmentPanel from './components/EnvironmentPanel';
import ConsolePanel from './components/ConsolePanel';
import StatusBar from './components/StatusBar';
import TabBar from './components/TabBar';
import CookieManagerModal from './components/CookieManagerModal';

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
      }
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, []);

  function select(id: string | null) {
    dispatch({ type: 'SET_ACTIVE_ENV', payload: id });
    setOpen(false);
    setQuery('');
  }

  if (state.environments.length === 0) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => { setOpen(o => !o); setQuery(''); }}
        className="flex items-center gap-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-300 hover:border-orange-500 focus:outline-none focus:border-orange-500 min-w-[140px] max-w-[220px]"
      >
        <span className="flex-1 text-left truncate">{activeEnv?.name ?? 'No environment'}</span>
        <span className="text-slate-500 ml-1">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-slate-800 border border-slate-600 rounded shadow-xl w-56">
          <div className="p-1 border-b border-slate-700">
            <input
              autoFocus
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
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-xs text-slate-500 italic">No match</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

const MIN_SIDEBAR = 160;
const MAX_SIDEBAR = 520;
const DEFAULT_SIDEBAR = 256;
const DEFAULT_CONSOLE_HEIGHT = 240;

type ServerStatus = 'checking' | 'online' | 'offline';

export default function App() {
  const { state, dispatch } = useApp();
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR);
  const [envQuickOpen, setEnvQuickOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleHeight, setConsoleHeight] = useState(DEFAULT_CONSOLE_HEIGHT);
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [serverStatus, setServerStatus] = useState<ServerStatus>('checking');
  const [cookieManagerOpen, setCookieManagerOpen] = useState(false);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

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
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('apilix:send'));
          break;
        case 's':
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('apilix:save'));
          break;
        case 'l':
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('apilix:focusUrl'));
          break;
        case 'n':
          if (inInput) return;
          e.preventDefault();
          {
            const newId = generateId();
            const newReq: PostmanItem = {
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
        case 'w':
          if (inInput) return;
          e.preventDefault();
          if (state.activeTabId) {
            dispatch({ type: 'CLOSE_TAB', payload: state.activeTabId });
          }
          break;
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [state.activeTabId, state.collections, dispatch]);

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

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const next = Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, startWidth.current + delta));
      setSidebarWidth(next);
    }
    function onMouseUp() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden">
      <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Left sidebar – width controlled by drag */}
      <div style={{ width: sidebarWidth, minWidth: sidebarWidth }} className="shrink-0 h-full overflow-hidden">
        <Sidebar />
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={onHandleMouseDown}
        className="w-1 shrink-0 cursor-col-resize bg-slate-700 hover:bg-orange-500 transition-colors"
        title="Drag to resize sidebar"
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Top bar */}
        <div className="flex items-center justify-end gap-2 px-4 py-2 border-b border-slate-700 bg-slate-900 shrink-0">
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

        {/* Tab bar — shown only in request view */}
        {state.view === 'request' && <TabBar dirtyIds={dirtyIds} />}

        {/* Content area */}
        {state.view === 'request' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <RequestBuilder onDirtyChange={setDirtyIds} />
            <ResponseViewer />
          </div>
        )}
        {/* RunnerPanel is always mounted to preserve form state; hidden when not active */}
        <div className={`flex-1 flex flex-col overflow-hidden ${state.view === 'runner' ? '' : 'hidden'}`}>
          <RunnerPanel />
        </div>
        {state.view === 'environments' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <EnvironmentPanel />
          </div>
        )}

        {/* Console panel (above status bar) — always mounted so the BroadcastChannel
            keeps broadcasting to a detached window even when the inline panel is closed */}
        <div style={consoleOpen ? undefined : { display: 'none' }}>
          <ConsolePanel
            height={consoleHeight}
            onHeightChange={setConsoleHeight}
            onClose={() => setConsoleOpen(false)}
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
        <CookieManagerModal onClose={() => setCookieManagerOpen(false)} />
      )}
    </div>
  );
}
