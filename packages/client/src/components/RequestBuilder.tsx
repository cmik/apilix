import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { marked } from 'marked';
import type { CollectionItem, CollectionRequest, CollectionHeader, CollectionQueryParam, OAuth2Config, CollectionBody } from '../types';
import { useApp, generateId } from '../store';
import { executeRequest, API_BASE } from '../api';
import { getUrlDisplay, buildCollectionDefinitionVarMap, buildVarMap, resolveVariables } from '../utils/variableResolver';
import { updateItemById, renameItemById, resolveInheritedAuth, resolveInheritedAuthWithSource, findItemInTree, flattenRequestNames, flattenRequestItems, collectAncestorScripts, getRequestBreadcrumb, getRequestBreadcrumbPrefix } from '../utils/treeHelpers';
import { parseCurlCommand } from '../utils/curlUtils';
import { parseHurlFile } from '../utils/hurlUtils';
import { openAuthorizationWindow } from '../utils/oauth';
import GraphQLPanel from './GraphQLPanel';
import SoapPanel from './SoapPanel';
import CodeEditor from './CodeEditor';
import type { CodeLanguage } from './CodeEditor';
import ScriptSnippetsLibrary from './ScriptSnippetsLibrary';
import ScriptEditor from './ScriptEditor';
import OAuthConfigPanel from './OAuthConfigPanel';
import { IconRequests } from './Icons';
import type { SaveExistingRequestTabsResult, UnsavedRequestTabSummary } from '../utils/requestTabSyncGuard';
import { buildAllVariableSuggestions, DYNAMIC_VARIABLE_SUGGESTIONS, type VariableSuggestion } from '../utils/variableAutocomplete';
import VarInput from './VarInput';
import { buildBodyPreview, highlightUnresolved } from '../utils/bodyPreview';
import { INJECT_TEST_SNIPPET } from '../utils/appEvents';
import type { InjectTestSnippetDetail } from '../utils/appEvents';

const CodeGenModal = lazy(() => import('./CodeGenModal'));
const ItemSettingsModal = lazy(() => import('./ItemSettingsModal'));

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
type RawLanguage = NonNullable<NonNullable<NonNullable<CollectionBody['options']>['raw']>['language']>;

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

function applyPathParams(
  url: string,
  params: Array<{ key: string; value: string }>,
  vars?: Record<string, string>
): string {
  let resolved = url;
  for (const p of params) {
    if (p.key) {
      // Resolve {{variable}} tokens in the param value before URL-encoding,
      // so that e.g. :id = {{userId}} correctly substitutes the variable.
      const rawValue = vars ? resolveVariables(p.value, vars) : p.value;
      resolved = resolved.replace(
        new RegExp(`:${p.key}(?=/|$|\\?|#)`, 'g'),
        encodeURIComponent(rawValue)
      );
    }
  }
  return resolved;
}

// Auth sub-fields can be either an array of {key,value} pairs (Postman v2.1)
// or a plain object with named properties (Postman v2.0).
function authVal(field: unknown, arrayKey: string): string {
  if (Array.isArray(field)) {
    return (field as Array<{ key: string; value: string }>).find(b => b.key === arrayKey)?.value ?? '';
  }
  if (field && typeof field === 'object') {
    return ((field as Record<string, string>)[arrayKey]) ?? '';
  }
  return '';
}

function itemToEditState(item: CollectionItem) {
  // In Postman v2.0 the request can be a plain URL string
  const rawReq = item.request as unknown;
  const isStringRequest = typeof rawReq === 'string';
  const req = (isStringRequest ? {} : rawReq) as CollectionRequest;
  const urlRaw = isStringRequest
    ? (rawReq as string)
    : (typeof req.url === 'string' ? req.url : (req.url?.raw ?? ''));
  const urlVars = typeof req.url === 'object' ? (Array.isArray(req.url?.variable) ? req.url!.variable! : []) : [];
  const detectedNames = extractPathParamNames(urlRaw);
  const storedMap = new Map(urlVars.map(v => [v.key ?? '', v.value ?? '']));
  // Headers can be a raw string in v2.0 — drop them in that case
  const headerArr = Array.isArray(req.header) ? req.header : [];
  return {
    method: req.method?.toUpperCase() ?? 'GET',
    url: urlRaw,
    headers: headerArr.map(h => ({ ...h })),
    queryParams: extractQueryParams(urlRaw),
    pathParams: detectedNames.map(k => ({ key: k, value: storedMap.get(k) ?? '' })),
    bodyMode: req.body?.soap ? 'soap' : (req.body?.mode ?? 'none'),
    bodyRaw: req.body?.raw ?? '',
    bodyRawLang: req.body?.options?.raw?.language ?? 'json',
    bodyFormData: Array.isArray(req.body?.formdata) ? req.body!.formdata! : [],
    bodyUrlEncoded: Array.isArray(req.body?.urlencoded) ? req.body!.urlencoded! : [],
    authType: req.auth?.type ?? 'inherit',
    authBearer: authVal(req.auth?.bearer, 'token'),
    authBasicUser: authVal(req.auth?.basic, 'username'),
    authBasicPass: authVal(req.auth?.basic, 'password'),
    authApiKeyName: authVal(req.auth?.apikey, 'key') || 'X-API-Key',
    authApiKeyValue: authVal(req.auth?.apikey, 'value'),
    authApiKeyIn: authVal(req.auth?.apikey, 'in') === 'query' ? 'query' : 'header',
    authOAuth2Config: req.auth?.oauth2 ?? ({
      grantType: 'authorization_code',
      clientId: '',
      clientSecret: '',
      tokenUrl: '',
    } as OAuth2Config),
    preRequestScript: getScript(item, 'prerequest'),
    testScript: getScript(item, 'test'),
    bodyGraphqlQuery: req.body?.graphql?.query ?? '',
    bodyGraphqlVariables: req.body?.graphql?.variables ?? '',
    bodySoapAction: req.body?.soap?.action ?? '',
    bodySoapVersion: (req.body?.soap?.version ?? '1.1') as '1.1' | '1.2',
    bodySoapWsdlUrl: req.body?.soap?.wsdlUrl ?? '',
    bodyFile: null as File | null,
    description: item.description ?? req.description ?? '',
  };
}

function safeDecodeParam(str: string): string {
  try { return decodeURIComponent(str); } catch { return str; }
}

function parseQueryString(qs: string): CollectionQueryParam[] {
  return qs
    .split('&')
    .map(p => {
      const [key, ...rest] = p.split('=');
      return { key: safeDecodeParam(key), value: safeDecodeParam(rest.join('=')) };
    })
    .filter(p => p.key);
}

function extractQueryParams(url: CollectionRequest['url']): CollectionQueryParam[] {
  if (typeof url === 'string') {
    const idx = url.indexOf('?');
    if (idx === -1) return [];
    return parseQueryString(url.slice(idx + 1));
  }
  if (url?.query && url.query.length > 0) {
    return url.query.map(q => ({ ...q }));
  }
  // Saved requests store url as { raw, variable } with no query array — parse raw
  if (url?.raw) {
    const idx = url.raw.indexOf('?');
    if (idx === -1) return [];
    return parseQueryString(url.raw.slice(idx + 1));
  }
  return [];
}

function getScript(item: CollectionItem, type: 'prerequest' | 'test'): string {
  const ev = (item.event ?? []).find(e => e.listen === type);
  if (!ev) return '';
  return Array.isArray(ev.script.exec) ? ev.script.exec.join('\n') : (ev.script.exec ?? '');
}

function buildSoapBody(edit: EditState): NonNullable<NonNullable<CollectionItem['request']>['body']> {
  return {
    mode: 'raw',
    raw: edit.bodyRaw,
    options: { raw: { language: 'xml' } },
    soap: { action: edit.bodySoapAction, version: edit.bodySoapVersion, wsdlUrl: edit.bodySoapWsdlUrl || undefined },
  };
}

function injectSoapHeaders(headers: CollectionHeader[], action: string, version: '1.1' | '1.2'): CollectionHeader[] {
  const out = headers.filter(h => {
    const k = h.key.toLowerCase();
    return k !== 'content-type' && k !== 'soapaction';
  });
  if (version === '1.2') {
    out.push({ key: 'Content-Type', value: `application/soap+xml; charset=utf-8${action ? `; action="${action}"` : ''}` });
  } else {
    out.push({ key: 'Content-Type', value: 'text/xml; charset=utf-8' });
    if (action) out.push({ key: 'SOAPAction', value: `"${action}"` });
  }
  return out;
}

