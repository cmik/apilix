import { useState, useEffect, useCallback, useRef } from 'react';
import { useApp, generateId } from '../store';
import type { MockRoute, MockCollection, AppCollection, CollectionItem, MockLogEntry, MockRouteRule, MockRouteChaos, WsOnConnectEvent, WsMessageHandler } from '../types';
import { startMockServer, stopMockServer, syncMockRoutes, getMockStatus, getMockLog, clearMockLog, getMockDb, clearMockDb } from '../api';
import ScriptEditor from './ScriptEditor';
import ScriptSnippetsLibrary from './ScriptSnippetsLibrary';
import ConfirmModal from './ConfirmModal';
import { useToast } from './Toast';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', '*'];
const STATUS_CODES = [200, 201, 204, 301, 302, 400, 401, 403, 404, 409, 422, 500, 502, 503];

const RULE_SOURCES: Array<{ value: MockRouteRule['source']; label: string }> = [
  { value: 'header', label: 'Header' },
  { value: 'query',  label: 'Query'  },
  { value: 'body',   label: 'Body'   },
  { value: 'param',  label: 'Param'  },
];

const RULE_OPERATORS: Array<{ value: MockRouteRule['operator']; label: string; hasValue: boolean }> = [
  { value: 'exists',      label: 'exists',       hasValue: false },
  { value: 'not-exists',  label: 'not exists',   hasValue: false },
  { value: 'equals',      label: '=',            hasValue: true  },
  { value: 'not-equals',  label: '≠',            hasValue: true  },
  { value: 'contains',    label: 'contains',     hasValue: true  },
  { value: 'starts-with', label: 'starts with',  hasValue: true  },
];

const SKIP_RESPONSE_HEADERS = new Set([
  'content-encoding', 'transfer-encoding', 'connection', 'keep-alive',
  ':status', 'set-cookie', 'alt-svc', 'x-content-type-options',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptyRule(): MockRouteRule {
  return {
    id: generateId(),
    source: 'header',
    field: '',
    operator: 'exists',
    value: '',
    statusCode: 401,
    responseBody: '{"error":"Unauthorized"}',
  };
}

function emptyWsOnConnectEvent(): WsOnConnectEvent {
  return { id: generateId(), payload: '', delay: 0 };
}

function emptyWsMessageHandler(): WsMessageHandler {
  return { id: generateId(), matchPattern: '', response: '' };
}

function emptyRoute(collectionId?: string): MockRoute {
  return {
    id: generateId(),
    enabled: true,
    collectionId,
    type: 'http',
    method: 'GET',
    path: '/api/example',
    statusCode: 200,
    responseHeaders: [{ key: 'Content-Type', value: 'application/json' }],
    responseBody: '{\n  "message": "Hello from mock!"\n}',
    delay: 0,
    description: '',
    rules: [],
    script: '',
    wsOnConnect: [],
    wsMessageHandlers: [],
  };
}

function getEffectiveRoutes(routes: MockRoute[], collections: MockCollection[]): MockRoute[] {
  const colMap = new Map(collections.map(c => [c.id, c]));
  return routes.map(r => {
    if (!r.collectionId) return r;
    const col = colMap.get(r.collectionId);
    if (!col || !col.enabled) return { ...r, enabled: false };
    return r;
  });
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

function flattenRequests(items: CollectionItem[]): CollectionItem[] {
  const result: CollectionItem[] = [];
  for (const item of items) {
    if (item.item) {
      result.push(...flattenRequests(item.item));
    } else if (item.request) {
      result.push(item);
    }
  }
  return result;
}

function extractPath(url: unknown): string {
  if (!url) return '/';
  const raw = typeof url === 'string' ? url : (url as any)?.raw ?? '';
  try {
    return new URL(raw).pathname || '/';
  } catch {
    if (raw.startsWith('/')) return raw.split('?')[0];
    const withoutProto = raw.replace(/^https?:\/\/[^/]+/, '');
    return (withoutProto || '/').split('?')[0] || '/';
  }
}

function collectionItemToMockRoute(item: CollectionItem, collectionId?: string): MockRoute {
  const req = item.request!;
  const method = (req.method ?? 'GET').toUpperCase();
  const path = extractPath(req.url);
  return {
    id: generateId(),
    enabled: true,
    collectionId,
    method,
    path,
    statusCode: 200,
    responseHeaders: [{ key: 'Content-Type', value: 'application/json' }],
    responseBody: '{\n  "ok": true\n}',
    delay: 0,
    description: item.name,
  };
}

// ─── HAR types ────────────────────────────────────────────────────────────────

interface HarHeader { name: string; value: string; }
interface HarContent { mimeType?: string; text?: string; encoding?: string; }
interface HarResponse { status: number; statusText?: string; headers?: HarHeader[]; content?: HarContent; }
interface HarRequest { method: string; url: string; }
interface HarEntry { request: HarRequest; response: HarResponse; }

function parseHarEntries(text: string): HarEntry[] {
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { throw new Error('Invalid JSON'); }
  if (!parsed?.log?.entries) throw new Error('Not a valid HAR file — missing "log.entries".');
  return parsed.log.entries as HarEntry[];
}

function harEntryToMockRoute(entry: HarEntry, collectionId?: string): MockRoute {
  const method = (entry.request.method ?? 'GET').toUpperCase();
  let path = '/';
  try { path = new URL(entry.request.url).pathname || '/'; } catch { path = '/'; }

  const responseHeaders = (entry.response.headers ?? [])
    .filter(h => !SKIP_RESPONSE_HEADERS.has(h.name.toLowerCase()))
    .map(h => ({ key: h.name, value: h.value }));

  let responseBody = entry.response.content?.text ?? '';
  if (entry.response.content?.encoding === 'base64' && responseBody) {
    try { responseBody = atob(responseBody); } catch { responseBody = ''; }
  }

  return {
    id: generateId(),
    enabled: true,
    collectionId,
    method,
    path,
    statusCode: entry.response.status ?? 200,
    responseHeaders,
    responseBody,
    delay: 0,
    description: `${method} ${path}`,
  };
}

// ─── Route Row ────────────────────────────────────────────────────────────────

function RouteRow({
  route, onEdit, onDelete, onToggle, indent = false,
}: {
  route: MockRoute; onEdit: () => void; onDelete: () => void; onToggle: () => void; indent?: boolean;
}) {
  const isWs = route.type === 'websocket';
  const statusColor = route.statusCode >= 500 ? 'text-red-400' : route.statusCode >= 400 ? 'text-orange-400' : route.statusCode >= 300 ? 'text-yellow-400' : 'text-green-400';
  return (
    <div className={`grid grid-cols-[20px_90px_1fr_52px_52px_64px] gap-2 items-center bg-slate-900 border rounded-lg px-3 py-2 transition-colors ${
      route.enabled ? 'border-slate-700 hover:border-slate-600' : 'border-slate-800 opacity-50'
    } ${indent ? 'ml-6' : ''}`}>
      <input type="checkbox" checked={route.enabled} onChange={onToggle} title={route.enabled ? 'Disable route' : 'Enable route'} className="accent-orange-500 cursor-pointer" />
      {isWs
        ? <span className="text-xs font-mono font-bold text-purple-400">WS</span>
        : <span className={`text-xs font-mono font-bold ${methodColor(route.method)}`}>{route.method === '*' ? 'ANY' : route.method}</span>
      }
      <div className="min-w-0">
        <p className="text-xs font-mono text-slate-200 truncate">{route.path}</p>
        {route.description && <p className="text-xs text-slate-500 truncate mt-0.5">{route.description}</p>}
      </div>
      <span className={`text-xs font-mono ${isWs ? 'text-slate-600' : statusColor}`}>{isWs ? '—' : route.statusCode}</span>
      <span className="text-xs text-slate-500">{!isWs && route.delay > 0 ? `${route.delay}ms` : '—'}</span>
      <div className="flex items-center gap-1 justify-end">
        <button onClick={onEdit} className="px-2 py-1 text-xs text-slate-500 hover:text-slate-200 hover:bg-slate-700 rounded transition-colors">Edit</button>
        <button onClick={onDelete} className="px-2 py-1 text-xs text-slate-600 hover:text-red-400 hover:bg-slate-700 rounded transition-colors">✕</button>
      </div>
    </div>
  );
}

// ─── Collection Section ───────────────────────────────────────────────────────

function CollectionSection({
  collection, routes, onToggleCollection, onDeleteCollection, onRenameCollection,
  onAddRoute, onEditRoute, onDeleteRoute, onToggleRoute,
}: {
  collection: MockCollection; routes: MockRoute[];
  onToggleCollection: () => void; onDeleteCollection: () => void;
  onRenameCollection: (name: string) => void; onAddRoute: () => void;
  onEditRoute: (r: MockRoute) => void; onDeleteRoute: (id: string) => void;
  onToggleRoute: (r: MockRoute) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [nameInput, setNameInput] = useState(collection.name);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (renaming) nameRef.current?.select(); }, [renaming]);

  function commitRename() {
    const trimmed = nameInput.trim();
    if (trimmed) onRenameCollection(trimmed); else setNameInput(collection.name);
    setRenaming(false);
  }

  return (
    <div className="space-y-1">
      <div className={`flex items-center gap-2 bg-slate-800/60 border rounded-lg px-3 py-2 ${collection.enabled ? 'border-slate-700' : 'border-slate-800 opacity-60'}`}>
        <button onClick={() => setExpanded(e => !e)} className="text-slate-500 hover:text-slate-200 transition-colors text-xs w-4 shrink-0" title={expanded ? 'Collapse' : 'Expand'}>
          {expanded ? '▾' : '▸'}
        </button>
        <input type="checkbox" checked={collection.enabled} onChange={onToggleCollection} title={collection.enabled ? 'Disable collection' : 'Enable collection'} className="accent-orange-500 cursor-pointer shrink-0" />
        {renaming ? (
          <input
            ref={nameRef}
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { setNameInput(collection.name); setRenaming(false); } }}
            className="flex-1 bg-slate-700 border border-orange-500 rounded px-2 py-0.5 text-xs text-slate-200 focus:outline-none"
          />
        ) : (
          <span className="flex-1 text-xs font-medium text-slate-200 truncate cursor-pointer" onDoubleClick={() => setRenaming(true)} title="Double-click to rename">
            {collection.name}
          </span>
        )}
        <span className="text-xs text-slate-500 shrink-0">{routes.length} route{routes.length !== 1 ? 's' : ''}</span>
        <button onClick={() => setRenaming(true)} title="Rename" className="text-slate-600 hover:text-slate-300 text-xs transition-colors shrink-0">✎</button>
        <button onClick={onAddRoute} title="Add route to collection" className="text-slate-500 hover:text-orange-400 text-xs transition-colors shrink-0">+ Route</button>
        <button onClick={() => setDeleteConfirm(true)} title="Delete collection" className="text-slate-600 hover:text-red-400 text-xs transition-colors shrink-0">✕</button>
      </div>
      {expanded && routes.length > 0 && (
        <div className="space-y-1 pl-4">
          {routes.map(route => (
            <RouteRow key={route.id} route={route} onEdit={() => onEditRoute(route)} onDelete={() => onDeleteRoute(route.id)} onToggle={() => onToggleRoute(route)} />
          ))}
        </div>
      )}
      {expanded && routes.length === 0 && (
        <div className="pl-4"><p className="text-xs text-slate-600 italic py-1">No routes — click "+ Route" to add one.</p></div>
      )}

      {deleteConfirm && (
        <ConfirmModal
          title="Delete collection?"
          message={<>Delete <strong className="text-slate-200">{collection.name}</strong>? Its routes will become uncollected. This cannot be undone.</>}
          confirmLabel="Delete"
          onConfirm={() => { setDeleteConfirm(false); onDeleteCollection(); }}
          onCancel={() => setDeleteConfirm(false)}
        />
      )}
    </div>
  );
}

