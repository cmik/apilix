import { useState, useEffect, useRef } from 'react';
import type { PostmanItem, PostmanRequest, PostmanHeader, PostmanQueryParam } from '../types';
import { useApp } from '../store';
import { executeRequest } from '../api';
import { getUrlDisplay, buildVarMap, resolveVariables } from '../utils/variableResolver';
import { updateItemById, renameItemById, resolveInheritedAuth } from '../utils/treeHelpers';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const METHOD_COLORS: Record<string, string> = {
  GET: 'text-green-400',
  POST: 'text-blue-400',
  PUT: 'text-yellow-400',
  PATCH: 'text-orange-400',
  DELETE: 'text-red-400',
  HEAD: 'text-purple-400',
  OPTIONS: 'text-slate-400',
};

const TABS = ['Params', 'Auth', 'Headers', 'Body', 'Pre-request', 'Tests'] as const;
type Tab = typeof TABS[number];

// ─── Local editable state for a request ─────────────────────────────────────

function itemToEditState(item: PostmanItem) {
  const req = item.request as PostmanRequest;
  const urlRaw = typeof req.url === 'string' ? req.url : (req.url?.raw ?? '');
  return {
    method: req.method?.toUpperCase() ?? 'GET',
    url: urlRaw,
    headers: (req.header ?? []).filter(h => !h.disabled).map(h => ({ ...h })),
    queryParams: extractQueryParams(req.url),
    bodyMode: req.body?.mode ?? 'none',
    bodyRaw: req.body?.raw ?? '',
    bodyRawLang: req.body?.options?.raw?.language ?? 'json',
    bodyFormData: req.body?.formdata ?? [],
    bodyUrlEncoded: req.body?.urlencoded ?? [],
    authType: req.auth?.type ?? 'inherit',
    authBearer: (req.auth?.bearer ?? []).find(b => b.key === 'token')?.value ?? '',
    authBasicUser: (req.auth?.basic ?? []).find(b => b.key === 'username')?.value ?? '',
    authBasicPass: (req.auth?.basic ?? []).find(b => b.key === 'password')?.value ?? '',
    authApiKeyName: (req.auth?.apikey ?? []).find(b => b.key === 'key')?.value ?? 'X-API-Key',
    authApiKeyValue: (req.auth?.apikey ?? []).find(b => b.key === 'value')?.value ?? '',
    preRequestScript: getScript(item, 'prerequest'),
    testScript: getScript(item, 'test'),
    bodyGraphqlQuery: req.body?.graphql?.query ?? '',
    bodyGraphqlVariables: req.body?.graphql?.variables ?? '',
    bodyFile: null as File | null,
  };
}

function extractQueryParams(url: PostmanRequest['url']): PostmanQueryParam[] {
  if (typeof url === 'string') {
    const idx = url.indexOf('?');
    if (idx === -1) return [];
    return url
      .slice(idx + 1)
      .split('&')
      .map(p => {
        const [key, ...rest] = p.split('=');
        return { key: decodeURIComponent(key), value: decodeURIComponent(rest.join('=')) };
      })
      .filter(p => p.key);
  }
  return (url?.query ?? []).filter(q => !q.disabled).map(q => ({ ...q }));
}

function getScript(item: PostmanItem, type: 'prerequest' | 'test'): string {
  const ev = (item.event ?? []).find(e => e.listen === type);
  if (!ev) return '';
  return Array.isArray(ev.script.exec) ? ev.script.exec.join('\n') : (ev.script.exec ?? '');
}

// ─── Key/value table component ───────────────────────────────────────────────

function KvTable({
  rows,
  onChange,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
}: {
  rows: Array<{ key: string; value: string; disabled?: boolean }>;
  onChange: (rows: Array<{ key: string; value: string }>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  function update(i: number, field: 'key' | 'value', val: string) {
    const next = rows.map((r, idx) => (idx === i ? { ...r, [field]: val } : r));
    onChange(next);
  }
  function remove(i: number) {
    onChange(rows.filter((_, idx) => idx !== i));
  }
  function addRow() {
    onChange([...rows, { key: '', value: '' }]);
  }

  return (
    <div className="flex flex-col gap-1">
      {rows.map((row, i) => (
        <div key={i} className="flex gap-1">
          <input
            value={row.key}
            onChange={e => update(i, 'key', e.target.value)}
            placeholder={keyPlaceholder}
            className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
          />
          <input
            value={row.value}
            onChange={e => update(i, 'value', e.target.value)}
            placeholder={valuePlaceholder}
            className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
          />
          <button onClick={() => remove(i)} className="px-2 text-slate-500 hover:text-red-400 text-lg leading-none">×</button>
        </div>
      ))}
      <button
        onClick={addRow}
        className="self-start text-xs text-slate-500 hover:text-orange-400 mt-1 transition-colors"
      >
        + Add row
      </button>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

type EditState = ReturnType<typeof itemToEditState>;
type TabCache = { edit: EditState; dirty: boolean };

function RenamableTitle({ name, onRename }: { name: string; onRename: (n: string) => void }) {
  const [renaming, setRenaming] = useState(false);
  const [val, setVal] = useState(name);

  // keep val in sync when name changes externally (e.g. renamed from tab)
  useEffect(() => { if (!renaming) setVal(name); }, [name, renaming]);

  function commit() {
    const trimmed = val.trim();
    if (trimmed && trimmed !== name) onRename(trimmed);
    setRenaming(false);
  }

  if (renaming) {
    return (
      <input
        autoFocus
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); }
        }}
        className="w-full bg-slate-700 border border-orange-500 rounded px-2 py-0.5 text-xs text-slate-100 font-medium uppercase tracking-wide focus:outline-none mb-1"
      />
    );
  }

  return (
    <div className="group flex items-center gap-1 mb-1">
      <p className="text-slate-400 text-xs font-medium uppercase tracking-wide truncate">{name}</p>
      <button
        onClick={() => { setVal(name); setRenaming(true); }}
        className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-600 hover:text-slate-300 shrink-0"
        title="Rename request"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 3.487a2.25 2.25 0 1 1 3.182 3.182L7.5 19.213l-4.5 1.318 1.318-4.5L16.862 3.487z" />
        </svg>
      </button>
    </div>
  );
}

