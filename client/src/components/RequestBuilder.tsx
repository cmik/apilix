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

    // Build the item from current edit state
    const item: PostmanItem = {
      ...activeReq.item,
      request: {
        method: edit.method,
        url: { raw: edit.url },
        header: edit.headers,
        body: edit.bodyMode !== 'none' ? {
          mode: edit.bodyMode as NonNullable<NonNullable<PostmanItem['request']>['body']>['mode'],
          raw: edit.bodyMode === 'raw' ? edit.bodyRaw : undefined,
          urlencoded: edit.bodyMode === 'urlencoded' ? edit.bodyUrlEncoded : undefined,
          formdata: edit.bodyMode === 'formdata' ? edit.bodyFormData : undefined,
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
          formdata: edit.bodyMode === 'formdata' ? edit.bodyFormData : undefined,
          options: edit.bodyMode === 'raw' ? { raw: { language: edit.bodyRawLang as 'json' | 'text' } } : undefined,
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
            <div className="flex gap-3 flex-wrap">
              {(['none', 'raw', 'urlencoded', 'formdata'] as const).map(m => (
                <label key={m} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="bodyMode"
                    value={m}
                    checked={edit.bodyMode === m}
                    onChange={() => setEdit(x => x ? { ...x, bodyMode: m } : x)}
                    className="accent-orange-500"
                  />
                  <span className="text-sm text-slate-300">{m}</span>
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
    </div>
  );
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