// ─── Route Editor Modal ────────────────────────────────────────────────────────

function RouteEditorModal({ initial, collections, onSave, onClose }: {
  initial: MockRoute; collections: MockCollection[];
  onSave: (r: MockRoute) => void; onClose: () => void;
}) {
  const [route, setRoute] = useState<MockRoute>({ ...initial });
  const [headerRows, setHeaderRows] = useState(
    initial.responseHeaders.length > 0 ? [...initial.responseHeaders] : [{ key: '', value: '' }]
  );
  const [rules, setRules] = useState<MockRouteRule[]>(initial.rules ?? []);
  const [script, setScript] = useState(initial.script ?? '');
  const [showRules, setShowRules] = useState((initial.rules ?? []).length > 0);
  const [showScript, setShowScript] = useState(!!initial.script);
  const [chaosEnabled, setChaosEnabled] = useState(initial.chaos?.enabled ?? false);
  const [chaosErrorRate, setChaosErrorRate] = useState(initial.chaos?.errorRate ?? 0);
  const [chaosDropRate, setChaosDropRate] = useState(initial.chaos?.dropRate ?? 0);
  const [chaosThrottleKbps, setChaosThrottleKbps] = useState(initial.chaos?.throttleKbps ?? 0);
  const [showChaos, setShowChaos] = useState(initial.chaos?.enabled ?? false);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [wsOnConnect, setWsOnConnect] = useState<WsOnConnectEvent[]>(initial.wsOnConnect ?? []);
  const [wsHandlers, setWsHandlers] = useState<WsMessageHandler[]>(initial.wsMessageHandlers ?? []);
  const scriptTextareaRef = useRef<HTMLTextAreaElement>(null);

  const isWs = route.type === 'websocket';

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function updateField<K extends keyof MockRoute>(k: K, v: MockRoute[K]) {
    setRoute(r => ({ ...r, [k]: v }));
  }

  function updateRule(id: string, patch: Partial<MockRouteRule>) {
    setRules(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
  }

  const handleInsertMockSnippet = useCallback((code: string) => {
    const el = scriptTextareaRef.current;
    if (!el) {
      setScript(prev => prev ? prev + '\n\n' + code : code);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const separator = (script.length > 0 && !script.endsWith('\n')) ? '\n\n' : (script.length > 0 ? '\n' : '');
    const before = script.slice(0, start);
    const after = script.slice(end);
    const insertion = (start === end && start === script.length ? separator : '') + code;
    setScript(before + insertion + after);
    requestAnimationFrame(() => {
      const insertPos = start + insertion.length;
      el.focus();
      el.setSelectionRange(insertPos, insertPos);
    });
    setShowScript(true);
    setScriptError(null);
  }, [script]);

  function handleSave() {
    if (!isWs && script.trim()) {
      try {
        // eslint-disable-next-line no-new-func
        new Function(script);
        setScriptError(null);
      } catch (e: any) {
        const msg = e?.message ?? 'Syntax error';
        setScriptError(msg);
        setShowScript(true);
        return;
      }
    } else {
      setScriptError(null);
    }
    const headers = headerRows.filter(h => h.key.trim());
    const chaos: MockRouteChaos = { enabled: chaosEnabled, errorRate: chaosErrorRate, dropRate: chaosDropRate, throttleKbps: chaosThrottleKbps };
    onSave({ ...route, responseHeaders: headers, rules, script, chaos, wsOnConnect, wsMessageHandlers: wsHandlers });
    onClose();
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700 shrink-0">
            <h2 className="text-sm font-semibold text-white">{initial.description === '' && initial.path === '/api/example' ? 'New Mock Route' : 'Edit Mock Route'}</h2>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none">×</button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

            {/* ── Type toggle ── */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">Type</label>
              <div className="flex rounded-lg overflow-hidden border border-slate-700 w-fit">
                {(['http', 'websocket'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => updateField('type', t)}
                    className={`px-4 py-1.5 text-xs font-medium transition-colors ${
                      route.type === t
                        ? t === 'websocket' ? 'bg-purple-700 text-white' : 'bg-orange-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {t === 'http' ? 'HTTP' : 'WebSocket'}
                  </button>
                ))}
              </div>
            </div>

            {collections.length > 0 && (
              <div>
                <label className="block text-xs text-slate-400 mb-1">Collection (optional)</label>
                <select
                  value={route.collectionId ?? ''}
                  onChange={e => updateField('collectionId', e.target.value || undefined)}
                  className="w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
                >
                  <option value="">— No collection —</option>
                  {collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs text-slate-400 mb-1">Description (optional)</label>
              <input value={route.description} onChange={e => updateField('description', e.target.value)} placeholder="Describe this mock route…" className="w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none" />
            </div>

            {/* HTTP fields */}
            {!isWs && (
              <>
                <div className="flex gap-2">
                  <div className="shrink-0">
                    <label className="block text-xs text-slate-400 mb-1">Method</label>
                    <select value={route.method} onChange={e => updateField('method', e.target.value)} className="bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none">
                      {METHODS.map(m => <option key={m} value={m}>{m === '*' ? 'ANY' : m}</option>)}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className="block text-xs text-slate-400 mb-1">Path</label>
                    <input value={route.path} onChange={e => updateField('path', e.target.value)} placeholder="/api/users/:id" className="w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs font-mono text-slate-200 focus:outline-none" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="block text-xs text-slate-400 mb-1">Status Code</label>
                    <select value={route.statusCode} onChange={e => updateField('statusCode', parseInt(e.target.value, 10))} className="w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none">
                      {STATUS_CODES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div className="w-36">
                    <label className="block text-xs text-slate-400 mb-1">Delay (ms)</label>
                    <input type="number" min={0} max={30000} value={route.delay} onChange={e => updateField('delay', Math.max(0, parseInt(e.target.value, 10) || 0))} className="w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Response Headers</label>
                  <div className="space-y-1">
                    {headerRows.map((h, i) => (
                      <div key={i} className="flex gap-1.5 group">
                        <input value={h.key} onChange={e => setHeaderRows(rows => rows.map((r, idx) => idx === i ? { ...r, key: e.target.value } : r))} placeholder="Header-Name" className="flex-1 bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none" />
                        <input value={h.value} onChange={e => setHeaderRows(rows => rows.map((r, idx) => idx === i ? { ...r, value: e.target.value } : r))} placeholder="value" className="flex-1 bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none" />
                        <button onClick={() => setHeaderRows(rows => rows.filter((_, idx) => idx !== i))} className="text-slate-600 hover:text-red-400 text-base opacity-0 group-hover:opacity-100 transition-opacity shrink-0">×</button>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => setHeaderRows(rows => [...rows, { key: '', value: '' }])} className="mt-1 text-xs text-slate-500 hover:text-orange-400 transition-colors">+ Add header</button>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    Response Body
                    <span className="ml-2 font-normal text-slate-600">
                      <code className="font-mono text-slate-500">{'{{param.id}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{query.page}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{body.field}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{header.x}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{method}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{$uuid}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{$randomInt(1,100)}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{$randomItem(a,b,c)}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{$requestCount}}'}</code>
                    </span>
                  </label>
                  <textarea value={route.responseBody} onChange={e => updateField('responseBody', e.target.value)} rows={10} spellCheck={false} className="w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs font-mono text-slate-200 focus:outline-none resize-y" />
                </div>

                {/* ── Chaos Mode ── */}
                <div className="border border-slate-700 rounded-lg overflow-hidden">
                  <button
                    onClick={() => setShowChaos(s => !s)}
                    className="w-full flex items-center justify-between px-3 py-2 bg-slate-800/60 hover:bg-slate-800 transition-colors text-left"
                  >
                    <span className="text-xs font-medium text-slate-300 flex items-center gap-2">
                      Chaos Mode
                      {chaosEnabled && <span className="px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded text-xs">active</span>}
                    </span>
                    <span className="text-slate-500 text-xs">{showChaos ? '▴' : '▾'}</span>
                  </button>
                  {showChaos && (
                    <div className="px-3 py-3 space-y-3">
                      <p className="text-xs text-slate-500">Inject real-world failures on this route for resilience testing. Applies after scripting and rules.</p>
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={chaosEnabled}
                          onChange={e => setChaosEnabled(e.target.checked)}
                          className="accent-red-500"
                        />
                        <span className="text-xs text-slate-300">Enable Chaos</span>
                      </label>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Error Rate (%)</label>
                          <input
                            type="number" min={0} max={100} step={1}
                            value={chaosErrorRate}
                            onChange={e => setChaosErrorRate(Math.min(100, Math.max(0, parseInt(e.target.value, 10) || 0)))}
                            className="w-full bg-slate-800 border border-slate-700 focus:border-red-500 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
                          />
                          <p className="mt-0.5 text-xs text-slate-600">% chance → 500</p>
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Drop Rate (%)</label>
                          <input
                            type="number" min={0} max={100} step={1}
                            value={chaosDropRate}
                            onChange={e => setChaosDropRate(Math.min(100, Math.max(0, parseInt(e.target.value, 10) || 0)))}
                            className="w-full bg-slate-800 border border-slate-700 focus:border-red-500 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
                          />
                          <p className="mt-0.5 text-xs text-slate-600">% chance → no response</p>
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Bandwidth (KB/s)</label>
                          <input
                            type="number" min={0} step={1}
                            value={chaosThrottleKbps}
                            onChange={e => setChaosThrottleKbps(Math.max(0, parseInt(e.target.value, 10) || 0))}
                            className="w-full bg-slate-800 border border-slate-700 focus:border-red-500 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
                          />
                          <p className="mt-0.5 text-xs text-slate-600">0 = unlimited</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* ── Rules ── */}
                <div className="border border-slate-700 rounded-lg overflow-hidden">
                  <button
                    onClick={() => setShowRules(s => !s)}
                    className="w-full flex items-center justify-between px-3 py-2 bg-slate-800/60 hover:bg-slate-800 transition-colors text-left"
                  >
                    <span className="text-xs font-medium text-slate-300 flex items-center gap-2">
                      Conditional Rules
                      {rules.length > 0 && <span className="px-1.5 py-0.5 bg-orange-500/20 text-orange-400 rounded text-xs">{rules.length}</span>}
                    </span>
                    <span className="text-slate-500 text-xs">{showRules ? '▴' : '▾'}</span>
                  </button>
                  {showRules && (
                    <div className="px-3 py-3 space-y-2">
                      <p className="text-xs text-slate-500">Rules are evaluated in order. The first match overrides the default response.</p>
                      {rules.map((rule, i) => {
                        const opDef = RULE_OPERATORS.find(o => o.value === rule.operator)!;
                        return (
                          <div key={rule.id} className="border border-slate-700 rounded-lg p-3 space-y-2 bg-slate-900">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-xs text-slate-500 shrink-0">If</span>
                              <select
                                value={rule.source}
                                onChange={e => updateRule(rule.id, { source: e.target.value as MockRouteRule['source'] })}
                                className="bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none"
                              >
                                {RULE_SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                              </select>
                              <input
                                value={rule.field}
                                onChange={e => updateRule(rule.id, { field: e.target.value })}
                                placeholder="field"
                                className="flex-1 min-w-[80px] bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none"
                              />
                              <select
                                value={rule.operator}
                                onChange={e => updateRule(rule.id, { operator: e.target.value as MockRouteRule['operator'] })}
                                className="bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none"
                              >
                                {RULE_OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                              {opDef.hasValue && (
                                <input
                                  value={rule.value}
                                  onChange={e => updateRule(rule.id, { value: e.target.value })}
                                  placeholder="value"
                                  className="flex-1 min-w-[80px] bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none"
                                />
                              )}
                              <button onClick={() => setRules(rs => rs.filter(r => r.id !== rule.id))} className="text-slate-600 hover:text-red-400 text-base transition-colors ml-auto shrink-0">×</button>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs text-slate-500 shrink-0">→ respond</span>
                              <select
                                value={rule.statusCode}
                                onChange={e => updateRule(rule.id, { statusCode: parseInt(e.target.value, 10) })}
                                className="bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none"
                              >
                                {STATUS_CODES.map(s => <option key={s} value={s}>{s}</option>)}
                              </select>
                              <input
                                value={rule.responseBody}
                                onChange={e => updateRule(rule.id, { responseBody: e.target.value })}
                                placeholder='{"error":"..."}  or any body'
                                className="flex-1 bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none"
                              />
                            </div>
                            {i < rules.length - 1 && <p className="text-xs text-slate-600 italic">↓ else check next rule…</p>}
                          </div>
                        );
                      })}
                      <button
                        onClick={() => setRules(rs => [...rs, emptyRule()])}
                        className="text-xs text-orange-400 hover:text-orange-300 transition-colors"
                      >
                        + Add Rule
                      </button>
                    </div>
                  )}
                </div>

                {/* ── Script ── */}
                <div className="border border-slate-700 rounded-lg overflow-hidden">
                  <button
                    onClick={() => setShowScript(s => !s)}
                    className="w-full flex items-center justify-between px-3 py-2 bg-slate-800/60 hover:bg-slate-800 transition-colors text-left"
                  >
                    <span className="text-xs font-medium text-slate-300 flex items-center gap-2">
                      Response Script
                      {script.trim() && !scriptError && <span className="px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded text-xs">active</span>}
                      {scriptError && <span className="px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded text-xs">syntax error</span>}
                    </span>
                    <span className="text-slate-500 text-xs">{showScript ? '▴' : '▾'}</span>
                  </button>
                  {showScript && (
                    <div className="px-3 py-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs text-slate-500">
                          JavaScript snippet. Runs before rules and default response. Call <code className="font-mono text-slate-400">respond(status, body)</code> to override.
                        </p>
                        <ScriptSnippetsLibrary target="mock" onInsert={handleInsertMockSnippet} />
                      </div>
                      <p className="text-xs text-slate-600">
                        Persistent state helpers: <code className="font-mono text-slate-500">db.get</code>, <code className="font-mono text-slate-500">db.set</code>, <code className="font-mono text-slate-500">db.push</code>, <code className="font-mono text-slate-500">db.findById</code>, <code className="font-mono text-slate-500">db.upsertById</code>, <code className="font-mono text-slate-500">db.removeById</code>, <code className="font-mono text-slate-500">db.clear</code>.
                      </p>
                      <ScriptEditor
                        textareaRef={scriptTextareaRef}
                        variant="mock"
                        value={script}
                        onChange={setScript}
                        rows={8}
                        placeholder={`// Available: req.method, req.path, req.headers, req.query, req.params, req.body, req.requestCount\n// respond(status, body[, headers])\n// db.get/set/push/findById/upsertById/removeById/clear\n\nif (req.method === 'POST') {\n  const created = db.push('users', { id: Date.now().toString(), ...req.body });\n  respond(201, created);\n} else {\n  respond(200, db.list('users'));\n}`}
                        className="w-full bg-slate-800 border border-slate-700 focus:border-blue-500 rounded px-2 py-1.5 text-xs font-mono text-slate-200 focus:outline-none resize-y"
                      />
                      {scriptError && (
                        <p className="text-xs text-red-400 bg-red-950/40 border border-red-800/50 rounded px-3 py-2 font-mono">{scriptError}</p>
                      )}
                      <p className="text-xs text-slate-600">Priority: Script → Rules → Default response. Timeout: 2 s.</p>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* WebSocket fields */}
            {isWs && (
              <>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Path</label>
                  <input value={route.path} onChange={e => updateField('path', e.target.value)} placeholder="/ws/events" className="w-full bg-slate-800 border border-slate-700 focus:border-purple-500 rounded px-2 py-1.5 text-xs font-mono text-slate-200 focus:outline-none" />
                  <p className="mt-1 text-xs text-slate-600">Connect with <code className="font-mono">ws://localhost:{'{port}'}{route.path || '/ws/...'}</code></p>
                </div>

                {/* On-Connect Events */}
                <div className="border border-slate-700 rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 bg-slate-800/60">
                    <span className="text-xs font-medium text-slate-300 flex items-center gap-2">
                      On-Connect Events
                      {wsOnConnect.length > 0 && <span className="px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded text-xs">{wsOnConnect.length}</span>}
                    </span>
                  </div>
                  <div className="px-3 py-3 space-y-2">
                    <p className="text-xs text-slate-500">Messages sent automatically when a client connects.</p>
                    <p className="text-xs text-slate-600">
                      Generators:{' '}
                      <code className="font-mono text-slate-500">{'{{$uuid}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{$timestamp}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{$isoDate}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{$randomInt(1,100)}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{$randomItem(a,b,c)}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{query.x}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{param.id}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{header.x}}'}</code>
                    </p>
                    {wsOnConnect.map((ev, i) => (
                      <div key={ev.id} className="border border-slate-700 rounded-lg p-3 space-y-2 bg-slate-900">
                        <div className="flex items-start gap-2">
                          <textarea
                            value={ev.payload}
                            onChange={e => setWsOnConnect(evs => evs.map((x, idx) => idx === i ? { ...x, payload: e.target.value } : x))}
                            placeholder='{"type":"welcome","message":"Connected!"}'
                            rows={3}
                            spellCheck={false}
                            className="flex-1 bg-slate-800 border border-slate-700 focus:border-purple-500 rounded px-2 py-1.5 text-xs font-mono text-slate-200 focus:outline-none resize-y"
                          />
                          <button onClick={() => setWsOnConnect(evs => evs.filter((_, idx) => idx !== i))} className="text-slate-600 hover:text-red-400 text-base transition-colors shrink-0 mt-1">×</button>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-xs text-slate-500 shrink-0">Delay (ms)</label>
                          <input
                            type="number" min={0} max={30000}
                            value={ev.delay ?? 0}
                            onChange={e => setWsOnConnect(evs => evs.map((x, idx) => idx === i ? { ...x, delay: Math.max(0, parseInt(e.target.value, 10) || 0) } : x))}
                            className="w-24 bg-slate-800 border border-slate-700 focus:border-purple-500 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none"
                          />
                        </div>
                      </div>
                    ))}
                    <button
                      onClick={() => setWsOnConnect(evs => [...evs, emptyWsOnConnectEvent()])}
                      className="text-xs text-purple-400 hover:text-purple-300 transition-colors"
                    >
                      + Add on-connect event
                    </button>
                  </div>
                </div>

                {/* Message Handlers */}
                <div className="border border-slate-700 rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 bg-slate-800/60">
                    <span className="text-xs font-medium text-slate-300 flex items-center gap-2">
                      Message Handlers
                      {wsHandlers.length > 0 && <span className="px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded text-xs">{wsHandlers.length}</span>}
                    </span>
                  </div>
                  <div className="px-3 py-3 space-y-2">
                    <p className="text-xs text-slate-500">When an incoming message exactly matches a pattern, the configured response is sent back. JSON and XML patterns are matched ignoring whitespace differences.</p>
                    <p className="text-xs text-slate-600">
                      Response generators:{' '}
                      <code className="font-mono text-slate-500">{'{{$uuid}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{$timestamp}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{$isoDate}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{$randomInt(1,100)}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{$randomItem(a,b,c)}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{body.field}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{query.x}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{param.id}}'}</code>{' '}
                      <code className="font-mono text-slate-500">{'{{$requestCount}}'}</code>
                    </p>
                    {wsHandlers.map((handler, i) => (
                      <div key={handler.id} className="border border-slate-700 rounded-lg p-3 space-y-2 bg-slate-900">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-slate-500 shrink-0">If message =</span>
                          <input
                            value={handler.matchPattern}
                            onChange={e => setWsHandlers(hs => hs.map((x, idx) => idx === i ? { ...x, matchPattern: e.target.value } : x))}
                            placeholder='{"action":"ping"}'
                            className="flex-1 bg-slate-800 border border-slate-700 focus:border-purple-500 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none"
                          />
                          <button onClick={() => setWsHandlers(hs => hs.filter((_, idx) => idx !== i))} className="text-slate-600 hover:text-red-400 text-base transition-colors shrink-0">×</button>
                        </div>
                        <div className="flex items-start gap-1.5">
                          <span className="text-xs text-slate-500 shrink-0 mt-2">→ send</span>
                          <textarea
                            value={handler.response}
                            onChange={e => setWsHandlers(hs => hs.map((x, idx) => idx === i ? { ...x, response: e.target.value } : x))}
                            placeholder='{"action":"pong"}'
                            rows={3}
                            spellCheck={false}
                            className="flex-1 bg-slate-800 border border-slate-700 focus:border-purple-500 rounded px-2 py-1.5 text-xs font-mono text-slate-200 focus:outline-none resize-y"
                          />
                        </div>
                      </div>
                    ))}
                    <button
                      onClick={() => setWsHandlers(hs => [...hs, emptyWsMessageHandler()])}
                      className="text-xs text-purple-400 hover:text-purple-300 transition-colors"
                    >
                      + Add message handler
                    </button>
                  </div>
                </div>
              </>
            )}

          </div>
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-700 shrink-0">
            <button onClick={onClose} className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors">Cancel</button>
            <button onClick={handleSave} disabled={!route.path.trim()} className="px-4 py-1.5 bg-orange-600 hover:bg-orange-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs rounded font-medium transition-colors">Save Route</button>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Import Routes Modal ──────────────────────────────────────────────────────

function ImportRoutesModal({ mockCollections, appCollections, onImport, onClose }: {
  mockCollections: MockCollection[]; appCollections: AppCollection[];
  onImport: (routes: MockRoute[]) => void; onClose: () => void;
}) {
  const [tab, setTab] = useState<'collection' | 'har'>('collection');
  const [targetCollectionId, setTargetCollectionId] = useState('');

  // From Collection state
  const [sourceColId, setSourceColId] = useState(appCollections[0]?._id ?? '');
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());

  // From HAR state
  const [harEntries, setHarEntries] = useState<HarEntry[]>([]);
  const [harError, setHarError] = useState<string | null>(null);
  const [harFilter, setHarFilter] = useState('');
  const [selectedHarIndices, setSelectedHarIndices] = useState<Set<number>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => { setSelectedItemIds(new Set()); }, [sourceColId]);

  const sourceCollection = appCollections.find(c => c._id === sourceColId);
  const flatRequests = sourceCollection ? flattenRequests(sourceCollection.item) : [];

  const filteredHarEntries = harEntries.filter(e => {
    if (!harFilter) return true;
    const lower = harFilter.toLowerCase();
    return e.request.url.toLowerCase().includes(lower) || e.request.method.toLowerCase().includes(lower);
  });

  function toggleItem(id: string) {
    setSelectedItemIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  function toggleHarEntry(idx: number) {
    setSelectedHarIndices(prev => { const next = new Set(prev); if (next.has(idx)) next.delete(idx); else next.add(idx); return next; });
  }

  async function handleHarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setHarError(null);
    try {
      const text = await file.text();
      const entries = parseHarEntries(text);
      setHarEntries(entries);
      setSelectedHarIndices(new Set(entries.map((_, i) => i)));
      setHarFilter('');
    } catch (err: any) {
      setHarError(err.message ?? 'Failed to parse HAR file');
      setHarEntries([]);
    }
    e.target.value = '';
  }

  function handleImport() {
    const target = targetCollectionId || undefined;
    let routes: MockRoute[] = [];
    if (tab === 'collection') {
      routes = flatRequests.filter(i => i.id && selectedItemIds.has(i.id)).map(i => collectionItemToMockRoute(i, target));
    } else {
      routes = harEntries
        .map((e, i) => ({ e, i }))
        .filter(({ i }) => selectedHarIndices.has(i))
        .map(({ e }) => harEntryToMockRoute(e, target));
    }
    if (routes.length > 0) onImport(routes);
    onClose();
  }

  const importCount = tab === 'collection' ? selectedItemIds.size : selectedHarIndices.size;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700 shrink-0">
            <h2 className="text-sm font-semibold text-white">Import Routes</h2>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none">×</button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-slate-700 shrink-0">
            {(['collection', 'har'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} className={`px-5 py-2.5 text-xs font-medium transition-colors ${tab === t ? 'text-orange-400 border-b-2 border-orange-500 -mb-px' : 'text-slate-400 hover:text-slate-200'}`}>
                {t === 'collection' ? 'From Collection' : 'From HAR File'}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {/* Target collection */}
            <div>
              <label className="block text-xs text-slate-400 mb-1">Add to collection (optional)</label>
              <select value={targetCollectionId} onChange={e => setTargetCollectionId(e.target.value)} className="w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none">
                <option value="">— No collection (uncollected) —</option>
                {mockCollections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {/* From Collection tab */}
            {tab === 'collection' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Source collection</label>
                  {appCollections.length === 0 ? (
                    <p className="text-xs text-slate-500 italic">No collections available. Import a collection first.</p>
                  ) : (
                    <select value={sourceColId} onChange={e => setSourceColId(e.target.value)} className="w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none">
                      {appCollections.map(c => <option key={c._id} value={c._id}>{c.info.name}</option>)}
                    </select>
                  )}
                </div>
                {flatRequests.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs text-slate-400">{flatRequests.length} request{flatRequests.length !== 1 ? 's' : ''} found</label>
                      <button onClick={() => setSelectedItemIds(new Set(flatRequests.map(i => i.id!).filter(Boolean)))} className="text-xs text-orange-400 hover:text-orange-300 transition-colors">Select all</button>
                    </div>
                    <div className="space-y-0.5 max-h-56 overflow-y-auto pr-1">
                      {flatRequests.map(item => (
                        <label key={item.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-slate-800 cursor-pointer">
                          <input type="checkbox" checked={item.id ? selectedItemIds.has(item.id) : false} onChange={() => item.id && toggleItem(item.id)} className="accent-orange-500 shrink-0" />
                          <span className={`text-xs font-mono font-bold shrink-0 ${methodColor(item.request?.method ?? 'GET')}`}>{(item.request?.method ?? 'GET').toUpperCase()}</span>
                          <span className="text-xs font-mono text-slate-300 truncate flex-1">{extractPath(item.request?.url)}</span>
                          {item.name && <span className="text-xs text-slate-500 truncate shrink-0 max-w-[140px]">{item.name}</span>}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {sourceCollection && flatRequests.length === 0 && (
                  <p className="text-xs text-slate-500 italic">This collection has no request items.</p>
                )}
              </div>
            )}

            {/* From HAR tab */}
            {tab === 'har' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">HAR file</label>
                  <div className="flex items-center gap-2">
                    <input ref={fileRef} type="file" accept=".har,application/json" onChange={handleHarFile} className="hidden" />
                    <button onClick={() => fileRef.current?.click()} className="px-3 py-1.5 bg-slate-800 border border-slate-600 hover:border-slate-400 text-xs text-slate-300 rounded transition-colors">
                      {harEntries.length > 0 ? `${harEntries.length} entries loaded — reload` : 'Choose .har file…'}
                    </button>
                    <span className="text-xs text-slate-500">DevTools → Network → Save as HAR</span>
                  </div>
                  {harError && <p className="mt-1.5 text-xs text-red-400 bg-red-950/30 border border-red-800/40 rounded px-2 py-1">{harError}</p>}
                </div>
                {harEntries.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <input value={harFilter} onChange={e => setHarFilter(e.target.value)} placeholder="Filter by URL or method…" className="flex-1 bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none" />
                      <button onClick={() => setSelectedHarIndices(new Set(filteredHarEntries.map((_, fi) => harEntries.indexOf(filteredHarEntries[fi]))))} className="text-xs text-orange-400 hover:text-orange-300 transition-colors shrink-0">Select all</button>
                    </div>
                    <div className="space-y-0.5 max-h-56 overflow-y-auto pr-1">
                      {filteredHarEntries.map((entry, fi) => {
                        const origIdx = harEntries.indexOf(entry);
                        let path = '/';
                        try { path = new URL(entry.request.url).pathname; } catch {}
                        return (
                          <label key={fi} className="flex items-center gap-2.5 px-2 py-1.5 rounded hover:bg-slate-800 cursor-pointer">
                            <input type="checkbox" checked={selectedHarIndices.has(origIdx)} onChange={() => toggleHarEntry(origIdx)} className="accent-orange-500 shrink-0" />
                            <span className={`text-xs font-mono font-bold shrink-0 ${methodColor(entry.request.method)}`}>{entry.request.method.toUpperCase()}</span>
                            <span className="text-xs font-mono text-slate-300 truncate flex-1">{path}</span>
                            <span className={`text-xs font-mono shrink-0 ${entry.response.status >= 400 ? 'text-red-400' : 'text-green-400'}`}>{entry.response.status}</span>
                          </label>
                        );
                      })}
                    </div>
                    {filteredHarEntries.length === 0 && <p className="text-xs text-slate-500 italic text-center py-2">No entries match the filter.</p>}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between px-5 py-3 border-t border-slate-700 shrink-0">
            <span className="text-xs text-slate-500">{importCount > 0 ? `${importCount} route${importCount !== 1 ? 's' : ''} selected` : 'Select routes to import'}</span>
            <div className="flex gap-2">
              <button onClick={onClose} className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors">Cancel</button>
              <button onClick={handleImport} disabled={importCount === 0} className="px-4 py-1.5 bg-orange-600 hover:bg-orange-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs rounded font-medium transition-colors">
                Import {importCount > 0 ? `${importCount} ` : ''}Route{importCount !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Traffic Inspector ────────────────────────────────────────────────────────

function statusColor(status: number) {
  if (status >= 500) return 'text-red-400';
  if (status >= 400) return 'text-orange-400';
  if (status >= 300) return 'text-yellow-400';
  return 'text-green-400';
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function TrafficInspector({ running }: { running: boolean }) {
  const [entries, setEntries] = useState<MockLogEntry[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!running) return;
    let active = true;
    function poll() {
      getMockLog().then(data => { if (active) setEntries(data.entries); }).catch(() => {});
    }
    poll();
    const interval = setInterval(poll, 1500);
    return () => { active = false; clearInterval(interval); };
  }, [running]);

  async function handleClear() {
    setClearing(true);
    try {
      await clearMockLog();
      setEntries([]);
      setExpandedId(null);
    } finally {
      setClearing(false);
    }
  }

  if (!running) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center pb-16">
        <p className="text-3xl mb-3">📡</p>
        <p className="text-sm font-medium text-slate-300 mb-1">Server not running</p>
        <p className="text-xs text-slate-500 max-w-xs">Start the mock server to capture incoming requests here.</p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center pb-16">
        <p className="text-3xl mb-3">📡</p>
        <p className="text-sm font-medium text-slate-300 mb-1">Waiting for requests…</p>
        <p className="text-xs text-slate-500 max-w-xs">Incoming requests to the mock server will appear here in real time.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-slate-800 shrink-0">
        <span className="text-xs text-slate-500">{entries.length} request{entries.length !== 1 ? 's' : ''} captured</span>
        <button
          onClick={handleClear}
          disabled={clearing}
          className="px-3 py-1 text-xs text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded transition-colors disabled:opacity-40"
        >
          Clear
        </button>
      </div>

      {/* Log list */}
      <div className="flex-1 overflow-y-auto">
        {entries.map(entry => {
          const expanded = expandedId === entry.id;
          const matched = entry.matchedRouteId !== null;
          const isWsEvent = !!entry.wsEventType;

          // WS event label + colour
          const wsLabel = entry.wsEventType === 'ws_connect' ? 'CONNECT'
            : entry.wsEventType === 'ws_disconnect' ? 'DISCONN'
            : entry.wsEventType === 'ws_message_in' ? '→ IN'
            : entry.wsEventType === 'ws_message_out' ? '← OUT'
            : '';
          const wsLabelColor = entry.wsEventType === 'ws_connect' ? 'text-green-400'
            : entry.wsEventType === 'ws_disconnect' ? 'text-slate-500'
            : entry.wsEventType === 'ws_message_in' ? 'text-blue-400'
            : 'text-purple-400';

          return (
            <div key={entry.id} className="border-b border-slate-800/60 last:border-none">
              {/* Summary row */}
              <button
                onClick={() => setExpandedId(expanded ? null : entry.id)}
                className={`w-full text-left px-5 py-2.5 flex items-center gap-3 hover:bg-slate-800/40 transition-colors ${expanded ? 'bg-slate-800/40' : ''}`}
              >
                <span className="text-xs text-slate-600 font-mono shrink-0 w-28">{formatTime(entry.timestamp)}</span>
                {isWsEvent ? (
                  <span className={`text-xs font-mono font-bold shrink-0 w-16 ${wsLabelColor}`}>{wsLabel}</span>
                ) : (
                  <span className={`text-xs font-mono font-bold shrink-0 w-16 ${methodColor(entry.method)}`}>{entry.method}</span>
                )}
                <span className="text-xs font-mono text-slate-300 flex-1 truncate text-left">
                  {entry.path}
                  {isWsEvent && entry.wsClientId && (
                    <span className="ml-2 text-slate-600">#{entry.wsClientId}</span>
                  )}
                </span>
                {isWsEvent ? (
                  <span className="text-xs font-mono text-purple-500 shrink-0 w-10 text-right">WS</span>
                ) : (
                  <span className={`text-xs font-mono font-semibold shrink-0 w-10 text-right ${statusColor(entry.responseStatus)}`}>{entry.responseStatus}</span>
                )}
                <span className={`text-xs shrink-0 w-4 text-right ${matched ? 'text-green-500' : 'text-orange-500'}`} title={matched ? `Matched: ${entry.matchedRoutePath}` : 'No route matched'}>
                  {matched ? '✓' : '✗'}
                </span>
                <span className="text-xs text-slate-600 shrink-0">{expanded ? '▴' : '▾'}</span>
              </button>

              {/* Expanded detail */}
              {expanded && (
                <div className="px-5 pb-4 space-y-3 bg-slate-900/40">
                  {/* Matched route */}
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Matched Route</p>
                    {matched ? (
                      <p className="text-xs font-mono text-slate-300">
                        {isWsEvent
                          ? <span className="text-purple-400">WS</span>
                          : <span className={methodColor(entry.method)}>{entry.method}</span>
                        }{' '}
                        {entry.matchedRoutePath}
                        {entry.matchedRouteName && entry.matchedRouteName !== entry.matchedRoutePath && (
                          <span className="text-slate-500 ml-2">— {entry.matchedRouteName}</span>
                        )}
                      </p>
                    ) : (
                      <p className="text-xs text-orange-400">No route matched — returned 404</p>
                    )}
                  </div>

                  {/* WS payload */}
                  {isWsEvent && (entry.body || entry.responseBody) && (
                    <div>
                      <p className="text-xs text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-2">
                        {entry.wsEventType === 'ws_message_in' ? 'Message (received)' : 'Message (sent)'}
                        {entry.wsMessageType && entry.wsMessageType !== 'string' && (
                          <span className={`px-1.5 py-0.5 rounded text-xs font-mono ${entry.wsMessageType === 'json' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-cyan-500/20 text-cyan-400'}`}>
                            {entry.wsMessageType.toUpperCase()}
                          </span>
                        )}
                      </p>
                      <pre className="bg-slate-800 rounded p-2 text-xs font-mono text-slate-200 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">{
                        (() => {
                          const text = entry.body || entry.responseBody;
                          try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
                        })()
                      }</pre>
                    </div>
                  )}

                  {/* HTTP-only fields */}
                  {!isWsEvent && (
                    <>
                      {/* Query params */}
                      {Object.keys(entry.query).length > 0 && (
                        <div>
                          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Query Params</p>
                          <div className="bg-slate-800 rounded p-2 space-y-0.5">
                            {Object.entries(entry.query).map(([k, v]) => (
                              <div key={k} className="flex gap-2 text-xs font-mono">
                                <span className="text-slate-400 shrink-0">{k}:</span>
                                <span className="text-slate-200">{v}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Request headers */}
                      <div>
                        <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Request Headers</p>
                        <div className="bg-slate-800 rounded p-2 space-y-0.5 max-h-32 overflow-y-auto">
                          {Object.entries(entry.headers).map(([k, v]) => (
                            <div key={k} className="flex gap-2 text-xs font-mono">
                              <span className="text-slate-400 shrink-0 capitalize">{k}:</span>
                              <span className="text-slate-200 break-all">{v}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Request body */}
                      {entry.body && (
                        <div>
                          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Request Body</p>
                          <pre className="bg-slate-800 rounded p-2 text-xs font-mono text-slate-200 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">{
                            (() => { try { return JSON.stringify(JSON.parse(entry.body), null, 2); } catch { return entry.body; } })()
                          }</pre>
                        </div>
                      )}

                      {/* Response body */}
                      <div>
                        <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Response Body <span className={`ml-1 font-semibold ${statusColor(entry.responseStatus)}`}>{entry.responseStatus}</span></p>
                        <pre className="bg-slate-800 rounded p-2 text-xs font-mono text-slate-200 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">{
                          (() => { try { return JSON.stringify(JSON.parse(entry.responseBody), null, 2); } catch { return entry.responseBody; } })()
                        }</pre>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MockStateViewer({ running }: { running: boolean }) {
  const [dbState, setDbState] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!running) {
      setDbState({});
      return;
    }
    let active = true;
    function poll() {
      setLoading(true);
      getMockDb()
        .then(data => { if (active) setDbState(data.data || {}); })
        .catch(() => {})
        .finally(() => { if (active) setLoading(false); });
    }
    poll();
    const interval = setInterval(poll, 1500);
    return () => { active = false; clearInterval(interval); };
  }, [running]);

  async function handleClear() {
    setClearing(true);
    try {
      await clearMockDb();
      setDbState({});
    } finally {
      setClearing(false);
    }
  }

  if (!running) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center pb-16">
        <p className="text-3xl mb-3">🗃️</p>
        <p className="text-sm font-medium text-slate-300 mb-1">Server not running</p>
        <p className="text-xs text-slate-500 max-w-xs">Start the mock server to use and inspect persistent mock state.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-5 py-2 border-b border-slate-800 shrink-0">
        <span className="text-xs text-slate-500">{Object.keys(dbState).length} key{Object.keys(dbState).length !== 1 ? 's' : ''} in state</span>
        <button
          onClick={handleClear}
          disabled={clearing}
          className="px-3 py-1 text-xs text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded transition-colors disabled:opacity-40"
        >
          Clear State
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading && Object.keys(dbState).length === 0 ? (
          <p className="text-xs text-slate-500">Loading state...</p>
        ) : Object.keys(dbState).length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center pb-16">
            <p className="text-3xl mb-3">🧪</p>
            <p className="text-sm font-medium text-slate-300 mb-1">State is empty</p>
            <p className="text-xs text-slate-500 max-w-xs">Use route scripts with db helpers to create persistent mock data.</p>
          </div>
        ) : (
          <pre className="bg-slate-900 border border-slate-800 rounded p-3 text-xs font-mono text-slate-200 whitespace-pre-wrap break-all">{JSON.stringify(dbState, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}

// ─── Main Panel ────────────────────────────────────────────────────────────────

export default function MockServerPanel() {
  const { state, dispatch } = useApp();
  const toast = useToast();
  const { mockRoutes, mockCollections, mockServerRunning, mockPort, collections: appCollections } = state;

  const [portInput, setPortInput] = useState(String(mockPort));
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingRoute, setEditingRoute] = useState<MockRoute | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [activeTab, setActiveTab] = useState<'routes' | 'traffic' | 'state'>('routes');

  useEffect(() => {
    getMockStatus()
      .then(s => {
        dispatch({ type: 'SET_MOCK_SERVER_RUNNING', payload: s.running });
        if (s.running) dispatch({ type: 'SET_MOCK_PORT', payload: s.port });
      })
      .catch(() => dispatch({ type: 'SET_MOCK_SERVER_RUNNING', payload: false }));
  }, [dispatch]);

  useEffect(() => {
    if (!mockServerRunning) return;
    const effective = getEffectiveRoutes(mockRoutes, mockCollections);
    syncMockRoutes(effective).catch(() => {});
  }, [mockRoutes, mockCollections, mockServerRunning]);

  async function handleToggle() {
    setError(null);
    setToggling(true);
    try {
      if (mockServerRunning) {
        await stopMockServer();
        dispatch({ type: 'SET_MOCK_SERVER_RUNNING', payload: false });
        toast.info('Mock server stopped.');
      } else {
        const port = parseInt(portInput, 10) || 3002;
        if (port < 1024 || port > 65535) { setError('Port must be between 1024 and 65535'); setToggling(false); return; }
        const effective = getEffectiveRoutes(mockRoutes, mockCollections);
        await startMockServer(port, effective);
        dispatch({ type: 'SET_MOCK_PORT', payload: port });
        dispatch({ type: 'SET_MOCK_SERVER_RUNNING', payload: true });
        toast.success(`Mock server started on port ${port}.`);
      }
    } catch (err: any) {
      const msg = err?.response?.data?.error ?? err?.message ?? 'Failed';
      setError(msg);
      toast.error(`Mock server error: ${msg}`);
    } finally {
      setToggling(false);
    }
  }

  function openNewRoute(collectionId?: string) {
    setIsNew(true);
    setEditingRoute(emptyRoute(collectionId));
  }

  const handleSaveRoute = useCallback((saved: MockRoute) => {
    dispatch({ type: isNew ? 'ADD_MOCK_ROUTE' : 'UPDATE_MOCK_ROUTE', payload: saved });
    setEditingRoute(null);
  }, [isNew, dispatch]);

  function handleImportRoutes(routes: MockRoute[]) {
    for (const r of routes) dispatch({ type: 'ADD_MOCK_ROUTE', payload: r });
  }

  function addCollection() {
    const name = window.prompt('Collection name:')?.trim();
    if (!name) return;
    dispatch({ type: 'ADD_MOCK_COLLECTION', payload: { id: generateId(), name, enabled: true, description: '' } });
  }

  const uncollectedRoutes = mockRoutes.filter(r => !r.collectionId);
  const hasContent = mockRoutes.length > 0 || mockCollections.length > 0;
  const mockUrl = `http://localhost:${mockPort}`;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-slate-950 text-slate-100">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-800 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Mock Server</h2>
            <p className="text-xs text-slate-500 mt-0.5">Define static or dynamic responses for endpoints — no backend required.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowImport(true)} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs rounded font-medium transition-colors">↓ Import</button>
            <button onClick={addCollection} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs rounded font-medium transition-colors">+ Collection</button>
            <button onClick={() => openNewRoute()} className="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded font-medium transition-colors">+ Route</button>
          </div>
        </div>

        {/* Server controls */}
        <div className="flex items-center gap-3 bg-slate-900 border border-slate-700 rounded-lg px-4 py-3">
          <span className={`w-2 h-2 rounded-full shrink-0 ${mockServerRunning ? 'bg-green-400 shadow-[0_0_6px_#4ade80]' : 'bg-slate-600'}`} />
          <div className="flex-1 min-w-0">
            {mockServerRunning ? (
              <p className="text-xs text-slate-300">Running on <a href={mockUrl} target="_blank" rel="noopener noreferrer" className="text-orange-400 hover:underline font-mono">{mockUrl}</a></p>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400 shrink-0">Port</span>
                <input type="number" min={1024} max={65535} value={portInput} onChange={e => setPortInput(e.target.value)} disabled={mockServerRunning} className="w-24 bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none disabled:opacity-40" />
              </div>
            )}
          </div>
          <button onClick={handleToggle} disabled={toggling} className={`px-4 py-1.5 text-xs rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-wait ${mockServerRunning ? 'bg-red-700 hover:bg-red-600 text-white' : 'bg-green-700 hover:bg-green-600 text-white'}`}>
            {toggling ? (mockServerRunning ? 'Stopping…' : 'Starting…') : (mockServerRunning ? 'Stop' : 'Start')}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-400 bg-red-950/40 border border-red-800/50 rounded px-3 py-2">{error}</p>}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800 shrink-0 px-5">
        {(['routes', 'traffic', 'state'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-xs font-medium transition-colors ${activeTab === tab ? 'text-orange-400 border-b-2 border-orange-500 -mb-px' : 'text-slate-400 hover:text-slate-200'}`}
          >
            {tab === 'routes' ? 'Routes' : tab === 'traffic' ? (
              <span className="flex items-center gap-1.5">
                Traffic
                {mockServerRunning && <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
              </span>
            ) : (
              'State'
            )}
          </button>
        ))}
      </div>

      {/* Routes tab */}
      {activeTab === 'routes' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex-1 overflow-y-auto px-5 py-3">
            {!hasContent ? (
              <div className="flex flex-col items-center justify-center h-full text-center pb-16">
                <p className="text-3xl mb-3">🎭</p>
                <p className="text-sm font-medium text-slate-300 mb-1">No mock routes yet</p>
                <p className="text-xs text-slate-500 mb-4 max-w-xs">Add routes to intercept HTTP requests and return custom responses — or import from a collection or HAR file.</p>
                <div className="flex gap-2">
                  <button onClick={() => openNewRoute()} className="px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded font-medium transition-colors">+ Add Route</button>
                  <button onClick={() => setShowImport(true)} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs rounded font-medium transition-colors">↓ Import Routes</button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Column headers */}
                <div className="grid grid-cols-[20px_90px_1fr_52px_52px_64px] gap-2 px-3 py-1 text-xs text-slate-600 uppercase tracking-wider">
                  <span /><span>Method</span><span>Path</span><span>Status</span><span>Delay</span><span />
                </div>

                {/* Uncollected routes */}
                {uncollectedRoutes.length > 0 && (
                  <div className="space-y-1">
                    {mockCollections.length > 0 && <p className="text-xs text-slate-600 uppercase tracking-wider px-1 mb-1">Uncollected</p>}
                    {uncollectedRoutes.map(route => (
                      <RouteRow key={route.id} route={route}
                        onEdit={() => { setIsNew(false); setEditingRoute({ ...route }); }}
                        onDelete={() => dispatch({ type: 'DELETE_MOCK_ROUTE', payload: route.id })}
                        onToggle={() => dispatch({ type: 'UPDATE_MOCK_ROUTE', payload: { ...route, enabled: !route.enabled } })}
                      />
                    ))}
                  </div>
                )}

                {/* Collections */}
                {mockCollections.map(collection => (
                  <CollectionSection
                    key={collection.id}
                    collection={collection}
                    routes={mockRoutes.filter(r => r.collectionId === collection.id)}
                    onToggleCollection={() => dispatch({ type: 'UPDATE_MOCK_COLLECTION', payload: { ...collection, enabled: !collection.enabled } })}
                    onDeleteCollection={() => dispatch({ type: 'DELETE_MOCK_COLLECTION', payload: collection.id })}
                    onRenameCollection={name => dispatch({ type: 'UPDATE_MOCK_COLLECTION', payload: { ...collection, name } })}
                    onAddRoute={() => openNewRoute(collection.id)}
                    onEditRoute={route => { setIsNew(false); setEditingRoute({ ...route }); }}
                    onDeleteRoute={id => dispatch({ type: 'DELETE_MOCK_ROUTE', payload: id })}
                    onToggleRoute={route => dispatch({ type: 'UPDATE_MOCK_ROUTE', payload: { ...route, enabled: !route.enabled } })}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Usage hint */}
          {hasContent && mockServerRunning && (
            <div className="px-5 py-3 border-t border-slate-800 shrink-0">
              <p className="text-xs text-slate-500">
                <span className="text-slate-400 font-medium">Request: </span>
                <code className="font-mono text-slate-400">{'{{param.id}}'}</code>{' '}
                <code className="font-mono text-slate-400">{'{{query.page}}'}</code>{' '}
                <code className="font-mono text-slate-400">{'{{body.field}}'}</code>{' '}
                <code className="font-mono text-slate-400">{'{{body.user.name}}'}</code>{' '}
                <code className="font-mono text-slate-400">{'{{header.authorization}}'}</code>{' '}
                <code className="font-mono text-slate-400">{'{{method}}'}</code>{' · '}
                <span className="text-slate-400 font-medium">Generators: </span>
                <code className="font-mono text-slate-400">{'{{$uuid}}'}</code>{' '}
                <code className="font-mono text-slate-400">{'{{$timestamp}}'}</code>{' '}
                <code className="font-mono text-slate-400">{'{{$isoDate}}'}</code>{' '}
                <code className="font-mono text-slate-400">{'{{$randomInt(1,100)}}'}</code>{' '}
                <code className="font-mono text-slate-400">{'{{$randomItem(a,b,c)}}'}</code>{' '}
                <code className="font-mono text-slate-400">{'{{$requestCount}}'}</code>
              </p>
            </div>
          )}
        </div>
      )}

      {/* Traffic tab */}
      {activeTab === 'traffic' && (
        <div className="flex-1 overflow-hidden">
          <TrafficInspector running={mockServerRunning} />
        </div>
      )}

      {/* State tab */}
      {activeTab === 'state' && (
        <div className="flex-1 overflow-hidden">
          <MockStateViewer running={mockServerRunning} />
        </div>
      )}

      {editingRoute && (
        <RouteEditorModal
          initial={editingRoute}
          collections={mockCollections}
          onSave={handleSaveRoute}
          onClose={() => setEditingRoute(null)}
        />
      )}

      {showImport && (
        <ImportRoutesModal
          mockCollections={mockCollections}
          appCollections={appCollections}
          onImport={handleImportRoutes}
          onClose={() => setShowImport(false)}
        />
      )}
    </div>
  );
}