interface RequestBuilderProps {
  /** Called whenever the dirty set changes so the parent can pass it to TabBar */
  onDirtyChange?: (ids: Set<string>) => void;
}

export default function RequestBuilder({ onDirtyChange }: RequestBuilderProps) {
  const { state, dispatch, getEnvironmentVars, getCollectionVars } = useApp();

  const activeTab = state.tabs.find(t => t.id === state.activeTabId) ?? null;
  const activeTabId = state.activeTabId;

  // Per-tab edit state lives in a ref (no store round-trips on every keystroke)
  const cacheRef = useRef<Map<string, TabCache>>(new Map());

  const [edit, setEditRaw] = useState<EditState | null>(() =>
    activeTab ? itemToEditState(activeTab.item) : null
  );
  const [dirty, setDirty] = useState(false);
  const [activeRequestTab, setActiveRequestTab] = useState<Tab>('Params');
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importText, setImportText] = useState('');
  const [importMode, setImportMode] = useState<'curl' | 'raw'>('curl');
  const [importError, setImportError] = useState('');

  // Swap edit state when active tab changes
  useEffect(() => {
    if (!activeTab) {
      setEditRaw(null);
      setDirty(false);
      return;
    }
    const cached = cacheRef.current.get(activeTab.id);
    if (cached) {
      setEditRaw(cached.edit);
      setDirty(cached.dirty);
    } else {
      const fresh = itemToEditState(activeTab.item);
      cacheRef.current.set(activeTab.id, { edit: fresh, dirty: false });
      setEditRaw(fresh);
      setDirty(false);
    }
    setActiveRequestTab('Params');
  }, [activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Notify parent of dirty set changes
  useEffect(() => {
    if (!onDirtyChange) return;
    const ids = new Set<string>();
    cacheRef.current.forEach((v, k) => { if (v.dirty) ids.add(k); });
    onDirtyChange(ids);
  }, [dirty, onDirtyChange]);

  // Wrapper: update edit + cache + dirty in one call
  function setEdit(updater: (prev: EditState) => EditState) {
    setEditRaw(prev => {
      if (!prev || !activeTab) return prev;
      const next = updater(prev);
      cacheRef.current.set(activeTab.id, { edit: next, dirty: true });
      setDirty(true);
      return next;
    });
  }

  // Backward-compat alias used below
  const activeReq = activeTab
    ? { collectionId: activeTab.collectionId, item: activeTab.item }
    : null;

  if (!activeReq || !edit) {
    return (
      <div className="flex-1 flex items-center justify-center text-center">
        <div>
          <div className="text-5xl mb-4">⚡</div>
          <p className="text-slate-400">Select a request from the sidebar</p>
          <p className="text-slate-600 text-sm mt-1">or import a collection to get started</p>
        </div>
      </div>
    );
  }

  const envVars = getEnvironmentVars();
  const collVars = getCollectionVars(activeReq.collectionId);
  const allVars = buildVarMap(envVars, collVars, state.globalVariables);

  // Sync query params into URL
  function syncParamsToUrl(params: PostmanQueryParam[]) {
    const baseUrl = edit!.url.split('?')[0];
    const qs = params
      .filter(p => p.key)
      .map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value ?? '')}`)
      .join('&');
    const newUrl = qs ? `${baseUrl}?${qs}` : baseUrl;
    setEdit(e => e ? { ...e, url: newUrl, queryParams: params } : e);
  }

  // Sync URL to query params when URL typed manually
  function handleUrlChange(val: string) {
    const params = extractQueryParamsFromString(val);
    setEdit(e => e ? { ...e, url: val, queryParams: params } : e);
  }

  function extractQueryParamsFromString(url: string): PostmanQueryParam[] {
    const idx = url.indexOf('?');
    if (idx === -1) return [];
    return url.slice(idx + 1).split('&').map(p => {
      const [k, ...rest] = p.split('=');
      return { key: k, value: rest.join('=') };
    }).filter(p => p.key);
  }

  async function handleSend() {
    if (!edit || !activeReq || !activeTab) return;
    const tabId = activeTab.id;
    dispatch({ type: 'SET_TAB_LOADING', payload: { tabId, loading: true } });
    dispatch({ type: 'SET_TAB_RESPONSE', payload: { tabId, response: null } });

    const col = state.collections.find(c => c._id === activeReq.collectionId);
    // Resolve auth — 'inherit' walks up the collection tree to find the effective parent auth
    const resolvedAuth = edit.authType === 'inherit'
      ? resolveInheritedAuth(col?.item ?? [], activeReq.item.id ?? '', col?.auth)
      : buildAuth(edit);

    // Read binary file as base64 if applicable
    let binaryBase64: string | undefined;
    if (edit.bodyMode === 'file' && edit.bodyFile) {
      const ab = await edit.bodyFile.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      binaryBase64 = btoa(binary);
    }

    // Build the item from current edit state
    const item: PostmanItem = {
      ...activeReq.item,
      request: {
        method: edit.method,
        url: { raw: edit.url },
        header: edit.headers,
        body: edit.bodyMode !== 'none' ? {
          mode: edit.bodyMode as NonNullable<NonNullable<PostmanItem['request']>['body']>['mode'],
          raw: edit.bodyMode === 'raw' ? edit.bodyRaw : edit.bodyMode === 'file' ? (binaryBase64 ?? '') : undefined,
          urlencoded: edit.bodyMode === 'urlencoded' ? edit.bodyUrlEncoded : undefined,
          formdata: edit.bodyMode === 'formdata' ? edit.bodyFormData : undefined,
          graphql: edit.bodyMode === 'graphql' ? { query: edit.bodyGraphqlQuery, variables: edit.bodyGraphqlVariables || undefined } : undefined,
          options: edit.bodyMode === 'raw' ? { raw: { language: edit.bodyRawLang as 'json' | 'text' } } : undefined,
        } : undefined,
        auth: resolvedAuth,
      },
      event: buildEvents(edit),
    };

    try {
      const result = await executeRequest({
        item,
        environment: envVars,
        collectionVariables: collVars,
        globals: state.globalVariables,
        collVars: col?.variable ?? [],
      });

      dispatch({ type: 'SET_TAB_RESPONSE', payload: { tabId, response: result } });

      dispatch({
        type: 'ADD_CONSOLE_LOG',
        payload: {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2),
          timestamp: Date.now(),
          method: edit.method,
          url: result.resolvedUrl ?? resolveVariables(edit.url, allVars),
          requestHeaders: result.requestHeaders
            ? Object.entries(result.requestHeaders).map(([key, value]) => ({ key, value }))
            : edit.headers.map(h => ({ ...h, value: resolveVariables(h.value, allVars) })),
          requestBody: result.requestBody ?? (edit.bodyMode === 'raw' ? resolveVariables(edit.bodyRaw, allVars) : undefined),
          scriptLogs: result.scriptLogs ?? [],
          response: result,
        },
      });

      if (result.updatedEnvironment) {
        dispatch({ type: 'UPDATE_ACTIVE_ENV_VARS', payload: result.updatedEnvironment });
      }
      if (result.updatedCollectionVariables) {
        dispatch({
          type: 'UPDATE_COLLECTION_VARS',
          payload: { collectionId: activeReq.collectionId, vars: result.updatedCollectionVariables },
        });
      }
    } catch (err) {
      const errPayload = {
        status: 0,
        statusText: 'Error',
        responseTime: 0,
        headers: {},
        body: (err as Error).message,
        size: 0,
        testResults: [],
        error: (err as Error).message,
      };
      dispatch({
        type: 'SET_TAB_RESPONSE',
        payload: { tabId, response: errPayload },
      });
      dispatch({
        type: 'ADD_CONSOLE_LOG',
        payload: {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2),
          timestamp: Date.now(),
          method: edit.method,
          url: resolveVariables(edit.url, allVars),
          requestHeaders: edit.headers.map(h => ({ ...h, value: resolveVariables(h.value, allVars) })),
          requestBody: edit.bodyMode === 'raw' ? resolveVariables(edit.bodyRaw, allVars) : undefined,
          response: errPayload,
        },
      });
    }
    dispatch({ type: 'SET_TAB_LOADING', payload: { tabId, loading: false } });
  }

  function handleSave() {
    if (!edit || !activeTab) return;
    const col = state.collections.find(c => c._id === activeTab.collectionId);
    if (!col || !activeTab.item.id) return;
    const updatedItem: PostmanItem = {
      ...activeTab.item,
      request: {
        ...(activeTab.item.request ?? {}),
        method: edit.method,
        url: { raw: edit.url },
        header: edit.headers,
        body: edit.bodyMode !== 'none' ? {
          mode: edit.bodyMode as NonNullable<NonNullable<PostmanItem['request']>['body']>['mode'],
          raw: edit.bodyMode === 'raw' ? edit.bodyRaw : undefined,
          urlencoded: edit.bodyMode === 'urlencoded' ? edit.bodyUrlEncoded : undefined,
          formdata: edit.bodyMode === 'formdata' ? edit.bodyFormData : undefined,          graphql: edit.bodyMode === 'graphql' ? { query: edit.bodyGraphqlQuery, variables: edit.bodyGraphqlVariables || undefined } : undefined,          options: edit.bodyMode === 'raw' ? { raw: { language: edit.bodyRawLang as 'json' | 'text' } } : undefined,
        } : undefined,
        auth: buildAuth(edit),
      },
      event: buildEvents(edit),
    };
    dispatch({ type: 'UPDATE_COLLECTION', payload: { ...col, item: updateItemById(col.item, activeTab.item.id, updatedItem) } });
    dispatch({ type: 'UPDATE_TAB_ITEM', payload: { tabId: activeTab.id, item: updatedItem } });
    // Mark clean in cache
    cacheRef.current.set(activeTab.id, { edit, dirty: false });
    setDirty(false);
  }

  function handleImport() {
    const parsed = importMode === 'curl'
      ? parseCurlCommand(importText)
      : parseRawHttp(importText);
    if (!parsed) {
      setImportError('Could not parse the input. Please check the format and try again.');
      return;
    }
    setEdit(e => {
      if (!e) return e;
      const url = parsed.url ?? e.url;
      const next: EditState = {
        ...e,
        method: parsed.method ?? e.method,
        url,
        queryParams: url ? extractQueryParamsFromString(url) : e.queryParams,
        headers: parsed.headers ?? e.headers,
        bodyRaw: parsed.bodyRaw ?? e.bodyRaw,
        bodyMode: (parsed.bodyMode ?? e.bodyMode) as EditState['bodyMode'],
        bodyRawLang: parsed.bodyRawLang ?? e.bodyRawLang,
        bodyFormData: parsed.bodyFormData ?? e.bodyFormData,
        bodyUrlEncoded: parsed.bodyUrlEncoded ?? e.bodyUrlEncoded,
      };
      if (parsed.authType && parsed.authType !== 'inherit') {
        return {
          ...next,
          authType: parsed.authType as EditState['authType'],
          authBasicUser: parsed.authBasicUser ?? e.authBasicUser,
          authBasicPass: parsed.authBasicPass ?? e.authBasicPass,
        };
      }
      return next;
    });
    setShowImportDialog(false);
    setImportText('');
    setImportError('');
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Request name */}
      <div className="px-4 pt-3 pb-1 border-b border-slate-700">
        <RenamableTitle
          name={activeReq.item.name}
          onRename={newName => {
            const col = state.collections.find(c => c._id === activeTab?.collectionId);
            const itemId = activeTab?.item.id;
            if (col && itemId && activeTab) {
              dispatch({
                type: 'UPDATE_COLLECTION',
                payload: { ...col, item: renameItemById(col.item, itemId, newName) },
              });
              dispatch({
                type: 'UPDATE_TAB_ITEM',
                payload: { tabId: activeTab.id, item: { ...activeTab.item, name: newName } },
              });
            }
          }}
        />
        {/* URL bar */}
        <div className="flex gap-2">
          <select
            value={edit.method}
            onChange={e => setEdit(x => x ? { ...x, method: e.target.value } : x)}
            className={`bg-slate-700 border border-slate-600 rounded px-2 py-2 text-sm font-bold focus:outline-none ${METHOD_COLORS[edit.method] || 'text-slate-300'}`}
          >
            {METHODS.map(m => (
              <option key={m} value={m} className="text-slate-100">{m}</option>
            ))}
          </select>
          <input
            type="text"
            value={edit.url}
            onChange={e => handleUrlChange(e.target.value)}
            placeholder="https://api.example.com/endpoint"
            className="flex-1 bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-orange-500"
          />
          <button
            onClick={() => { setImportText(''); setImportError(''); setShowImportDialog(true); }}
            title="Import from cURL or Raw HTTP"
            className="px-3 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-500 text-slate-400 hover:text-slate-200 text-xs rounded transition-colors shrink-0 whitespace-nowrap"
          >
            Import
          </button>
          {dirty && (
            <button
              onClick={handleSave}
              title="Save changes to collection"
              className="px-3 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-500 text-slate-200 text-sm rounded transition-colors flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
              </svg>
              Save
            </button>
          )}
          <button
            onClick={handleSend}
            disabled={state.isLoading}
            className="px-5 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-orange-900 text-white text-sm font-semibold rounded transition-colors"
          >
            {state.isLoading ? '...' : 'Send'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-700 bg-slate-800 shrink-0">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setActiveRequestTab(t)}
            className={`px-4 py-2 text-xs font-medium transition-colors ${
              activeRequestTab === t
                ? 'text-orange-400 border-b-2 border-orange-400 -mb-px'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-3 bg-slate-800/50 min-h-0">
        {activeRequestTab === 'Params' && (
          <KvTable
            rows={edit.queryParams}
            onChange={params => syncParamsToUrl(params)}
            keyPlaceholder="Parameter"
          />
        )}

        {activeRequestTab === 'Headers' && (
          <KvTable
            rows={edit.headers}
            onChange={headers => setEdit(x => x ? { ...x, headers } : x)}
            keyPlaceholder="Header name"
          />
        )}

        {activeRequestTab === 'Body' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 flex-wrap">
              {(['none', 'raw', 'urlencoded', 'formdata', 'graphql', 'file'] as const).map(m => (
                <label key={m} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="bodyMode"
                    value={m}
                    checked={edit.bodyMode === m}
                    onChange={() => setEdit(x => x ? { ...x, bodyMode: m } : x)}
                    className="accent-orange-500"
                  />
                  <span className="text-sm text-slate-300">{m === 'file' ? 'binary' : m}</span>
                </label>
              ))}
              {edit.bodyMode === 'raw' && (
                <select
                  value={edit.bodyRawLang}
                  onChange={e => setEdit(x => x ? { ...x, bodyRawLang: e.target.value as 'json' | 'javascript' | 'html' | 'xml' | 'text' } : x)}
                  className="ml-4 bg-slate-700 border border-slate-600 rounded px-2 py-0.5 text-xs text-slate-300"
                >
                  {['json', 'text', 'xml', 'html', 'javascript'].map(l => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              )}
              {edit.bodyMode === 'raw' && (
                <button
                  onClick={() => {
                    try {
                      let formatted = edit.bodyRaw;
                      if (edit.bodyRawLang === 'json') {
                        formatted = JSON.stringify(JSON.parse(edit.bodyRaw), null, 2);
                      } else if (edit.bodyRawLang === 'xml' || edit.bodyRawLang === 'html') {
                        let indent = 0;
                        formatted = edit.bodyRaw
                          .replace(/>\s*</g, '>\n<')
                          .split('\n')
                          .map(line => {
                            line = line.trim();
                            if (!line) return '';
                            if (line.startsWith('</')) indent = Math.max(indent - 1, 0);
                            const pad = '  '.repeat(indent);
                            if (line.startsWith('<') && !line.startsWith('</') && !line.startsWith('<?') && !line.endsWith('/>') && !/<\/[^>]+>$/.test(line)) indent++;
                            return pad + line;
                          })
                          .filter(Boolean)
                          .join('\n');
                      }
                      if (formatted !== edit.bodyRaw) {
                        setEdit(x => x ? { ...x, bodyRaw: formatted } : x);
                      }
                    } catch { /* ignore parse errors */ }
                  }}
                  className="ml-auto text-xs text-slate-500 hover:text-orange-400 transition-colors"
                >
                  Beautify
                </button>
              )}
            </div>
            {edit.bodyMode === 'raw' && (
              <textarea
                value={edit.bodyRaw}
                onChange={e => setEdit(x => x ? { ...x, bodyRaw: e.target.value } : x)}
                  rows={10}
                  className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500 resize-y"
                  placeholder={edit.bodyRawLang === 'json' ? '{\n  "key": "value"\n}' : 'Request body...'}
                  spellCheck={false}
              />
            )}
            {edit.bodyMode === 'urlencoded' && (
              <KvTable
                rows={edit.bodyUrlEncoded}
                onChange={v => setEdit(x => x ? { ...x, bodyUrlEncoded: v } : x)}
              />
            )}
            {edit.bodyMode === 'formdata' && (
              <KvTable
                rows={edit.bodyFormData}
                onChange={v => setEdit(x => x ? { ...x, bodyFormData: v } : x)}
              />
            )}
            {edit.bodyMode === 'graphql' && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-slate-400 font-medium">Query</label>
                  <textarea
                    value={edit.bodyGraphqlQuery}
                    onChange={e => setEdit(x => x ? { ...x, bodyGraphqlQuery: e.target.value } : x)}
                    rows={8}
                    className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500 resize-y"
                    placeholder={"query {\n  ...\n}"}
                    spellCheck={false}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-slate-400 font-medium">Variables</label>
                  <textarea
                    value={edit.bodyGraphqlVariables}
                    onChange={e => setEdit(x => x ? { ...x, bodyGraphqlVariables: e.target.value } : x)}
                    rows={4}
                    className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500 resize-y"
                    placeholder={'{ "variable": "value" }'}
                    spellCheck={false}
                  />
                </div>
              </div>
            )}
            {edit.bodyMode === 'file' && (
              <div className="flex flex-col gap-2">
                <label className="text-xs text-slate-400">Select a file to send as the request body</label>
                <input
                  type="file"
                  onChange={e => setEdit(x => x ? { ...x, bodyFile: e.target.files?.[0] ?? null } : x)}
                  className="text-sm text-slate-300 file:bg-slate-600 file:border-0 file:rounded file:px-3 file:py-1 file:text-sm file:text-slate-200 file:cursor-pointer file:mr-3 hover:file:bg-slate-500"
                />
                {edit.bodyFile && (
                  <p className="text-xs text-slate-400">
                    Selected: <span className="text-slate-200">{edit.bodyFile.name}</span>
                    <span className="ml-2 text-slate-500">({(edit.bodyFile.size / 1024).toFixed(1)} KB)</span>
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {activeRequestTab === 'Auth' && (() => {
          const authCol = state.collections.find(c => c._id === activeReq!.collectionId);
          const inheritedAuth = edit.authType === 'inherit'
            ? resolveInheritedAuth(authCol?.item ?? [], activeReq!.item.id ?? '', authCol?.auth)
            : undefined;
          const inheritedLabel =
            !inheritedAuth || inheritedAuth.type === 'noauth' ? 'No Auth'
            : inheritedAuth.type === 'bearer' ? 'Bearer Token'
            : inheritedAuth.type === 'basic' ? 'Basic Auth'
            : inheritedAuth.type === 'apikey' ? 'API Key'
            : inheritedAuth.type;
          return (
          <div className="flex flex-col gap-3">
            <select
              value={edit.authType}
              onChange={e => setEdit(x => x ? { ...x, authType: e.target.value as NonNullable<PostmanItem['request']>['auth'] extends { type: infer T } ? T : never } : x)}
              className="w-56 bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 focus:outline-none"
            >
              <option value="inherit">Inherit auth from parent</option>
              <option value="noauth">No Auth</option>
              <option value="bearer">Bearer Token</option>
              <option value="basic">Basic Auth</option>
              <option value="apikey">API Key</option>
            </select>

            {edit.authType === 'inherit' && (
              <div className="flex gap-2.5 bg-slate-700/40 border border-slate-600 rounded px-3 py-2.5">
                <svg className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <p className="text-xs text-slate-300">This request inherits authorization from its parent folder or collection.</p>
                  <p className="text-xs mt-1">
                    <span className="text-slate-400">Effective: </span>
                    <span className={inheritedAuth && inheritedAuth.type !== 'noauth' ? 'text-orange-400 font-medium' : 'text-slate-500 italic'}>
                      {inheritedLabel}
                    </span>
                  </p>
                </div>
              </div>
            )}

            {edit.authType === 'bearer' && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-slate-400">Token</label>
                <input
                  value={edit.authBearer}
                  onChange={e => setEdit(x => x ? { ...x, authBearer: e.target.value } : x)}
                  placeholder="{{token}}"
                  className="bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
                />
              </div>
            )}

            {edit.authType === 'basic' && (
              <div className="flex flex-col gap-2">
                <div>
                  <label className="text-xs text-slate-400">Username</label>
                  <input
                    value={edit.authBasicUser}
                    onChange={e => setEdit(x => x ? { ...x, authBasicUser: e.target.value } : x)}
                    className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400">Password</label>
                  <input
                    type="password"
                    value={edit.authBasicPass}
                    onChange={e => setEdit(x => x ? { ...x, authBasicPass: e.target.value } : x)}
                    className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
                  />
                </div>
              </div>
            )}

            {edit.authType === 'apikey' && (
              <div className="flex flex-col gap-2">
                <div>
                  <label className="text-xs text-slate-400">Key Name</label>
                  <input
                    value={edit.authApiKeyName}
                    onChange={e => setEdit(x => x ? { ...x, authApiKeyName: e.target.value } : x)}
                    className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400">Value</label>
                  <input
                    value={edit.authApiKeyValue}
                    onChange={e => setEdit(x => x ? { ...x, authApiKeyValue: e.target.value } : x)}
                    className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
                  />
                </div>
              </div>
            )}
          </div>
          );
        })()}

        {activeRequestTab === 'Pre-request' && (
          <div className="flex flex-col gap-2">
            <p className="text-slate-500 text-xs">JavaScript runs before the request. Use <code className="text-orange-400">pm.environment.set("key", "value")</code></p>
            <textarea
              value={edit.preRequestScript}
              onChange={e => setEdit(x => x ? { ...x, preRequestScript: e.target.value } : x)}
              rows={14}
              spellCheck={false}
              className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500 resize-y"
              placeholder="// Pre-request script\npm.environment.set('timestamp', Date.now().toString());"
            />
          </div>
        )}

        {activeRequestTab === 'Tests' && (
          <div className="flex flex-col gap-2">
            <p className="text-slate-500 text-xs">JavaScript runs after the response. Use <code className="text-orange-400">pm.test()</code> and <code className="text-orange-400">pm.expect()</code></p>
            <textarea
              value={edit.testScript}
              onChange={e => setEdit(x => x ? { ...x, testScript: e.target.value } : x)}
              rows={14}
              spellCheck={false}
              className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500 resize-y"
              placeholder={`pm.test("Status is 200", () => {\n  pm.response.to.have.status(200);\n});\n\npm.test("Response has id", () => {\n  const json = pm.response.json();\n  pm.expect(json.id).to.exist;\n});`}
            />
          </div>
        )}
      </div>

      {/* Import dialog */}
      {showImportDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={e => { if (e.target === e.currentTarget) setShowImportDialog(false); }}
        >
          <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl w-full max-w-2xl mx-4 flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <h3 className="text-sm font-semibold text-slate-200">Import Request</h3>
              <button onClick={() => setShowImportDialog(false)} className="text-slate-500 hover:text-slate-300 text-xl leading-none">×</button>
            </div>
            <div className="px-4 py-3 flex flex-col gap-3">
              <div className="flex gap-1 bg-slate-900 p-1 rounded">
                {(['curl', 'raw'] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => { setImportMode(m); setImportError(''); }}
                    className={`flex-1 text-xs px-3 py-1.5 rounded transition-colors font-medium ${
                      importMode === m ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {m === 'curl' ? 'cURL' : 'Raw HTTP'}
                  </button>
                ))}
              </div>
              <textarea
                autoFocus
                value={importText}
                onChange={e => { setImportText(e.target.value); setImportError(''); }}
                rows={12}
                spellCheck={false}
                className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500 resize-y"
                placeholder={importMode === 'curl'
                  ? "curl -X POST https://api.example.com/users \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"name\": \"Alice\"}'"
                  : "POST /users HTTP/1.1\nHost: api.example.com\nContent-Type: application/json\n\n{\"name\": \"Alice\"}"}
              />
              {importError && <p className="text-xs text-red-400">{importError}</p>}
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowImportDialog(false)}
                  className="px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleImport}
                  className="px-4 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-sm font-medium rounded transition-colors"
                >
                  Import
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Import parsers ──────────────────────────────────────────────────────────

function tokenizeCurl(str: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < str.length) {
    while (i < str.length && /[ \t]/.test(str[i])) i++;
    if (i >= str.length) break;
    const ch = str[i];
    // ANSI-C quoting: $'...'
    if (ch === '$' && str[i + 1] === "'") {
      i += 2;
      let tok = '';
      while (i < str.length && str[i] !== "'") {
        if (str[i] === '\\') {
          i++;
          const esc = str[i] ?? '';
          if (esc === 'n') tok += '\n';
          else if (esc === 't') tok += '\t';
          else if (esc === 'r') tok += '\r';
          else tok += esc;
        } else {
          tok += str[i];
        }
        i++;
      }
      i++;
      tokens.push(tok);
    } else if (ch === '"' || ch === "'") {
      i++;
      let tok = '';
      while (i < str.length && str[i] !== ch) {
        if (str[i] === '\\' && ch === '"') {
          i++;
          tok += str[i] ?? '';
        } else {
          tok += str[i];
        }
        i++;
      }
      i++;
      tokens.push(tok);
    } else {
      let tok = '';
      while (i < str.length && !/[ \t]/.test(str[i])) {
        tok += str[i];
        i++;
      }
      tokens.push(tok);
    }
  }
  return tokens;
}

function parseCurlCommand(curlStr: string): Partial<EditState> | null {
  const normalized = curlStr.trim().replace(/\\\r?\n/g, ' ').replace(/\r?\n/g, ' ');
  if (!/^curl\s/i.test(normalized)) return null;

  const tokens = tokenizeCurl(normalized.slice(normalized.toLowerCase().indexOf('curl ') + 5));
  let method = '';
  let url = '';
  const headers: Array<{ key: string; value: string }> = [];
  let bodyRaw = '';
  let bodyMode: EditState['bodyMode'] = 'none';
  const bodyFormData: Array<{ key: string; value: string }> = [];
  const bodyUrlEncoded: Array<{ key: string; value: string }> = [];
  let authBasicUser = '';
  let authBasicPass = '';
  let authType = '';

  // Flags that consume next token but are otherwise ignored
  const skipWithArg = new Set([
    '-o', '--output', '--connect-timeout', '--max-time',
    '--proxy', '-x', '--cert', '--key', '--cacert', '--capath',
    '-b', '--cookie', '-c', '--cookie-jar', '--resolve',
  ]);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // Handle --flag=value syntax
    let flag = t;
    let inlineVal: string | undefined;
    const eqIdx = t.indexOf('=');
    if (eqIdx > 0 && t.startsWith('-')) {
      flag = t.slice(0, eqIdx);
      inlineVal = t.slice(eqIdx + 1);
    }
    const nextArg = (): string => {
      if (inlineVal !== undefined) return inlineVal;
      return tokens[++i] ?? '';
    };

    if (flag === '-X' || flag === '--request') {
      method = nextArg().toUpperCase();
    } else if (flag === '-H' || flag === '--header') {
      const h = nextArg();
      const ci = h.indexOf(':');
      if (ci !== -1) headers.push({ key: h.slice(0, ci).trim(), value: h.slice(ci + 1).trim() });
    } else if (flag === '-d' || flag === '--data' || flag === '--data-raw' || flag === '--data-binary' || flag === '--data-ascii') {
      const val = nextArg();
      if (!val.startsWith('@')) { bodyRaw = bodyRaw ? bodyRaw + '&' + val : val; bodyMode = 'raw'; }
    } else if (flag === '--data-urlencode') {
      const val = nextArg();
      const ei = val.indexOf('=');
      if (ei !== -1) { bodyUrlEncoded.push({ key: val.slice(0, ei), value: val.slice(ei + 1) }); bodyMode = 'urlencoded'; }
      else { bodyRaw = bodyRaw ? bodyRaw + '&' + val : val; bodyMode = 'raw'; }
    } else if (flag === '-F' || flag === '--form' || flag === '--form-string') {
      const val = nextArg();
      const ei = val.indexOf('=');
      if (ei !== -1) bodyFormData.push({ key: val.slice(0, ei), value: val.slice(ei + 1) });
      bodyMode = 'formdata';
    } else if (flag === '-u' || flag === '--user') {
      const val = nextArg();
      const ci = val.indexOf(':');
      authBasicUser = ci !== -1 ? val.slice(0, ci) : val;
      authBasicPass = ci !== -1 ? val.slice(ci + 1) : '';
      authType = 'basic';
    } else if (flag === '-A' || flag === '--user-agent') {
      headers.push({ key: 'User-Agent', value: nextArg() });
    } else if (flag === '--url') {
      url = nextArg();
    } else if (flag === '--get' || flag === '-G') {
      method = 'GET';
    } else if (flag === '--head' || flag === '-I') {
      method = 'HEAD';
    } else if (skipWithArg.has(flag) && inlineVal === undefined) {
      i++; // skip consumed argument
    } else if (!t.startsWith('-') && !url) {
      url = t;
    }
  }

  if (!url) return null;
  if (!method) method = bodyMode !== 'none' ? 'POST' : 'GET';

  const ct = headers.find(h => h.key.toLowerCase() === 'content-type')?.value ?? '';
  const bodyRawLang = ct.includes('json') ? 'json' : ct.includes('xml') ? 'xml' : ct.includes('html') ? 'html' : 'text';

  return {
    method, url, headers, bodyRaw, bodyMode, bodyFormData, bodyUrlEncoded, bodyRawLang,
    ...(authType === 'basic' ? { authType, authBasicUser, authBasicPass } : {}),
  };
}

function parseRawHttp(rawStr: string): Partial<EditState> | null {
  const text = rawStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const lines = text.split('\n');
  if (!lines.length) return null;

  const match = lines[0].trim().match(/^([A-Z]+)\s+(\S+)(?:\s+HTTP\/[\d.]+)?$/i);
  if (!match) return null;

  const method = match[1].toUpperCase();
  const path = match[2];
  const headers: Array<{ key: string; value: string }> = [];
  let host = '';
  let i = 1;

  while (i < lines.length && lines[i].trim() !== '') {
    const ci = lines[i].indexOf(':');
    if (ci !== -1) {
      const key = lines[i].slice(0, ci).trim();
      const value = lines[i].slice(ci + 1).trim();
      if (key.toLowerCase() === 'host') host = value;
      else headers.push({ key, value });
    }
    i++;
  }
  i++; // skip blank separator line

  const body = lines.slice(i).join('\n').trim();

  let url = path;
  if (host && !path.startsWith('http://') && !path.startsWith('https://')) {
    const secure = host.endsWith(':443') || host.endsWith(':8443');
    url = `${secure ? 'https' : 'http'}://${host}${path.startsWith('/') ? path : '/' + path}`;
  }

  const ct = headers.find(h => h.key.toLowerCase() === 'content-type')?.value ?? '';
  const bodyRawLang = ct.includes('json') ? 'json' : ct.includes('xml') ? 'xml' : ct.includes('html') ? 'html' : 'text';

  return {
    method, url, headers,
    bodyRaw: body,
    bodyMode: body ? 'raw' : 'none',
    bodyRawLang,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildAuth(edit: ReturnType<typeof itemToEditState>): PostmanRequest['auth'] {
  switch (edit.authType) {
    case 'inherit':
      return undefined; // undefined auth = inherit from parent (Postman-compatible)
    case 'bearer':
      return { type: 'bearer', bearer: [{ key: 'token', value: edit.authBearer }] };
    case 'basic':
      return {
        type: 'basic',
        basic: [
          { key: 'username', value: edit.authBasicUser },
          { key: 'password', value: edit.authBasicPass },
        ],
      };
    case 'apikey':
      return {
        type: 'apikey',
        apikey: [
          { key: 'key', value: edit.authApiKeyName },
          { key: 'value', value: edit.authApiKeyValue },
          { key: 'in', value: 'header' },
        ],
      };
    default:
      return { type: 'noauth' };
  }
}

function buildEvents(edit: ReturnType<typeof itemToEditState>): PostmanItem['event'] {
  const events: PostmanItem['event'] = [];
  if (edit.preRequestScript.trim()) {
    events.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: edit.preRequestScript.split('\n') } });
  }
  if (edit.testScript.trim()) {
    events.push({ listen: 'test', script: { type: 'text/javascript', exec: edit.testScript.split('\n') } });
  }
  return events;
}
