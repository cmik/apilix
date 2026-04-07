import { useState, useEffect, useRef, useCallback } from 'react';
import { marked } from 'marked';
import type { CollectionItem, CollectionRequest, CollectionHeader, CollectionQueryParam } from '../types';
import { useApp } from '../store';
import { executeRequest } from '../api';
import { getUrlDisplay, buildVarMap, resolveVariables } from '../utils/variableResolver';
import { updateItemById, renameItemById, resolveInheritedAuth, findItemInTree } from '../utils/treeHelpers';
import { parseCurlCommand } from '../utils/curlUtils';
import { parseHurlFile } from '../utils/hurlUtils';
import GraphQLPanel from './GraphQLPanel';
import CodeGenModal from './CodeGenModal';
import ScriptSnippetsLibrary from './ScriptSnippetsLibrary';
import ScriptEditor from './ScriptEditor';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'WS'];

const METHOD_COLORS: Record<string, string> = {
  GET: 'text-green-400',
  POST: 'text-blue-400',
  PUT: 'text-yellow-400',
  PATCH: 'text-orange-400',
  DELETE: 'text-red-400',
  HEAD: 'text-purple-400',
  OPTIONS: 'text-slate-400',
  WS: 'text-cyan-400',
};

const TABS = ['Params', 'Auth', 'Headers', 'Body', 'Pre-request', 'Tests', 'Docs'] as const;
type Tab = typeof TABS[number];

function flattenRequestNames(items: CollectionItem[]): string[] {
  const names: string[] = [];
  function walk(arr: CollectionItem[]) {
    for (const it of arr) {
      if (it.request && it.name) names.push(it.name);
      if (it.item) walk(it.item);
    }
  }
  walk(items);
  return names;
}

// ─── Local editable state for a request ─────────────────────────────────────

function extractPathParamNames(url: string): string[] {
  // Match :paramName segments in URL path (not inside query string)
  const pathPart = url.split('?')[0];
  const names: string[] = [];
  const re = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pathPart)) !== null) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function applyPathParams(url: string, params: Array<{ key: string; value: string }>): string {
  let resolved = url;
  for (const p of params) {
    if (p.key) {
      resolved = resolved.replace(
        new RegExp(`:${p.key}(?=/|$|\\?|#)`, 'g'),
        encodeURIComponent(p.value)
      );
    }
  }
  return resolved;
}

function itemToEditState(item: CollectionItem) {
  const req = item.request as CollectionRequest;
  const urlRaw = typeof req.url === 'string' ? req.url : (req.url?.raw ?? '');
  const urlVars = typeof req.url === 'object' ? (req.url?.variable ?? []) : [];
  const detectedNames = extractPathParamNames(urlRaw);
  const storedMap = new Map(urlVars.map(v => [v.key ?? '', v.value ?? '']));
  return {
    method: req.method?.toUpperCase() ?? 'GET',
    url: urlRaw,
    headers: (req.header ?? []).map(h => ({ ...h })),
    queryParams: extractQueryParams(req.url),
    pathParams: detectedNames.map(k => ({ key: k, value: storedMap.get(k) ?? '' })),
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
    description: item.description ?? req.description ?? '',
  };
}

function extractQueryParams(url: CollectionRequest['url']): CollectionQueryParam[] {
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
  return (url?.query ?? []).map(q => ({ ...q }));
}

function getScript(item: CollectionItem, type: 'prerequest' | 'test'): string {
  const ev = (item.event ?? []).find(e => e.listen === type);
  if (!ev) return '';
  return Array.isArray(ev.script.exec) ? ev.script.exec.join('\n') : (ev.script.exec ?? '');
}

// ─── Script tab with snippet library ─────────────────────────────────────────

interface ScriptTabProps {
  label: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  target: 'prerequest' | 'test';
  requestNames?: string[];
  onSyntaxCheck?: (hasError: boolean) => void;
}