function buildUpdatedRequestItem(item: CollectionItem, edit: EditState): CollectionItem {
  const isSoap = edit.bodyMode === 'soap';
  return {
    ...item,
    description: edit.description || undefined,
    request: {
      ...(item.request ?? {}),
      method: edit.method,
      url: { raw: edit.url, variable: edit.pathParams.filter(p => p.key).map(p => ({ key: p.key, value: p.value })) },
      header: isSoap ? injectSoapHeaders(edit.headers, edit.bodySoapAction, edit.bodySoapVersion) : edit.headers,
      body: edit.bodyMode !== 'none' ? (
        isSoap ? buildSoapBody(edit) : {
          mode: edit.bodyMode as NonNullable<NonNullable<CollectionItem['request']>['body']>['mode'],
          raw: edit.bodyMode === 'raw' ? edit.bodyRaw : undefined,
          urlencoded: edit.bodyMode === 'urlencoded' ? edit.bodyUrlEncoded : undefined,
          formdata: edit.bodyMode === 'formdata' ? edit.bodyFormData : undefined,
          graphql: edit.bodyMode === 'graphql' ? { query: edit.bodyGraphqlQuery, variables: edit.bodyGraphqlVariables || undefined } : undefined,
          options: edit.bodyMode === 'raw' ? { raw: { language: edit.bodyRawLang as RawLanguage } } : undefined,
        }
      ) : undefined,
      auth: buildAuth(edit),
    },
    event: buildEvents(edit),
  };
}

// ─── Script tab with snippet library ─────────────────────────────────────────

interface ScriptTabProps {
  label: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  target: 'prerequest' | 'test';
  requestNames?: string[];
  requestItems?: Array<{ id: string; name: string }>;
  onSyntaxCheck?: (hasError: boolean) => void;
}

function ScriptTab({ label, value, onChange, placeholder, target, requestNames, requestItems, onSyntaxCheck }: ScriptTabProps) {
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
        requestItems={requestItems}
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
  variableSuggestions,
}: {
  rows: Array<{ key: string; value: string; disabled?: boolean }>;
  onChange: (rows: Array<{ key: string; value: string; disabled?: boolean }>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  variableSuggestions?: VariableSuggestion[];
}) {
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkText, setBulkText] = useState('');

  // Flush in-progress bulk text back to the parent when this instance unmounts
  // (e.g. user switches request tabs while bulk edit is open).
  const bulkModeRef = useRef(bulkMode);
  const bulkTextRef = useRef(bulkText);
  bulkModeRef.current = bulkMode;
  bulkTextRef.current = bulkText;
  useEffect(() => {
    return () => {
      if (bulkModeRef.current) {
        onChange(textToRows(bulkTextRef.current));
      }
    };
    // onChange identity is stable across renders; refs hold latest values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          <VarInput
            value={row.key}
            onChange={v => update(i, 'key', v)}
            placeholder={keyPlaceholder}
            disabled={row.disabled}
            variableSuggestions={variableSuggestions}
            className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-orange-500 disabled:cursor-not-allowed"
          />
          <VarInput
            value={row.value}
            onChange={v => update(i, 'value', v)}
            placeholder={valuePlaceholder}
            disabled={row.disabled}
            variableSuggestions={variableSuggestions}
            className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-orange-500 disabled:cursor-not-allowed"
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
type TabCache = { edit: EditState; dirty: boolean; activeRequestTab: Tab };

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
        className="w-full bg-slate-700 border border-orange-500 rounded px-2 py-0.5 text-xs text-slate-100 font-medium focus:outline-none mb-1"
      />
    );
  }

  return (
    <div className="group flex items-center gap-1 mb-1">
      <p className="text-slate-400 text-xs font-medium truncate">{name}</p>
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
  /** When provided (split view), the URL bar is portaled into this element instead of rendered inline */
  urlBarPortalTarget?: HTMLElement | null;
}

