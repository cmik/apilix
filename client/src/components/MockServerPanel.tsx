import { useState, useEffect, useCallback, useRef } from 'react';
import { useApp, generateId } from '../store';
import type { MockRoute, MockCollection, AppCollection, PostmanItem } from '../types';
import { startMockServer, stopMockServer, syncMockRoutes, getMockStatus } from '../api';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', '*'];
const STATUS_CODES = [200, 201, 204, 301, 302, 400, 401, 403, 404, 409, 422, 500, 502, 503];

const SKIP_RESPONSE_HEADERS = new Set([
  'content-encoding', 'transfer-encoding', 'connection', 'keep-alive',
  ':status', 'set-cookie', 'alt-svc', 'x-content-type-options',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptyRoute(collectionId?: string): MockRoute {
  return {
    id: generateId(),
    enabled: true,
    collectionId,
    method: 'GET',
    path: '/api/example',
    statusCode: 200,
    responseHeaders: [{ key: 'Content-Type', value: 'application/json' }],
    responseBody: '{\n  "message": "Hello from mock!"\n}',
    delay: 0,
    description: '',
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

function flattenRequests(items: PostmanItem[]): PostmanItem[] {
  const result: PostmanItem[] = [];
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

function postmanItemToMockRoute(item: PostmanItem, collectionId?: string): MockRoute {
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
  const statusColor = route.statusCode >= 500 ? 'text-red-400' : route.statusCode >= 400 ? 'text-orange-400' : route.statusCode >= 300 ? 'text-yellow-400' : 'text-green-400';
  return (
    <div className={`grid grid-cols-[20px_90px_1fr_52px_52px_64px] gap-2 items-center bg-slate-900 border rounded-lg px-3 py-2 transition-colors ${
      route.enabled ? 'border-slate-700 hover:border-slate-600' : 'border-slate-800 opacity-50'
    } ${indent ? 'ml-6' : ''}`}>
      <input type="checkbox" checked={route.enabled} onChange={onToggle} title={route.enabled ? 'Disable route' : 'Enable route'} className="accent-orange-500 cursor-pointer" />
      <span className={`text-xs font-mono font-bold ${methodColor(route.method)}`}>{route.method === '*' ? 'ANY' : route.method}</span>
      <div className="min-w-0">
        <p className="text-xs font-mono text-slate-200 truncate">{route.path}</p>
        {route.description && <p className="text-xs text-slate-500 truncate mt-0.5">{route.description}</p>}
      </div>
      <span className={`text-xs font-mono ${statusColor}`}>{route.statusCode}</span>
      <span className="text-xs text-slate-500">{route.delay > 0 ? `${route.delay}ms` : '—'}</span>
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
        <button onClick={() => { if (window.confirm(`Delete collection "${collection.name}"? Routes will become uncollected.`)) onDeleteCollection(); }} title="Delete collection" className="text-slate-600 hover:text-red-400 text-xs transition-colors shrink-0">✕</button>
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

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function updateField<K extends keyof MockRoute>(k: K, v: MockRoute[K]) {
    setRoute(r => ({ ...r, [k]: v }));
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
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700 shrink-0">
            <h2 className="text-sm font-semibold text-white">{initial.description === '' && initial.path === '/api/example' ? 'New Mock Route' : 'Edit Mock Route'}</h2>
            <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none">×</button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
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
                  supports <code className="font-mono text-slate-500">{'{{param.id}}'}</code>{' '}
                  <code className="font-mono text-slate-500">{'{{query.page}}'}</code>{' '}
                  <code className="font-mono text-slate-500">{'{{body.field}}'}</code>
                </span>
              </label>
              <textarea value={route.responseBody} onChange={e => updateField('responseBody', e.target.value)} rows={10} spellCheck={false} className="w-full bg-slate-800 border border-slate-700 focus:border-orange-500 rounded px-2 py-1.5 text-xs font-mono text-slate-200 focus:outline-none resize-y" />
            </div>
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
      routes = flatRequests.filter(i => i.id && selectedItemIds.has(i.id)).map(i => postmanItemToMockRoute(i, target));
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
                    <p className="text-xs text-slate-500 italic">No collections available. Import a Postman collection first.</p>
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

// ─── Main Panel ────────────────────────────────────────────────────────────────

export default function MockServerPanel() {
  const { state, dispatch } = useApp();
  const { mockRoutes, mockCollections, mockServerRunning, mockPort, collections: appCollections } = state;

  const [portInput, setPortInput] = useState(String(mockPort));
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingRoute, setEditingRoute] = useState<MockRoute | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [showImport, setShowImport] = useState(false);

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
      } else {
        const port = parseInt(portInput, 10) || 3002;
        if (port < 1024 || port > 65535) { setError('Port must be between 1024 and 65535'); setToggling(false); return; }
        const effective = getEffectiveRoutes(mockRoutes, mockCollections);
        await startMockServer(port, effective);
        dispatch({ type: 'SET_MOCK_PORT', payload: port });
        dispatch({ type: 'SET_MOCK_SERVER_RUNNING', payload: true });
      }
    } catch (err: any) {
      setError(err?.response?.data?.error ?? err?.message ?? 'Failed');
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

      {/* Routes list */}
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
            Tip: Use <code className="font-mono text-slate-400">{'{{param.id}}'}</code>,{' '}
            <code className="font-mono text-slate-400">{'{{query.page}}'}</code>, or{' '}
            <code className="font-mono text-slate-400">{'{{body.field}}'}</code> in the response body for dynamic substitution.
            Disabling a collection suppresses all its routes.
          </p>
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