function ScriptTab({ label, value, onChange, placeholder, target, requestNames, onSyntaxCheck }: ScriptTabProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleInsert = useCallback((code: string) => {
    const el = textareaRef.current;
    if (!el) {
      onChange(value ? value + '\n\n' + code : code);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const separator = (value.length > 0 && !value.endsWith('\n')) ? '\n\n' : (value.length > 0 ? '\n' : '');
    const before = value.slice(0, start);
    const after = value.slice(end);
    const newValue = before + (start === end && start === value.length ? separator : '') + code + after;
    onChange(newValue);
    // Restore focus and move cursor after inserted snippet
    requestAnimationFrame(() => {
      const insertPos = start + (start === end && start === value.length ? separator.length : 0) + code.length;
      el.focus();
      el.setSelectionRange(insertPos, insertPos);
    });
  }, [value, onChange]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-slate-500 text-xs">{label}</p>
        <ScriptSnippetsLibrary target={target} onInsert={handleInsert} />
      </div>
      <ScriptEditor
        textareaRef={textareaRef}
        value={value}
        onChange={onChange}
        onSyntaxCheck={onSyntaxCheck}
        rows={14}
        placeholder={placeholder}
        requestNames={requestNames}
      />
    </div>
  );
}

// ─── Key/value table component ───────────────────────────────────────────────

function rowsToText(rows: Array<{ key: string; value: string; disabled?: boolean }>): string {
  return rows
    .filter(r => r.key || r.value)
    .map(r => {
      const line = `${r.key}: ${r.value}`;
      return r.disabled ? `# ${line}` : line;
    })
    .join('\n');
}

function textToRows(text: string): Array<{ key: string; value: string; disabled?: boolean }> {
  return text
    .split('\n')
    .map(line => {
      const disabled = line.trimStart().startsWith('#');
      const stripped = disabled ? line.replace(/^[\s#]+/, '') : line;
      const colonIdx = stripped.indexOf(':');
      if (colonIdx === -1) {
        return { key: stripped.trim(), value: '', disabled };
      }
      return {
        key: stripped.slice(0, colonIdx).trim(),
        value: stripped.slice(colonIdx + 1).trim(),
        disabled,
      };
    })
    .filter(r => r.key || r.value);
}

function KvTable({
  rows,
  onChange,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
}: {
  rows: Array<{ key: string; value: string; disabled?: boolean }>;
  onChange: (rows: Array<{ key: string; value: string; disabled?: boolean }>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkText, setBulkText] = useState('');

  function enterBulk() {
    setBulkText(rowsToText(rows));
    setBulkMode(true);
  }

  function exitBulk() {
    onChange(textToRows(bulkText));
    setBulkMode(false);
  }

  function update(i: number, field: 'key' | 'value', val: string) {
    const next = rows.map((r, idx) => (idx === i ? { ...r, [field]: val } : r));
    onChange(next);
  }
  function toggle(i: number) {
    const next = rows.map((r, idx) => (idx === i ? { ...r, disabled: !r.disabled } : r));
    onChange(next);
  }
  function remove(i: number) {
    onChange(rows.filter((_, idx) => idx !== i));
  }
  function addRow() {
    onChange([...rows, { key: '', value: '' }]);
  }

  if (bulkMode) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-400">One <code className="text-orange-400">key: value</code> per line. Prefix a line with <code className="text-orange-400">#</code> to disable it.</span>
          <button
            onClick={exitBulk}
            className="text-xs text-orange-400 hover:text-orange-300 transition-colors"
          >
            ← Table view
          </button>
        </div>
        <textarea
          value={bulkText}
          onChange={e => setBulkText(e.target.value)}
          rows={8}
          spellCheck={false}
          placeholder={`${keyPlaceholder}: ${valuePlaceholder}\n...`}
          className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-orange-500 resize-y"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {rows.map((row, i) => (
        <div key={i} className={`flex gap-1 items-center ${row.disabled ? 'opacity-40' : ''}`}>
          <input
            type="checkbox"
            checked={!row.disabled}
            onChange={() => toggle(i)}
            title={row.disabled ? 'Enable' : 'Disable'}
            className="shrink-0 accent-orange-500 cursor-pointer"
          />
          <input
            value={row.key}
            onChange={e => update(i, 'key', e.target.value)}
            placeholder={keyPlaceholder}
            disabled={row.disabled}
            className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-orange-500 disabled:cursor-not-allowed"
          />
          <input
            value={row.value}
            onChange={e => update(i, 'value', e.target.value)}
            placeholder={valuePlaceholder}
            disabled={row.disabled}
            className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-orange-500 disabled:cursor-not-allowed"
          />
          <button onClick={() => remove(i)} className="px-2 text-slate-500 hover:text-red-400 text-lg leading-none">×</button>
        </div>
      ))}
      <div className="flex items-center gap-3 mt-1">
        <button
          onClick={addRow}
          className="text-xs text-slate-500 hover:text-orange-400 transition-colors"
        >
          + Add row
        </button>
        <button
          onClick={enterBulk}
          className="text-xs text-slate-500 hover:text-orange-400 transition-colors"
        >
          Bulk edit
        </button>
      </div>
    </div>
  );
}

// ─── WebSocket Panel ────────────────────────────────────────────────────────

interface WsMessage {
  id: string;
  direction: 'sent' | 'received' | 'info' | 'error';
  text: string;
  timestamp: number;
}

type WsStatus = 'disconnected' | 'connecting' | 'connected';