export default function RequestBuilder({ onDirtyChange, urlBarPortalTarget }: RequestBuilderProps) {
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
  const [showParentSettings, setShowParentSettings] = useState(false);
  const [showSaveToCollection, setShowSaveToCollection] = useState(false);
  const [saveTargetCollectionId, setSaveTargetCollectionId] = useState<string>('');
  const closeAfterSaveRef = useRef(false);
  const [showHistorySaveModal, setShowHistorySaveModal] = useState(false);
  const [historySaveMode, setHistorySaveMode] = useState<'overwrite' | 'new'>('overwrite');
  const [historySaveCollectionId, setHistorySaveCollectionId] = useState<string>('');
  // Save As modal
  const [showSaveAsModal, setShowSaveAsModal] = useState(false);
  const [saveAsTabId, setSaveAsTabId] = useState<string | null>(null);
  const [saveAsName, setSaveAsName] = useState('');
  const [saveAsCollectionId, setSaveAsCollectionId] = useState('');
  // Save All orphan modal
  const [showSaveAllOrphanModal, setShowSaveAllOrphanModal] = useState(false);
  const [saveAllOrphanTabIds, setSaveAllOrphanTabIds] = useState<string[]>([]);
  const [saveAllOrphanCollectionId, setSaveAllOrphanCollectionId] = useState('');
  const [importText, setImportText] = useState('');
  const [importMode, setImportMode] = useState<'curl' | 'raw' | 'hurl'>('curl');
  const [importError, setImportError] = useState('');
  const [docsMode, setDocsMode] = useState<'edit' | 'preview'>('edit');
  const [bodyPreviewMode, setBodyPreviewMode] = useState<'edit' | 'preview'>('edit');
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
      setActiveRequestTab(cached.activeRequestTab);
    } else {
      const fresh = itemToEditState(activeTab.item);
      cacheRef.current.set(activeTab.id, { edit: fresh, dirty: false, activeRequestTab: 'Params' });
      setEditRaw(fresh);
      setDirty(false);
      setActiveRequestTab('Params');
    }
  }, [activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Notify parent of dirty set changes
  useEffect(() => {
    if (!onDirtyChange) return;
    const ids = new Set<string>();
    cacheRef.current.forEach((v, k) => { if (v.dirty) ids.add(k); });
    onDirtyChange(ids);
  }, [dirty, onDirtyChange]);

  // Reset body preview to edit mode when switching tabs or changing body type
  useEffect(() => {
    setBodyPreviewMode('edit');
  }, [activeTabId, edit?.bodyMode]);

  function emitDirtyChange() {
    if (!onDirtyChange) return;
    const ids = new Set<string>();
    cacheRef.current.forEach((value, key) => {
      if (value.dirty) ids.add(key);
    });
    onDirtyChange(ids);
  }

  function getUnsavedSummary(): UnsavedRequestTabSummary {
    const dirtyTabIds: string[] = [];
    const existingDirtyTabIds: string[] = [];
    const draftDirtyTabIds: string[] = [];

    for (const tab of state.tabs) {
      const cached = cacheRef.current.get(tab.id);
      if (!cached?.dirty) continue;
      dirtyTabIds.push(tab.id);

      const collection = state.collections.find(c => c._id === tab.collectionId);
      const itemStillExists = collection && tab.item.id ? findItemInTree(collection.item, tab.item.id) !== null : false;
      if (collection && itemStillExists && tab.item.id) existingDirtyTabIds.push(tab.id);
      else draftDirtyTabIds.push(tab.id);
    }

    return { dirtyTabIds, existingDirtyTabIds, draftDirtyTabIds };
  }

  function saveExistingDirtyTabs(tabIds?: string[]): SaveExistingRequestTabsResult {
    const targetIds = new Set(tabIds ?? getUnsavedSummary().existingDirtyTabIds);
    const updatedCollectionsById = new Map(state.collections.map(collection => [collection._id, collection]));
    const changedCollectionIds = new Set<string>();
    const tabUpdates: Array<{ tabId: string; item: CollectionItem }> = [];
    const savedTabIds: string[] = [];
    const skippedTabIds: string[] = [];

    for (const tab of state.tabs) {
      if (!targetIds.has(tab.id)) continue;
      const cached = cacheRef.current.get(tab.id);
      if (!cached?.dirty || !tab.item.id) continue;

      const collection = updatedCollectionsById.get(tab.collectionId);
      const itemStillExists = collection ? findItemInTree(collection.item, tab.item.id) !== null : false;
      if (!collection || !itemStillExists) {
        skippedTabIds.push(tab.id);
        continue;
      }

      const updatedItem = buildUpdatedRequestItem(tab.item, cached.edit);
      const updatedCollection = {
        ...collection,
        item: updateItemById(collection.item, tab.item.id, updatedItem),
      };

      updatedCollectionsById.set(collection._id, updatedCollection);
      changedCollectionIds.add(collection._id);
      tabUpdates.push({ tabId: tab.id, item: updatedItem });
      savedTabIds.push(tab.id);
      cacheRef.current.set(tab.id, { ...cached, dirty: false });
    }

    const updatedCollections = state.collections.map(collection => updatedCollectionsById.get(collection._id) ?? collection);

    for (const collectionId of changedCollectionIds) {
      const updatedCollection = updatedCollectionsById.get(collectionId);
      if (updatedCollection) dispatch({ type: 'UPDATE_COLLECTION', payload: updatedCollection });
    }
    for (const update of tabUpdates) {
      dispatch({ type: 'UPDATE_TAB_ITEM', payload: update });
    }

    if (activeTab) {
      const activeCached = cacheRef.current.get(activeTab.id);
      setDirty(activeCached?.dirty ?? false);
    }
    emitDirtyChange();

    return {
      savedTabIds,
      skippedTabIds,
      updatedCollections,
    };
  }

  // Listen for global keyboard shortcut events from App
  useEffect(() => {
    const onSend = () => _sendRef.current();
    const onSave = () => {
      closeAfterSaveRef.current = false;
      _saveRef.current();
    };
    const onSaveClose = () => {
      closeAfterSaveRef.current = true;
      _saveRef.current();
    };
    const onSyncSummary = (event: Event) => {
      const detail = (event as CustomEvent<{ resolve?: (summary: UnsavedRequestTabSummary) => void }>).detail;
      detail?.resolve?.(getUnsavedSummary());
    };
    const onSyncSaveExisting = (event: Event) => {
      const detail = (event as CustomEvent<{ resolve?: (result: SaveExistingRequestTabsResult) => void; tabIds?: string[] }>).detail;
      detail?.resolve?.(saveExistingDirtyTabs(detail?.tabIds));
    };
    const onFocusUrl = () => { urlInputRef.current?.focus(); urlInputRef.current?.select(); };
    const onInjectSnippet = (event: Event) => {
      const detail = (event as CustomEvent<InjectTestSnippetDetail>).detail;
      const snippet = detail?.snippet;
      if (typeof snippet !== 'string') return;

      const targetTabId = detail?.tabId;

      // Target is the currently active tab (most common case)
      if (!targetTabId || targetTabId === activeTab?.id) {
        if (!activeTab) return;
        setEdit(prev => ({
          ...prev,
          testScript: prev.testScript.trim() ? prev.testScript + '\n\n' + snippet : snippet,
        }));
        setActiveRequestTabCached('Tests');
        return;
      }

      // User switched tabs before confirming — update the originating tab's cache
      const cached = cacheRef.current.get(targetTabId);
      if (!cached) return;
      const currentScript = cached.edit.testScript ?? '';
      cacheRef.current.set(targetTabId, {
        ...cached,
        dirty: true,
        activeRequestTab: 'Tests',
        edit: {
          ...cached.edit,
          testScript: currentScript.trim() ? currentScript + '\n\n' + snippet : snippet,
        },
      });
    };
    document.addEventListener('apilix:send', onSend);
    document.addEventListener('apilix:save', onSave);
    document.addEventListener('apilix:save-close', onSaveClose);
    document.addEventListener('apilix:request-tab-sync-summary', onSyncSummary as EventListener);
    document.addEventListener('apilix:request-tab-sync-save-existing', onSyncSaveExisting as EventListener);
    document.addEventListener('apilix:focusUrl', onFocusUrl);
    document.addEventListener(INJECT_TEST_SNIPPET, onInjectSnippet as EventListener);
    const onSaveAs = (event: Event) => {
      const { tabId } = (event as CustomEvent<{ tabId: string }>).detail;
      const tab = state.tabs.find(t => t.id === tabId);
      if (!tab) return;
      setSaveAsTabId(tabId);
      setSaveAsName(tab.item.name ?? 'Copy of Request');
      setSaveAsCollectionId(state.collections[0]?._id ?? '');
      setShowSaveAsModal(true);
    };
    const onSaveAll = () => {
      // 1. Save all existing linked dirty tabs silently
      saveExistingDirtyTabs();
      // 2. Check for remaining orphaned / draft dirty tabs
      const summary = getUnsavedSummary();
      if (summary.draftDirtyTabIds.length > 0) {
        setSaveAllOrphanTabIds(summary.draftDirtyTabIds);
        setSaveAllOrphanCollectionId(state.collections[0]?._id ?? '');
        setShowSaveAllOrphanModal(true);
      }
    };
    document.addEventListener('apilix:save-as', onSaveAs as EventListener);
    document.addEventListener('apilix:save-all', onSaveAll);
    return () => {
      document.removeEventListener('apilix:send', onSend);
      document.removeEventListener('apilix:save', onSave);
      document.removeEventListener('apilix:save-close', onSaveClose);
      document.removeEventListener('apilix:request-tab-sync-summary', onSyncSummary as EventListener);
      document.removeEventListener('apilix:request-tab-sync-save-existing', onSyncSaveExisting as EventListener);
      document.removeEventListener('apilix:focusUrl', onFocusUrl);
      document.removeEventListener(INJECT_TEST_SNIPPET, onInjectSnippet as EventListener);
      document.removeEventListener('apilix:save-as', onSaveAs as EventListener);
      document.removeEventListener('apilix:save-all', onSaveAll);
    };
  }, [activeTab, onDirtyChange, state.collections, state.tabs]);

  // Wrapper: update edit + cache + dirty in one call
  function setEdit(updater: (prev: EditState) => EditState) {
    setEditRaw(prev => {
      if (!prev || !activeTab) return prev;
      const next = updater(prev);
      const existing = cacheRef.current.get(activeTab.id);
      cacheRef.current.set(activeTab.id, { edit: next, dirty: true, activeRequestTab: existing?.activeRequestTab ?? 'Params' });
      setDirty(true);
      return next;
    });
  }

  // Wrapper: update active request sub-tab + cache in one call
  function setActiveRequestTabCached(tab: Tab) {
    setActiveRequestTab(tab);
    if (activeTab) {
      const existing = cacheRef.current.get(activeTab.id);
      if (existing) {
        cacheRef.current.set(activeTab.id, { ...existing, activeRequestTab: tab });
      }
    }
  }

  // Backward-compat alias used below
  const activeReq = activeTab
    ? { collectionId: activeTab.collectionId, item: activeTab.item }
    : null;

  if (!activeReq || !edit) {
    return (
      <div className="flex-1 flex items-center justify-center text-center">
        <div>
          <IconRequests className="w-16 h-16 mb-4 mx-auto text-slate-500" />
          <p className="text-slate-400">Select a request from the sidebar</p>
          <p className="text-slate-600 text-sm mt-1">or import a collection to get started</p>
        </div>
      </div>
    );
  }

  const envVars = getEnvironmentVars();
  const collVars = getCollectionVars(activeReq.collectionId);
  const col = state.collections.find(c => c._id === activeReq.collectionId);
  const collectionDefinitionVars = buildCollectionDefinitionVarMap(col?.variable ?? []);
  const allVars = buildVarMap(envVars, collVars, state.globalVariables, {}, collectionDefinitionVars);
  const variableSuggestions = buildAllVariableSuggestions(allVars);

  // Sync query params into URL
  function syncParamsToUrl(params: CollectionQueryParam[]) {
    const baseUrl = edit!.url.split('?')[0];
    const qs = params
      .filter(p => p.key && !p.disabled)
      .map(p => `${p.key.replace(/[&# ]/g, c => c === '&' ? '%26' : c === '#' ? '%23' : '%20')}=${(p.value ?? '').replace(/[&# ]/g, c => c === '&' ? '%26' : c === '#' ? '%23' : '%20')}`)
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
      const dynamicNames = DYNAMIC_VARIABLE_SUGGESTIONS.map(s => s.name);
      const dynamicNamesSet = new Set(dynamicNames);
      const allVarNames = [...dynamicNames, ...Object.keys(allVars).filter(k => !dynamicNamesSet.has(k))];
      const matches = allVarNames.filter(k => k.toLowerCase().startsWith(query));
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

  function resolveCodeGenUrlWithPathParams(editState: EditState, vars: Record<string, string>) {
    const resolvedUrl = resolveVariables(editState.url, vars);
    const pathParams = Array.isArray(editState.pathParams) ? editState.pathParams : [];

    return pathParams.reduce((url, param) => {
      const key = resolveVariables(param.key, vars);
      if (!key) return url;
      const value = encodeURIComponent(resolveVariables(param.value, vars));
      return url.replace(new RegExp(`:${key}(?=/|$|\\?)`, 'g'), value);
    }, resolvedUrl);
  }

  // Build CodeGenParams with all variable placeholders resolved
  function buildResolvedCodeGenParams(editState: EditState, vars: Record<string, string>) {
    return {
      method: editState.method,
      url: resolveCodeGenUrlWithPathParams(editState, vars),
      headers: editState.headers.map(h => ({
        key: resolveVariables(h.key, vars),
        value: resolveVariables(h.value, vars),
        disabled: h.disabled,
      })),
      bodyMode: editState.bodyMode,
      bodyRaw: resolveVariables(editState.bodyRaw, vars),
      bodyFormData: editState.bodyFormData.map(f => ({
        key: resolveVariables(f.key, vars),
        value: resolveVariables(f.value, vars),
        disabled: f.disabled,
      })),
      bodyUrlEncoded: editState.bodyUrlEncoded.map(e => ({
        key: resolveVariables(e.key, vars),
        value: resolveVariables(e.value, vars),
        disabled: e.disabled,
      })),
      bodyGraphqlQuery: resolveVariables(editState.bodyGraphqlQuery, vars),
      bodyGraphqlVariables: resolveVariables(editState.bodyGraphqlVariables, vars),
      authType: editState.authType,
      authBearer: resolveVariables(editState.authBearer, vars),
      authBasicUser: resolveVariables(editState.authBasicUser, vars),
      authBasicPass: resolveVariables(editState.authBasicPass, vars),
      authApiKeyName: resolveVariables(editState.authApiKeyName, vars),
      authApiKeyValue: resolveVariables(editState.authApiKeyValue, vars),
    };
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
    const resolvedUrl = applyPathParams(edit.url, edit.pathParams, allVars);
    const ancestorScripts = collectAncestorScripts(col?.item ?? [], activeReq.item.id ?? '', col?.event);
    const item: CollectionItem = {
      ...activeReq.item,
      request: {
        method: edit.method,
        url: { raw: resolvedUrl, variable: edit.pathParams.filter(p => p.key).map(p => ({ key: p.key, value: p.value })) },
        header: edit.headers.filter(h => !h.disabled),
        body: edit.bodyMode !== 'none' ? (
          edit.bodyMode === 'soap' ? buildSoapBody(edit) : {
            mode: edit.bodyMode as NonNullable<NonNullable<CollectionItem['request']>['body']>['mode'],
            raw: edit.bodyMode === 'raw' ? edit.bodyRaw : edit.bodyMode === 'file' ? (binaryBase64 ?? '') : undefined,
            urlencoded: edit.bodyMode === 'urlencoded' ? edit.bodyUrlEncoded : undefined,
            formdata: edit.bodyMode === 'formdata' ? edit.bodyFormData : undefined,
            graphql: edit.bodyMode === 'graphql' ? { query: edit.bodyGraphqlQuery, variables: edit.bodyGraphqlVariables || undefined } : undefined,
            options: edit.bodyMode === 'raw' ? { raw: { language: edit.bodyRawLang as RawLanguage } } : undefined,
          }
        ) : undefined,
        auth: resolvedAuth,
      },
      event: buildMergedEvents(edit, ancestorScripts),
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

      // History log (only the main request, not child requests)
      if (activeReq) {
        dispatch({
          type: 'ADD_REQUEST_HISTORY',
          payload: {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2),
            timestamp: logBase,
            method: edit.method,
            url: result.resolvedUrl ?? resolveVariables(edit.url, allVars),
            collectionId: activeReq.collectionId,
            itemId: activeReq.item.id ?? '',
            requestSnapshot: buildUpdatedRequestItem(activeTab.item, edit),
            statusCode: result.status ?? null,
            statusText: result.statusText ?? '',
            responseTime: result.responseTime ?? 0,
            error: result.error,
          },
        });
      }

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
      if (activeReq) {
        dispatch({
          type: 'ADD_REQUEST_HISTORY',
          payload: {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2),
            timestamp: Date.now(),
            method: edit.method,
            url: resolveVariables(edit.url, allVars),
            collectionId: activeReq.collectionId,
            itemId: activeReq.item.id ?? '',
            requestSnapshot: buildUpdatedRequestItem(activeTab.item, edit),
            statusCode: null,
            statusText: 'Error',
            responseTime: 0,
            error: (err as Error).message,
          },
        });
      }
    }
    dispatch({ type: 'SET_TAB_LOADING', payload: { tabId, loading: false } });
  }
  _sendRef.current = handleSend;

  async function handleSendToMock() {
    if (!edit || !activeReq || !activeTab) return;
    if (!state.mockServerRunning) {
      window.alert('Mock server is not running. Start the mock server and try again.');
      return;
    }
    const mockBase = `http://localhost:${state.mockPort}`;
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
        url: { raw: applyPathParams(edit.url, edit.pathParams, allVars) },
        header: edit.headers.filter(h => !h.disabled),
        body: edit.bodyMode !== 'none' ? (
          edit.bodyMode === 'soap' ? buildSoapBody(edit) : {
            mode: edit.bodyMode as NonNullable<NonNullable<CollectionItem['request']>['body']>['mode'],
            raw: edit.bodyMode === 'raw' ? edit.bodyRaw : edit.bodyMode === 'file' ? (binaryBase64 ?? '') : undefined,
            urlencoded: edit.bodyMode === 'urlencoded' ? edit.bodyUrlEncoded : undefined,
            formdata: edit.bodyMode === 'formdata' ? edit.bodyFormData : undefined,
            graphql: edit.bodyMode === 'graphql' ? { query: edit.bodyGraphqlQuery, variables: edit.bodyGraphqlVariables || undefined } : undefined,
            options: edit.bodyMode === 'raw' ? { raw: { language: edit.bodyRawLang as RawLanguage } } : undefined,
          }
        ) : undefined,
        auth: resolvedAuth,
      },
      event: buildMergedEvents(edit, collectAncestorScripts(col?.item ?? [], activeReq.item.id ?? '', col?.event)),
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
        mockBase,
      });
      dispatch({ type: 'SET_TAB_RESPONSE', payload: { tabId, response: result } });
      dispatch({
        type: 'ADD_CONSOLE_LOG',
        payload: {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2),
          timestamp: Date.now(),
          method: edit.method,
          url: result.resolvedUrl ?? mockBase,
          requestHeaders: result.requestHeaders
            ? Object.entries(result.requestHeaders).map(([key, value]) => ({ key, value }))
            : edit.headers.map(h => ({ ...h, value: resolveVariables(h.value, allVars) })),
          requestBody: result.requestBody ?? (edit.bodyMode === 'raw' ? resolveVariables(edit.bodyRaw, allVars) : undefined),
          scriptLogs: result.scriptLogs ?? [],
          response: result,
        },
      });
      dispatch({
        type: 'ADD_REQUEST_HISTORY',
        payload: {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2),
          timestamp: Date.now(),
          method: edit.method,
          url: result.resolvedUrl ?? mockBase,
          collectionId: activeReq.collectionId,
          itemId: activeReq.item.id ?? '',
          requestSnapshot: buildUpdatedRequestItem(activeTab.item, edit),
          statusCode: result.status ?? null,
          statusText: result.statusText ?? '',
          responseTime: result.responseTime ?? 0,
          error: result.error,
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
          url: mockBase,
          requestHeaders: edit.headers.map(h => ({ ...h, value: resolveVariables(h.value, allVars) })),
          requestBody: edit.bodyMode === 'raw' ? resolveVariables(edit.bodyRaw, allVars) : undefined,
          response: errPayload,
        },
      });
      dispatch({
        type: 'ADD_REQUEST_HISTORY',
        payload: {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2),
          timestamp: Date.now(),
          method: edit.method,
          url: mockBase,
          collectionId: activeReq.collectionId,
          itemId: activeReq.item.id ?? '',
          requestSnapshot: buildUpdatedRequestItem(activeTab.item, edit),
          statusCode: null,
          statusText: 'Error',
          responseTime: 0,
          error: (err as Error).message,
        },
      });
    }
    dispatch({ type: 'SET_TAB_LOADING', payload: { tabId, loading: false } });
  }

  // ─── OAuth 2.0 Handlers ──────────────────────────────────────────────────────

  async function handleGetAuthorizationCode() {
    if (!edit) return;
    const config = edit.authOAuth2Config;
    
    if (!config.authorizationUrl || !config.clientId || !config.tokenUrl) {
      window.alert('Missing required fields: Authorization URL, Client ID, or Token URL');
      return;
    }

    try {
      const result = await openAuthorizationWindow(
        config.authorizationUrl,
        config.clientId,
        config.redirectUrl || 'http://localhost:3000/oauth/callback',
        config.scopes || []
      );

      if (!result) {
        window.alert('Authorization was cancelled or the popup was blocked.');
        return;
      }

      // Exchange code for token
      try {
        const response = await fetch(`${API_BASE}/oauth/exchange-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            oauth2Config: {
              ...config,
              codeVerifier: result.codeVerifier,
            },
            authorizationCode: result.code,
            environment: envVars,
          }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to exchange authorization code');
        }

        const { accessToken, refreshToken, expiresAt } = await response.json();

        // Update the OAuth config with the new token
        setEdit(e => e ? {
          ...e,
          authOAuth2Config: {
            ...e.authOAuth2Config,
            accessToken,
            ...(refreshToken && { refreshToken }),
            expiresAt,
            codeVerifier: undefined, // Clear verifier after use
          },
        } : e);

        window.alert('Authorization successful! Token has been obtained.');
      } catch (err) {
        window.alert(`Failed to exchange authorization code: ${(err as Error).message}`);
      }
    } catch (err) {
      window.alert(`Failed to get authorization code: ${(err as Error).message}`);
    }
  }

  async function handleRefreshOAuthToken() {
    if (!edit) return;
    const config = edit.authOAuth2Config;

    if (!config.tokenUrl || !config.clientId) {
      window.alert('Missing required fields: Token URL or Client ID');
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/oauth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oauth2Config: config,
          environment: envVars,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to refresh token');
      }

      const { accessToken, refreshToken, expiresAt } = await response.json();

      // Update the OAuth config with the new token
      setEdit(e => e ? {
        ...e,
        authOAuth2Config: {
          ...e.authOAuth2Config,
          accessToken,
          ...(refreshToken && { refreshToken }),
          expiresAt,
        },
      } : e);

      window.alert('Token refreshed successfully!');
    } catch (err) {
      window.alert(`Failed to refresh token: ${(err as Error).message}`);
    }
  }

  function handleSave() {
    if (!activeTab || !edit) return;
    // History snapshot tab — ask the user before saving
    if (activeTab.fromHistory) {
      setHistorySaveMode('overwrite');
      setHistorySaveCollectionId(state.collections[0]?._id ?? '');
      setShowHistorySaveModal(true);
      return;
    }
    const col = state.collections.find(c => c._id === activeTab.collectionId);
    // Orphaned tab — collection deleted, or item deleted from within the collection
    const itemStillExists = col && activeTab.item.id ? findItemInTree(col.item, activeTab.item.id) !== null : false;
    if (!col || !itemStillExists) {
      setSaveTargetCollectionId(state.collections[0]?._id ?? '');
      setShowSaveToCollection(true);
      return;
    }
    if (!activeTab.item.id) return;
    const updatedItem = buildUpdatedRequestItem(activeTab.item, edit);
    dispatch({ type: 'UPDATE_COLLECTION', payload: { ...col, item: updateItemById(col.item, activeTab.item.id, updatedItem) } });
    dispatch({ type: 'UPDATE_TAB_ITEM', payload: { tabId: activeTab.id, item: updatedItem } });
    // Mark clean in cache
    cacheRef.current.set(activeTab.id, { edit, dirty: false, activeRequestTab });
    setDirty(false);
    emitDirtyChange();
  }
  _saveRef.current = handleSave;

  function handleSaveAs(tabId: string, newName: string, targetCollectionId: string) {
    const tab = state.tabs.find(t => t.id === tabId);
    if (!tab) return;
    const targetCol = state.collections.find(c => c._id === targetCollectionId);
    if (!targetCol) return;

    // Use cached draft edit if available, otherwise fall back to tab.item
    const cached = cacheRef.current.get(tabId);
    const baseItem = cached?.edit
      ? buildUpdatedRequestItem(tab.item, cached.edit)
      : tab.item;

    const newItem: CollectionItem = {
      ...baseItem,
      id: generateId(),
      name: newName.trim() || baseItem.name,
    };

    dispatch({ type: 'UPDATE_COLLECTION', payload: { ...targetCol, item: [...targetCol.item, newItem] } });
    dispatch({ type: 'UPDATE_TAB', payload: { tabId, collectionId: targetCollectionId, item: newItem } });

    if (cached) {
      cacheRef.current.set(tabId, { ...cached, dirty: false });
    }
    if (tabId === activeTab?.id) {
      setDirty(false);
    }
    emitDirtyChange();
  }

  function handleSaveAllOrphans(tabIds: string[], targetCollectionId: string) {
    const targetCol = state.collections.find(c => c._id === targetCollectionId);
    if (!targetCol) return;

    let updatedItems = [...targetCol.item];
    for (const tabId of tabIds) {
      const tab = state.tabs.find(t => t.id === tabId);
      if (!tab) continue;
      const cached = cacheRef.current.get(tabId);
      const baseItem = cached?.edit
        ? buildUpdatedRequestItem(tab.item, cached.edit)
        : tab.item;
      const newItem: CollectionItem = { ...baseItem, id: generateId() };
      updatedItems = [...updatedItems, newItem];
      dispatch({ type: 'UPDATE_TAB', payload: { tabId, collectionId: targetCollectionId, item: newItem } });
      if (cached) cacheRef.current.set(tabId, { ...cached, dirty: false });
    }
    dispatch({ type: 'UPDATE_COLLECTION', payload: { ...targetCol, item: updatedItems } });
    emitDirtyChange();
  }

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

  const urlBarSection = (
    <div className="px-4 pt-3 pb-1 border-b border-slate-700 bg-slate-900">
      {/* Request name with breadcrumb prefix */}
        <div className="flex items-center gap-0 mb-1 min-w-0">
          {activeTab?.item.id && col && (() => {
            const prefix = getRequestBreadcrumbPrefix(state.collections, activeReq.collectionId, activeTab.item.id);
            if (!prefix) return null;
            const prefixStr = prefix.join(' > ');
            return (
              <span
                className="text-slate-600 text-[10px] shrink-0 mb-1 truncate max-w-[50%]"
                title={prefixStr}
              >
                {prefixStr}&nbsp;&gt;&nbsp;
              </span>
            );
          })()}
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
        </div>
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
  );

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {urlBarPortalTarget ? createPortal(urlBarSection, urlBarPortalTarget) : urlBarSection}

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
                onClick={() => setActiveRequestTabCached(t)}
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
              key={activeTabId + '-params'}
              rows={edit.queryParams}
              onChange={params => syncParamsToUrl(params)}
              keyPlaceholder="Parameter"
              variableSuggestions={variableSuggestions}
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
                      <VarInput
                        value={param.value}
                        onChange={v => {
                          const updated = edit.pathParams.map((p, j) =>
                            j === i ? { ...p, value: v } : p
                          );
                          setEdit(x => x ? { ...x, pathParams: updated } : x);
                        }}
                        placeholder="value"
                        variableSuggestions={variableSuggestions}
                        className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
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
            key={activeTabId + '-headers'}
            rows={edit.headers}
            onChange={headers => setEdit(x => x ? { ...x, headers } : x)}
            keyPlaceholder="Header name"
            variableSuggestions={variableSuggestions}
          />
        )}

        {activeRequestTab === 'Body' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 flex-wrap">
              {(['none', 'raw', 'urlencoded', 'formdata', 'graphql', 'soap', 'file'] as const).map(m => (
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
              {edit.bodyMode !== 'none' && (
                <div className="ml-auto flex items-center gap-2">
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
                      className="text-xs text-slate-500 hover:text-orange-400 transition-colors"
                    >
                      Beautify
                    </button>
                  )}
                  {edit.bodyMode !== 'file' && (
                    <div className="flex rounded overflow-hidden border border-slate-600 text-xs">
                      <button
                        onClick={() => setBodyPreviewMode('edit')}
                        className={`px-3 py-1 transition-colors ${bodyPreviewMode === 'edit' ? 'bg-slate-600 text-slate-100' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}
                      >Edit</button>
                      <button
                        onClick={() => setBodyPreviewMode('preview')}
                        className={`px-3 py-1 transition-colors ${bodyPreviewMode === 'preview' ? 'bg-slate-600 text-slate-100' : 'bg-slate-800 text-slate-400 hover:text-slate-200'}`}
                      >Preview</button>
                    </div>
                  )}
                </div>
              )}
            </div>
            {bodyPreviewMode === 'edit' && edit.bodyMode === 'raw' && (
              <CodeEditor
                value={edit.bodyRaw}
                onChange={e => setEdit(x => x ? { ...x, bodyRaw: e.target.value } : x)}
                language={edit.bodyRawLang as CodeLanguage}
                rows={10}
                variableSuggestions={variableSuggestions}
                placeholder={edit.bodyRawLang === 'json' ? '{\n  "key": "value"\n}' : 'Request body...'}
              />
            )}
            {bodyPreviewMode === 'edit' && edit.bodyMode === 'urlencoded' && (
              <KvTable
                key={activeTabId + '-urlencoded'}
                rows={edit.bodyUrlEncoded}
                onChange={v => setEdit(x => x ? { ...x, bodyUrlEncoded: v } : x)}
                variableSuggestions={variableSuggestions}
              />
            )}
            {bodyPreviewMode === 'edit' && edit.bodyMode === 'formdata' && (
              <KvTable
                key={activeTabId + '-formdata'}
                rows={edit.bodyFormData}
                onChange={v => setEdit(x => x ? { ...x, bodyFormData: v } : x)}
                variableSuggestions={variableSuggestions}
              />
            )}
            {bodyPreviewMode === 'edit' && edit.bodyMode === 'graphql' && (
              <GraphQLPanel
                query={edit.bodyGraphqlQuery}
                variables={edit.bodyGraphqlVariables}
                url={resolveVariables(edit.url, allVars)}
                headers={edit.headers.filter(h => !h.disabled)}
                variableSuggestions={variableSuggestions}
                onQueryChange={q => setEdit(x => x ? { ...x, bodyGraphqlQuery: q } : x)}
                onVariablesChange={v => setEdit(x => x ? { ...x, bodyGraphqlVariables: v } : x)}
              />
            )}
            {bodyPreviewMode === 'edit' && edit.bodyMode === 'soap' && (
              <SoapPanel
                envelope={edit.bodyRaw}
                action={edit.bodySoapAction}
                version={edit.bodySoapVersion}
                wsdlUrl={edit.bodySoapWsdlUrl}
                variableSuggestions={variableSuggestions}
                onEnvelopeChange={v => setEdit(x => x ? { ...x, bodyRaw: v } : x)}
                onActionChange={v => setEdit(x => x ? { ...x, bodySoapAction: v } : x)}
                onVersionChange={v => setEdit(x => x ? { ...x, bodySoapVersion: v } : x)}
                onWsdlUrlChange={v => setEdit(x => x ? { ...x, bodySoapWsdlUrl: v } : x)}
              />
            )}
            {bodyPreviewMode === 'preview' && edit.bodyMode !== 'none' && edit.bodyMode !== 'file' && (() => {
              const preview = buildBodyPreview({
                bodyMode: edit.bodyMode,
                bodyRaw: edit.bodyRaw,
                bodyRawLang: edit.bodyRawLang,
                bodyUrlEncoded: edit.bodyUrlEncoded,
                bodyFormData: edit.bodyFormData,
                bodyGraphqlVariables: edit.bodyGraphqlVariables,
              }, allVars);

              if (preview.kind === 'text') {
                const segs = highlightUnresolved(preview.text);
                return (
                  <div className="relative">
                    {edit.bodyMode === 'graphql' && (
                      <p className="text-xs text-slate-500 mb-1">GraphQL variables (resolved)</p>
                    )}
                    <pre className="bg-slate-900 border border-slate-700 rounded px-3 py-2 text-xs font-mono text-slate-200 overflow-auto whitespace-pre-wrap min-h-[80px]">
                      {segs.map((s, i) =>
                        s.unresolved
                          ? <mark key={i} className="bg-amber-500/20 text-amber-300 rounded px-0.5 not-italic">{s.text}</mark>
                          : <span key={i}>{s.text}</span>
                      )}
                      {!preview.text && <span className="text-slate-600 italic">Empty body.</span>}
                    </pre>
                  </div>
                );
              }

              if (preview.kind === 'kv') {
                return (
                  <div className="flex flex-col gap-2">
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr className="text-slate-500 border-b border-slate-700">
                          <th className="text-left py-1 pr-3 font-medium w-1/3">Key</th>
                          <th className="text-left py-1 font-medium">Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.length === 0 && (
                          <tr><td colSpan={2} className="py-2 text-slate-600 italic">No entries.</td></tr>
                        )}
                        {preview.rows.map((row, i) => (
                          <tr key={i} className={`border-b border-slate-800 ${row.disabled ? 'opacity-40' : ''}`}>
                            <td className="py-1 pr-3 font-mono text-slate-300">
                              {highlightUnresolved(row.key).map((s, j) =>
                                s.unresolved ? <mark key={j} className="bg-amber-500/20 text-amber-300 rounded px-0.5 not-italic">{s.text}</mark> : <span key={j}>{s.text}</span>
                              )}
                            </td>
                            <td className="py-1 font-mono text-slate-300">
                              {highlightUnresolved(row.value).map((s, j) =>
                                s.unresolved ? <mark key={j} className="bg-amber-500/20 text-amber-300 rounded px-0.5 not-italic">{s.text}</mark> : <span key={j}>{s.text}</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {preview.serialized && (
                      <p className="text-[10px] text-slate-500 font-mono break-all border border-slate-700 rounded px-2 py-1 bg-slate-900">
                        <span className="text-slate-600 mr-1">Serialized:</span>
                        {highlightUnresolved(preview.serialized).map((s, i) =>
                          s.unresolved ? <mark key={i} className="bg-amber-500/20 text-amber-300 rounded px-0.5 not-italic">{s.text}</mark> : <span key={i}>{s.text}</span>
                        )}
                      </p>
                    )}
                  </div>
                );
              }

              if (preview.kind === 'form') {
                return (
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="text-slate-500 border-b border-slate-700">
                        <th className="text-left py-1 pr-3 font-medium w-1/3">Key</th>
                        <th className="text-left py-1 pr-3 font-medium w-1/6">Type</th>
                        <th className="text-left py-1 font-medium">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.length === 0 && (
                        <tr><td colSpan={3} className="py-2 text-slate-600 italic">No entries.</td></tr>
                      )}
                      {preview.rows.map((row, i) => (
                        <tr key={i} className={`border-b border-slate-800 ${row.disabled ? 'opacity-40' : ''}`}>
                          <td className="py-1 pr-3 font-mono text-slate-300">
                            {highlightUnresolved(row.key).map((s, j) =>
                              s.unresolved ? <mark key={j} className="bg-amber-500/20 text-amber-300 rounded px-0.5 not-italic">{s.text}</mark> : <span key={j}>{s.text}</span>
                            )}
                          </td>
                          <td className="py-1 pr-3">
                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${row.type === 'file' ? 'text-sky-400 bg-sky-400/15' : 'text-slate-400 bg-slate-400/15'}`}>
                              {row.type}
                            </span>
                          </td>
                          <td className="py-1 font-mono text-slate-300">
                            {row.type === 'file'
                              ? <span className="text-sky-400 italic">{row.value}</span>
                              : highlightUnresolved(row.value).map((s, j) =>
                                  s.unresolved ? <mark key={j} className="bg-amber-500/20 text-amber-300 rounded px-0.5 not-italic">{s.text}</mark> : <span key={j}>{s.text}</span>
                                )
                            }
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                );
              }

              return null;
            })()}
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
            : inheritedAuth.type === 'oauth2' ? 'OAuth 2.0'
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
              <option value="oauth2">OAuth 2.0</option>
            </select>

            {edit.authType === 'inherit' && (() => {
              const authColForSource = state.collections.find(c => c._id === activeReq!.collectionId);
              const { source } = resolveInheritedAuthWithSource(
                authColForSource?.item ?? [],
                activeReq!.item.id ?? '',
                authColForSource?.auth,
                authColForSource?.info.name ?? 'Collection',
              );
              return (
                <div className="flex gap-2.5 bg-slate-700/40 border border-slate-600 rounded px-3 py-2.5">
                  <svg className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-300">This request inherits authorization from its parent folder or collection.</p>
                    <p className="text-xs mt-1">
                      <span className="text-slate-400">Effective: </span>
                      <span className={inheritedAuth && inheritedAuth.type !== 'noauth' ? 'text-orange-400 font-medium' : 'text-slate-500 italic'}>
                        {inheritedLabel}
                      </span>
                    </p>
                    <p className="text-xs mt-1">
                      <span className="text-slate-400">Defined in: </span>
                      <span className="text-slate-200 font-medium">{source.name}</span>
                      <span className="text-slate-500 ml-1">({source.kind})</span>
                    </p>
                    <button
                      onClick={() => setShowParentSettings(true)}
                      className="mt-2 text-xs text-orange-400 hover:text-orange-300 underline underline-offset-2 transition-colors"
                    >
                      Edit {source.kind} auth settings ↗
                    </button>
                  </div>
                </div>
              );
            })()}

            {edit.authType === 'bearer' && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-slate-400">Token</label>
                <VarInput
                  value={edit.authBearer}
                  onChange={v => setEdit(x => x ? { ...x, authBearer: v } : x)}
                  placeholder="{{token}}"
                  variableSuggestions={variableSuggestions}
                  className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
                />
              </div>
            )}

            {edit.authType === 'basic' && (
              <div className="flex flex-col gap-2">
                <div>
                  <label className="text-xs text-slate-400">Username</label>
                  <VarInput
                    value={edit.authBasicUser}
                    onChange={v => setEdit(x => x ? { ...x, authBasicUser: v } : x)}
                    variableSuggestions={variableSuggestions}
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
                  <label className="text-xs text-slate-400">Add to</label>
                  <select
                    value={edit.authApiKeyIn}
                    onChange={e => setEdit(x => x ? { ...x, authApiKeyIn: e.target.value === 'query' ? 'query' : 'header' } : x)}
                    className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
                  >
                    <option value="header">Header</option>
                    <option value="query">Query Params</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400">Key Name</label>
                  <VarInput
                    value={edit.authApiKeyName}
                    onChange={v => setEdit(x => x ? { ...x, authApiKeyName: v } : x)}
                    variableSuggestions={variableSuggestions}
                    className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-400">Value</label>
                  <VarInput
                    value={edit.authApiKeyValue}
                    onChange={v => setEdit(x => x ? { ...x, authApiKeyValue: v } : x)}
                    variableSuggestions={variableSuggestions}
                    className="mt-1 w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
                  />
                </div>
              </div>
            )}

            {edit.authType === 'oauth2' && (
              <OAuthConfigPanel
                config={edit.authOAuth2Config}
                onChange={config => setEdit(x => x ? { ...x, authOAuth2Config: { ...x.authOAuth2Config, ...config } } : x)}
                onGetAuthorizationCode={handleGetAuthorizationCode}
                onRefreshToken={handleRefreshOAuthToken}
                variableSuggestions={variableSuggestions}
              />
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
            requestItems={flattenRequestItems(col?.item ?? [])}
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
            requestItems={flattenRequestItems(col?.item ?? [])}
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
          onClick={e => { if (e.target === e.currentTarget) { closeAfterSaveRef.current = false; setShowSaveToCollection(false); } }}
        >
          <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl w-full max-w-sm mx-4">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <h3 className="text-sm font-semibold text-slate-200">Save to Collection</h3>
              <button onClick={() => { closeAfterSaveRef.current = false; setShowSaveToCollection(false); }} className="text-slate-500 hover:text-slate-300 text-xl leading-none">×</button>
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
                  onClick={() => { closeAfterSaveRef.current = false; setShowSaveToCollection(false); }}
                  className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  disabled={!saveTargetCollectionId}
                  onClick={() => {
                    if (!activeTab || !edit || !saveTargetCollectionId) { closeAfterSaveRef.current = false; return; }
                    const targetCol = state.collections.find(c => c._id === saveTargetCollectionId);
                    if (!targetCol) { closeAfterSaveRef.current = false; return; }
                    const updatedItem: CollectionItem = {
                      ...activeTab.item,
                      description: edit.description || undefined,
                      request: {
                        ...(activeTab.item.request ?? {}),
                        method: edit.method,
                        url: { raw: edit.url, variable: edit.pathParams.filter(p => p.key).map(p => ({ key: p.key, value: p.value })) },
                        header: edit.headers,
                        body: edit.bodyMode !== 'none' ? (
                          edit.bodyMode === 'soap' ? buildSoapBody(edit) : {
                            mode: edit.bodyMode as NonNullable<NonNullable<CollectionItem['request']>['body']>['mode'],
                            raw: edit.bodyMode === 'raw' ? edit.bodyRaw : undefined,
                            urlencoded: edit.bodyMode === 'urlencoded' ? edit.bodyUrlEncoded : undefined,
                            formdata: edit.bodyMode === 'formdata' ? edit.bodyFormData : undefined,
                            graphql: edit.bodyMode === 'graphql' ? { query: edit.bodyGraphqlQuery, variables: edit.bodyGraphqlVariables || undefined } : undefined,
                            options: edit.bodyMode === 'raw' ? { raw: { language: edit.bodyRawLang as RawLanguage } } : undefined,
                          }
                        ) : undefined,
                        auth: buildAuth(edit),
                      },
                    };
                    dispatch({ type: 'UPDATE_COLLECTION', payload: { ...targetCol, item: [...targetCol.item, updatedItem] } });
                    dispatch({ type: 'UPDATE_TAB', payload: { tabId: activeTab.id, collectionId: saveTargetCollectionId, item: updatedItem } });
                    cacheRef.current.set(activeTab.id, { edit, dirty: false, activeRequestTab });
                    setDirty(false);
                    setShowSaveToCollection(false);
                    if (closeAfterSaveRef.current) {
                      closeAfterSaveRef.current = false;
                      dispatch({ type: 'CLOSE_TAB', payload: activeTab.id });
                    }
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

      {/* History snapshot save modal */}
      {showHistorySaveModal && activeTab && edit && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={e => { if (e.target === e.currentTarget) setShowHistorySaveModal(false); }}
        >
          <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl w-full max-w-sm mx-4">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <h3 className="text-sm font-semibold text-slate-200">Save History Snapshot</h3>
              <button onClick={() => setShowHistorySaveModal(false)} className="text-slate-500 hover:text-slate-300 text-xl leading-none">×</button>
            </div>
            <div className="px-4 py-4 flex flex-col gap-3">
              <p className="text-xs text-slate-400">This request was opened from history. Choose how to save it:</p>
              <div className="flex flex-col gap-2">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="historySaveMode"
                    value="overwrite"
                    checked={historySaveMode === 'overwrite'}
                    onChange={() => setHistorySaveMode('overwrite')}
                    className="mt-0.5 accent-orange-500"
                  />
                  <div>
                    <span className="text-xs text-slate-200 font-medium">Overwrite original request</span>
                    <p className="text-[11px] text-slate-500 mt-0.5">Replace the request in its original collection with these changes.</p>
                  </div>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="historySaveMode"
                    value="new"
                    checked={historySaveMode === 'new'}
                    onChange={() => setHistorySaveMode('new')}
                    className="mt-0.5 accent-orange-500"
                  />
                  <div>
                    <span className="text-xs text-slate-200 font-medium">Save as new request</span>
                    <p className="text-[11px] text-slate-500 mt-0.5">Add a copy to a collection without touching the original.</p>
                  </div>
                </label>
              </div>
              {historySaveMode === 'new' && (
                state.collections.length === 0 ? (
                  <p className="text-xs text-orange-400">No collections available. Please create a collection first.</p>
                ) : (
                  <select
                    value={historySaveCollectionId}
                    onChange={e => setHistorySaveCollectionId(e.target.value)}
                    className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
                  >
                    {state.collections.map(c => (
                      <option key={c._id} value={c._id}>{c.info.name}</option>
                    ))}
                  </select>
                )
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setShowHistorySaveModal(false)}
                  className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  disabled={
                    (historySaveMode === 'new' && !historySaveCollectionId) ||
                    (historySaveMode === 'overwrite' && (!activeTab?.item?.id || !state.collections.some(c => c._id === activeTab.collectionId && !!findItemInTree(c.item, activeTab.item.id!))))
                  }
                  onClick={() => {
                    if (!activeTab || !edit) return;
                    if (historySaveMode === 'overwrite') {
                      const col = state.collections.find(c => c._id === activeTab.collectionId);
                      const targetItemId = activeTab.item.id;
                      const canOverwrite = !!(col && targetItemId && findItemInTree(col.item, targetItemId));
                      if (!canOverwrite) {
                        window.alert('The original request can no longer be found. Please save it as a new request instead.');
                        return;
                      }
                      const updatedItem = buildUpdatedRequestItem(activeTab.item, edit);
                      dispatch({ type: 'UPDATE_COLLECTION', payload: { ...col, item: updateItemById(col.item, targetItemId, updatedItem) } });
                      dispatch({ type: 'UPDATE_TAB_ITEM', payload: { tabId: activeTab.id, item: updatedItem } });
                      dispatch({ type: 'CLEAR_TAB_HISTORY_FLAG', payload: activeTab.id });
                      cacheRef.current.set(activeTab.id, { edit, dirty: false, activeRequestTab });
                      setDirty(false);
                      emitDirtyChange();
                    } else {
                      const targetCol = state.collections.find(c => c._id === historySaveCollectionId);
                      if (!targetCol) return;
                      const newItem: CollectionItem = { ...buildUpdatedRequestItem(activeTab.item, edit), id: generateId() };
                      dispatch({ type: 'UPDATE_COLLECTION', payload: { ...targetCol, item: [...targetCol.item, newItem] } });
                      dispatch({ type: 'UPDATE_TAB', payload: { tabId: activeTab.id, collectionId: historySaveCollectionId, item: newItem } });
                      dispatch({ type: 'CLEAR_TAB_HISTORY_FLAG', payload: activeTab.id });
                      cacheRef.current.set(activeTab.id, { edit, dirty: false, activeRequestTab });
                      setDirty(false);
                      emitDirtyChange();
                    }
                    setShowHistorySaveModal(false);
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

      {/* Save As modal */}
      {showSaveAsModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={e => { if (e.target === e.currentTarget) setShowSaveAsModal(false); }}
        >
          <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl w-full max-w-sm mx-4">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <h3 className="text-sm font-semibold text-slate-200">Save As New Request</h3>
              <button onClick={() => setShowSaveAsModal(false)} className="text-slate-500 hover:text-slate-300 text-xl leading-none">×</button>
            </div>
            <div className="px-4 py-4 flex flex-col gap-3">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Request name</label>
                <input
                  autoFocus
                  value={saveAsName}
                  onChange={e => setSaveAsName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && saveAsName.trim() && saveAsCollectionId) {
                      handleSaveAs(saveAsTabId!, saveAsName, saveAsCollectionId);
                      setShowSaveAsModal(false);
                    }
                    if (e.key === 'Escape') setShowSaveAsModal(false);
                  }}
                  className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
                />
              </div>
              {state.collections.length === 0 ? (
                <p className="text-xs text-orange-400">No collections available. Please create a collection first.</p>
              ) : (
                <>
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">Target collection</label>
                    <select
                      value={saveAsCollectionId}
                      onChange={e => setSaveAsCollectionId(e.target.value)}
                      className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
                    >
                      {state.collections.map(c => (
                        <option key={c._id} value={c._id}>{c.info.name}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setShowSaveAsModal(false)}
                  className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  disabled={!saveAsName.trim() || !saveAsCollectionId}
                  onClick={() => {
                    if (saveAsTabId) handleSaveAs(saveAsTabId, saveAsName, saveAsCollectionId);
                    setShowSaveAsModal(false);
                  }}
                  className="px-4 py-1.5 bg-orange-500 hover:bg-orange-600 text-white text-xs rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Save As
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Save All — orphaned tabs modal */}
      {showSaveAllOrphanModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={e => { if (e.target === e.currentTarget) setShowSaveAllOrphanModal(false); }}
        >
          <div className="bg-slate-800 border border-slate-600 rounded-lg shadow-2xl w-full max-w-sm mx-4">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <h3 className="text-sm font-semibold text-slate-200">Save Unsaved Requests</h3>
              <button onClick={() => setShowSaveAllOrphanModal(false)} className="text-slate-500 hover:text-slate-300 text-xl leading-none">×</button>
            </div>
            <div className="px-4 py-4 flex flex-col gap-3">
              <p className="text-xs text-slate-400">
                {saveAllOrphanTabIds.length} request{saveAllOrphanTabIds.length !== 1 ? 's are' : ' is'} not linked to a collection. Choose where to save them:
              </p>
              <ul className="text-xs text-slate-300 list-disc list-inside space-y-0.5 max-h-28 overflow-y-auto">
                {saveAllOrphanTabIds.map(id => {
                  const name = state.tabs.find(t => t.id === id)?.item.name ?? id;
                  return <li key={id}>{name}</li>;
                })}
              </ul>
              {state.collections.length === 0 ? (
                <p className="text-xs text-orange-400">No collections available. Please create a collection first.</p>
              ) : (
                <select
                  value={saveAllOrphanCollectionId}
                  onChange={e => setSaveAllOrphanCollectionId(e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
                >
                  {state.collections.map(c => (
                    <option key={c._id} value={c._id}>{c.info.name}</option>
                  ))}
                </select>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setShowSaveAllOrphanModal(false)}
                  className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                >
                  Skip
                </button>
                <button
                  disabled={!saveAllOrphanCollectionId}
                  onClick={() => {
                    handleSaveAllOrphans(saveAllOrphanTabIds, saveAllOrphanCollectionId);
                    setShowSaveAllOrphanModal(false);
                  }}
                  className="px-4 py-1.5 bg-orange-500 hover:bg-orange-600 text-white text-xs rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Save All
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Code generation modal */}
      {showParentSettings && edit && activeReq && (() => {
        const authColP = state.collections.find(c => c._id === activeReq.collectionId);
        if (!authColP) return null;
        const { source } = resolveInheritedAuthWithSource(
          authColP.item ?? [],
          activeReq.item.id ?? '',
          authColP.auth,
          authColP.info.name,
        );
        const parentFolderItem = source.kind === 'folder' && source.id
          ? findItemInTree(authColP.item, source.id)
          : null;
        return (
          <Suspense fallback={null}>
            <ItemSettingsModal
              kind={source.kind}
              name={source.name}
              auth={source.kind === 'folder' ? parentFolderItem?.auth : authColP.auth}
              event={source.kind === 'folder' ? parentFolderItem?.event : authColP.event}
              description={source.kind === 'folder' ? parentFolderItem?.description : authColP.info.description}
              variables={source.kind === 'collection' ? (authColP.variable ?? []) : undefined}
              requestNames={flattenRequestNames(authColP.item)}
              requestItems={flattenRequestItems(authColP.item)}
              onSave={(auth, events, description, variables) => {
                if (source.kind === 'folder' && parentFolderItem && parentFolderItem.id) {
                  const updated = { ...parentFolderItem, auth, event: events.length ? events : undefined, description: description || undefined };
                  dispatch({ type: 'UPDATE_COLLECTION', payload: { ...authColP, item: updateItemById(authColP.item, parentFolderItem.id, updated) } });
                } else {
                  dispatch({
                    type: 'UPDATE_COLLECTION',
                    payload: {
                      ...authColP,
                      auth,
                      event: events.length ? events : undefined,
                      variable: variables?.length ? variables : undefined,
                      info: { ...authColP.info, description: description || undefined },
                    },
                  });
                }
                setShowParentSettings(false);
              }}
              onClose={() => setShowParentSettings(false)}
              variableSuggestions={variableSuggestions}
            />
          </Suspense>
        );
      })()}

      {showCodeGen && (
        <Suspense fallback={null}>
          <CodeGenModal
            params={buildResolvedCodeGenParams(edit, allVars)}
            onClose={() => setShowCodeGen(false)}
          />
        </Suspense>
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
          { key: 'in', value: edit.authApiKeyIn },
        ],
      };
    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: edit.authOAuth2Config,
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

/**
 * Like buildEvents but prepends ancestor (folder/collection) scripts before the
 * request's own scripts so the executor runs them in order: collection → folders → request.
 */
function buildMergedEvents(
  edit: ReturnType<typeof itemToEditState>,
  ancestor: { prereqs: string[]; tests: string[] },
): CollectionItem['event'] {
  const events: CollectionItem['event'] = [];
  const prereqParts = [...ancestor.prereqs, edit.preRequestScript.trim()].filter(Boolean);
  const testParts = [...ancestor.tests, edit.testScript.trim()].filter(Boolean);
  if (prereqParts.length > 0) {
    events.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: prereqParts.join('\n\n').split('\n') } });
  }
  if (testParts.length > 0) {
    events.push({ listen: 'test', script: { type: 'text/javascript', exec: testParts.join('\n\n').split('\n') } });
  }
  return events;
}
