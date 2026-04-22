import { useState, useEffect, useRef, useMemo } from 'react';
import { API_BASE } from '../api';
import { useApp, generateId } from '../store';
import * as StorageDriver from '../utils/storageDriver';
import { useToast } from './Toast';
import type {
  CaptureCookie,
  CaptureEntry,
  CaptureSortDirection,
  CaptureSortKey,
  CollectionItem,
  CollectionBody,
} from '../types';

type CaptureContentCategory = 'all' | 'xhr' | 'html' | 'js' | 'css' | 'img' | 'other';

// ─── OS-default Chrome path heuristic ────────────────────────────────────────

function defaultChromePath(): string {
  // navigator.platform is deprecated but still works for this quick heuristic
  const p = (navigator.platform ?? '').toLowerCase();
  if (p.includes('mac')) return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (p.includes('win')) return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  return '/usr/bin/google-chrome';
}

function normalizeMethod(method?: string): string {
  return String(method || 'GET').trim().toUpperCase();
}

// ─── Convert CaptureEntry → CollectionItem ────────────────────────────────────

function entryToCollectionItem(entry: CaptureEntry): CollectionItem {
  let parsedUrl: URL | null = null;
  try { parsedUrl = new URL(entry.url); } catch (_) {}

  const headers = Object.entries(entry.requestHeaders ?? {})
    .filter(([k]) => !k.startsWith(':') && k.toLowerCase() !== 'cookie')
    .map(([key, value]) => ({ key, value }));

  let body: CollectionBody | undefined;
  if (entry.requestBody) {
    const ct = (entry.requestHeaders?.['content-type'] ?? entry.requestHeaders?.['Content-Type'] ?? '').toLowerCase();
    if (ct.includes('application/json')) {
      body = { mode: 'raw', raw: entry.requestBody, options: { raw: { language: 'json' } } };
    } else if (ct.includes('application/x-www-form-urlencoded')) {
      const pairs = entry.requestBody.split('&').map(p => {
        const [k, ...v] = p.split('=');
        return { key: decodeURIComponent(k ?? ''), value: decodeURIComponent(v.join('=') ?? '') };
      });
      body = { mode: 'urlencoded', urlencoded: pairs };
    } else {
      body = { mode: 'raw', raw: entry.requestBody };
    }
  }

  const rawUrl = parsedUrl
    ? parsedUrl.pathname + (parsedUrl.search || '')
    : entry.url;
  const host = parsedUrl ? parsedUrl.hostname.split('.') : [];
  const port = parsedUrl?.port || undefined;
  const pathSegs = parsedUrl ? parsedUrl.pathname.replace(/^\//, '').split('/') : [];
  const querySegs = parsedUrl
    ? Array.from(parsedUrl.searchParams.entries()).map(([key, value]) => ({ key, value }))
    : [];

  return {
    id: generateId(),
    name: `${normalizeMethod(entry.method)} ${rawUrl}`,
    request: {
      method: normalizeMethod(entry.method),
      url: {
        raw: entry.url,
        protocol: parsedUrl?.protocol.replace(':', '') ?? 'https',
        host,
        port,
        path: pathSegs,
        query: querySegs.length ? querySegs : undefined,
      },
      header: headers,
      body,
    },
  };
}

// ─── Content-type category ────────────────────────────────────────────────────

function resourceCategory(resourceType?: string, mimeType?: string): CaptureContentCategory {
  const kind = (resourceType ?? '').toLowerCase();
  if (kind === 'xhr' || kind === 'fetch') return 'xhr';
  if (kind === 'document') return mimeCategory(mimeType) === 'html' ? 'html' : 'other';
  if (kind === 'script') return 'js';
  if (kind === 'stylesheet') return 'css';
  if (kind === 'image') return 'img';
  return mimeCategory(mimeType);
}

function entryDisplayType(entry: CaptureEntry): string {
  return entry.resourceType || resourceCategory(entry.resourceType, entry.mimeType).toUpperCase();
}

function sortEntries(entries: CaptureEntry[], sortKey: CaptureSortKey, direction: CaptureSortDirection): CaptureEntry[] {
  const dir = direction === 'asc' ? 1 : -1;
  return [...entries].sort((left, right) => {
    let a;
    let b;
    switch (sortKey) {
      case 'method':
        a = left.method;
        b = right.method;
        break;
      case 'domain':
        a = left.domain || urlDomain(left.url);
        b = right.domain || urlDomain(right.url);
        break;
      case 'url':
        a = left.url;
        b = right.url;
        break;
      case 'type':
        a = entryDisplayType(left);
        b = entryDisplayType(right);
        break;
      case 'status':
        a = left.status ?? (left.state === 'failed' ? -1 : 0);
        b = right.status ?? (right.state === 'failed' ? -1 : 0);
        break;
      case 'duration':
        a = left.duration ?? -1;
        b = right.duration ?? -1;
        break;
      case 'size':
        a = left.size ?? -1;
        b = right.size ?? -1;
        break;
      case 'timestamp':
      default:
        a = left.timestamp;
        b = right.timestamp;
        break;
    }
    if (typeof a === 'number' && typeof b === 'number') {
      if (a === b) return (left.timestamp - right.timestamp) * -1;
      return (a - b) * dir;
    }
    const cmp = String(a ?? '').localeCompare(String(b ?? ''), undefined, { sensitivity: 'base' });
    if (cmp === 0) return (right.timestamp - left.timestamp);
    return cmp * dir;
  });
}

function mimeCategory(mimeType?: string): CaptureContentCategory {
  if (!mimeType) return 'other';
  const m = mimeType.toLowerCase();
  // Check image/ first — image/svg+xml must not match the xml branch below
  if (m.startsWith('image/')) return 'img';
  if (m.includes('json') || m === 'text/xml' || m === 'application/xml' || m.endsWith('+xml')) return 'xhr';
  if (m.includes('html')) return 'html';
  if (m.includes('javascript') || m.includes('ecmascript')) return 'js';
  if (m.includes('css')) return 'css';
  if (m.includes('font/') || m.startsWith('audio/') || m.startsWith('video/')) return 'other';
  if (m.startsWith('text/')) return 'xhr';
  return 'other';
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ entry }: { entry: CaptureEntry }) {
  if (entry.state === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 text-slate-400 text-xs">
        <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
        </svg>
        …
      </span>
    );
  }
  if (entry.state === 'failed') {
    return <span className="text-red-400 text-xs font-medium">Err</span>;
  }
  const s = entry.status ?? 0;
  const color = s >= 500 ? 'text-red-400' : s >= 400 ? 'text-orange-400' : s >= 300 ? 'text-yellow-400' : 'text-green-400';
  return <span className={`${color} text-xs font-medium`}>{s}</span>;
}