function WebSocketPanel({ url, headers }: {
  url: string;
  headers: Array<{ key: string; value: string; disabled?: boolean }>;
}) {
  const [status, setStatus] = useState<WsStatus>('disconnected');
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const [input, setInput] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const streamEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Close connection on unmount (tab switch / component teardown)
  useEffect(() => {
    return () => { wsRef.current?.close(1000); };
  }, []);

  function addMsg(direction: WsMessage['direction'], text: string) {
    setMessages(prev => [...prev, {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      direction,
      text,
      timestamp: Date.now(),
    }]);
  }

  function connect() {
    if (wsRef.current) return;
    if (!url.trim()) { addMsg('error', 'URL is empty'); return; }
    setStatus('connecting');

    // Support Sec-WebSocket-Protocol via headers
    const protocolHeader = headers.find(
      h => !h.disabled && h.key.toLowerCase() === 'sec-websocket-protocol'
    );
    const protocols = protocolHeader?.value
      ? protocolHeader.value.split(',').map(s => s.trim()).filter(Boolean)
      : undefined;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, protocols);
    } catch (err) {
      setStatus('disconnected');
      addMsg('error', `Connection failed: ${(err as Error).message}`);
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      addMsg('info', `Connected to ${url}`);
    };
    ws.onmessage = e => {
      addMsg('received', typeof e.data === 'string' ? e.data : '[Binary frame]');
    };
    ws.onerror = () => {
      addMsg('error', 'WebSocket error');
    };
    ws.onclose = e => {
      wsRef.current = null;
      setStatus('disconnected');
      addMsg('info', `Disconnected (code ${e.code}${e.reason ? ': ' + e.reason : ''})`);
    };
  }

  function disconnect() {
    wsRef.current?.close(1000, 'User disconnected');
  }

  function sendMessage() {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !input.trim()) return;
    wsRef.current.send(input);
    addMsg('sent', input);
    setInput('');
  }

  const STATUS_STYLE: Record<WsStatus, string> = {
    disconnected: 'bg-slate-700 text-slate-400',
    connecting: 'bg-yellow-900/70 text-yellow-300',
    connected: 'bg-green-900/70 text-green-300',
  };
  const MSG_STYLE: Record<WsMessage['direction'], string> = {
    sent: 'text-blue-300',
    received: 'text-green-300',
    info: 'text-slate-500 italic',
    error: 'text-red-400',
  };
  const MSG_PREFIX: Record<WsMessage['direction'], string> = {
    sent: '↑',
    received: '↓',
    info: '·',
    error: '✕',
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden min-h-0">
      {/* Toolbar */}
      <div className="px-3 py-2 border-b border-slate-700 bg-slate-800 flex items-center gap-3 shrink-0">
        <span className={`text-xs px-2 py-0.5 rounded font-medium ${STATUS_STYLE[status]}`}>
          {status === 'connecting' ? 'Connecting…' : status === 'connected' ? 'Connected' : 'Disconnected'}
        </span>
        {status !== 'connected' ? (
          <button
            onClick={connect}
            disabled={status === 'connecting'}
            className="px-3 py-1 bg-green-700 hover:bg-green-600 disabled:bg-slate-600 disabled:text-slate-500 text-white text-xs font-medium rounded transition-colors"
          >
            {status === 'connecting' ? 'Connecting…' : 'Connect'}
          </button>
        ) : (
          <button
            onClick={disconnect}
            className="px-3 py-1 bg-red-800 hover:bg-red-700 text-white text-xs font-medium rounded transition-colors"
          >
            Disconnect
          </button>
        )}
        <span className="text-xs text-slate-600">
          {messages.length} event{messages.length !== 1 ? 's' : ''}
        </span>
        {messages.length > 0 && (
          <button
            onClick={() => setMessages([])}
            className="ml-auto text-xs text-slate-600 hover:text-slate-400 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Message stream */}
      <div className="flex-1 overflow-y-auto p-3 bg-slate-900/60 font-mono text-xs min-h-0">
        {messages.length === 0 && (
          <p className="text-slate-600 italic text-center py-10">
            {status === 'disconnected'
              ? 'Click Connect to open a WebSocket connection'
              : 'Waiting for messages…'}
          </p>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={`flex gap-2 mb-0.5 leading-relaxed ${MSG_STYLE[msg.direction]}`}>
            <span className="shrink-0 w-3 text-center">{MSG_PREFIX[msg.direction]}</span>
            <span className="text-slate-600 shrink-0 tabular-nums">
              {new Date(msg.timestamp).toLocaleTimeString()}
            </span>
            <span className="break-all whitespace-pre-wrap flex-1">{msg.text}</span>
          </div>
        ))}
        <div ref={streamEndRef} />
      </div>

      {/* Message input */}
      <div className="px-3 py-2 border-t border-slate-700 bg-slate-800 shrink-0 flex gap-2 items-end">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          disabled={status !== 'connected'}
          placeholder={status === 'connected' ? 'Enter message (Enter to send, Shift+Enter for newline)' : 'Connect first…'}
          rows={2}
          spellCheck={false}
          className="flex-1 bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500 resize-none disabled:opacity-40 disabled:cursor-not-allowed"
        />
        <button
          onClick={sendMessage}
          disabled={status !== 'connected' || !input.trim()}
          className="px-4 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:bg-slate-700 disabled:text-slate-600 text-white text-sm font-medium rounded transition-colors"
        >
          Send
        </button>
      </div>
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
  const urlInputRef = useRef<HTMLInputElement>(null);
  const _sendRef = useRef<() => void>(() => {});
  const _saveRef = useRef<() => void>(() => {});

  const [edit, setEditRaw] = useState<EditState | null>(() =>
    activeTab ? itemToEditState(activeTab.item) : null
  );
  const [dirty, setDirty] = useState(false);
  const [activeRequestTab, setActiveRequestTab] = useState<Tab>('Params');
  const [preRequestHasError, setPreRequestHasError] = useState(false);
  const [testHasError, setTestHasError] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showCodeGen, setShowCodeGen] = useState(false);
  const [showSaveToCollection, setShowSaveToCollection] = useState(false);
  const [saveTargetCollectionId, setSaveTargetCollectionId] = useState<string>('');
  const [importText, setImportText] = useState('');
  const [importMode, setImportMode] = useState<'curl' | 'raw' | 'hurl'>('curl');
  const [importError, setImportError] = useState('');
  const [docsMode, setDocsMode] = useState<'edit' | 'preview'>('edit');
  const [urlAcSuggestions, setUrlAcSuggestions] = useState<string[]>([]);
  const [urlAcIndex, setUrlAcIndex] = useState(0);
  const [urlAcLeft, setUrlAcLeft] = useState(0);
  const [showSendMenu, setShowSendMenu] = useState(false);
  const sendMenuRef = useRef<HTMLDivElement>(null);

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

  // Listen for global keyboard shortcut events from App
  useEffect(() => {
    const onSend = () => _sendRef.current();
    const onSave = () => _saveRef.current();
    const onFocusUrl = () => { urlInputRef.current?.focus(); urlInputRef.current?.select(); };
    document.addEventListener('apilix:send', onSend);
    document.addEventListener('apilix:save', onSave);
    document.addEventListener('apilix:focusUrl', onFocusUrl);
    return () => {
      document.removeEventListener('apilix:send', onSend);
      document.removeEventListener('apilix:save', onSave);
      document.removeEventListener('apilix:focusUrl', onFocusUrl);
    };
  }, []);

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
  const col = state.collections.find(c => c._id === activeReq.collectionId);

  // Sync query params into URL
  function syncParamsToUrl(params: CollectionQueryParam[]) {
    const baseUrl = edit!.url.split('?')[0];
    const qs = params
      .filter(p => p.key && !p.disabled)
      .map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value ?? '')}`)
      .join('&');
    const newUrl = qs ? `${baseUrl}?${qs}` : baseUrl;
    setEdit(e => e ? { ...e, url: newUrl, queryParams: params } : e);
  }

  // Sync URL to query params when URL typed manually
  function measureInputTextWidth(text: string): number {
    const input = urlInputRef.current;
    const font = input ? getComputedStyle(input).font : '14px monospace';
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return 0;
    ctx.font = font;
    return ctx.measureText(text).width;
  }

  function handleUrlChange(val: string) {
    const params = extractQueryParamsFromString(val);
    const detectedNames = extractPathParamNames(val);
    setEdit(e => {
      if (!e) return e;
      const existing = new Map(e.pathParams.map(p => [p.key, p.value]));
      const pathParams = detectedNames.map(k => ({ key: k, value: existing.get(k) ?? '' }));
      return { ...e, url: val, queryParams: params, pathParams };
    });
    // Variable autocomplete: detect {{ before cursor
    const cursorPos = urlInputRef.current?.selectionStart ?? val.length;
    const before = val.slice(0, cursorPos);
    const openIdx = before.lastIndexOf('{{');
    if (openIdx !== -1 && !before.slice(openIdx + 2).includes('}}')) {
      const query = before.slice(openIdx + 2).toLowerCase();
      const matches = Object.keys(allVars).filter(k => k.toLowerCase().startsWith(query));
      setUrlAcSuggestions(matches);
      setUrlAcIndex(0);
      // Compute horizontal offset: padding-left (12px) + width of text up to {{ opening
      const paddingLeft = 12;
      const left = paddingLeft + measureInputTextWidth(val.slice(0, openIdx));
      setUrlAcLeft(left);
    } else {
      setUrlAcSuggestions([]);
    }
  }

  function insertUrlVariable(name: string) {
    const val = edit?.url ?? '';
    const cursorPos = urlInputRef.current?.selectionStart ?? val.length;
    const before = val.slice(0, cursorPos);
    const openIdx = before.lastIndexOf('{{');
    const newVal = val.slice(0, openIdx) + `{{${name}}}` + val.slice(cursorPos);
    const newCursor = openIdx + name.length + 4;
    const params = extractQueryParamsFromString(newVal);
    setEdit(e => e ? { ...e, url: newVal, queryParams: params } : e);
    setUrlAcSuggestions([]);
    requestAnimationFrame(() => {
      urlInputRef.current?.focus();
      urlInputRef.current?.setSelectionRange(newCursor, newCursor);
    });
  }

  function handleUrlKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (urlAcSuggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setUrlAcIndex(i => (i + 1) % urlAcSuggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setUrlAcIndex(i => (i - 1 + urlAcSuggestions.length) % urlAcSuggestions.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      insertUrlVariable(urlAcSuggestions[urlAcIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setUrlAcSuggestions([]);
    }
  }

  function extractQueryParamsFromString(url: string): CollectionQueryParam[] {
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
    const resolvedUrl = applyPathParams(edit.url, edit.pathParams);
    const item: CollectionItem = {
      ...activeReq.item,
      request: {
        method: edit.method,
        url: { raw: resolvedUrl, variable: edit.pathParams.filter(p => p.key).map(p => ({ key: p.key, value: p.value })) },
        header: edit.headers.filter(h => !h.disabled),
        body: edit.bodyMode !== 'none' ? {
          mode: edit.bodyMode as NonNullable<NonNullable<CollectionItem['request']>['body']>['mode'],
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
        cookies: state.cookieJar,
        collectionItems: col?.item ?? [],
      });

      dispatch({ type: 'SET_TAB_RESPONSE', payload: { tabId, response: result } });

      // Use a stable base timestamp so ordering is deterministic regardless of dispatch timing.
      // The store prepends entries, so dispatch order (not timestamp) controls visual order:
      //   dispatch pre-children first → they end up at the bottom (oldest)
      //   dispatch main request second → middle
      //   dispatch test children last → they end up at the top (newest)
      const logBase = Date.now();
      let logSeq = 0;

      // 1. Pre-request children (ran before main) — dispatch first so they appear below it
      if (result.preChildRequests && result.preChildRequests.length > 0) {
        result.preChildRequests.forEach((child) => {
          dispatch({
            type: 'ADD_CONSOLE_LOG',
            payload: {
              id: (logBase + logSeq).toString(36) + Math.random().toString(36).slice(2),
              timestamp: logBase + logSeq++,
              method: child.method,
              url: child.result.resolvedUrl ?? child.name,
              requestHeaders: child.result.requestHeaders
                ? Object.entries(child.result.requestHeaders).map(([key, value]) => ({ key, value }))
                : [],
              requestBody: child.result.requestBody,
              scriptLogs: child.result.scriptLogs ?? [],
              response: child.result,
            },
          });
        });
      }

      // 2. Main request
      dispatch({
        type: 'ADD_CONSOLE_LOG',
        payload: {
          id: (logBase + logSeq).toString(36) + Math.random().toString(36).slice(2),
          timestamp: logBase + logSeq++,
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

      // 3. Test children (ran after main) — dispatch last so they appear above it
      if (result.testChildRequests && result.testChildRequests.length > 0) {
        result.testChildRequests.forEach((child) => {
          dispatch({
            type: 'ADD_CONSOLE_LOG',
            payload: {
              id: (logBase + logSeq).toString(36) + Math.random().toString(36).slice(2),
              timestamp: logBase + logSeq++,
              method: child.method,
              url: child.result.resolvedUrl ?? child.name,
              requestHeaders: child.result.requestHeaders
                ? Object.entries(child.result.requestHeaders).map(([key, value]) => ({ key, value }))
                : [],
              requestBody: child.result.requestBody,
              scriptLogs: child.result.scriptLogs ?? [],
              response: child.result,
            },
          });
        });
      }

      if (result.updatedEnvironment) {
        dispatch({ type: 'UPDATE_ACTIVE_ENV_VARS', payload: result.updatedEnvironment });
      }
      if (result.updatedCollectionVariables) {
        dispatch({
          type: 'UPDATE_COLLECTION_VARS',
          payload: { collectionId: activeReq.collectionId, vars: result.updatedCollectionVariables },
        });
      }
      if (result.updatedGlobals) {
        dispatch({ type: 'UPDATE_GLOBAL_VARS', payload: result.updatedGlobals });
      }
      if (result.updatedCookies) {
        Object.entries(result.updatedCookies).forEach(([domain, cookies]) => {
          dispatch({ type: 'UPSERT_DOMAIN_COOKIES', payload: { domain, cookies } });
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
  _sendRef.current = handleSend;

  function buildMockUrl(mockBase: string, resolvedRaw: string) {
    try {
      const parsed = new URL(resolvedRaw);
      return mockBase + parsed.pathname + parsed.search + parsed.hash;
    } catch {
      const strippedOrigin = resolvedRaw.replace(/^https?:\/\/[^/]+/i, '');
      const normalizedPath = strippedOrigin !== resolvedRaw ? (strippedOrigin || '/') : resolvedRaw;
      const withSlash = normalizedPath.startsWith('/') ? normalizedPath : '/' + normalizedPath;
      return mockBase + withSlash;
    }
  }

  async function handleSendToMock() {
    if (!edit || !activeReq || !activeTab) return;
    if (!state.mockServerRunning) {
      window.alert('Mock server is not running. Start the mock server and try again.');
      return;
    }
    const mockBase = `http://localhost:${state.mockPort}`;
    const resolvedRaw = resolveVariables(applyPathParams(edit.url, edit.pathParams), allVars);
    const mockUrl = buildMockUrl(mockBase, resolvedRaw);
    const tabId = activeTab.id;
    dispatch({ type: 'SET_TAB_LOADING', payload: { tabId, loading: true } });
    dispatch({ type: 'SET_TAB_RESPONSE', payload: { tabId, response: null } });

    const col = state.collections.find(c => c._id === activeReq.collectionId);
    const resolvedAuth = edit.authType === 'inherit'
      ? resolveInheritedAuth(col?.item ?? [], activeReq.item.id ?? '', col?.auth)
      : buildAuth(edit);

    let binaryBase64: string | undefined;
    if (edit.bodyMode === 'file' && edit.bodyFile) {
      const ab = await edit.bodyFile.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      binaryBase64 = btoa(binary);
    }

    const item: CollectionItem = {
      ...activeReq.item,
      request: {
        method: edit.method,
        url: { raw: mockUrl },
        header: edit.headers.filter(h => !h.disabled),
        body: edit.bodyMode !== 'none' ? {
          mode: edit.bodyMode as NonNullable<NonNullable<CollectionItem['request']>['body']>['mode'],
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
        cookies: state.cookieJar,
        collectionItems: col?.item ?? [],
      });
      dispatch({ type: 'SET_TAB_RESPONSE', payload: { tabId, response: result } });
      dispatch({
        type: 'ADD_CONSOLE_LOG',
        payload: {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2),
          timestamp: Date.now(),
          method: edit.method,
          url: result.resolvedUrl ?? mockUrl,
          requestHeaders: result.requestHeaders
            ? Object.entries(result.requestHeaders).map(([key, value]) => ({ key, value }))
            : edit.headers.map(h => ({ ...h, value: resolveVariables(h.value, allVars) })),
          requestBody: result.requestBody ?? (edit.bodyMode === 'raw' ? resolveVariables(edit.bodyRaw, allVars) : undefined),
          scriptLogs: result.scriptLogs ?? [],
          response: result,
        },
      });
      if (result.updatedEnvironment) dispatch({ type: 'UPDATE_ACTIVE_ENV_VARS', payload: result.updatedEnvironment });
      if (result.updatedCollectionVariables) dispatch({ type: 'UPDATE_COLLECTION_VARS', payload: { collectionId: activeReq.collectionId, vars: result.updatedCollectionVariables } });
      if (result.updatedGlobals) dispatch({ type: 'UPDATE_GLOBAL_VARS', payload: result.updatedGlobals });
      if (result.updatedCookies) Object.entries(result.updatedCookies).forEach(([domain, cookies]) => dispatch({ type: 'UPSERT_DOMAIN_COOKIES', payload: { domain, cookies } }));
    } catch (err) {
      const errPayload = { status: 0, statusText: 'Error', responseTime: 0, headers: {}, body: (err as Error).message, size: 0, testResults: [], error: (err as Error).message };
      dispatch({ type: 'SET_TAB_RESPONSE', payload: { tabId, response: errPayload } });
      dispatch({
        type: 'ADD_CONSOLE_LOG',
        payload: {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2),
          timestamp: Date.now(),
          method: edit.method,
          url: mockUrl,
          requestHeaders: edit.headers.map(h => ({ ...h, value: resolveVariables(h.value, allVars) })),
          requestBody: edit.bodyMode === 'raw' ? resolveVariables(edit.bodyRaw, allVars) : undefined,
          response: errPayload,
        },
      });
    }
    dispatch({ type: 'SET_TAB_LOADING', payload: { tabId, loading: false } });
  }

  function handleSave() {
    if (!activeTab || !edit) return;
    const col = state.collections.find(c => c._id === activeTab.collectionId);
    // Orphaned tab — collection deleted, or item deleted from within the collection
    const itemStillExists = col && activeTab.item.id ? findItemInTree(col.item, activeTab.item.id) !== null : false;
    if (!col || !itemStillExists) {
      setSaveTargetCollectionId(state.collections[0]?._id ?? '');
      setShowSaveToCollection(true);
      return;
    }
    if (!activeTab.item.id) return;
    const updatedItem: CollectionItem = {
      ...activeTab.item,
      description: edit.description || undefined,
      request: {
        ...(activeTab.item.request ?? {}),
        method: edit.method,
        url: { raw: edit.url, variable: edit.pathParams.filter(p => p.key).map(p => ({ key: p.key, value: p.value })) },
        header: edit.headers,
        body: edit.bodyMode !== 'none' ? {
          mode: edit.bodyMode as NonNullable<NonNullable<CollectionItem['request']>['body']>['mode'],
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
  _saveRef.current = handleSave;

  function handleImport() {
    if (importMode === 'hurl') {
      const items = parseHurlFile(importText);
      if (items.length === 0) {
        setImportError('No valid HURL request found. Make sure the entry starts with a method line like "GET https://…".');
        return;
      }
      // itemToEditState handles all fields: url, headers, queryParams, body, auth, test/pre-request scripts
      const parsed = itemToEditState(items[0]);
      setEdit(e => e ? { ...e, ...parsed } : e);
      setShowImportDialog(false);
      setImportText('');
      setImportError('');
      return;
    }
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
          <div className="relative flex-1">
          <input
            ref={urlInputRef}
            type="text"
            value={edit.url}
            onChange={e => handleUrlChange(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            onBlur={() => setTimeout(() => setUrlAcSuggestions([]), 120)}
            placeholder="https://api.example.com/endpoint"
            className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:border-orange-500"
          />
          {urlAcSuggestions.length > 0 && (
            <div className="absolute top-full mt-1 z-50 bg-slate-800 border border-slate-600 rounded shadow-xl min-w-52 max-h-52 overflow-y-auto" style={{ left: urlAcLeft }}>
              {urlAcSuggestions.map((name, i) => (
                <button
                  key={name}
                  onMouseDown={e => { e.preventDefault(); insertUrlVariable(name); }}
                  className={`w-full text-left px-3 py-1.5 text-xs font-mono flex items-center gap-1 ${i === urlAcIndex ? 'bg-orange-600/20 text-orange-300' : 'text-slate-300 hover:bg-slate-700'}`}
                >
                  <span className="text-slate-500">{'{{'}</span>{name}<span className="text-slate-500">{'}}'}</span>
                  {allVars[name] !== undefined && (
                    <span className="ml-auto text-slate-500 truncate max-w-24">{allVars[name]}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          </div>
          <button
            onClick={() => { setImportText(''); setImportError(''); setShowImportDialog(true); }}
            title="Import from cURL or Raw HTTP"
            className="px-3 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-500 text-slate-400 hover:text-slate-200 text-xs rounded transition-colors shrink-0 whitespace-nowrap"
          >
            Import
          </button>
          {edit.method !== 'WS' && (
            <button
              onClick={() => setShowCodeGen(true)}
              title="Generate code snippet"
              className="px-3 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-500 text-slate-400 hover:text-slate-200 text-xs rounded transition-colors shrink-0 whitespace-nowrap"
            >
              Code
            </button>
          )}
          {dirty && (
            <button
              onClick={handleSave}
              title="Save changes to collection (⌘S / Ctrl+S)"
              className="px-3 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-500 text-slate-200 text-sm rounded transition-colors flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
              </svg>
              Save
            </button>
          )}
          {edit.method !== 'WS' && (
            <div ref={sendMenuRef} className="relative flex">
              <button
                onClick={handleSend}
                disabled={state.isLoading}
                title="Send request (⌘↵ / Ctrl+↵)"
                className="px-5 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-orange-900 text-white text-sm font-semibold rounded-l transition-colors"
              >
                {state.isLoading ? '...' : 'Send'}
              </button>
              <button
                onClick={() => setShowSendMenu(v => !v)}
                disabled={state.isLoading}
                title="Send options"
                className="px-2 py-2 bg-orange-700 hover:bg-orange-600 disabled:bg-orange-900 text-white text-xs rounded-r border-l border-orange-500 transition-colors"
              >
                ▾
              </button>
              {showSendMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowSendMenu(false)} />
                  <div className="absolute right-0 top-full mt-1 z-50 bg-slate-800 border border-slate-600 rounded-md shadow-2xl py-1 min-w-[190px]">
                    <button
                      onClick={() => { setShowSendMenu(false); handleSendToMock(); }}
                      disabled={!state.mockServerRunning}
                      title={state.mockServerRunning ? `Send to mock server on port ${state.mockPort}` : 'Start the mock server first'}
                      className="w-full text-left flex items-center gap-2.5 px-3 py-1.5 text-xs transition-colors hover:bg-slate-700 text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                    >
                      <span className="w-4 shrink-0 text-center">🎭</span>
                      <span>
                        Send to Mock Server
                        {state.mockServerRunning && <span className="ml-1 text-slate-500 font-mono">:{state.mockPort}</span>}
                      </span>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tabs (HTTP only) */}
      {edit.method !== 'WS' && (
        <div className="flex border-b border-slate-700 bg-slate-800 shrink-0">
          {TABS.map(t => {
            const hasErr =
              (t === 'Pre-request' && preRequestHasError && !!edit.preRequestScript.trim()) ||
              (t === 'Tests' && testHasError && !!edit.testScript.trim());
            return (
              <button
                key={t}
                onClick={() => setActiveRequestTab(t)}
                className={`relative px-4 py-2 text-xs font-medium transition-colors ${
                  activeRequestTab === t
                    ? 'text-orange-400 border-b-2 border-orange-400 -mb-px'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {t}
                {hasErr && (
                  <span className="absolute top-1.5 right-1 w-1.5 h-1.5 rounded-full bg-red-500" title="Syntax error in script" />
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* WebSocket panel */}
      {edit.method === 'WS' && (
        <WebSocketPanel
          key={activeTabId ?? 'ws'}
          url={resolveVariables(edit.url, allVars)}
          headers={edit.headers}
        />
      )}

      {/* Tab content (HTTP only) */}
      {edit.method !== 'WS' && <div className="flex-1 overflow-y-auto p-3 bg-slate-800/50 min-h-0">
        {activeRequestTab === 'Params' && (
          <div className="flex flex-col gap-4">
            <KvTable
              rows={edit.queryParams}
              onChange={params => syncParamsToUrl(params)}
              keyPlaceholder="Parameter"
            />
            {edit.pathParams.length > 0 && (
              <div>
                <p className="text-xs text-slate-500 uppercase tracking-wider font-medium mb-2">Path Variables</p>
                <div className="flex flex-col gap-1">
                  {edit.pathParams.map((param, i) => (
                    <div key={param.key} className="flex gap-1 items-center">
                      <span className="w-36 shrink-0 px-2 py-1 bg-slate-700/50 border border-slate-600 rounded text-sm font-mono text-slate-400 truncate">
                        :{param.key}
                      </span>
                      <input
                        value={param.value}
                        onChange={e => {
                          const updated = edit.pathParams.map((p, j) =>
                            j === i ? { ...p, value: e.target.value } : p
                          );
                          setEdit(x => x ? { ...x, pathParams: updated } : x);
                        }}
                        placeholder="value"
                        className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
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
              <GraphQLPanel
                query={edit.bodyGraphqlQuery}
                variables={edit.bodyGraphqlVariables}
                url={resolveVariables(edit.url, allVars)}
                headers={edit.headers.filter(h => !h.disabled)}
                onQueryChange={q => setEdit(x => x ? { ...x, bodyGraphqlQuery: q } : x)}
                onVariablesChange={v => setEdit(x => x ? { ...x, bodyGraphqlVariables: v } : x)}
              />
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
              onChange={e => setEdit(x => x ? { ...x, authType: e.target.value as NonNullable<CollectionItem['request']>['auth'] extends { type: infer T } ? T : never } : x)}
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
          <ScriptTab
            label={<>JavaScript runs before the request. Use <code className="text-orange-400">apx.environment.set("key", "value")</code></>}
            value={edit.preRequestScript}
            onChange={v => setEdit(x => x ? { ...x, preRequestScript: v } : x)}
            onSyntaxCheck={setPreRequestHasError}
            placeholder={`// Pre-request script\napx.environment.set('timestamp', Date.now().toString());`}
            target="prerequest"
            requestNames={flattenRequestNames(col?.item ?? [])}
          />
        )}

        {activeRequestTab === 'Tests' && (
          <ScriptTab
            label={<>JavaScript runs after the response. Use <code className="text-orange-400">apx.test()</code> and <code className="text-orange-400">apx.expect()</code></>}
            value={edit.testScript}
            onChange={v => setEdit(x => x ? { ...x, testScript: v } : x)}
            onSyntaxCheck={setTestHasError}
            placeholder={`apx.test("Status is 200", () => {\n  apx.response.to.have.status(200);\n});\n\napx.test("Response has id", () => {\n  const json = apx.response.json();\n  apx.expect(json.id).to.exist;\n});`}
            target="test"
            requestNames={flattenRequestNames(col?.item ?? [])}
          />
        )}

        {activeRequestTab === 'Docs' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-500">Add notes or documentation for this request. Supports Markdown.</p>
              <div className="flex rounded overflow-hidden border border-slate-600 text-xs">
                <button
                  onClick={() => setDocsMode('edit')}
                  className={`px-3 py-1 transition-colors ${docsMode === 'edit' ? 'bg-slate-600 text-slate-100' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}
                >Edit</button>
                <button
                  onClick={() => setDocsMode('preview')}
                  className={`px-3 py-1 transition-colors ${docsMode === 'preview' ? 'bg-slate-600 text-slate-100' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}
                >Preview</button>
              </div>
            </div>
            {docsMode === 'edit' ? (
              <textarea
                value={edit.description}
                onChange={e => setEdit(x => x ? { ...x, description: e.target.value } : x)}
                rows={16}
                spellCheck={false}
                className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500 resize-y"
                placeholder={'# My Request\n\nDescribe what this request does, its parameters, and expected responses.'}
              />
            ) : (
              <div
                className="markdown-preview bg-slate-900 border border-slate-600 rounded px-4 py-3 min-h-[200px] text-sm text-slate-200 overflow-auto"
                // Content is always user-authored, never from external sources
                dangerouslySetInnerHTML={{ __html: edit.description ? marked.parse(edit.description) as string : '<p class="text-slate-600 italic">Nothing to preview.</p>' }}
              />
            )}
          </div>
        )}
      </div>}

      {/* Import dialog */}
      {showImportDialog && (        <div
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
                {(['curl', 'raw', 'hurl'] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => { setImportMode(m); setImportError(''); }}
                    className={`flex-1 text-xs px-3 py-1.5 rounded transition-colors font-medium ${
                      importMode === m ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {m === 'curl' ? 'cURL' : m === 'raw' ? 'Raw HTTP' : 'HURL'}
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
                  : importMode === 'raw'
                  ? "POST /users HTTP/1.1\nHost: api.example.com\nContent-Type: application/json\n\n{\"name\": \"Alice\"}"
                  : "POST https://api.example.com/users\nContent-Type: application/json\n\n{\"name\": \"Alice\"}\n\nHTTP *"}
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

      {/* Save-to-collection modal (orphaned tab) */}
      {showSaveToCollection && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={e => { if (e.target === e.currentTarget) setShowSaveToCollection(false); }}
        >
          <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl w-full max-w-sm mx-4">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <h3 className="text-sm font-semibold text-slate-200">Save to Collection</h3>
              <button onClick={() => setShowSaveToCollection(false)} className="text-slate-500 hover:text-slate-300 text-xl leading-none">×</button>
            </div>
            <div className="px-4 py-4 flex flex-col gap-3">
              <p className="text-xs text-slate-400">This request is no longer linked to a collection. Choose where to save it:</p>
              {state.collections.length === 0 ? (
                <p className="text-xs text-orange-400">No collections available. Please create a collection first.</p>
              ) : (
                <select
                  value={saveTargetCollectionId}
                  onChange={e => setSaveTargetCollectionId(e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
                >
                  {state.collections.map(c => (
                    <option key={c._id} value={c._id}>{c.info.name}</option>
                  ))}
                </select>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setShowSaveToCollection(false)}
                  className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  disabled={!saveTargetCollectionId}
                  onClick={() => {
                    if (!activeTab || !edit || !saveTargetCollectionId) return;
                    const targetCol = state.collections.find(c => c._id === saveTargetCollectionId);
                    if (!targetCol) return;
                    const updatedItem: CollectionItem = {
                      ...activeTab.item,
                      description: edit.description || undefined,
                      request: {
                        ...(activeTab.item.request ?? {}),
                        method: edit.method,
                        url: { raw: edit.url, variable: edit.pathParams.filter(p => p.key).map(p => ({ key: p.key, value: p.value })) },
                        header: edit.headers,
                        body: edit.bodyMode !== 'none' ? {
                          mode: edit.bodyMode as NonNullable<NonNullable<CollectionItem['request']>['body']>['mode'],
                          raw: edit.bodyMode === 'raw' ? edit.bodyRaw : undefined,
                          urlencoded: edit.bodyMode === 'urlencoded' ? edit.bodyUrlEncoded : undefined,
                          formdata: edit.bodyMode === 'formdata' ? edit.bodyFormData : undefined,
                          graphql: edit.bodyMode === 'graphql' ? { query: edit.bodyGraphqlQuery, variables: edit.bodyGraphqlVariables || undefined } : undefined,
                          options: edit.bodyMode === 'raw' ? { raw: { language: edit.bodyRawLang as 'json' | 'text' } } : undefined,
                        } : undefined,
                        auth: buildAuth(edit),
                      },
                    };
                    dispatch({ type: 'UPDATE_COLLECTION', payload: { ...targetCol, item: [...targetCol.item, updatedItem] } });
                    dispatch({ type: 'UPDATE_TAB', payload: { tabId: activeTab.id, collectionId: saveTargetCollectionId, item: updatedItem } });
                    cacheRef.current.set(activeTab.id, { edit, dirty: false });
                    setDirty(false);
                    setShowSaveToCollection(false);
                  }}
                  className="px-4 py-1.5 bg-orange-500 hover:bg-orange-600 text-white text-xs rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Code generation modal */}
      {showCodeGen && (
        <CodeGenModal
          params={{
            method: edit.method,
            url: edit.url,
            headers: edit.headers,
            bodyMode: edit.bodyMode,
            bodyRaw: edit.bodyRaw,
            bodyFormData: edit.bodyFormData,
            bodyUrlEncoded: edit.bodyUrlEncoded,
            bodyGraphqlQuery: edit.bodyGraphqlQuery,
            bodyGraphqlVariables: edit.bodyGraphqlVariables,
            authType: edit.authType,
            authBearer: edit.authBearer,
            authBasicUser: edit.authBasicUser,
            authBasicPass: edit.authBasicPass,
            authApiKeyName: edit.authApiKeyName,
            authApiKeyValue: edit.authApiKeyValue,
          }}
          onClose={() => setShowCodeGen(false)}
        />
      )}
    </div>
  );
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

function buildAuth(edit: ReturnType<typeof itemToEditState>): CollectionRequest['auth'] {
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

function buildEvents(edit: ReturnType<typeof itemToEditState>): CollectionItem['event'] {
  const events: CollectionItem['event'] = [];
  if (edit.preRequestScript.trim()) {
    events.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: edit.preRequestScript.split('\n') } });
  }
  if (edit.testScript.trim()) {
    events.push({ listen: 'test', script: { type: 'text/javascript', exec: edit.testScript.split('\n') } });
  }
  return events;
}
