import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useApp, generateId } from '../store';
import type { ConsoleEntry } from '../types';
import { maskSecrets } from '../utils/secretMask';

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 600;
const BROADCAST_CHANNEL = 'apilix-console-v1';
const INTEGRATED_DETAIL_MODE_KEY = 'apilix_console_integrated_detail_mode';

// ─── Electron terminal API (stable reference — set once by preload) ───────────

type ElectronTerminalAPI = {
  terminalStart: (opts: { shellPath?: string; cwd?: string }) => Promise<{ sessionId: string; pid: number; cwd: string; shell: string }>;
  terminalInput: (sessionId: string, data: string) => Promise<void>;
  terminalStop: (sessionId: string) => Promise<void>;
  terminalOnData: (cb: (sessionId: string, data: string) => void) => () => void;
  terminalOnExit: (cb: (sessionId: string, exitCode: number | null) => void) => () => void;
};

function getElectronTerminalAPI(): ElectronTerminalAPI | null {
  const api = (window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI;
  if (api && typeof api.terminalStart === 'function') return api as unknown as ElectronTerminalAPI;
  return null;
}

type DetailMode = 'compact' | 'focus';

function loadDetailMode(storageKey: string): DetailMode {
  try {
    const value = localStorage.getItem(storageKey);
    return value === 'focus' ? 'focus' : 'compact';
  } catch {
    return 'compact';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function methodBadge(method: string): string {
  const map: Record<string, string> = {
    GET: 'text-green-400 bg-green-400/15',
    POST: 'text-blue-400 bg-blue-400/15',
    PUT: 'text-yellow-400 bg-yellow-400/15',
    PATCH: 'text-orange-400 bg-orange-400/15',
    DELETE: 'text-red-400 bg-red-400/15',
    HEAD: 'text-purple-400 bg-purple-400/15',
    OPTIONS: 'text-slate-400 bg-slate-400/15',
  };
  return map[method.toUpperCase()] ?? 'text-slate-400 bg-slate-400/15';
}

function statusBadge(status: number): string {
  if (status >= 500) return 'text-red-400 bg-red-400/15';
  if (status >= 400) return 'text-yellow-400 bg-yellow-400/15';
  if (status >= 300) return 'text-sky-400 bg-sky-400/15';
  if (status >= 200) return 'text-green-400 bg-green-400/15';
  return 'text-red-400 bg-red-400/15';
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

function EntryDetail({
  entry,
  mask,
  detailMode,
  onToggleDetailMode,
  detailMaxHeight,
  bodyMaxHeight,
}: {
  entry: ConsoleEntry;
  mask: (v: string) => string;
  detailMode: DetailMode;
  onToggleDetailMode: () => void;
  detailMaxHeight: number;
  bodyMaxHeight: number;
}) {
  const logCount = entry.scriptLogs?.length ?? 0;
  const testResults = entry.response?.testResults ?? [];
  const skippedCount = testResults.filter(t => t.skipped).length;
  const testCount = testResults.length - skippedCount;
  const failCount = testResults.filter(t => t.passed === false).length;
  const [tab, setTab] = useState<'response' | 'request' | 'tests' | 'logs'>('response');

  return (
    <div className="bg-slate-900 border-t-2 border-orange-500/40 text-xs">
      <div className="flex border-b border-slate-800">
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
          onClick={e => { e.stopPropagation(); setTab('tests'); }}
          className={`px-4 py-1.5 transition-colors border-b-2 flex items-center gap-1.5 ${
            tab === 'tests'
              ? 'text-orange-400 border-orange-500'
              : 'text-slate-500 border-transparent hover:text-slate-300'
          }`}
        >
          Tests
          {testCount > 0 && (
            <span className={`text-[10px] font-semibold px-1 rounded ${
              tab === 'tests'
                ? 'bg-orange-500/20 text-orange-300'
                : failCount > 0
                  ? 'bg-red-500/20 text-red-400'
                  : 'bg-green-500/20 text-green-400'
            }`}>
              {failCount > 0 ? `${failCount} fail` : testCount}{skippedCount > 0 ? ` +${skippedCount}` : ''}
            </span>
          )}
        </button>
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

        <div className="ml-auto flex items-center pr-2">
          <button
            onClick={e => {
              e.stopPropagation();
              onToggleDetailMode();
            }}
            className="text-[11px] text-slate-500 hover:text-orange-300 px-2 py-1 rounded hover:bg-slate-800 transition-colors"
            title={detailMode === 'focus' ? 'Use compact detail view' : 'Use focus detail view'}
            aria-label="Toggle focus/compact detail view"
            aria-pressed={detailMode === 'focus'}
          >
            {detailMode === 'focus' ? 'Compact view' : 'Focus view'}
          </button>
        </div>
      </div>

      <div className="p-3 overflow-auto font-mono" style={{ maxHeight: detailMaxHeight }}>
        {tab === 'request' && (
          <div className="space-y-2.5">
            <div>
              <span className="text-slate-500">URL  </span>
              <span className="text-slate-300 break-all">{mask(entry.url)}</span>
            </div>
            {entry.requestHeaders.length > 0 && (
              <div>
                <p className="text-slate-500 mb-1">Headers</p>
                {entry.requestHeaders.map((h, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-slate-500 shrink-0">{h.key}:</span>
                    <span className="text-slate-300 break-all">{mask(h.value)}</span>
                  </div>
                ))}
              </div>
            )}
            {entry.requestBody && (
              <div>
                <p className="text-slate-500 mb-1">Body</p>
                <pre className="bg-slate-800/60 rounded p-2 text-slate-300 whitespace-pre-wrap break-all">
                  {mask(tryFormat(entry.requestBody))}
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
                    <span className="text-slate-300">{entry.response.status} {entry.response.statusText}</span>
                  </span>
                  <span>
                    <span className="text-slate-500">Time  </span>
                    <span className="text-slate-300">{entry.response.responseTime} ms</span>
                  </span>
                  <span>
                    <span className="text-slate-500">Size  </span>
                    <span className="text-slate-300">{entry.response.size} B</span>
                  </span>
                </div>

                {Object.keys(entry.response.headers).length > 0 && (
                  <div>
                    <p className="text-slate-500 mb-1">Headers</p>
                    {Object.entries(entry.response.headers).map(([k, v]) => (
                      <div key={k} className="flex gap-2">
                        <span className="text-slate-500 shrink-0">{k}:</span>
                        <span className="text-slate-300 break-all">{v}</span>
                      </div>
                    ))}
                  </div>
                )}

                {entry.response.body && (
                  <div>
                    <p className="text-slate-500 mb-1">Body</p>
                    <pre
                      className="bg-slate-800/60 rounded p-2 text-slate-300 whitespace-pre-wrap break-all overflow-auto"
                      style={{ maxHeight: bodyMaxHeight }}
                    >
                      {tryFormat(entry.response.body)}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {tab === 'tests' && (
          <div className="space-y-1">
            {testResults.length === 0 ? (
              <p className="text-slate-600 italic">No tests for this request</p>
            ) : (
              testResults.map((t, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className={`shrink-0 font-semibold text-[10px] pt-px w-7 ${
                    t.skipped ? 'text-slate-500' : t.passed ? 'text-green-400' : 'text-red-400'
                  }`}>
                    {t.skipped ? '~' : t.passed ? '✓' : '✗'}
                  </span>
                  <span className={`flex-1 break-all ${t.skipped ? 'text-slate-500 italic' : t.passed ? 'text-slate-300' : 'text-red-300'}`}>
                    {t.name}
                    {t.passed === false && t.error && (
                      <span className="block text-red-500 mt-0.5">{t.error}</span>
                    )}
                  </span>
                </div>
              ))
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
                    {mask(log.args.join(' '))}
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

function buildHtml(logs: ConsoleEntry[], theme: 'dark' | 'light'): string {
  // Escape </script> sequences so they don't break the inline script tag
  const initialData = JSON.stringify(logs).replace(/<\/script>/gi, '<\\/script>');
  const lightClass = theme === 'light' ? ' class="light"' : '';

  return `<!DOCTYPE html>
<html lang="en"${lightClass}>
<head>
<meta charset="UTF-8">
<title>Console — APILIX</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#020617;--bg-hdr:#0f172a;--bg-row-hover:#0f172a;--bg-row-sel:#1e293b;
  --bg-input:#1e293b;--bg-pre:#1e293b;
  --border:#1e293b;--border-row:rgba(30,41,59,.8);--border-input:#334155;
  --text:#cbd5e1;--text-dim:#64748b;--text-dimmer:#334155;--text-title:#94a3b8;
  --text-input:#cbd5e1;--text-ph:#475569;--text-btn-hover:#e2e8f0;
  --scrollbar:#334155;--scrollbar-h:#475569;
  --detail-max-height:min(42vh,320px);
  --detail-body-max-height:min(28vh,220px);
}
html.light{
  --bg:#ffffff;--bg-hdr:#f8fafc;--bg-row-hover:#f8fafc;--bg-row-sel:#f1f5f9;
  --bg-input:#f1f5f9;--bg-pre:#f1f5f9;
  --border:#e2e8f0;--border-row:rgba(226,232,240,.8);--border-input:#cbd5e1;
  --text:#1e293b;--text-dim:#64748b;--text-dimmer:#94a3b8;--text-title:#64748b;
  --text-input:#1e293b;--text-ph:#94a3b8;--text-btn-hover:#1e293b;
  --scrollbar:#cbd5e1;--scrollbar-h:#94a3b8;
}
body.focus-detail{
  --detail-max-height:max(220px,calc(100vh - 210px));
  --detail-body-max-height:max(180px,calc(100vh - 300px));
}
body{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;background:var(--bg);color:var(--text);font-size:12px;display:flex;flex-direction:column;height:100vh;overflow:hidden}
#hdr{display:flex;align-items:center;gap:8px;padding:5px 12px;border-bottom:1px solid var(--border);background:var(--bg-hdr);flex-shrink:0;user-select:none}
#title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-title)}
#cnt{font-size:11px;color:var(--text-dimmer);margin-left:2px}
#filter{flex:1;min-width:0;background:var(--bg-input);border:1px solid var(--border-input);color:var(--text-input);font-family:inherit;font-size:11px;padding:3px 8px;border-radius:4px;outline:none}
#filter:focus{border-color:#f97316}
#filter::placeholder{color:var(--text-ph)}
#clearBtn{background:transparent;border:1px solid var(--border-input);color:var(--text-dim);font-size:11px;padding:3px 10px;border-radius:4px;cursor:pointer;font-family:inherit;flex-shrink:0}
#clearBtn:hover{color:var(--text-btn-hover);border-color:var(--text-dim)}
#focusBtn{background:transparent;border:1px solid var(--border-input);color:var(--text-dim);font-size:11px;padding:3px 10px;border-radius:4px;cursor:pointer;font-family:inherit;flex-shrink:0}
#focusBtn:hover{color:#fdba74;border-color:#f97316}
#list{flex:1;overflow-y:auto;min-height:0}
.empty{display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-dimmer);font-style:italic;font-size:12px;user-select:none}
.row{border-bottom:1px solid var(--border-row);cursor:pointer}
.row:hover .row-inner{background:var(--bg-row-hover)}
.row.sel{border-left:2px solid #f97316}
.row.sel .row-inner{background:var(--bg-row-sel)}
.row-inner{display:flex;align-items:center;gap:6px;padding:5px 12px;user-select:none}
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
.url{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--text);font-family:inherit}
.timing{color:var(--text-dim);flex-shrink:0;font-variant-numeric:tabular-nums}
.ts{color:var(--text-dimmer);flex-shrink:0;font-variant-numeric:tabular-nums}
.chev{width:12px;height:12px;flex-shrink:0;color:var(--text-dim);transition:transform .15s}
.sel .chev{transform:rotate(180deg);color:#f97316}
.detail{background:var(--bg-hdr);border-top:2px solid rgba(249,115,22,.25)}
.dtabs{display:flex;border-bottom:1px solid var(--border)}
.dtab{padding:5px 14px;font-size:11px;cursor:pointer;border:none;border-bottom:2px solid transparent;color:var(--text-dim);background:transparent;font-family:inherit;text-transform:capitalize}
.dtab:hover{color:var(--text)}
.dtab.act{color:#f97316;border-bottom-color:#f97316}
.dbody{padding:10px 12px;overflow:auto;max-height:var(--detail-max-height);font-size:11px;line-height:1.7}
.dlabel{color:var(--text-dim);margin-bottom:4px}
.dsect{margin-bottom:10px}
.kv{display:flex;gap:8px}
.kvk{color:var(--text-dim);flex-shrink:0}
.kvv{color:var(--text);word-break:break-all}
.meta{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:10px}
.metai{color:var(--text)}
.mlab{color:var(--text-dim)}
pre.bp{background:var(--bg-pre);border-radius:4px;padding:8px;color:var(--text);white-space:pre-wrap;word-break:break-all;max-height:var(--detail-body-max-height);overflow:auto;font-family:inherit;font-size:11px;margin:0}
.err-text{color:#f87171}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--scrollbar);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--scrollbar-h)}
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
  <button id="focusBtn">Focus view</button>
  <button id="clearBtn">Clear</button>
</div>
<div id="list"></div>
<script>
var logs = ${initialData};
var selId = null;
var dtab = {};
var filterText = '';
var DETAIL_MODE_STORAGE_KEY = 'apilix_console_windowed_detail_mode';
var detailMode = 'compact';

function loadDetailMode() {
  try {
    var stored = localStorage.getItem(DETAIL_MODE_STORAGE_KEY);
    return stored === 'focus' ? 'focus' : 'compact';
  } catch (e) {
    return 'compact';
  }
}

function saveDetailMode() {
  try {
    localStorage.setItem(DETAIL_MODE_STORAGE_KEY, detailMode);
  } catch (e) {
    // Ignore storage errors in detached window.
  }
}

function applyDetailMode() {
  var btn = document.getElementById('focusBtn');
  if (detailMode === 'focus') {
    document.body.classList.add('focus-detail');
    if (btn) {
      btn.textContent = 'Compact view';
      btn.setAttribute('aria-pressed', 'true');
      btn.setAttribute('aria-label', 'Switch to compact view');
    }
  } else {
    document.body.classList.remove('focus-detail');
    if (btn) {
      btn.textContent = 'Focus view';
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-label', 'Switch to focus view');
    }
  }
}

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
  ['response','request','tests','logs'].forEach(function(t) {
    var btn = document.createElement('button');
    var tr = e.response && e.response.testResults;
    var extra = '';
    if (t === 'tests' && tr && tr.length > 0) {
      var fails = tr.filter(function(r) { return r.passed === false; }).length;
      var skipped = tr.filter(function(r) { return !!r.skipped; }).length;
      var countable = tr.length - skipped;
      extra = ' <span style="font-size:10px;font-weight:700;padding:0 3px;border-radius:3px;' +
        (fails > 0 ? 'color:#f87171;background:rgba(248,113,113,.15)' : 'color:#4ade80;background:rgba(74,222,128,.15)') + '">' +
        (fails > 0 ? fails + ' fail' : countable) + (skipped > 0 ? ' +' + skipped : '') + '</span>';
    }
    if (t === 'logs' && e.scriptLogs && e.scriptLogs.length > 0) {
      extra = ' <span style="font-size:10px;font-weight:700;padding:0 3px;border-radius:3px;background:#1e293b;color:#94a3b8">' + e.scriptLogs.length + '</span>';
    }
    btn.className = 'dtab' + (tab === t ? ' act' : '');
    btn.innerHTML = t.charAt(0).toUpperCase() + t.slice(1) + extra;
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
  } else if (tab === 'tests') {
    var tr = e.response && e.response.testResults;
    if (!tr || tr.length === 0) {
      var noTests = document.createElement('p');
      noTests.style.cssText = 'color:var(--text-dimmer);font-style:italic';
      noTests.textContent = 'No tests for this request';
      body.appendChild(noTests);
    } else {
      tr.forEach(function(t) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin-bottom:4px';
        var icon = document.createElement('span');
        icon.style.cssText = 'flex-shrink:0;font-weight:700;width:14px;' + (t.skipped ? 'color:#64748b' : t.passed ? 'color:#4ade80' : 'color:#f87171');
        icon.textContent = t.skipped ? '~' : t.passed ? '✓' : '✗';
        var label = document.createElement('span');
        label.style.cssText = 'word-break:break-all;' + (t.skipped ? 'color:var(--text-dimmer);font-style:italic' : t.passed ? 'color:var(--text)' : 'color:#fca5a5');
        label.textContent = t.name;
        if (t.passed === false && t.error) {
          var errNote = document.createElement('span');
          errNote.style.cssText = 'display:block;color:#f87171;margin-top:2px;font-size:10px';
          errNote.textContent = t.error;
          label.appendChild(errNote);
        }
        row.appendChild(icon); row.appendChild(label);
        body.appendChild(row);
      });
    }
  } else if (tab === 'logs') {
    var sl = e.scriptLogs;
    if (!sl || sl.length === 0) {
      var noLogs = document.createElement('p');
      noLogs.style.cssText = 'color:var(--text-dimmer);font-style:italic';
      noLogs.textContent = 'No console output for this request';
      body.appendChild(noLogs);
    } else {
      var levelColor = {log:'#cbd5e1',info:'#7dd3fc',warn:'#fde047',error:'#f87171'};
      sl.forEach(function(log) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin-bottom:3px';
        var lvl = document.createElement('span');
        var lc = levelColor[log.level] || '#cbd5e1';
        lvl.style.cssText = 'flex-shrink:0;font-weight:700;text-transform:uppercase;font-size:10px;width:36px;padding-top:1px;color:' + lc;
        lvl.textContent = log.level;
        var msg = document.createElement('span');
        msg.style.cssText = 'word-break:break-all;color:' + lc;
        msg.textContent = log.args.join(' ');
        row.appendChild(lvl); row.appendChild(msg);
        body.appendChild(row);
      });
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
    if (window.getSelection && window.getSelection().toString()) return;
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
document.getElementById('focusBtn').addEventListener('click', function() {
  detailMode = detailMode === 'focus' ? 'compact' : 'focus';
  saveDetailMode();
  applyDetailMode();
});
document.getElementById('clearBtn').addEventListener('click', function() {
  logs = []; selId = null; dtab = {}; render();
  ch.postMessage({ type: 'CLEAR' });
});

var ch = new BroadcastChannel('apilix-console-v1');
ch.onmessage = function(ev) {
  if (ev.data && ev.data.type === 'LOGS_UPDATE') { logs = ev.data.logs; render(); }
  if (ev.data && ev.data.type === 'THEME_CHANGE') {
    if (ev.data.theme === 'light') document.documentElement.classList.add('light');
    else document.documentElement.classList.remove('light');
  }
};

detailMode = loadDetailMode();
applyDetailMode();
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
  theme: 'dark' | 'light';
  /** Active bottom-panel mode: 'console' (default) or 'terminal'. */
  mode: 'console' | 'terminal';
  onModeChange: (m: 'console' | 'terminal') => void;
}

export default function ConsolePanel({ height, onHeightChange, onClose, theme, mode, onModeChange }: ConsolePanelProps) {
  const { state, dispatch, secretSet } = useApp();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState<DetailMode>(() => loadDetailMode(INTEGRATED_DETAIL_MODE_KEY));
  const logs = state.consoleLogs;

  // Terminal state
  const terminalSession = state.terminalSession;
  const [termInput, setTermInput] = useState('');
  const [termStopping, setTermStopping] = useState(false);
  const termOutputRef = useRef<HTMLDivElement | null>(null);
  const termInputRef = useRef<HTMLInputElement | null>(null);
  // Use a ref so data-listener callbacks always see the current sessionId
  // without being torn down and re-registered on every state change (fix for
  // the stale-closure bug that dropped the shell's initial prompt).
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = terminalSession.sessionId;

  const eAPI = getElectronTerminalAPI();
  const isElectron = eAPI !== null;

  // Register terminal data / exit listeners once on mount.
  // Callbacks read sessionIdRef.current so they are never stale.
  useEffect(() => {
    if (!eAPI) return;

    const removeData = eAPI.terminalOnData((sessionId, data) => {
      if (sessionId !== sessionIdRef.current) return;
      // Split into logical lines, strip ANSI escape sequences
      const text = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        // Skip the empty token produced by a trailing newline
        if (i === lines.length - 1 && line === '') return;
        const stripped = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
        dispatch({
          type: 'TERMINAL_APPEND_OUTPUT',
          payload: { id: generateId(), stream: 'stdout', text: stripped, ts: Date.now() },
        });
      });
    });

    const removeExit = eAPI.terminalOnExit((sessionId, exitCode) => {
      if (sessionId !== sessionIdRef.current) return;
      dispatch({ type: 'TERMINAL_SESSION_ENDED', payload: { exitCode } });
      dispatch({
        type: 'TERMINAL_APPEND_OUTPUT',
        payload: { id: generateId(), stream: 'system', text: `Process exited with code ${exitCode ?? '?'}`, ts: Date.now() },
      });
    });

    return () => {
      removeData();
      removeExit();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — eAPI is stable; sessionId read via ref

  // Auto-scroll terminal output to bottom when lines change
  useEffect(() => {
    if (mode === 'terminal' && termOutputRef.current) {
      termOutputRef.current.scrollTop = termOutputRef.current.scrollHeight;
    }
  }, [terminalSession.lines, mode]);

  // Focus input when switching to terminal mode
  useEffect(() => {
    if (mode === 'terminal' && termInputRef.current) {
      termInputRef.current.focus();
    }
  }, [mode]);

  async function handleTerminalStart() {
    if (!eAPI) return;
    try {
      dispatch({ type: 'TERMINAL_CLEAR_OUTPUT' });
      const shellPath = state.settings?.terminalShellPath as string | undefined;
      const result = await eAPI.terminalStart({ shellPath });
      dispatch({ type: 'TERMINAL_SESSION_STARTED', payload: result });
      dispatch({
        type: 'TERMINAL_APPEND_OUTPUT',
        payload: { id: generateId(), stream: 'system', text: `Shell: ${result.shell}  CWD: ${result.cwd}`, ts: Date.now() },
      });
    } catch (err) {
      dispatch({
        type: 'TERMINAL_APPEND_OUTPUT',
        payload: { id: generateId(), stream: 'system', text: `Failed to start terminal: ${(err as Error).message}`, ts: Date.now() },
      });
    }
  }

  async function handleTerminalStop() {
    if (!eAPI || !terminalSession.sessionId || termStopping) return;
    setTermStopping(true);
    try {
      await eAPI.terminalStop(terminalSession.sessionId);
      dispatch({ type: 'TERMINAL_SESSION_ENDED', payload: { exitCode: null } });
      dispatch({
        type: 'TERMINAL_APPEND_OUTPUT',
        payload: { id: generateId(), stream: 'system', text: 'Session stopped.', ts: Date.now() },
      });
    } finally {
      setTermStopping(false);
    }
  }

  function handleTerminalInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!eAPI || !terminalSession.sessionId) return;
      const line = termInput + '\n';
      // Echo the typed command (no PTY so the shell won't echo it back)
      dispatch({
        type: 'TERMINAL_APPEND_OUTPUT',
        payload: { id: generateId(), stream: 'system', text: '$ ' + termInput, ts: Date.now() },
      });
      setTermInput('');
      eAPI.terminalInput(terminalSession.sessionId, line).catch(() => {});
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      if (!eAPI || !terminalSession.sessionId) return;
      eAPI.terminalInput(terminalSession.sessionId, '\x03').catch(() => {});
    }
  }

  const termFontSize = (state.settings?.terminalFontSize as number | undefined) ?? 13;

  const shouldMask = state.settings?.maskSecrets !== false;
  const mask = (v: string) => shouldMask ? maskSecrets(v, secretSet) : v;

  const maskedLogs = useMemo(() => {
    if (!shouldMask || secretSet.size === 0) return logs;
    return logs.map(e => ({
      ...e,
      url: mask(e.url),
      requestHeaders: e.requestHeaders.map(h => ({ ...h, value: mask(h.value) })),
      requestBody: e.requestBody ? mask(e.requestBody) : e.requestBody,
      scriptLogs: e.scriptLogs?.map(l => ({ ...l, args: l.args.map(a => mask(a)) })),
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs, shouldMask, secretSet]);

  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);
  const winRef = useRef<Window | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  // Deselect if cleared
  useEffect(() => {
    if (selectedId && !logs.find(l => l.id === selectedId)) setSelectedId(null);
  }, [logs, selectedId]);

  useEffect(() => {
    try {
      localStorage.setItem(INTEGRATED_DETAIL_MODE_KEY, detailMode);
    } catch {
      // Ignore storage write failures.
    }
  }, [detailMode]);

  // Broadcast live updates to the detached window
  useEffect(() => {
    const ch = channelRef.current;
    if (!ch) return;
    if (winRef.current && !winRef.current.closed) {
      ch.postMessage({ type: 'LOGS_UPDATE', logs: maskedLogs });
    }
  }, [maskedLogs]);

  // Apply theme changes directly to the detached window's DOM
  useEffect(() => {
    if (!winRef.current || winRef.current.closed) return;
    const html = winRef.current.document.documentElement;
    if (theme === 'light') html.classList.add('light');
    else html.classList.remove('light');
  }, [theme]);

  // Listen for CLEAR from detached window
  useEffect(() => {
    const ch = new BroadcastChannel(BROADCAST_CHANNEL);
    const handler = (ev: MessageEvent) => {
      if (ev.data && ev.data.type === 'CLEAR') {
        dispatch({ type: 'CLEAR_CONSOLE_LOGS' });
      }
    };
    ch.addEventListener('message', handler);
    return () => { ch.removeEventListener('message', handler); ch.close(); };
  }, [dispatch]);

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
    win.document.write(buildHtml(maskedLogs, theme));
    win.document.close();
    onClose();
  }

  function toggleEntry(id: string) {
    setSelectedId(prev => (prev === id ? null : id));
  }

  function toggleDetailMode() {
    setDetailMode(prev => (prev === 'focus' ? 'compact' : 'focus'));
  }

  const detailMaxHeight = detailMode === 'focus'
    ? Math.max(220, Math.min(height - 90, 480))
    : Math.max(160, Math.min(Math.floor(height * 0.45), 280));

  const bodyMaxHeight = detailMode === 'focus'
    ? Math.max(180, Math.min(Math.floor(detailMaxHeight * 0.72), detailMaxHeight - 30))
    : Math.max(120, Math.min(Math.floor(detailMaxHeight * 0.55), detailMaxHeight - 30));

  return (
    <div
      className="shrink-0 flex flex-col border-t border-slate-700 bg-slate-950"
      style={{ height }}
    >
      {/* Drag-to-resize handle */}
      <div
        onMouseDown={onHandleMouseDown}
        className="h-0.5 shrink-0 cursor-row-resize bg-slate-700 hover:bg-orange-500 transition-colors"
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

        {/* Mode tabs */}
        <button
          onClick={() => onModeChange('console')}
          className={`text-xs px-2 py-0.5 rounded transition-colors ${mode === 'console' ? 'text-orange-400 bg-orange-900/20' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'}`}
        >
          Console
          {mode === 'console' && <span className="ml-1 text-slate-600">{logs.length}</span>}
        </button>
        <button
          onClick={() => onModeChange('terminal')}
          className={`text-xs px-2 py-0.5 rounded transition-colors ${mode === 'terminal' ? 'text-orange-400 bg-orange-900/20' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'}`}
        >
          Terminal
          {mode === 'terminal' && terminalSession.connected && (
            <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
          )}
        </button>

        <div className="flex-1" />

        {mode === 'console' && (
          <>
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
          </>
        )}

        {mode === 'terminal' && (
          <>
            {terminalSession.connected ? (
              <button
                onClick={handleTerminalStop}
                disabled={termStopping}
                className="text-xs text-red-400 hover:text-red-300 px-2 py-0.5 rounded hover:bg-slate-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                title="Stop terminal session"
              >
                {termStopping ? 'Stopping…' : 'Stop'}
              </button>
            ) : (
              <button
                onClick={handleTerminalStart}
                disabled={!isElectron}
                className="text-xs text-green-400 hover:text-green-300 px-2 py-0.5 rounded hover:bg-slate-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                title={isElectron ? 'Start terminal session' : 'Terminal only available in the desktop app'}
              >
                Start
              </button>
            )}
            <button
              onClick={() => dispatch({ type: 'TERMINAL_CLEAR_OUTPUT' })}
              className="text-xs text-slate-500 hover:text-slate-200 px-2 py-0.5 rounded hover:bg-slate-800 transition-colors"
              title="Clear output"
            >
              Clear
            </button>
          </>
        )}

        <button
          onClick={onClose}
          className="text-slate-500 hover:text-slate-200 text-base leading-none w-5 h-5 flex items-center justify-center rounded hover:bg-slate-800 ml-1 transition-colors"
          title="Close"
        >
          ×
        </button>
      </div>

      {/* Terminal pane */}
      {mode === 'terminal' && (
        <div className="flex-1 flex flex-col min-h-0 bg-slate-950">
          {!isElectron ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center px-6 py-8 max-w-sm">
                <svg className="w-8 h-8 text-slate-600 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
                <p className="text-sm font-medium text-slate-400 mb-1">Terminal not available</p>
                <p className="text-xs text-slate-600">The integrated terminal is only available in the Apilix desktop app.</p>
              </div>
            </div>
          ) : (
            <>
              {/* Output */}
              <div
                ref={termOutputRef}
                className="flex-1 overflow-y-auto min-h-0 px-3 py-2 font-mono"
                style={{ fontSize: termFontSize }}
              >
                {terminalSession.lines.length === 0 && !terminalSession.connected && (
                  <span className="text-slate-700 italic text-xs">Press Start to open a terminal session.</span>
                )}
                {terminalSession.lines.map(line => (
                  <div
                    key={line.id}
                    className={
                      line.stream === 'stderr'
                        ? 'text-red-400 whitespace-pre-wrap break-all'
                        : line.stream === 'system'
                        ? 'text-slate-500 italic whitespace-pre-wrap break-all'
                        : 'text-slate-200 whitespace-pre-wrap break-all'
                    }
                  >
                    {line.text}
                  </div>
                ))}
              </div>

              {/* Input bar */}
              <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-t border-slate-800">
                <span className="text-slate-600 font-mono text-xs select-none">
                  {terminalSession.cwd ? terminalSession.cwd.replace(/^.*\/([^/]+)$/, '$1') : '$'}
                </span>
                <input
                  ref={termInputRef}
                  type="text"
                  value={termInput}
                  onChange={e => setTermInput(e.target.value)}
                  onKeyDown={handleTerminalInputKeyDown}
                  disabled={!terminalSession.connected}
                  placeholder={terminalSession.connected ? 'Type a command… (Enter to run, Ctrl+C to interrupt)' : 'Start a session to type commands'}
                  className="flex-1 bg-transparent border-none outline-none font-mono text-slate-200 placeholder:text-slate-700 disabled:opacity-40"
                  style={{ fontSize: termFontSize }}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                />
              </div>
            </>
          )}
        </div>
      )}

      {/* Log list */}
      {mode === 'console' && (
      <div className="flex-1 overflow-y-auto min-h-0">
        {logs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-slate-700 italic select-none">
            No requests logged yet
          </div>
        ) : (
          logs.map(entry => (
            <div
              key={entry.id}
              onClick={() => {
                if (window.getSelection()?.toString()) return;
                toggleEntry(entry.id);
              }}
              className={`cursor-pointer border-b border-slate-800/80 transition-colors ${
                selectedId === entry.id
                  ? 'bg-slate-800 border-l-2 border-l-orange-500'
                  : 'hover:bg-slate-900'
              }`}
            >
              {/* Row */}
              <div className="flex items-center gap-2 px-3 py-1.5 text-xs select-none">
                <span className={`font-mono font-semibold text-[11px] px-1.5 py-0.5 rounded shrink-0 ${methodBadge(entry.method)}`}>
                  {entry.method}
                </span>

                {entry.response && (
                  <span className={`font-mono font-semibold text-[11px] px-1.5 py-0.5 rounded shrink-0 ${statusBadge(entry.response.status)}`}>
                    {entry.response.status}
                  </span>
                )}

                <span className={`flex-1 truncate font-mono min-w-0 ${selectedId === entry.id ? 'text-slate-200' : 'text-slate-300'}`}>
                  {mask(entry.url)}
                </span>

                {entry.response && (
                  <span className="shrink-0 tabular-nums text-slate-500">
                    {entry.response.responseTime} ms
                  </span>
                )}

                <span className="shrink-0 tabular-nums text-slate-600">
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
              {selectedId === entry.id && (
                <EntryDetail
                  entry={entry}
                  mask={mask}
                  detailMode={detailMode}
                  onToggleDetailMode={toggleDetailMode}
                  detailMaxHeight={detailMaxHeight}
                  bodyMaxHeight={bodyMaxHeight}
                />
              )}
            </div>
          ))
        )}
      </div>
      )}
    </div>
  );
}
