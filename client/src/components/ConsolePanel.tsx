import { useState, useRef, useEffect, useCallback } from 'react';
import { useApp } from '../store';
import type { ConsoleEntry } from '../types';

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 600;
const BROADCAST_CHANNEL = 'apilix-console-v1';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function methodBadge(method: string): string {
  const map: Record<string, string> = {
    GET: 'text-green-400 bg-green-900/30',
    POST: 'text-blue-400 bg-blue-900/30',
    PUT: 'text-yellow-400 bg-yellow-900/30',
    PATCH: 'text-orange-400 bg-orange-900/30',
    DELETE: 'text-red-400 bg-red-900/30',
    HEAD: 'text-purple-400 bg-purple-900/30',
    OPTIONS: 'text-slate-300 bg-slate-700',
  };
  return map[method.toUpperCase()] ?? 'text-slate-300 bg-slate-700';
}

function statusBadge(status: number): string {
  if (status >= 500) return 'text-red-400 bg-red-900/30';
  if (status >= 400) return 'text-yellow-400 bg-yellow-900/30';
  if (status >= 300) return 'text-sky-400 bg-sky-900/30';
  if (status >= 200) return 'text-green-400 bg-green-900/30';
  return 'text-red-400 bg-red-900/30';
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function tryFormat(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

// ─── Entry detail (expanded view) ────────────────────────────────────────────

const LOG_LEVEL_COLOR: Record<string, string> = {
  log: 'text-slate-300',
  info: 'text-sky-300',
  warn: 'text-yellow-300',
  error: 'text-red-400',
};

function EntryDetail({ entry }: { entry: ConsoleEntry }) {
  const logCount = entry.scriptLogs?.length ?? 0;
  const [tab, setTab] = useState<'response' | 'request' | 'logs'>('response');

  return (
    <div className="bg-slate-900 border-t-2 border-orange-500/30 text-xs">
      <div className="flex border-b border-slate-700/60">
        {(['response', 'request'] as const).map(t => (
          <button
            key={t}
            onClick={e => { e.stopPropagation(); setTab(t); }}
            className={`px-4 py-1.5 capitalize transition-colors border-b-2 ${
              tab === t
                ? 'text-orange-400 border-orange-500'
                : 'text-slate-500 border-transparent hover:text-slate-300'
            }`}
          >
            {t}
          </button>
        ))}
        <button
          onClick={e => { e.stopPropagation(); setTab('logs'); }}
          className={`px-4 py-1.5 transition-colors border-b-2 flex items-center gap-1.5 ${
            tab === 'logs'
              ? 'text-orange-400 border-orange-500'
              : 'text-slate-500 border-transparent hover:text-slate-300'
          }`}
        >
          Logs
          {logCount > 0 && (
            <span className={`text-[10px] font-semibold px-1 rounded ${tab === 'logs' ? 'bg-orange-500/20 text-orange-300' : 'bg-slate-700 text-slate-400'}`}>
              {logCount}
            </span>
          )}
        </button>
      </div>

      <div className="p-3 overflow-auto max-h-44 font-mono">
        {tab === 'request' && (
          <div className="space-y-2.5">
            <div>
              <span className="text-slate-500">URL  </span>
              <span className="text-slate-200 break-all">{entry.url}</span>
            </div>
            {entry.requestHeaders.length > 0 && (
              <div>
                <p className="text-slate-500 mb-1">Headers</p>
                {entry.requestHeaders.map((h, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-slate-400 shrink-0">{h.key}:</span>
                    <span className="text-slate-200 break-all">{h.value}</span>
                  </div>
                ))}
              </div>
            )}
            {entry.requestBody && (
              <div>
                <p className="text-slate-500 mb-1">Body</p>
                <pre className="bg-slate-800 rounded p-2 text-slate-200 whitespace-pre-wrap break-all">
                  {tryFormat(entry.requestBody)}
                </pre>
              </div>
            )}
          </div>
        )}

        {tab === 'response' && (
          <div className="space-y-2.5">
            {!entry.response || entry.response.error ? (
              <p className="text-red-400">{entry.response?.error ?? 'No response'}</p>
            ) : (
              <>
                <div className="flex gap-6 flex-wrap">
                  <span>
                    <span className="text-slate-500">Status  </span>
                    <span className="text-slate-200">{entry.response.status} {entry.response.statusText}</span>
                  </span>
                  <span>
                    <span className="text-slate-500">Time  </span>
                    <span className="text-slate-200">{entry.response.responseTime} ms</span>
                  </span>
                  <span>
                    <span className="text-slate-500">Size  </span>
                    <span className="text-slate-200">{entry.response.size} B</span>
                  </span>
                </div>

                {Object.keys(entry.response.headers).length > 0 && (
                  <div>
                    <p className="text-slate-500 mb-1">Headers</p>
                    {Object.entries(entry.response.headers).map(([k, v]) => (
                      <div key={k} className="flex gap-2">
                        <span className="text-slate-400 shrink-0">{k}:</span>
                        <span className="text-slate-200 break-all">{v}</span>
                      </div>
                    ))}
                  </div>
                )}

                {entry.response.body && (
                  <div>
                    <p className="text-slate-500 mb-1">Body</p>
                    <pre className="bg-slate-800 rounded p-2 text-slate-200 whitespace-pre-wrap break-all max-h-36 overflow-auto">
                      {tryFormat(entry.response.body)}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {tab === 'logs' && (
          <div className="space-y-1">
            {!entry.scriptLogs || entry.scriptLogs.length === 0 ? (
              <p className="text-slate-600 italic">No console output for this request</p>
            ) : (
              entry.scriptLogs.map((log, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <span className={`shrink-0 font-semibold uppercase text-[10px] w-9 pt-px ${LOG_LEVEL_COLOR[log.level]}`}>
                    {log.level}
                  </span>
                  <span className={`break-all ${LOG_LEVEL_COLOR[log.level]}`}>
                    {log.args.join(' ')}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Build standalone HTML for "Open in new window" ──────────────────────────

function buildHtml(logs: ConsoleEntry[]): string {
  // Escape </script> sequences so they don't break the inline script tag
  const initialData = JSON.stringify(logs).replace(/<\/script>/gi, '<\\/script>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Console — APILIX</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;background:#020617;color:#cbd5e1;font-size:12px;display:flex;flex-direction:column;height:100vh;overflow:hidden}
#hdr{display:flex;align-items:center;gap:8px;padding:5px 12px;border-bottom:1px solid #1e293b;background:#0f172a;flex-shrink:0;user-select:none}
#title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8}
#cnt{font-size:11px;color:#334155;margin-left:2px}
#filter{flex:1;min-width:0;background:#1e293b;border:1px solid #334155;color:#cbd5e1;font-family:inherit;font-size:11px;padding:3px 8px;border-radius:4px;outline:none}
#filter:focus{border-color:#f97316}
#filter::placeholder{color:#475569}
#clearBtn{background:transparent;border:1px solid #334155;color:#64748b;font-size:11px;padding:3px 10px;border-radius:4px;cursor:pointer;font-family:inherit;flex-shrink:0}
#clearBtn:hover{color:#e2e8f0;border-color:#64748b}
#list{flex:1;overflow-y:auto;min-height:0}
.empty{display:flex;align-items:center;justify-content:center;height:100%;color:#1e293b;font-style:italic;font-size:12px;user-select:none}
.row{border-bottom:1px solid rgba(30,41,59,.8);cursor:pointer;user-select:none}
.row:hover .row-inner{background:#0f172a}
.row.sel{border-left:2px solid #f97316}
.row.sel .row-inner{background:#1e293b}
.row-inner{display:flex;align-items:center;gap:6px;padding:5px 12px}
.badge{font-size:10px;font-weight:700;padding:1px 5px;border-radius:3px;flex-shrink:0;font-family:inherit}
.mGET{color:#4ade80;background:rgba(74,222,128,.15)}
.mPOST{color:#60a5fa;background:rgba(96,165,250,.15)}
.mPUT{color:#facc15;background:rgba(250,204,21,.15)}
.mPATCH{color:#fb923c;background:rgba(251,146,60,.15)}
.mDELETE{color:#f87171;background:rgba(248,113,113,.15)}
.mHEAD{color:#c084fc;background:rgba(192,132,252,.15)}
.mOTHER{color:#94a3b8;background:rgba(148,163,184,.15)}
.s2{color:#4ade80;background:rgba(74,222,128,.15)}
.s3{color:#38bdf8;background:rgba(56,189,248,.15)}
.s4{color:#facc15;background:rgba(250,204,21,.15)}
.s5,.sE{color:#f87171;background:rgba(248,113,113,.15)}
.url{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;color:#cbd5e1;font-family:inherit}
.timing{color:#64748b;flex-shrink:0;font-variant-numeric:tabular-nums}
.ts{color:#334155;flex-shrink:0;font-variant-numeric:tabular-nums}
.chev{width:12px;height:12px;flex-shrink:0;color:#64748b;transition:transform .15s}
.sel .chev{transform:rotate(180deg);color:#f97316}
.detail{background:#0f172a;border-top:2px solid rgba(249,115,22,.25)}
.dtabs{display:flex;border-bottom:1px solid #1e293b}
.dtab{padding:5px 14px;font-size:11px;cursor:pointer;border:none;border-bottom:2px solid transparent;color:#64748b;background:transparent;font-family:inherit;text-transform:capitalize}
.dtab:hover{color:#94a3b8}
.dtab.act{color:#f97316;border-bottom-color:#f97316}
.dbody{padding:10px 12px;overflow:auto;max-height:220px;font-size:11px;line-height:1.7}
.dlabel{color:#64748b;margin-bottom:4px}
.dsect{margin-bottom:10px}
.kv{display:flex;gap:8px}
.kvk{color:#94a3b8;flex-shrink:0}
.kvv{color:#cbd5e1;word-break:break-all}
.meta{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:10px}
.metai{color:#cbd5e1}
.mlab{color:#64748b}
pre.bp{background:#1e293b;border-radius:4px;padding:8px;color:#cbd5e1;white-space:pre-wrap;word-break:break-all;max-height:140px;overflow:auto;font-family:inherit;font-size:11px;margin:0}
.err-text{color:#f87171}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#334155;border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:#475569}
</style>
</head>
<body>
<div id="hdr">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" style="flex-shrink:0">
    <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
  </svg>
  <span id="title">Console</span>
  <span id="cnt">0</span>
  <input id="filter" type="text" placeholder="Filter by URL or method\u2026">
  <button id="clearBtn">Clear</button>
</div>
<div id="list"></div>
<script>
var logs = ${initialData};
var selId = null;
var dtab = {};
var filterText = '';

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmt(s) {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch(e) { return s; }
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function mCls(m) {
  var map = {GET:'mGET',POST:'mPOST',PUT:'mPUT',PATCH:'mPATCH',DELETE:'mDELETE',HEAD:'mHEAD'};
  return map[(m||'GET').toUpperCase()] || 'mOTHER';
}
function sCls(status, err) {
  if (err || !status) return 'sE';
  if (status >= 500) return 's5';
  if (status >= 400) return 's4';
  if (status >= 300) return 's3';
  return 's2';
}

function renderDetail(e) {
  var tab = dtab[e.id] || 'response';
  var det = document.createElement('div');
  det.className = 'detail';
  var tabsEl = document.createElement('div');
  tabsEl.className = 'dtabs';
  ['response','request'].forEach(function(t) {
    var btn = document.createElement('button');
    btn.className = 'dtab' + (tab === t ? ' act' : '');
    btn.textContent = t;
    btn.addEventListener('click', function(ev) { ev.stopPropagation(); dtab[e.id] = t; render(); });
    tabsEl.appendChild(btn);
  });
  det.appendChild(tabsEl);
  var body = document.createElement('div');
  body.className = 'dbody';
  if (tab === 'request') {
    var urlSect = document.createElement('div');
    urlSect.className = 'dsect';
    urlSect.innerHTML = '<span class="mlab">URL &nbsp;</span><span style="color:#cbd5e1;word-break:break-all">' + esc(e.url) + '</span>';
    body.appendChild(urlSect);
    if (e.requestHeaders && e.requestHeaders.length > 0) {
      var hSect = document.createElement('div'); hSect.className = 'dsect';
      var hLabel = document.createElement('p'); hLabel.className = 'dlabel'; hLabel.textContent = 'Headers';
      hSect.appendChild(hLabel);
      e.requestHeaders.forEach(function(h) {
        var kv = document.createElement('div'); kv.className = 'kv';
        kv.innerHTML = '<span class="kvk">' + esc(h.key) + ':</span><span class="kvv">' + esc(h.value) + '</span>';
        hSect.appendChild(kv);
      });
      body.appendChild(hSect);
    }
    if (e.requestBody) {
      var bSect = document.createElement('div'); bSect.className = 'dsect';
      var bLabel = document.createElement('p'); bLabel.className = 'dlabel'; bLabel.textContent = 'Body';
      bSect.appendChild(bLabel);
      var pre = document.createElement('pre'); pre.className = 'bp'; pre.textContent = fmt(e.requestBody);
      bSect.appendChild(pre); body.appendChild(bSect);
    }
  } else {
    if (!e.response || e.response.error) {
      var errEl = document.createElement('p'); errEl.className = 'err-text';
      errEl.textContent = (e.response && e.response.error) ? e.response.error : 'No response';
      body.appendChild(errEl);
    } else {
      var meta = document.createElement('div'); meta.className = 'meta';
      meta.innerHTML =
        '<span class="metai"><span class="mlab">Status &nbsp;</span>' + esc(String(e.response.status)) + ' ' + esc(e.response.statusText) + '</span>' +
        '<span class="metai"><span class="mlab">Time &nbsp;</span>' + esc(String(e.response.responseTime)) + ' ms</span>' +
        '<span class="metai"><span class="mlab">Size &nbsp;</span>' + esc(String(e.response.size)) + ' B</span>';
      body.appendChild(meta);
      var rh = e.response.headers;
      if (rh && Object.keys(rh).length > 0) {
        var rhSect = document.createElement('div'); rhSect.className = 'dsect';
        var rhLabel = document.createElement('p'); rhLabel.className = 'dlabel'; rhLabel.textContent = 'Headers';
        rhSect.appendChild(rhLabel);
        Object.keys(rh).forEach(function(k) {
          var kv = document.createElement('div'); kv.className = 'kv';
          kv.innerHTML = '<span class="kvk">' + esc(k) + ':</span><span class="kvv">' + esc(String(rh[k])) + '</span>';
          rhSect.appendChild(kv);
        });
        body.appendChild(rhSect);
      }
      if (e.response.body) {
        var rbSect = document.createElement('div'); rbSect.className = 'dsect';
        var rbLabel = document.createElement('p'); rbLabel.className = 'dlabel'; rbLabel.textContent = 'Body';
        rbSect.appendChild(rbLabel);
        var rbPre = document.createElement('pre'); rbPre.className = 'bp'; rbPre.textContent = fmt(e.response.body);
        rbSect.appendChild(rbPre); body.appendChild(rbSect);
      }
    }
  }
  det.appendChild(body);
  return det;
}

function renderEntry(e) {
  var sel = selId === e.id;
  var d = document.createElement('div');
  d.className = 'row' + (sel ? ' sel' : '');
  d.dataset.id = e.id;
  var inner = document.createElement('div'); inner.className = 'row-inner';
  var mb = document.createElement('span'); mb.className = 'badge ' + mCls(e.method); mb.textContent = e.method;
  inner.appendChild(mb);
  if (e.response) {
    var sb = document.createElement('span');
    sb.className = 'badge ' + sCls(e.response.status, e.response.error);
    sb.textContent = e.response.error ? '!' : String(e.response.status);
    inner.appendChild(sb);
  }
  var urlEl = document.createElement('span'); urlEl.className = 'url';
  urlEl.textContent = e.url; urlEl.title = e.url;
  inner.appendChild(urlEl);
  if (e.response && !e.response.error) {
    var timing = document.createElement('span'); timing.className = 'timing';
    timing.textContent = e.response.responseTime + ' ms';
    inner.appendChild(timing);
  }
  var ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = fmtTime(e.timestamp);
  inner.appendChild(ts);
  var chev = document.createElementNS('http://www.w3.org/2000/svg','svg');
  chev.setAttribute('class','chev'); chev.setAttribute('viewBox','0 0 24 24');
  chev.setAttribute('fill','none'); chev.setAttribute('stroke','currentColor'); chev.setAttribute('stroke-width','2');
  var poly = document.createElementNS('http://www.w3.org/2000/svg','polyline');
  poly.setAttribute('points','6 9 12 15 18 9'); chev.appendChild(poly);
  inner.appendChild(chev);
  d.appendChild(inner);
  if (sel) { d.appendChild(renderDetail(e)); }
  d.addEventListener('click', function(ev) {
    if (ev.target.closest && ev.target.closest('.dtab')) return;
    selId = (selId === e.id) ? null : e.id;
    render();
  });
  return d;
}

function render() {
  var listEl = document.getElementById('list');
  document.getElementById('cnt').textContent = String(logs.length);
  var filtered = filterText
    ? logs.filter(function(e) {
        var q = filterText.toLowerCase();
        return e.url.toLowerCase().indexOf(q) >= 0 || e.method.toLowerCase().indexOf(q) >= 0;
      })
    : logs;
  if (selId && !logs.find(function(l) { return l.id === selId; })) { selId = null; }
  listEl.innerHTML = '';
  if (filtered.length === 0) {
    var empty = document.createElement('div'); empty.className = 'empty';
    empty.textContent = logs.length === 0 ? 'No requests logged yet' : 'No matches for filter';
    listEl.appendChild(empty); return;
  }
  filtered.forEach(function(e) { listEl.appendChild(renderEntry(e)); });
}

document.getElementById('filter').addEventListener('input', function(ev) {
  filterText = ev.target.value; render();
});
document.getElementById('clearBtn').addEventListener('click', function() {
  logs = []; selId = null; dtab = {}; render();
});

var ch = new BroadcastChannel('apilix-console-v1');
ch.onmessage = function(ev) {
  if (ev.data && ev.data.type === 'LOGS_UPDATE') { logs = ev.data.logs; render(); }
};

render();
<\/script>
</body>
</html>`;
}

// ─── ConsolePanel ─────────────────────────────────────────────────────────────

interface ConsolePanelProps {
  height: number;
  onHeightChange: (h: number) => void;
  onClose: () => void;
}

export default function ConsolePanel({ height, onHeightChange, onClose }: ConsolePanelProps) {
  const { state, dispatch } = useApp();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);
  const winRef = useRef<Window | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  const logs = state.consoleLogs;

  // Deselect if cleared
  useEffect(() => {
    if (selectedId && !logs.find(l => l.id === selectedId)) setSelectedId(null);
  }, [logs, selectedId]);

  // Broadcast live updates to the detached window
  useEffect(() => {
    const ch = channelRef.current;
    if (!ch) return;
    if (winRef.current && !winRef.current.closed) {
      ch.postMessage({ type: 'LOGS_UPDATE', logs });
    }
  }, [logs]);

  // Close the broadcast channel on unmount
  useEffect(() => {
    return () => { channelRef.current?.close(); };
  }, []);

  const onHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      startY.current = e.clientY;
      startH.current = height;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [height]
  );

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current) return;
      const delta = startY.current - e.clientY;
      onHeightChange(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startH.current + delta)));
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onHeightChange]);

  function openInNewWindow() {
    // Reuse the window if it's still open
    if (winRef.current && !winRef.current.closed) {
      winRef.current.focus();
      onClose();
      return;
    }
    const win = window.open('', '_blank', 'width=1100,height=700,left=100,top=80');
    if (!win) return;
    winRef.current = win;
    if (!channelRef.current) {
      channelRef.current = new BroadcastChannel(BROADCAST_CHANNEL);
    }
    win.document.open();
    win.document.write(buildHtml(logs));
    win.document.close();
    onClose();
  }

  function toggleEntry(id: string) {
    setSelectedId(prev => (prev === id ? null : id));
  }

  return (
    <div
      className="shrink-0 flex flex-col border-t border-slate-700 bg-slate-950"
      style={{ height }}
    >
      {/* Drag-to-resize handle */}
      <div
        onMouseDown={onHandleMouseDown}
        className="h-1 shrink-0 cursor-row-resize bg-slate-700 hover:bg-orange-500 transition-colors"
        title="Drag to resize"
      />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-700 shrink-0 select-none">
        {/* Icon */}
        <svg
          className="w-3.5 h-3.5 text-slate-400 shrink-0"
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Console</span>
        <span className="text-xs text-slate-600">{logs.length}</span>

        <div className="flex-1" />

        <button
          onClick={() => { dispatch({ type: 'CLEAR_CONSOLE_LOGS' }); }}
          className="text-xs text-slate-500 hover:text-slate-200 px-2 py-0.5 rounded hover:bg-slate-800 transition-colors"
          title="Clear"
        >
          Clear
        </button>

        <button
          onClick={openInNewWindow}
          className="flex items-center gap-1 text-xs text-slate-500 hover:text-orange-400 px-2 py-0.5 rounded hover:bg-slate-800 transition-colors"
          title="Open in new window"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
          <span>New window</span>
        </button>

        <button
          onClick={onClose}
          className="text-slate-500 hover:text-slate-200 text-base leading-none w-5 h-5 flex items-center justify-center rounded hover:bg-slate-800 ml-1 transition-colors"
          title="Close"
        >
          ×
        </button>
      </div>

      {/* Log list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {logs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-slate-700 italic select-none">
            No requests logged yet
          </div>
        ) : (
          logs.map(entry => (
            <div
              key={entry.id}
              onClick={() => toggleEntry(entry.id)}
              className={`cursor-pointer border-b border-slate-800/50 transition-colors select-none ${
                selectedId === entry.id
                  ? 'bg-slate-800 border-l-2 border-l-orange-500'
                  : 'hover:bg-slate-800/70'
              }`}
            >
              {/* Row */}
              <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <span className={`font-mono font-semibold text-[11px] px-1.5 py-0.5 rounded shrink-0 ${methodBadge(entry.method)}`}>
                  {entry.method}
                </span>

                {entry.response && (
                  <span className={`font-mono font-semibold text-[11px] px-1.5 py-0.5 rounded shrink-0 ${statusBadge(entry.response.status)}`}>
                    {entry.response.status}
                  </span>
                )}

                <span className="flex-1 text-slate-300 truncate font-mono min-w-0">
                  {entry.url}
                </span>

                {entry.response && (
                  <span className="text-slate-500 shrink-0 tabular-nums">
                    {entry.response.responseTime} ms
                  </span>
                )}

                <span className="text-slate-700 shrink-0 tabular-nums">
                  {formatTime(entry.timestamp)}
                </span>

                <svg
                  className={`w-3 h-3 shrink-0 transition-transform ${selectedId === entry.id ? 'rotate-180 text-orange-400' : 'text-slate-500'}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>

              {/* Expanded detail */}
              {selectedId === entry.id && <EntryDetail entry={entry} />}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
