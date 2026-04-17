import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react';
import { useApp } from '../store';
import type { TestResult, TlsCertInfo, NetworkTimings, RedirectHop } from '../types';
import SaveToVarModal from './SaveToVarModal';
import TestValueModal from './TestValueModal';
import { buildSaveToVarSnippet } from '../utils/testSnippetUtils';

type RespTab = 'Body' | 'Headers' | 'Test Results' | 'TLS' | 'Timeline' | 'Redirects';

function StatusBadge({ status }: { status: number }) {
  const color =
    status >= 500 ? 'bg-red-700 text-red-100' :
    status >= 400 ? 'bg-yellow-700 text-yellow-100' :
    status >= 300 ? 'bg-blue-700 text-blue-100' :
    status >= 200 ? 'bg-green-700 text-green-100' :
    'bg-slate-600 text-slate-300';
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-bold ${color}`}>{status}</span>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Redirect Chain Inspector ────────────────────────────────────────────────────
function RedirectChainView({ chain, finalUrl, finalStatus }: { chain: RedirectHop[]; finalUrl?: string; finalStatus: number }) {
  const allHops = [
    ...chain,
    { url: finalUrl ?? '', status: finalStatus, isFinal: true },
  ];
  const statusColor = (s: number) =>
    s >= 500 ? 'bg-red-700 text-red-100' :
    s >= 400 ? 'bg-yellow-700 text-yellow-100' :
    s >= 300 ? 'bg-blue-700 text-blue-100' :
    'bg-green-700 text-green-100';
  return (
    <div className="p-3 flex flex-col gap-0">
      {allHops.map((hop, i) => (
        <div key={i}>
          <div className="flex items-start gap-3 py-2">
            <div className="flex flex-col items-center pt-0.5">
              <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${statusColor(hop.status)}`}>{hop.status}</span>
              {i < allHops.length - 1 && (
                <div className="w-px flex-1 bg-slate-600 my-1" style={{ minHeight: 12 }} />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className={`text-xs font-mono break-all ${'isFinal' in hop && hop.isFinal ? 'text-slate-100 font-semibold' : 'text-slate-300'}`}>{hop.url}</p>
              {'responseTime' in hop && (
                <p className="text-xs text-slate-500 mt-0.5">{hop.responseTime} ms</p>
              )}
              {'isFinal' in hop && hop.isFinal && (
                <span className="inline-block mt-1 text-xs text-green-400 bg-green-900/30 px-1.5 py-0.5 rounded">Final response</span>
              )}
              {'headers' in hop && hop.headers && 'location' in hop.headers && (
                <p className="text-xs text-slate-500 mt-0.5">Location: <span className="text-slate-400 font-mono">{hop.headers.location}</span></p>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── TLS Cert Viewer ────────────────────────────────────────────────────────
const SUBJECT_LABELS: Record<string, string> = { CN: 'Common Name', O: 'Organization', OU: 'Unit', C: 'Country', ST: 'State', L: 'Locality' };

function CertRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <tr className="border-b border-slate-800/50 last:border-0">
      <td className="py-1 pr-3 text-slate-400 text-xs font-medium w-28 align-top shrink-0">{label}</td>
      <td className={`py-1 text-slate-200 text-xs break-all ${mono ? 'font-mono' : ''}`}>{value || '—'}</td>
    </tr>
  );
}

function TlsCertViewer({ chain }: { chain: TlsCertInfo[] }) {
  const roleLabels = ['Leaf (end-entity)', 'Intermediate CA', 'Root CA'];
  function fmtSubject(subj: Record<string, string> | null) {
    if (!subj) return '—';
    return Object.entries(subj).map(([k, v]) => `${SUBJECT_LABELS[k] ?? k}=${v}`).join(', ');
  }
  return (
    <div className="p-3 flex flex-col gap-3 overflow-auto">
      {chain.map((cert, i) => (
        <div key={i} className="border border-slate-700 rounded">
          <div className="px-3 py-1.5 bg-slate-700/50 rounded-t border-b border-slate-700 flex items-center gap-2">
            <span className="text-xs font-bold text-orange-400">#{i + 1}</span>
            <span className="text-xs text-slate-300">{roleLabels[i] ?? 'CA'}</span>
          </div>
          <div className="p-2">
            <table className="w-full">
              <tbody>
                <CertRow label="Subject" value={fmtSubject(cert.subject)} mono />
                <CertRow label="Issuer" value={fmtSubject(cert.issuer)} mono />
                <CertRow label="Valid From" value={cert.validFrom ?? ''} />
                <CertRow label="Valid To" value={cert.validTo ?? ''} />
                {cert.subjectAltNames && <CertRow label="SANs" value={cert.subjectAltNames} mono />}
                {cert.fingerprint256 && <CertRow label="SHA-256" value={cert.fingerprint256} mono />}
                {cert.serialNumber && <CertRow label="Serial" value={cert.serialNumber} mono />}
                {cert.bits != null && <CertRow label="Key Size" value={`${cert.bits} bits`} />}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Network Timeline ────────────────────────────────────────────────────────
function NetworkTimeline({ timings }: { timings: NetworkTimings }) {
  const phases: { label: string; value: number; color: string; bar: string }[] = [
    { label: 'DNS',    value: timings.dns,    color: 'text-purple-400', bar: 'bg-purple-500' },
    { label: 'TCP',    value: timings.tcp,    color: 'text-blue-400',   bar: 'bg-blue-500'   },
    { label: 'TLS',    value: timings.tls,    color: 'text-amber-400',  bar: 'bg-amber-500'  },
    { label: 'Server', value: timings.server, color: 'text-green-400',  bar: 'bg-green-500'  },
  ].filter(p => p.value > 0);
  const total = timings.total || 1;
  let offset = 0;
  return (
    <div className="p-4 flex flex-col gap-4">
      {/* Composite waterfall bar */}
      <div className="flex h-4 rounded overflow-hidden w-full bg-slate-800">
        {phases.map(p => (
          <div
            key={p.label}
            className={`${p.bar} opacity-80 h-full`}
            style={{ width: `${(p.value / total) * 100}%` }}
            title={`${p.label}: ${p.value} ms`}
          />
        ))}
      </div>
      {/* Per-phase rows */}
      <div className="flex flex-col gap-1.5">
        {phases.map(p => {
          const pctW = `${(p.value / total) * 100}%`;
          const pctL = `${(offset / total) * 100}%`;
          const snap = offset;
          offset += p.value;
          return (
            <div key={p.label} className="flex items-center gap-3 text-xs">
              <span className={`w-2.5 h-2.5 rounded-sm shrink-0 ${p.bar}`} />
              <span className={`w-14 shrink-0 ${p.color}`}>{p.label}</span>
              <div className="flex-1 relative h-3.5 bg-slate-800 rounded overflow-hidden">
                <div
                  className={`absolute h-full ${p.bar} opacity-60`}
                  style={{ left: pctL, width: pctW }}
                />
              </div>
              <span className="text-slate-300 w-16 text-right font-mono tabular-nums">{p.value} ms</span>
            </div>
          );
        })}
        <div className="flex items-center gap-3 text-xs pt-2 mt-1 border-t border-slate-700">
          <span className="w-2.5 h-2.5 shrink-0" />
          <span className="w-14 text-slate-400 shrink-0">Total</span>
          <div className="flex-1" />
          <span className="text-slate-200 w-16 text-right font-mono font-bold tabular-nums">{timings.total} ms</span>
        </div>
      </div>
    </div>
  );
}

function TestResultRow({ result }: { result: TestResult }) {
  if (result.skipped) {
    return (
      <div className="flex items-start gap-2 py-1.5 px-2 rounded bg-slate-700/30">
        <span className="text-sm shrink-0 text-slate-500">~</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-slate-500 italic">{result.name}</p>
        </div>
      </div>
    );
  }
  return (
    <div className={`flex items-start gap-2 py-1.5 px-2 rounded ${result.passed ? 'bg-green-900/20' : 'bg-red-900/20'}`}>
      <span className={`text-sm shrink-0 ${result.passed ? 'text-green-400' : 'text-red-400'}`}>
        {result.passed ? '✓' : '✗'}
      </span>
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${result.passed ? 'text-green-200' : 'text-red-200'}`}>{result.name}</p>
        {!result.passed && result.error && (
          <p className="text-xs text-red-400 mt-0.5 font-mono break-all">{result.error}</p>
        )}
      </div>
    </div>
  );
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
  const parts = text.split(regex);
  return parts.map((part, i) =>
    i % 2 === 1
      ? <mark key={i} className="search-match bg-yellow-500/30 text-yellow-200 rounded-sm not-italic">{part}</mark>
      : part
  );
}

type JsonNodeProps = {
  data: unknown;
  name?: string;
  depth: number;
  isLast: boolean;
  searchQuery?: string;
  path?: (string | number)[];
  onSaveToVar?: (path: (string | number)[], value: unknown, x: number, y: number) => void;
};

function JsonNode({ data, name, depth, isLast, searchQuery, path, onSaveToVar }: JsonNodeProps) {
  const [open, setOpen] = useState(true);
  const paddingLeft = depth * 16;
  const comma = !isLast ? <span className="text-slate-500">,</span> : null;
  const keyEl = name !== undefined
    ? <><span className="text-amber-300">"</span><span className="text-amber-300">{searchQuery ? highlightText(name, searchQuery) : name}</span><span className="text-amber-300">"</span><span className="text-slate-500">: </span></>
    : null;

  const leafCtx = onSaveToVar
    ? {
        onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); onSaveToVar(path ?? [], data, e.clientX, e.clientY); },
        title: 'Right-click to save as variable',
      }
    : {};
  const leafCls = onSaveToVar ? ' cursor-context-menu hover:bg-slate-700/50 rounded' : '';

  if (data === null) {
    return <div style={{ paddingLeft }} className={`leading-5${leafCls}`} {...leafCtx}>{keyEl}<span className="text-rose-400 hover:bg-rose-400/15 rounded px-0.5">null</span>{comma}</div>;
  }
  if (typeof data === 'boolean') {
    return <div style={{ paddingLeft }} className={`leading-5${leafCls}`} {...leafCtx}>{keyEl}<span className="text-purple-400 hover:bg-purple-400/15 rounded px-0.5">{String(data)}</span>{comma}</div>;
  }
  if (typeof data === 'number') {
    return <div style={{ paddingLeft }} className={`leading-5${leafCls}`} {...leafCtx}>{keyEl}<span className="text-sky-300 hover:bg-sky-300/15 rounded px-0.5">{data}</span>{comma}</div>;
  }
  if (typeof data === 'string') {
    return (
      <div style={{ paddingLeft }} className={`leading-5 break-all${leafCls}`} {...leafCtx}>
        {keyEl}
        <span className="text-emerald-400 hover:bg-emerald-400/15 rounded px-0.5">
          &quot;{searchQuery ? highlightText(data, searchQuery) : data}&quot;
        </span>
        {comma}
      </div>
    );
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <div style={{ paddingLeft }} className="leading-5">{keyEl}<span className="text-slate-300">[]</span>{comma}</div>;
    }
    return (
      <>
        <div style={{ paddingLeft }} className="flex items-center leading-5">
          <button
            onClick={() => setOpen(o => !o)}
            className="text-slate-500 hover:text-orange-400 w-3.5 shrink-0 text-center select-none"
            style={{ fontSize: 10 }}
          >
            {open ? '▾' : '▸'}
          </button>
          <span>
            {keyEl}
            <span className="text-slate-300">[</span>
            {!open && <><span className="mx-1 text-slate-500 text-xs italic cursor-pointer hover:text-slate-300" onClick={() => setOpen(true)}>{data.length} items</span><span className="text-slate-300">]</span>{comma}</>}
          </span>
        </div>
        {open && (
          <>
            {data.map((item, i) => (
              <JsonNode key={i} data={item} depth={depth + 1} isLast={i === data.length - 1} searchQuery={searchQuery} path={[...(path ?? []), i]} onSaveToVar={onSaveToVar} />
            ))}
            <div style={{ paddingLeft: paddingLeft + 14 }} className="leading-5">
              <span className="text-slate-300">]</span>{comma}
            </div>
          </>
        )}
      </>
    );
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) {
      return <div style={{ paddingLeft }} className="leading-5">{keyEl}<span className="text-slate-300">{'{}'}</span>{comma}</div>;
    }
    return (
      <>
        <div style={{ paddingLeft }} className="flex items-center leading-5">
          <button
            onClick={() => setOpen(o => !o)}
            className="text-slate-500 hover:text-orange-400 w-3.5 shrink-0 text-center select-none"
            style={{ fontSize: 10 }}
          >
            {open ? '▾' : '▸'}
          </button>
          <span>
            {keyEl}
            <span className="text-slate-300">{'{'}</span>
            {!open && <><span className="mx-1 text-slate-500 text-xs italic cursor-pointer hover:text-slate-300" onClick={() => setOpen(true)}>{entries.length} keys</span><span className="text-slate-300">{'}'}</span>{comma}</>}
          </span>
        </div>
        {open && (
          <>
            {entries.map(([k, v], i) => (
              <JsonNode key={k} data={v} name={k} depth={depth + 1} isLast={i === entries.length - 1} searchQuery={searchQuery} path={[...(path ?? []), k]} onSaveToVar={onSaveToVar} />
            ))}
            <div style={{ paddingLeft: paddingLeft + 14 }} className="leading-5">
              <span className="text-slate-300">{'}'}</span>{comma}
            </div>
          </>
        )}
      </>
    );
  }

  return null;
}

// ── XML tree ────────────────────────────────────────────────────────────────

interface XmlNodeProps {
  node: Element | Text | Node;
  depth: number;
}

function XmlNode({ node, depth }: XmlNodeProps) {
  const [open, setOpen] = useState(true);
  const paddingLeft = depth * 16;

  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent?.trim() ?? '';
    if (!text) return null;
    return (
      <div style={{ paddingLeft }} className="leading-5 text-emerald-400 break-all">
        {text}
      </div>
    );
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const el = node as Element;
  const tag = el.nodeName;
  const attrs = Array.from(el.attributes);
  const children = Array.from(el.childNodes).filter(n => {
    if (n.nodeType === Node.TEXT_NODE) return (n.textContent?.trim() ?? '') !== '';
    return n.nodeType === Node.ELEMENT_NODE;
  });

  const attrStr = attrs.map(a => (
    <span key={a.name}>
      {' '}
      <span className="text-sky-300">{a.name}</span>
      <span className="text-slate-500">="</span>
      <span className="text-amber-300">{a.value}</span>
      <span className="text-slate-500">"</span>
    </span>
  ));

  if (children.length === 0) {
    return (
      <div style={{ paddingLeft }} className="leading-5">
        <span className="text-slate-500">{'<'}</span>
        <span className="text-rose-400">{tag}</span>
        {attrStr}
        <span className="text-slate-500">{'/>'}</span>
      </div>
    );
  }

  const isSingleText = children.length === 1 && children[0].nodeType === Node.TEXT_NODE;
  if (isSingleText) {
    return (
      <div style={{ paddingLeft }} className="leading-5 break-all">
        <span className="text-slate-500">{'<'}</span>
        <span className="text-rose-400">{tag}</span>
        {attrStr}
        <span className="text-slate-500">{'>'}</span>
        <span className="text-emerald-400">{children[0].textContent?.trim()}</span>
        <span className="text-slate-500">{'</'}</span>
        <span className="text-rose-400">{tag}</span>
        <span className="text-slate-500">{'>'}</span>
      </div>
    );
  }

  return (
    <>
      <div style={{ paddingLeft }} className="flex items-center leading-5">
        <button
          onClick={() => setOpen(o => !o)}
          className="text-slate-500 hover:text-orange-400 w-3.5 shrink-0 text-center select-none"
          style={{ fontSize: 10 }}
        >
          {open ? '▾' : '▸'}
        </button>
        <span>
          <span className="text-slate-500">{'<'}</span>
          <span className="text-rose-400">{tag}</span>
          {attrStr}
          <span className="text-slate-500">{'>'}</span>
          {!open && (
            <>
              <span className="mx-1 text-slate-500 text-xs italic cursor-pointer hover:text-slate-300" onClick={() => setOpen(true)}>
                {children.length} {children.length === 1 ? 'child' : 'children'}
              </span>
              <span className="text-slate-500">{'</'}</span>
              <span className="text-rose-400">{tag}</span>
              <span className="text-slate-500">{'>'}</span>
            </>
          )}
        </span>
      </div>
      {open && (
        <>
          {children.map((child, i) => (
            <XmlNode key={i} node={child} depth={depth + 1} />
          ))}
          <div style={{ paddingLeft: paddingLeft + 14 }} className="leading-5">
            <span className="text-slate-500">{'</'}</span>
            <span className="text-rose-400">{tag}</span>
            <span className="text-slate-500">{'>'}</span>
          </div>
        </>
      )}
    </>
  );
}

function XmlTreeView({ body }: { body: string }) {
  const doc = new DOMParser().parseFromString(body, 'text/xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) {
    return (
      <pre className="p-3 text-sm font-mono text-slate-200 whitespace-pre-wrap break-all">
        {body}
      </pre>
    );
  }
  return (
    <div className="p-3 text-sm font-mono text-slate-200">
      <XmlNode node={doc.documentElement} depth={0} />
    </div>
  );
}

function JsonTreeView({ body, searchQuery, onSaveToVar }: {
  body: string;
  searchQuery?: string;
  onSaveToVar?: (path: (string | number)[], value: unknown, x: number, y: number) => void;
}) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return (
      <pre className="p-3 text-sm font-mono text-slate-200 whitespace-pre-wrap break-all">
        {searchQuery ? highlightText(body, searchQuery) : body}
      </pre>
    );
  }
  return (
    <div className="p-3 text-sm font-mono text-slate-200">
      <JsonNode data={parsed} depth={0} isLast={true} searchQuery={searchQuery} path={[]} onSaveToVar={onSaveToVar} />
    </div>
  );
}

// ── JSONPath evaluator ──────────────────────────────────────────────────────
function collectAll(node: unknown, key: string, acc: unknown[]) {
  if (key === '*') {
    if (Array.isArray(node)) { node.forEach(v => { acc.push(v); collectAll(v, key, acc); }); }
    else if (node && typeof node === 'object') { Object.values(node as object).forEach(v => { acc.push(v); collectAll(v, key, acc); }); }
  } else {
    if (Array.isArray(node)) { node.forEach(v => collectAll(v, key, acc)); }
    else if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>;
      if (key in o) acc.push(o[key]);
      Object.values(o).forEach(v => collectAll(v, key, acc));
    }
  }
}

function applyJsonPath(root: unknown, expr: string): { value: unknown; error?: string } {
  const path = expr.trim();
  if (!path || path === '$') return { value: root };
  if (!path.startsWith('$')) return { value: undefined, error: 'Expression must start with $' };
  let current: unknown[] = [root];
  let i = 1;
  try {
    while (i < path.length) {
      const next: unknown[] = [];
      if (path[i] === '.') {
        if (path[i + 1] === '.') {
          i += 2;
          let key = '';
          if (i < path.length && path[i] === '[') {
            i++;
            while (i < path.length && path[i] !== ']') key += path[i++];
            i++;
            key = key.trim().replace(/^['"]|['"]$/g, '');
          } else {
            while (i < path.length && path[i] !== '.' && path[i] !== '[') key += path[i++];
          }
          current.forEach(c => collectAll(c, key, next));
        } else {
          i++;
          let key = '';
          if (i < path.length && path[i] === '*') { i++; key = '*'; }
          else { while (i < path.length && path[i] !== '.' && path[i] !== '[') key += path[i++]; }
          if (key === '*') {
            current.forEach(c => {
              if (Array.isArray(c)) c.forEach(v => next.push(v));
              else if (c && typeof c === 'object') Object.values(c as object).forEach(v => next.push(v));
            });
          } else {
            current.forEach(c => {
              if (c && typeof c === 'object' && !Array.isArray(c)) {
                const o = c as Record<string, unknown>;
                if (key in o) next.push(o[key]);
              }
            });
          }
        }
      } else if (path[i] === '[') {
        i++;
        let inner = '';
        while (i < path.length && path[i] !== ']') inner += path[i++];
        i++;
        inner = inner.trim();
        if (inner === '*') {
          current.forEach(c => {
            if (Array.isArray(c)) c.forEach(v => next.push(v));
            else if (c && typeof c === 'object') Object.values(c as object).forEach(v => next.push(v));
          });
        } else if (/^-?\d+$/.test(inner)) {
          const idx = parseInt(inner, 10);
          current.forEach(c => {
            if (Array.isArray(c)) { const a = idx < 0 ? c.length + idx : idx; if (a >= 0 && a < c.length) next.push(c[a]); }
          });
        } else if (/^(-?\d*):(-?\d*)$/.test(inner)) {
          const [, s, e] = inner.match(/^(-?\d*):(-?\d*)$/)!;
          current.forEach(c => {
            if (Array.isArray(c)) {
              const st = s ? parseInt(s, 10) : 0;
              const en = e ? parseInt(e, 10) : c.length;
              const as2 = st < 0 ? Math.max(c.length + st, 0) : Math.min(st, c.length);
              const ae2 = en < 0 ? Math.max(c.length + en, 0) : Math.min(en, c.length);
              c.slice(as2, ae2).forEach(v => next.push(v));
            }
          });
        } else if (inner.includes(',')) {
          inner.split(',').map(p => p.trim().replace(/^['"]|['"]$/g, '')).forEach(p => {
            if (/^-?\d+$/.test(p)) {
              const idx = parseInt(p, 10);
              current.forEach(c => { if (Array.isArray(c)) { const a = idx < 0 ? c.length + idx : idx; if (a >= 0 && a < c.length) next.push(c[a]); } });
            } else {
              current.forEach(c => { if (c && typeof c === 'object' && !Array.isArray(c)) { const o = c as Record<string, unknown>; if (p in o) next.push(o[p]); } });
            }
          });
        } else {
          const key = inner.replace(/^['"]|['"]$/g, '');
          current.forEach(c => {
            if (c && typeof c === 'object' && !Array.isArray(c)) {
              const o = c as Record<string, unknown>;
              if (key in o) next.push(o[key]);
            }
          });
        }
      } else { break; }
      current = next;
      if (current.length === 0) break;
    }
  } catch (e) { return { value: undefined, error: String(e) }; }
  if (current.length === 0) return { value: null };
  return { value: current.length === 1 ? current[0] : current };
}
// ────────────────────────────────────────────────────────────────────────────

// ── Context-menu position helper ────────────────────────────────────────────
/** Clamp a context-menu so it stays inside the viewport. */
function clampMenuPosition(
  x: number,
  y: number,
  menuWidth = 180,
  menuHeight = 80,
): { left: number; top: number } {
  const left = Math.min(x, window.innerWidth - menuWidth - 4);
  const top = Math.min(y, window.innerHeight - menuHeight - 4);
  return { left: Math.max(4, left), top: Math.max(4, top) };
}
// ────────────────────────────────────────────────────────────────────────────

export default function ResponseViewer() {
  const { state } = useApp();
  const [tab, setTab] = useState<RespTab>('Body');
  const [rawMode, setRawMode] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const [jsonPathExpr, setJsonPathExpr] = useState('');
  const [jsonPathOpen, setJsonPathOpen] = useState(false);
  const jsonPathInputRef = useRef<HTMLInputElement>(null);
  const [ctxMenu, setCtxMenu] = useState<{ left: number; top: number; path: (string | number)[]; value: unknown } | null>(null);
  const [saveToVarTarget, setSaveToVarTarget] = useState<{ path: (string | number)[]; value: unknown } | null>(null);
  const [testValueTarget, setTestValueTarget] = useState<{ path: (string | number)[]; value: unknown } | null>(null);

  const handleSaveToVar = useCallback((path: (string | number)[], value: unknown, x: number, y: number) => {
    setCtxMenu({ ...clampMenuPosition(x, y), path, value });
  }, []);

  const copyBody = () => {
    if (!response) return;
    navigator.clipboard.writeText(response.body).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  const searchInputRef = useRef<HTMLInputElement>(null);
  const bodyContentRef = useRef<HTMLDivElement>(null);

  const { response, isLoading } = state;

  const availableTabs = useMemo<RespTab[]>(() => {
    const tabs: RespTab[] = ['Body', 'Headers', 'Test Results'];
    if (response?.redirectChain && response.redirectChain.length > 0) tabs.push('Redirects');
    if (response?.tlsCertChain && response.tlsCertChain.length > 0) tabs.push('TLS');
    if (response?.networkTimings) tabs.push('Timeline');
    return tabs;
  }, [response]);

  // Reset to Body if the current tab is no longer available
  useEffect(() => {
    if (!availableTabs.includes(tab)) setTab('Body');
  }, [availableTabs]);

  const jsonPathResult = useMemo(() => {
    if (!jsonPathExpr.trim() || !response) return null;
    try {
      const parsed = JSON.parse(response.body);
      return applyJsonPath(parsed, jsonPathExpr);
    } catch {
      return { value: undefined, error: 'Response is not valid JSON' };
    }
  }, [jsonPathExpr, response]);

  const isJson = useMemo(() => {
    if (!response) return false;
    try { JSON.parse(response.body); return true; } catch { return false; }
  }, [response]);

  const isXml = useMemo(() => {
    if (!response) return false;
    const ct = (response.headers?.['content-type'] ?? response.headers?.['Content-Type'] ?? '').toLowerCase();
    return ct.includes('xml') || ct.includes('soap');
  }, [response]);

  const totalMatches = useMemo(() => {
    if (!searchQuery.trim() || !response) return 0;
    const body = response.body.toLowerCase();
    const q = searchQuery.toLowerCase();
    let count = 0;
    let pos = 0;
    while (true) {
      const idx = body.indexOf(q, pos);
      if (idx === -1) break;
      count++;
      pos = idx + 1;
    }
    return count;
  }, [searchQuery, response]);

  // Reset match index when query changes
  useEffect(() => { setMatchIndex(0); }, [searchQuery]);

  // Global hotkey: Cmd+F / Ctrl+F
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setTab('Body');
        setSearchOpen(true);
        const selected = window.getSelection()?.toString().trim();
        if (selected) {
          setSearchQuery(selected);
          setMatchIndex(0);
        }
        setTimeout(() => {
          if (searchInputRef.current) {
            searchInputRef.current.focus();
            searchInputRef.current.select();
          }
        }, 50);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Scroll to current match after render
  useLayoutEffect(() => {
    if (!bodyContentRef.current || !searchQuery.trim() || totalMatches === 0) return;
    const marks = bodyContentRef.current.querySelectorAll<HTMLElement>('mark.search-match');
    if (marks.length === 0) return;
    const cur = matchIndex % marks.length;
    marks.forEach((m, i) => {
      if (i === cur) {
        m.style.backgroundColor = 'rgba(234,179,8,0.6)';
        m.style.outline = '1px solid rgba(234,179,8,0.9)';
        m.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        m.style.backgroundColor = '';
        m.style.outline = '';
      }
    });
  }, [matchIndex, searchQuery, totalMatches, rawMode, response]);

  const closeSearch = () => { setSearchOpen(false); setSearchQuery(''); setMatchIndex(0); };

  const handleSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      closeSearch();
    } else if (e.key === 'Enter' && totalMatches > 0) {
      if (e.shiftKey) {
        setMatchIndex(i => (i - 1 + totalMatches) % totalMatches);
      } else {
        setMatchIndex(i => (i + 1) % totalMatches);
      }
    }
  };

  if (isLoading) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center border-t border-slate-700 bg-slate-900">
        <div className="text-slate-400 text-sm flex items-center gap-2">
          <span className="animate-pulse">⏳</span> Sending request...
        </div>
      </div>
    );
  }

  if (!response) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center border-t border-slate-700 bg-slate-900">
        <p className="text-slate-600 text-sm">Hit Send to see the response</p>
      </div>
    );
  }

  const passed = response.testResults.filter(t => t.passed === true).length;
  const skipped = response.testResults.filter(t => t.skipped).length;
  const failed = response.testResults.filter(t => t.passed === false).length;
  const countable = response.testResults.length - skipped;

  return (
    <div className="h-full min-h-0 border-t border-slate-700 bg-slate-900 flex flex-col">
      {/* Response status bar */}
      <div className="flex items-center gap-4 px-3 py-2 border-b border-slate-700 shrink-0">
        {response.error ? (
          <span className="text-red-400 text-sm font-medium">⚠ {response.error}</span>
        ) : (
          <>
            <StatusBadge status={response.status} />
            <span className="text-slate-400 text-xs">{response.statusText}</span>
            <span className="text-slate-500 text-xs">{response.responseTime} ms</span>
            <span className="text-slate-500 text-xs">{formatSize(response.size)}</span>
          </>
        )}
        {/* Test summary badge */}
        {response.testResults.length > 0 && (
          <span className={`ml-auto text-xs px-2 py-0.5 rounded font-medium ${
            failed > 0 ? 'bg-red-800 text-red-200' : 'bg-green-800 text-green-200'
          }`}>
            Tests: {passed}/{countable} passed{skipped > 0 ? ` (${skipped} skipped)` : ''}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-700 shrink-0">
        {availableTabs.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-xs font-medium transition-colors ${
              tab === t
                ? 'text-orange-400 border-b-2 border-orange-400 -mb-px'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t === 'Test Results'
              ? `Tests ${response.testResults.length > 0 ? `(${passed}/${countable}${skipped > 0 ? ` +${skipped}` : ''})` : ''}`
              : t}
          </button>
        ))}
        {tab === 'Body' && (
          <div className="ml-auto flex items-center gap-2 pr-3">
            <label className="flex items-center gap-1 text-xs text-slate-500 cursor-pointer">
              <input
                type="checkbox"
                checked={rawMode}
                onChange={e => setRawMode(e.target.checked)}
                className="accent-orange-500"
              />
              Raw
            </label>
            <button
              onClick={copyBody}
              className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                copied ? 'text-green-400' : 'text-slate-500 hover:text-slate-300'
              }`}
              title={copied ? 'Copied!' : 'Copy response body'}
            >
              {copied ? '✓' : '⧉'}
            </button>
            {isJson && (
              <button
                onClick={() => { setJsonPathOpen(o => !o); if (!jsonPathOpen) setTimeout(() => jsonPathInputRef.current?.focus(), 50); }}
                className={`text-xs px-1.5 py-0.5 rounded transition-colors font-mono ${
                  jsonPathOpen || jsonPathExpr ? 'text-orange-400 bg-orange-500/10' : 'text-slate-500 hover:text-slate-300'
                }`}
                title="Filter by JSONPath"
              >
                $.…
              </button>
            )}
            <button
              onClick={() => { setSearchOpen(o => !o); if (!searchOpen) setTimeout(() => searchInputRef.current?.focus(), 50); }}
              className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                searchOpen ? 'text-orange-400 bg-orange-500/10' : 'text-slate-500 hover:text-slate-300'
              }`}
              title="Search in body (⌘F)"
            >
              🔍
            </button>
          </div>
        )}
      </div>

      {/* JSONPath filter bar */}
      {tab === 'Body' && jsonPathOpen && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-700 bg-slate-800/80 shrink-0">
          <span className="text-xs text-slate-500 font-mono shrink-0">$.</span>
          <input
            ref={jsonPathInputRef}
            type="text"
            value={jsonPathExpr}
            onChange={e => setJsonPathExpr(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && setJsonPathOpen(false)}
            placeholder="e.g. $.data[0].name  or  $..email  or  $.items[*]"
            className="flex-1 bg-slate-700 text-slate-200 text-xs px-2 py-1 rounded outline-none border border-slate-600 focus:border-orange-500 placeholder-slate-500 font-mono"
          />
          {jsonPathExpr.trim() && jsonPathResult && (
            <span className={`text-xs whitespace-nowrap ${
              jsonPathResult.error ? 'text-red-400' : 'text-slate-400'
            }`}>
              {jsonPathResult.error
                ? 'Error'
                : Array.isArray(jsonPathResult.value)
                  ? `${(jsonPathResult.value as unknown[]).length} result(s)`
                  : '1 result'}
            </span>
          )}
          {jsonPathExpr && (
            <button
              onClick={() => setJsonPathExpr('')}
              className="text-slate-500 hover:text-slate-200 px-1 text-sm"
              title="Clear filter"
            >✕</button>
          )}
          <button
            onClick={() => { setJsonPathOpen(false); }}
            className="text-slate-500 hover:text-slate-200 px-1 text-xs"
            title="Close"
          >✕</button>
        </div>
      )}

      {/* Search bar */}
      {tab === 'Body' && searchOpen && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-700 bg-slate-800/80 shrink-0">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKey}
            placeholder="Search in body… (Enter ↓  Shift+Enter ↑  Esc close)"
            className="flex-1 bg-slate-700 text-slate-200 text-xs px-2 py-1 rounded outline-none border border-slate-600 focus:border-orange-500 placeholder-slate-500"
          />
          {searchQuery.trim() && (
            <span className={`text-xs whitespace-nowrap ${
              totalMatches === 0 ? 'text-red-400' : 'text-slate-400'
            }`}>
              {totalMatches === 0 ? 'No matches' : `${matchIndex + 1} / ${totalMatches}`}
            </span>
          )}
          <button
            onClick={() => totalMatches > 0 && setMatchIndex(i => (i - 1 + totalMatches) % totalMatches)}
            disabled={totalMatches === 0}
            className="text-slate-400 hover:text-slate-200 disabled:opacity-30 px-1 text-sm"
            title="Previous match (Shift+Enter)"
          >↑</button>
          <button
            onClick={() => totalMatches > 0 && setMatchIndex(i => (i + 1) % totalMatches)}
            disabled={totalMatches === 0}
            className="text-slate-400 hover:text-slate-200 disabled:opacity-30 px-1 text-sm"
            title="Next match (Enter)"
          >↓</button>
          <button
            onClick={closeSearch}
            className="text-slate-500 hover:text-slate-200 px-1 text-sm"
            title="Close (Esc)"
          >✕</button>
        </div>
      )}

      {/* Content */}
      <div ref={bodyContentRef} className="flex-1 overflow-auto">
        {tab === 'Body' && (() => {
          // JSONPath active and has a result
          if (jsonPathExpr.trim() && jsonPathResult) {
            if (jsonPathResult.error) {
              return <p className="p-4 text-sm text-red-400 font-mono">{jsonPathResult.error}</p>;
            }
            const serialized = JSON.stringify(jsonPathResult.value, null, 2) ?? 'null';
            return rawMode ? (
              <pre className="p-3 text-sm font-mono text-slate-200 whitespace-pre-wrap break-all">
                {searchQuery.trim() ? highlightText(serialized, searchQuery) : serialized}
              </pre>
            ) : (
              <JsonTreeView body={serialized} searchQuery={searchQuery.trim() ? searchQuery : undefined} />
            );
          }
          return rawMode ? (
            <pre className="p-3 text-sm font-mono text-slate-200 whitespace-pre-wrap break-all">
              {searchQuery.trim() ? highlightText(response.body, searchQuery) : response.body}
            </pre>
          ) : isXml ? (
            <XmlTreeView body={response.body} />
          ) : (
            <JsonTreeView body={response.body} searchQuery={searchQuery.trim() ? searchQuery : undefined} onSaveToVar={handleSaveToVar} />
          );
        })()}

        {tab === 'Headers' && (
          <div className="p-3">
            {Object.entries(response.headers).length === 0 ? (
              <p className="text-slate-500 text-sm">No headers</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {Object.entries(response.headers).map(([k, v]) => (
                    <tr key={k} className="border-b border-slate-800">
                      <td className="py-1 pr-4 text-slate-400 font-medium w-1/3">{k}</td>
                      <td className="py-1 text-slate-200 font-mono break-all">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === 'Test Results' && (
          <div className="p-3 flex flex-col gap-1">
            {response.testResults.length === 0 ? (
              <p className="text-slate-500 text-sm">No tests ran. Add test scripts in the Tests tab.</p>
            ) : (
              response.testResults.map((r, i) => <TestResultRow key={i} result={r} />)
            )}
          </div>
        )}

        {tab === 'Redirects' && response.redirectChain && response.redirectChain.length > 0 && (
          <RedirectChainView chain={response.redirectChain} finalUrl={response.resolvedUrl} finalStatus={response.status} />
        )}

        {tab === 'TLS' && response.tlsCertChain && response.tlsCertChain.length > 0 && (
          <TlsCertViewer chain={response.tlsCertChain} />
        )}

        {tab === 'Timeline' && response.networkTimings && (
          <NetworkTimeline timings={response.networkTimings} />
        )}
      </div>

      {/* Context menu: actions for a response value */}
      {ctxMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setCtxMenu(null)} />
          <div
            className="fixed z-50 bg-slate-800 border border-slate-600 rounded shadow-xl text-xs py-1"
            style={{ left: ctxMenu.left, top: ctxMenu.top }}
          >
            <button
              className="block w-full text-left px-4 py-2 text-slate-200 hover:bg-slate-700 transition-colors whitespace-nowrap"
              onClick={() => {
                setSaveToVarTarget({ path: ctxMenu.path, value: ctxMenu.value });
                setCtxMenu(null);
              }}
            >
              Save as variable…
            </button>
            <button
              className="block w-full text-left px-4 py-2 text-slate-200 hover:bg-slate-700 transition-colors whitespace-nowrap"
              onClick={() => {
                setTestValueTarget({ path: ctxMenu.path, value: ctxMenu.value });
                setCtxMenu(null);
              }}
            >
              Test this value…
            </button>
          </div>
        </>
      )}

      {/* Save-to-variable modal */}
      {saveToVarTarget && (
        <SaveToVarModal
          path={saveToVarTarget.path}
          value={saveToVarTarget.value}
          collectionId={state.activeRequest?.collectionId || null}
          onConfirm={(varName, scope) => {
            const snippet = buildSaveToVarSnippet(varName, scope, saveToVarTarget.path);
            document.dispatchEvent(
              new CustomEvent('apilix:inject-test-snippet', { detail: { snippet } })
            );
            setSaveToVarTarget(null);
          }}
          onClose={() => setSaveToVarTarget(null)}
        />
      )}

      {testValueTarget && (
        <TestValueModal
          path={testValueTarget.path}
          value={testValueTarget.value}
          onClose={() => setTestValueTarget(null)}
        />
      )}
    </div>
  );
}
