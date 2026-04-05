import { useState, useEffect, useCallback } from 'react';
import { useApp, generateId } from '../store';
import type { MockRoute } from '../types';
import { startMockServer, stopMockServer, syncMockRoutes, getMockStatus } from '../api';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', '*'];
const STATUS_CODES = [200, 201, 204, 301, 302, 400, 401, 403, 404, 409, 422, 500, 502, 503];

function emptyRoute(): MockRoute {
  return {
    id: generateId(),
    enabled: true,
    method: 'GET',
    path: '/api/example',
    statusCode: 200,
    responseHeaders: [{ key: 'Content-Type', value: 'application/json' }],
    responseBody: '{\n  "message": "Hello from mock!"\n}',
    delay: 0,
    description: '',
  };
}

// ─── Route Editor Modal ────────────────────────────────────────────────────────

function RouteEditorModal({
  initial,
  onSave,
  onClose,
}: {
  initial: MockRoute;
  onSave: (r: MockRoute) => void;
  onClose: () => void;
}) {
  const [route, setRoute] = useState<MockRoute>({ ...initial });
  const [headerRows, setHeaderRows] = useState(
    initial.responseHeaders.length > 0 ? [...initial.responseHeaders] : [{ key: '', value: '' }]
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function updateField<K extends keyof MockRoute>(k: K, v: MockRoute[K]) {
    setRoute(r => ({ ...r, [k]: v }));
  }

  function updateHeader(i: number, field: 'key' | 'value', val: string) {
    setHeaderRows(rows => rows.map((r, idx) => idx === i ? { ...r, [field]: val } : r));
  }

  function removeHeader(i: number) {
    setHeaderRows(rows => rows.filter((_, idx) => idx !== i));
  }

  function addHeader() {
    setHeaderRows(rows => [...rows, { key: '', value: '' }]);
  }

  function handleSave() {
    const headers = headerRows.filter(h => h.key.trim());
    onSave({ ...route, responseHeaders: headers });
    onClose();
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700 shrink-0">
            <h2 className="text-sm font-semibold text-white">
              {initial.path === '/api/example' && !initial.description ? 'New Mock Route' : 'Edit Mock Route'}
            </h2>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none">×</button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {/* Description */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">Description (optional)</label>
              <input
                value={route.description}
                onChange={e => updateField('description', e.target.value)}
                placeholder="Describe this mock route…"
                className="w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
              />
            </div>

            {/* Method + Path */}
            <div className="flex gap-2">
              <div className="shrink-0">
                <label className="block text-xs text-slate-400 mb-1">Method</label>
                <select
                  value={route.method}
                  onChange={e => updateField('method', e.target.value)}
                  className="bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
                >
                  {METHODS.map(m => <option key={m} value={m}>{m === '*' ? 'ANY' : m}</option>)}
                </select>
              </div>
              <div className="flex-1">
                <label className="block text-xs text-slate-400 mb-1">Path</label>
                <input
                  value={route.path}
                  onChange={e => updateField('path', e.target.value)}
                  placeholder="/api/users/:id"
                  className="w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs font-mono text-slate-200 focus:outline-none"
                />
              </div>
            </div>

            {/* Status + Delay */}
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs text-slate-400 mb-1">Status Code</label>
                <select
                  value={route.statusCode}
                  onChange={e => updateField('statusCode', parseInt(e.target.value, 10))}
                  className="w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
                >
                  {STATUS_CODES.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="w-36">
                <label className="block text-xs text-slate-400 mb-1">Delay (ms)</label>
                <input
                  type="number"
                  min={0}
                  max={30000}
                  value={route.delay}
                  onChange={e => updateField('delay', Math.max(0, parseInt(e.target.value, 10) || 0))}
                  className="w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
                />
              </div>
            </div>

            {/* Response Headers */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">Response Headers</label>
              <div className="space-y-1">
                {headerRows.map((h, i) => (
                  <div key={i} className="flex gap-1.5 group">
                    <input
                      value={h.key}
                      onChange={e => updateHeader(i, 'key', e.target.value)}
                      placeholder="Header-Name"
                      className="flex-1 bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none"
                    />
                    <input
                      value={h.value}
                      onChange={e => updateHeader(i, 'value', e.target.value)}
                      placeholder="value"
                      className="flex-1 bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none"
                    />
                    <button
                      onClick={() => removeHeader(i)}
                      className="text-slate-600 hover:text-red-400 text-base opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                    >×</button>
                  </div>
                ))}
              </div>
              <button
                onClick={addHeader}
                className="mt-1 text-xs text-slate-500 hover:text-orange-400 transition-colors"
              >+ Add header</button>
            </div>

            {/* Response Body */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Response Body
                <span className="ml-2 font-normal text-slate-600">
                  supports <code className="font-mono text-slate-500">{'{{param.id}}'}</code>{' '}
                  <code className="font-mono text-slate-500">{'{{query.page}}'}</code>{' '}
                  <code className="font-mono text-slate-500">{'{{body.field}}'}</code>
                </span>
              </label>
              <textarea
                value={route.responseBody}
                onChange={e => updateField('responseBody', e.target.value)}
                rows={10}
                spellCheck={false}
                className="w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs font-mono text-slate-200 focus:outline-none resize-y"
              />
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-700 shrink-0">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!route.path.trim()}
              className="px-4 py-1.5 bg-orange-600 hover:bg-orange-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs rounded font-medium transition-colors"
            >
              Save Route
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Main Panel ────────────────────────────────────────────────────────────────

export default function MockServerPanel() {
  const { state, dispatch } = useApp();
  const { mockRoutes, mockServerRunning, mockPort } = state;

  const [portInput, setPortInput] = useState(String(mockPort));
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingRoute, setEditingRoute] = useState<MockRoute | null>(null);
  const [isNew, setIsNew] = useState(false);

  // On mount, sync server status
  useEffect(() => {
    getMockStatus()
      .then(s => {
        dispatch({ type: 'SET_MOCK_SERVER_RUNNING', payload: s.running });
        if (s.running) dispatch({ type: 'SET_MOCK_PORT', payload: s.port });
      })
      .catch(() => dispatch({ type: 'SET_MOCK_SERVER_RUNNING', payload: false }));
  }, [dispatch]);

  // Sync routes to server whenever routes change while running
  useEffect(() => {
    if (!mockServerRunning) return;
    syncMockRoutes(mockRoutes).catch(() => {});
  }, [mockRoutes, mockServerRunning]);

  async function handleToggle() {
    setError(null);
    setToggling(true);
    try {
      if (mockServerRunning) {
        await stopMockServer();
        dispatch({ type: 'SET_MOCK_SERVER_RUNNING', payload: false });
      } else {
        const port = parseInt(portInput, 10) || 3002;
        if (port < 1024 || port > 65535) {
          setError('Port must be between 1024 and 65535');
          setToggling(false);
          return;
        }
        await startMockServer(port, mockRoutes);
        dispatch({ type: 'SET_MOCK_PORT', payload: port });
        dispatch({ type: 'SET_MOCK_SERVER_RUNNING', payload: true });
      }
    } catch (err: any) {
      setError(err?.response?.data?.error ?? err?.message ?? 'Failed');
    } finally {
      setToggling(false);
    }
  }

  function openNewRoute() {
    setIsNew(true);
    setEditingRoute(emptyRoute());
  }

  function openEditRoute(route: MockRoute) {
    setIsNew(false);
    setEditingRoute({ ...route });
  }

  const handleSaveRoute = useCallback((saved: MockRoute) => {
    if (isNew) {
      dispatch({ type: 'ADD_MOCK_ROUTE', payload: saved });
    } else {
      dispatch({ type: 'UPDATE_MOCK_ROUTE', payload: saved });
    }
    setEditingRoute(null);
  }, [isNew, dispatch]);

  function handleDelete(id: string) {
    dispatch({ type: 'DELETE_MOCK_ROUTE', payload: id });
  }

  function handleToggleRoute(route: MockRoute) {
    dispatch({ type: 'UPDATE_MOCK_ROUTE', payload: { ...route, enabled: !route.enabled } });
  }

  function methodColor(method: string) {
    switch (method) {
      case 'GET': return 'text-green-400';
      case 'POST': return 'text-yellow-400';
      case 'PUT': return 'text-blue-400';
      case 'PATCH': return 'text-orange-400';
      case 'DELETE': return 'text-red-400';
      case '*': return 'text-purple-400';
      default: return 'text-slate-400';
    }
  }

  const mockUrl = `http://localhost:${mockPort}`;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-slate-950 text-slate-100">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-800 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Mock Server</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Define static or dynamic responses for endpoints — no backend required.
            </p>
          </div>
          <button
            onClick={openNewRoute}
            className="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded font-medium transition-colors"
          >
            + Add Route
          </button>
        </div>

        {/* Server controls */}
        <div className="flex items-center gap-3 bg-slate-900 border border-slate-700 rounded-lg px-4 py-3">
          {/* Status dot */}
          <span className={`w-2 h-2 rounded-full shrink-0 ${mockServerRunning ? 'bg-green-400 shadow-[0_0_6px_#4ade80]' : 'bg-slate-600'}`} />

          <div className="flex-1 min-w-0">
            {mockServerRunning ? (
              <p className="text-xs text-slate-300">
                Running on{' '}
                <a
                  href={mockUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-orange-400 hover:underline font-mono"
                >
                  {mockUrl}
                </a>
              </p>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400 shrink-0">Port</span>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={portInput}
                  onChange={e => setPortInput(e.target.value)}
                  disabled={mockServerRunning}
                  className="w-24 bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none disabled:opacity-40"
                />
              </div>
            )}
          </div>

          <button
            onClick={handleToggle}
            disabled={toggling}
            className={`px-4 py-1.5 text-xs rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-wait ${
              mockServerRunning
                ? 'bg-red-700 hover:bg-red-600 text-white'
                : 'bg-green-700 hover:bg-green-600 text-white'
            }`}
          >
            {toggling ? (mockServerRunning ? 'Stopping…' : 'Starting…') : (mockServerRunning ? 'Stop' : 'Start')}
          </button>
        </div>

        {error && (
          <p className="mt-2 text-xs text-red-400 bg-red-950/40 border border-red-800/50 rounded px-3 py-2">
            {error}
          </p>
        )}
      </div>

      {/* Routes list */}
      <div className="flex-1 overflow-y-auto px-5 py-3">
        {mockRoutes.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center pb-16">
            <p className="text-3xl mb-3">🎭</p>
            <p className="text-sm font-medium text-slate-300 mb-1">No mock routes yet</p>
            <p className="text-xs text-slate-500 mb-4 max-w-xs">
              Add routes to intercept HTTP requests and return custom responses — great for frontend development without a real backend.
            </p>
            <button
              onClick={openNewRoute}
              className="px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded font-medium transition-colors"
            >
              + Add Your First Route
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Column headers */}
            <div className="grid grid-cols-[24px_100px_1fr_60px_60px_72px] gap-2 px-3 py-1 text-xs text-slate-600 uppercase tracking-wider">
              <span />
              <span>Method</span>
              <span>Path</span>
              <span>Status</span>
              <span>Delay</span>
              <span />
            </div>

            {mockRoutes.map(route => (
              <div
                key={route.id}
                className={`grid grid-cols-[24px_100px_1fr_60px_60px_72px] gap-2 items-center bg-slate-900 border rounded-lg px-3 py-2.5 transition-colors ${
                  route.enabled ? 'border-slate-700 hover:border-slate-600' : 'border-slate-800 opacity-50'
                }`}
              >
                {/* Toggle enabled */}
                <input
                  type="checkbox"
                  checked={route.enabled}
                  onChange={() => handleToggleRoute(route)}
                  title={route.enabled ? 'Disable route' : 'Enable route'}
                  className="accent-orange-500 cursor-pointer"
                />

                {/* Method badge */}
                <span className={`text-xs font-mono font-bold ${methodColor(route.method)}`}>
                  {route.method === '*' ? 'ANY' : route.method}
                </span>

                {/* Path + description */}
                <div className="min-w-0">
                  <p className="text-xs font-mono text-slate-200 truncate">{route.path}</p>
                  {route.description && (
                    <p className="text-xs text-slate-500 truncate mt-0.5">{route.description}</p>
                  )}
                </div>

                {/* Status code */}
                <span className={`text-xs font-mono ${route.statusCode >= 400 ? 'text-red-400' : route.statusCode >= 300 ? 'text-yellow-400' : 'text-green-400'}`}>
                  {route.statusCode}
                </span>

                {/* Delay */}
                <span className="text-xs text-slate-500">
                  {route.delay > 0 ? `${route.delay}ms` : '—'}
                </span>

                {/* Actions */}
                <div className="flex items-center gap-1 justify-end">
                  <button
                    onClick={() => openEditRoute(route)}
                    title="Edit route"
                    className="px-2 py-1 text-xs text-slate-500 hover:text-slate-200 hover:bg-slate-700 rounded transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(route.id)}
                    title="Delete route"
                    className="px-2 py-1 text-xs text-slate-600 hover:text-red-400 hover:bg-slate-700 rounded transition-colors"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Usage hint */}
      {mockRoutes.length > 0 && mockServerRunning && (
        <div className="px-5 py-3 border-t border-slate-800 shrink-0">
          <p className="text-xs text-slate-500">
            Tip: Use <code className="font-mono text-slate-400">{'{{param.id}}'}</code>,{' '}
            <code className="font-mono text-slate-400">{'{{query.page}}'}</code>, or{' '}
            <code className="font-mono text-slate-400">{'{{body.field}}'}</code> in the response body for dynamic substitution.
          </p>
        </div>
      )}

      {/* Route editor modal */}
      {editingRoute && (
        <RouteEditorModal
          initial={editingRoute}
          onSave={handleSaveRoute}
          onClose={() => setEditingRoute(null)}
        />
      )}
    </div>
  );
}