// ─── Method badge ─────────────────────────────────────────────────────────────

function MethodBadge({ method }: { method: string }) {
  const normalizedMethod = normalizeMethod(method);
  const colors: Record<string, string> = {
    GET: 'text-green-400', POST: 'text-orange-400', PUT: 'text-blue-400',
    PATCH: 'text-purple-400', DELETE: 'text-red-400', HEAD: 'text-slate-400', OPTIONS: 'text-slate-400',
  };
  return <span className={`${colors[normalizedMethod] ?? 'text-slate-300'} text-xs font-bold w-14 shrink-0`}>{normalizedMethod}</span>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtSize(bytes?: number) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDuration(ms?: number) {
  if (ms === undefined || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function urlPath(url: string) {
  try { const u = new URL(url); return u.pathname + (u.search || ''); } catch { return url; }
}

function urlDomain(url: string) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function MetaGrid({ pairs }: { pairs: Array<{ label: string; value: string | number | null | undefined }> }) {
  return (
    <div className="grid grid-cols-2 gap-2 rounded border border-slate-800 bg-slate-950 p-2">
      {pairs.map(({ label, value }) => (
        <div key={label}>
          <p className="text-slate-500 uppercase tracking-wider text-[10px] mb-0.5">{label}</p>
          <p className="text-slate-200 break-all">{value === null || value === undefined || value === '' ? '—' : String(value)}</p>
        </div>
      ))}
    </div>
  );
}

function CookieDetailCard({ cookie }: { cookie: CaptureCookie }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-950 p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-slate-200 font-medium break-all">{cookie.name}</p>
          <p className="text-slate-400 break-all text-[11px]">{cookie.value || '—'}</p>
        </div>
        <div className="flex flex-wrap gap-1 justify-end">
          {cookie.secure && <span className="px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 text-[10px]">Secure</span>}
          {cookie.httpOnly && <span className="px-1.5 py-0.5 rounded bg-sky-900/40 text-sky-300 text-[10px]">HttpOnly</span>}
          {cookie.partitioned && <span className="px-1.5 py-0.5 rounded bg-violet-900/40 text-violet-300 text-[10px]">Partitioned</span>}
          {cookie.sameSite && <span className="px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 text-[10px]">SameSite={cookie.sameSite}</span>}
        </div>
      </div>
      <MetaGrid
        pairs={[
          { label: 'Domain', value: cookie.domain },
          { label: 'Path', value: cookie.path },
          { label: 'Expires', value: cookie.expires },
          { label: 'Max-Age', value: cookie.maxAge },
        ]}
      />
      {cookie.attributes && cookie.attributes.length > 0 && (
        <div>
          <p className="text-slate-500 uppercase tracking-wider text-[10px] mb-1">Attributes</p>
          <div className="flex flex-wrap gap-1.5">
            {cookie.attributes.map((attr) => (
              <span key={`${cookie.raw}-${attr.key}`} className="px-2 py-1 rounded bg-slate-800 text-slate-300 text-[10px] break-all">
                {attr.key}{attr.value !== null ? `=${attr.value}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}
      <div>
        <p className="text-slate-500 uppercase tracking-wider text-[10px] mb-1">Raw</p>
        <pre className="bg-slate-900 rounded p-2 text-slate-300 text-[10px] overflow-x-auto whitespace-pre-wrap break-all">{cookie.raw}</pre>
      </div>
    </div>
  );
}

function CookieViewer({ requestCookies, responseCookies }: { requestCookies?: CaptureCookie[]; responseCookies?: CaptureCookie[] }) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-slate-500 uppercase tracking-wider text-[10px] mb-2">Request Cookies</p>
        {requestCookies && requestCookies.length > 0 ? (
          <div className="space-y-2">
            {requestCookies.map((cookie) => <CookieDetailCard key={`req-${cookie.raw}`} cookie={cookie} />)}
          </div>
        ) : (
          <p className="text-slate-500 text-xs italic">No request cookies</p>
        )}
      </div>
      <div>
        <p className="text-slate-500 uppercase tracking-wider text-[10px] mb-2">Response Cookies</p>
        {responseCookies && responseCookies.length > 0 ? (
          <div className="space-y-2">
            {responseCookies.map((cookie) => <CookieDetailCard key={`res-${cookie.raw}`} cookie={cookie} />)}
          </div>
        ) : (
          <p className="text-slate-500 text-xs italic">No response cookies</p>
        )}
      </div>
    </div>
  );
}

function CookiesTable({ title, cookies }: { title: string; cookies?: Array<{ name: string; value: string; raw: string }> }) {
  if (!cookies || cookies.length === 0) return null;
  return (
    <div>
      <p className="text-slate-500 uppercase tracking-wider text-[10px] mb-1">{title}</p>
      <table className="w-full text-xs">
        <tbody>
          {cookies.map((cookie) => (
            <tr key={`${title}-${cookie.raw}`} className="border-b border-slate-800">
              <td className="py-1 pr-3 text-slate-400 font-medium w-1/3 align-top break-all">{cookie.name}</td>
              <td className="py-1 text-slate-200 break-all">{cookie.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HeadersTable({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  if (!entries.length) return <p className="text-slate-500 text-xs italic">No headers</p>;
  return (
    <table className="w-full text-xs">
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k} className="border-b border-slate-800">
            <td className="py-1 pr-3 text-slate-400 font-medium w-1/3 align-top break-all">{k}</td>
            <td className="py-1 text-slate-200 break-all">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SortHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onToggle,
  className,
}: {
  label: string;
  sortKey: CaptureSortKey;
  activeKey: CaptureSortKey;
  direction: CaptureSortDirection;
  onToggle: (key: CaptureSortKey) => void;
  className: string;
}) {
  const active = activeKey === sortKey;
  const arrow = !active ? '↕' : direction === 'asc' ? '↑' : '↓';
  return (
    <button
      type="button"
      onClick={() => onToggle(sortKey)}
      className={`${className} text-left hover:text-slate-200 transition-colors`}
      title={`Sort by ${label.toLowerCase()}`}
    >
      <span>{label}</span>
      <span className="ml-1 text-[9px]">{arrow}</span>
    </button>
  );
}

// ─── Detail pane ─────────────────────────────────────────────────────────────

function DetailPane({ entry }: { entry: CaptureEntry }) {
  const [tab, setTab] = useState<'request' | 'response' | 'cookies'>('request');
  const bodyPreview = entry.responseBody
    ? entry.responseBody.slice(0, 50_000) + (entry.responseBody.length > 50_000 ? '\n[truncated]' : '')
    : null;

  return (
    <div className="h-full flex flex-col overflow-hidden border-l border-slate-700">
      {/* Tabs */}
      <div className="flex border-b border-slate-700 shrink-0">
        {(['request', 'response', 'cookies'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-xs font-medium capitalize transition-colors ${
              tab === t ? 'text-orange-400 border-b-2 border-orange-400' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
        {tab === 'request' && (
          <>
            <MetaGrid
              pairs={[
                { label: 'Method', value: entry.method },
                { label: 'Domain', value: entry.domain || urlDomain(entry.url) },
                { label: 'Type', value: entryDisplayType(entry) },
                { label: 'State', value: entry.state },
              ]}
            />
            <div>
              <p className="text-slate-500 uppercase tracking-wider text-[10px] mb-1">URL</p>
              <p className="text-slate-200 break-all font-mono">{entry.url}</p>
            </div>
            <CookiesTable title="Cookies" cookies={entry.requestCookies} />
            <div>
              <p className="text-slate-500 uppercase tracking-wider text-[10px] mb-1">Headers</p>
              <HeadersTable headers={entry.requestHeaders} />
            </div>
            {entry.requestBody && (
              <div>
                <p className="text-slate-500 uppercase tracking-wider text-[10px] mb-1">Body</p>
                <pre className="bg-slate-950 rounded p-2 text-slate-200 text-[11px] overflow-x-auto whitespace-pre-wrap break-all">
                  {entry.requestBody}
                </pre>
              </div>
            )}
          </>
        )}

        {tab === 'response' && (
          <>
            <MetaGrid
              pairs={[
                { label: 'Status', value: entry.status ?? (entry.state === 'failed' ? 'Failed' : 'Pending') },
                { label: 'Domain', value: entry.domain || urlDomain(entry.url) },
                { label: 'Type', value: entryDisplayType(entry) },
                { label: 'Duration', value: fmtDuration(entry.duration) },
                { label: 'Size', value: fmtSize(entry.size) },
                { label: 'MIME', value: entry.mimeType || '—' },
              ]}
            />
            <div className="flex items-center gap-2">
              <StatusBadge entry={entry} />
              {entry.statusText && <span className="text-slate-400">{entry.statusText}</span>}
              {entry.mimeType && <span className="text-slate-500 italic">{entry.mimeType}</span>}
            </div>
            <CookiesTable title="Set-Cookie" cookies={entry.responseCookies} />
            <div>
              <p className="text-slate-500 uppercase tracking-wider text-[10px] mb-1">Headers</p>
              <HeadersTable headers={entry.responseHeaders ?? {}} />
            </div>
            {bodyPreview !== null && (
              <div>
                <p className="text-slate-500 uppercase tracking-wider text-[10px] mb-1">Body</p>
                <pre className="bg-slate-950 rounded p-2 text-slate-200 text-[11px] overflow-x-auto whitespace-pre-wrap break-all">
                  {bodyPreview}
                </pre>
              </div>
            )}
            {entry.state === 'failed' && (
              <p className="text-red-400">{entry.errorText}</p>
            )}
          </>
        )}

        {tab === 'cookies' && (
          <CookieViewer requestCookies={entry.requestCookies} responseCookies={entry.responseCookies} />
        )}
      </div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export default function BrowserCapturePanel() {
  const { state, dispatch } = useApp();
  const toast = useToast();
  const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI?.cdpLaunchChrome;
  const captureView = state.captureViewState;
  const captureGenerationRef = useRef(state.captureGeneration);

  const [chromePath, setChromePath] = useState(defaultChromePath);
  const [port, setPort] = useState(9222);
  const [connecting, setConnecting] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Import
  const [importTargetId, setImportTargetId] = useState('');

  const esRef = useRef<EventSource | null>(null);
  const cdpSettingsAppliedRef = useRef(false);

  useEffect(() => {
    captureGenerationRef.current = state.captureGeneration;
  }, [state.captureGeneration]);

  // ── Restore saved Chrome path and port from settings ──────────────────────
  useEffect(() => {
    if (!state.storageReady || cdpSettingsAppliedRef.current) return;
    cdpSettingsAppliedRef.current = true;
    if (state.settings.cdpChromePath) setChromePath(state.settings.cdpChromePath);
    if (state.settings.cdpPort)       setPort(state.settings.cdpPort);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.storageReady]);

  // ── SSE wiring ────────────────────────────────────────────────────────────

  function openStream() {
    if (esRef.current) { esRef.current.close(); }
    const es = new EventSource(`${API_BASE}/cdp/stream`);
    esRef.current = es;

    es.addEventListener('request', (e: MessageEvent) => {
      try {
        const entry: CaptureEntry = { ...JSON.parse(e.data), selected: false };
        dispatch({ type: 'CAPTURE_ADD_ENTRY', payload: { entry, generation: captureGenerationRef.current } });
      } catch (_) {}
    });

    es.addEventListener('response', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        dispatch({
          type: 'CAPTURE_UPDATE_ENTRY',
          payload: {
            entry: { ...data, state: 'complete' as const },
            generation: captureGenerationRef.current,
          },
        });
      } catch (_) {}
    });

    es.addEventListener('failed', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        dispatch({
          type: 'CAPTURE_UPDATE_ENTRY',
          payload: {
            entry: { id: data.id, state: 'failed' as const, errorText: data.errorText },
            generation: captureGenerationRef.current,
          },
        });
      } catch (_) {}
    });

    es.addEventListener('stopped', () => {
      dispatch({ type: 'SET_CAPTURE_RUNNING', payload: false });
    });

    es.onerror = () => {
      // EventSource auto-reconnects; only update state if we were running
    };
  }

  useEffect(() => {
    // Open stream on mount so we catch events if the user reconnects via the panel
    openStream();
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Connect flow ──────────────────────────────────────────────────────────

  async function handleLaunchAndConnect() {
    setConnecting(true);
    setConnError(null);
    try {
      const api = (window as any).electronAPI;
      await api.cdpLaunchChrome(chromePath, port);
      // Give Chrome a moment to start the debug port
      await new Promise(r => setTimeout(r, 1500));
      await connectToChrome();
    } catch (e: any) {
      const msg = e.message ?? String(e);
      setConnError(msg);
      toast.error(`Capture: ${msg}`);
    } finally {
      setConnecting(false);
    }
  }

  async function handleConnect() {
    setConnecting(true);
    setConnError(null);
    try {
      await connectToChrome();
    } catch (e: any) {
      const msg = e.message ?? String(e);
      setConnError(msg);
      toast.error(`Capture: ${msg}`);
    } finally {
      setConnecting(false);
    }
  }

  async function connectToChrome() {
    const res = await fetch(`${API_BASE}/cdp/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error ?? 'Connection failed');
    dispatch({ type: 'SET_CAPTURE_RUNNING', payload: true });
    toast.success(`Capture started on port ${port}.`);
    openStream();
  }

  async function handleDisconnect() {
    await fetch(`${API_BASE}/cdp/disconnect`, { method: 'POST' });
    if (isElectron) {
      try { await (window as any).electronAPI.cdpKillChrome(); } catch (_) {}
    }
    dispatch({ type: 'SET_CAPTURE_RUNNING', payload: false });
    toast.info('Capture stopped.');
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  function toggleSelect(id: string) {
    dispatch({ type: 'CAPTURE_UPDATE_ENTRY', payload: {
      entry: {
        id,
        selected: !state.captureEntries.find(e => e.id === id)?.selected,
      },
    }});
  }

  const selectedEntries = state.captureEntries.filter(e => e.selected);

  const resourceTypeOptions = useMemo(() => {
    const values = new Set<string>();
    for (const entry of state.captureEntries) {
      if (entry.resourceType) values.add(entry.resourceType);
    }
    return ['ALL', ...Array.from(values).sort((a, b) => a.localeCompare(b))];
  }, [state.captureEntries]);

  const methodOptions = useMemo(() => {
    const values = new Set<string>();
    for (const entry of state.captureEntries) {
      values.add(normalizeMethod(entry.method));
    }
    return ['ALL', ...Array.from(values).sort((a, b) => a.localeCompare(b))];
  }, [state.captureEntries]);

  function updateCaptureViewState(payload: Partial<typeof captureView>) {
    dispatch({ type: 'SET_CAPTURE_VIEW_STATE', payload });
  }

  function toggleSort(nextKey: CaptureSortKey) {
    if (captureView.sortKey === nextKey) {
      updateCaptureViewState({
        sortDirection: captureView.sortDirection === 'asc' ? 'desc' : 'asc',
      });
      return;
    }
    updateCaptureViewState({
      sortKey: nextKey,
      sortDirection: nextKey === 'timestamp' ? 'desc' : 'asc',
    });
  }

  function selectAll(checked: boolean) {
    for (const e of sortedEntries) {
      if (e.selected !== checked) {
        dispatch({ type: 'CAPTURE_UPDATE_ENTRY', payload: { entry: { id: e.id, selected: checked } } });
      }
    }
  }

  // ── Filters ───────────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return state.captureEntries.filter(e => {
      if (captureView.search && !e.url.toLowerCase().includes(captureView.search.toLowerCase())) return false;
      const domain = (e.domain || urlDomain(e.url)).toLowerCase();
      if (captureView.filterDomain && !domain.includes(captureView.filterDomain.toLowerCase())) return false;
      if (captureView.filterMethod !== 'ALL' && normalizeMethod(e.method) !== normalizeMethod(captureView.filterMethod)) return false;
      if (captureView.filterStatus !== 'ALL') {
        if (captureView.filterStatus === 'pending' && e.state !== 'pending') return false;
        if (captureView.filterStatus === 'failed' && e.state !== 'failed') return false;
        if (captureView.filterStatus === '2xx' && (e.status === undefined || e.status < 200 || e.status >= 300)) return false;
        if (captureView.filterStatus === '3xx' && (e.status === undefined || e.status < 300 || e.status >= 400)) return false;
        if (captureView.filterStatus === '4xx' && (e.status === undefined || e.status < 400 || e.status >= 500)) return false;
        if (captureView.filterStatus === '5xx' && (e.status === undefined || e.status < 500 || e.status >= 600)) return false;
      }
      if (captureView.filterResourceType !== 'ALL' && (e.resourceType || 'Other') !== captureView.filterResourceType) return false;
      return true;
    });
  }, [state.captureEntries, captureView]);

  const sortedEntries = useMemo(
    () => sortEntries(filtered, captureView.sortKey, captureView.sortDirection),
    [filtered, captureView.sortKey, captureView.sortDirection],
  );

  const allChecked = sortedEntries.length > 0 && sortedEntries.every(e => e.selected);
  const someChecked = sortedEntries.some(e => e.selected);

  const selectedEntry = state.captureEntries.find(e => e.id === selectedId) ?? null;

  // ── Import ────────────────────────────────────────────────────────────────

  function importSelected(targetCollectionId?: string) {
    const items = selectedEntries.map(entryToCollectionItem);
    if (!items.length) return;

    if (targetCollectionId) {
      const col = state.collections.find(c => c._id === targetCollectionId);
      if (!col) return;
      dispatch({ type: 'UPDATE_COLLECTION', payload: { ...col, item: [...col.item, ...items] } });
    } else {
      dispatch({
        type: 'ADD_COLLECTION',
        payload: {
          _id: generateId(),
          info: {
            name: `Capture ${new Date().toLocaleTimeString()}`,
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
          },
          item: items,
        },
      });
    }

    // Deselect imported entries
    for (const e of selectedEntries) {
      dispatch({ type: 'CAPTURE_UPDATE_ENTRY', payload: { entry: { id: e.id, selected: false } } });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden text-sm text-slate-200 bg-slate-900">

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-slate-700 p-2 flex flex-wrap items-center gap-2">
        <span className="text-slate-400 text-xs font-medium mr-1">📡 Browser Capture</span>

        {isElectron && (
          <div className="flex items-center gap-1 flex-1 min-w-48">
            <input
              value={chromePath}
              onChange={e => {
                setChromePath(e.target.value);
                dispatch({ type: 'UPDATE_SETTINGS', payload: { cdpChromePath: e.target.value } });
              }}
              placeholder="Chrome executable path"
              className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-orange-500"
            />
            <button
              onClick={async () => {
                const picked = await StorageDriver.pickFile([{ name: 'Executable', extensions: ['*'] }]);
                if (picked) {
                  setChromePath(picked);
                  dispatch({ type: 'UPDATE_SETTINGS', payload: { cdpChromePath: picked } });
                }
              }}
              title="Browse for Chrome executable"
              className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded transition-colors shrink-0"
            >
              …
            </button>
          </div>
        )}

        <input
          type="number"
          value={port}
          onChange={e => {
            const v = Number(e.target.value);
            setPort(v);
            dispatch({ type: 'UPDATE_SETTINGS', payload: { cdpPort: v } });
          }}
          className="w-20 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-orange-500"
          min={1024}
          max={65535}
          title="Chrome debugging port"
        />

        {!state.captureRunning ? (
          <>
            {isElectron && (
              <button
                onClick={handleLaunchAndConnect}
                disabled={connecting}
                className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs rounded font-medium transition-colors"
              >
                {connecting ? 'Launching…' : '🚀 Launch Chrome'}
              </button>
            )}
            <button
              onClick={handleConnect}
              disabled={connecting}
              className="px-3 py-1 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-xs rounded font-medium transition-colors"
            >
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
          </>
        ) : (
          <button
            onClick={handleDisconnect}
            className="px-3 py-1 bg-red-700 hover:bg-red-600 text-white text-xs rounded font-medium transition-colors"
          >
            ⏹ Disconnect
          </button>
        )}

        <button
          onClick={() => {
            setSelectedId(null);
            dispatch({ type: 'CAPTURE_CLEAR' });
          }}
          className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs rounded transition-colors"
        >
          Clear
        </button>

        {state.captureRunning && (
          <span className="flex items-center gap-1 text-green-400 text-xs">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            Capturing
          </span>
        )}

        {connError && (
          <span className="text-red-400 text-xs">{connError}</span>
        )}
      </div>

      {/* ── Filter bar ──────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-slate-700 px-2 py-1.5 flex flex-wrap items-center gap-2">
        <input
          value={captureView.search}
          onChange={e => updateCaptureViewState({ search: e.target.value })}
          placeholder="Search URL…"
          className="flex-1 min-w-32 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-orange-500"
        />

        <input
          value={captureView.filterDomain}
          onChange={e => updateCaptureViewState({ filterDomain: e.target.value })}
          placeholder="Filter domain…"
          className="min-w-36 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-orange-500"
        />

        <select
          value={captureView.filterMethod}
          onChange={e => updateCaptureViewState({ filterMethod: e.target.value })}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none cursor-pointer"
        >
          {methodOptions.map(m => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>

        <select
          value={captureView.filterStatus}
          onChange={e => updateCaptureViewState({ filterStatus: e.target.value })}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none cursor-pointer"
        >
          {['ALL', '2xx', '3xx', '4xx', '5xx', 'failed', 'pending'].map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select
          value={captureView.filterResourceType}
          onChange={e => updateCaptureViewState({ filterResourceType: e.target.value })}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none cursor-pointer"
        >
          {resourceTypeOptions.map((type) => (
            <option key={type} value={type}>{type === 'ALL' ? 'All resources' : type}</option>
          ))}
        </select>

        <span className="text-slate-500 text-xs ml-auto">{filtered.length} entries</span>
      </div>

      {/* ── Main area: table + detail pane ──────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Table */}
        <div className={`flex flex-col overflow-hidden ${selectedEntry ? 'w-1/2' : 'flex-1'}`}>
          {/* Table header */}
          <div className="shrink-0 flex items-center gap-2 px-2 py-1.5 border-b border-slate-700 bg-slate-950 text-[10px] text-slate-400 uppercase tracking-wider">
            <input
              type="checkbox"
              checked={allChecked}
              ref={el => { if (el) el.indeterminate = someChecked && !allChecked; }}
              onChange={e => selectAll(e.target.checked)}
              className="accent-orange-500 cursor-pointer"
            />
            <SortHeader label="Method" sortKey="method" activeKey={captureView.sortKey} direction={captureView.sortDirection} onToggle={toggleSort} className="w-14 shrink-0" />
            <SortHeader label="Domain" sortKey="domain" activeKey={captureView.sortKey} direction={captureView.sortDirection} onToggle={toggleSort} className="w-28 shrink-0" />
            <SortHeader label="URL" sortKey="url" activeKey={captureView.sortKey} direction={captureView.sortDirection} onToggle={toggleSort} className="flex-1 min-w-0" />
            <SortHeader label="Type" sortKey="type" activeKey={captureView.sortKey} direction={captureView.sortDirection} onToggle={toggleSort} className="w-20 shrink-0" />
            <SortHeader label="Status" sortKey="status" activeKey={captureView.sortKey} direction={captureView.sortDirection} onToggle={toggleSort} className="w-12 text-right shrink-0" />
            <SortHeader label="Duration" sortKey="duration" activeKey={captureView.sortKey} direction={captureView.sortDirection} onToggle={toggleSort} className="w-14 text-right shrink-0" />
            <SortHeader label="Size" sortKey="size" activeKey={captureView.sortKey} direction={captureView.sortDirection} onToggle={toggleSort} className="w-14 text-right shrink-0" />
          </div>

          {/* Rows */}
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="flex items-center justify-center h-32 text-slate-500 text-xs">
                {state.captureEntries.length === 0
                  ? 'Connect to Chrome and browse to capture requests'
                  : 'No requests match the current filters'}
              </div>
            ) : (
              sortedEntries.map(entry => (
                <div
                  key={entry.id}
                  onClick={() => setSelectedId(entry.id === selectedId ? null : entry.id)}
                  className={`flex items-center gap-2 px-2 py-1.5 cursor-pointer border-b border-slate-800/60 transition-colors ${
                    selectedId === entry.id
                      ? 'bg-slate-700'
                      : 'hover:bg-slate-800/60'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={entry.selected}
                    onChange={() => toggleSelect(entry.id)}
                    onClick={e => e.stopPropagation()}
                    className="accent-orange-500 cursor-pointer shrink-0"
                  />
                  <MethodBadge method={entry.method} />
                  <span className="w-28 shrink-0 truncate text-xs text-slate-400" title={entry.domain || urlDomain(entry.url)}>
                    {entry.domain || urlDomain(entry.url) || '—'}
                  </span>
                  <span
                    className="flex-1 min-w-0 truncate text-xs text-slate-300"
                    title={entry.url}
                  >
                    {urlPath(entry.url)}
                  </span>
                  <span className="w-20 shrink-0 truncate text-xs text-slate-400" title={entryDisplayType(entry)}>
                    {entryDisplayType(entry)}
                  </span>
                  <span className="w-12 text-right shrink-0">
                    <StatusBadge entry={entry} />
                  </span>
                  <span className="w-14 text-right text-xs text-slate-400 shrink-0">
                    {fmtDuration(entry.duration)}
                  </span>
                  <span className="w-14 text-right text-xs text-slate-400 shrink-0">
                    {fmtSize(entry.size)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Detail pane */}
        {selectedEntry && (
          <div className="w-1/2 min-h-0 overflow-hidden">
            <DetailPane entry={selectedEntry} />
          </div>
        )}
      </div>

      {/* ── Import bar ──────────────────────────────────────────────────── */}
      {selectedEntries.length > 0 && (
        <div className="shrink-0 border-t border-slate-700 px-3 py-2 flex items-center gap-3 bg-slate-950">
          <span className="text-xs text-slate-300 font-medium">
            {selectedEntries.length} selected
          </span>
          <button
            onClick={() => importSelected()}
            className="px-3 py-1 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded font-medium transition-colors"
          >
            Import to new collection
          </button>
          {state.collections.length > 0 && (
            <select
              value={importTargetId}
              onChange={e => {
                if (e.target.value) {
                  importSelected(e.target.value);
                  setImportTargetId('');
                }
              }}
              className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none cursor-pointer"
            >
              <option value="">Import to existing…</option>
              {state.collections.map(c => (
                <option key={c._id} value={c._id}>{c.info.name}</option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  );
}
