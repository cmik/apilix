import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useApp } from '../store';
import type { HistoryRequest } from '../types';
import { formatDayLabel, groupByDay } from '../utils/historyUtils';
import { maskSecrets } from '../utils/secretMask';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const METHOD_COLORS: Record<string, string> = {
  GET:     'text-green-400 bg-green-400/15',
  POST:    'text-blue-400 bg-blue-400/15',
  PUT:     'text-yellow-400 bg-yellow-400/15',
  PATCH:   'text-orange-400 bg-orange-400/15',
  DELETE:  'text-red-400 bg-red-400/15',
  HEAD:    'text-purple-400 bg-purple-400/15',
  OPTIONS: 'text-sky-400 bg-sky-400/15',
};

function methodBadge(method: string) {
  const cls = METHOD_COLORS[method.toUpperCase()] ?? 'text-slate-400 bg-slate-400/15';
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${cls}`}>
      {method.toUpperCase()}
    </span>
  );
}

function statusBadgeClass(code: number | null, hasError: boolean): string {
  if (hasError && !code) return 'text-red-400 bg-red-400/15';
  if (code === null) return 'text-slate-500 bg-slate-700';
  if (code < 300) return 'text-green-400 bg-green-400/15';
  if (code < 400) return 'text-sky-400 bg-sky-400/15';
  if (code < 500) return 'text-yellow-400 bg-yellow-400/15';
  return 'text-red-400 bg-red-400/15';
}

// ─── HistoryPanel ─────────────────────────────────────────────────────────────

export default function HistoryPanel() {
  const { state, dispatch, secretSet } = useApp();
  const shouldMask = state.settings?.maskSecrets !== false;
  const mask = (v: string) => shouldMask ? maskSecrets(v, secretSet) : v;

  const [search, setSearch] = useState('');
  const [methodFilter, setMethodFilter] = useState('ALL');
  const [confirmClear, setConfirmClear] = useState(false);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
  }, []);

  const methods = useMemo(() => {
    const s = new Set(state.requestHistory.map((h: HistoryRequest) => h.method.toUpperCase()));
    return ['ALL', ...Array.from(s).sort()];
  }, [state.requestHistory]);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = state.requestHistory.filter((h: HistoryRequest) => {
      if (methodFilter !== 'ALL' && h.method.toUpperCase() !== methodFilter) return false;
      if (q && !h.url.toLowerCase().includes(q)) return false;
      return true;
    });
    return groupByDay(filtered);
  }, [state.requestHistory, search, methodFilter]);

  const totalFiltered = grouped.reduce((sum, g) => sum + g.entries.length, 0);

  function reopenRequest(entry: HistoryRequest) {
    dispatch({
      type: 'OPEN_HISTORY_SNAPSHOT',
      payload: { collectionId: entry.collectionId, item: { ...entry.requestSnapshot } },
    });
  }

  function handleClear() {
    if (!confirmClear) {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      setConfirmClear(true);
      clearTimerRef.current = setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    dispatch({ type: 'CLEAR_REQUEST_HISTORY' });
    setConfirmClear(false);
  }

  return (
    <div className="flex flex-col h-full bg-slate-900 text-slate-200">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-slate-700 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-orange-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="font-semibold text-slate-100 text-sm">History</span>
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded text-slate-400 bg-slate-700">
            {state.requestHistory.length}
          </span>
        </div>
        <button
          onClick={handleClear}
          disabled={state.requestHistory.length === 0}
          className={`text-xs px-2 py-1 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
            confirmClear
              ? 'bg-red-700 hover:bg-red-600 text-white font-medium'
              : 'text-slate-500 hover:text-red-400 hover:bg-slate-800'
          }`}
        >
          {confirmClear ? 'Confirm clear' : 'Clear'}
        </button>
      </div>

      {/* Filters */}
      <div className="px-3 py-2 border-b border-slate-700 flex items-center gap-2 shrink-0">
        <div className="relative flex-1">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 text-xs pointer-events-none">🔍</span>
          <input
            type="text"
            placeholder="Search URL…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full bg-slate-800 border border-slate-600 rounded pl-6 pr-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-orange-500"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-sm leading-none"
            >×</button>
          )}
        </div>
        <select
          value={methodFilter}
          onChange={e => setMethodFilter(e.target.value)}
          className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-orange-500"
        >
          {methods.map((m: string) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {totalFiltered === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-slate-500 select-none">
            <svg className="w-10 h-10 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm">
              {state.requestHistory.length === 0 ? 'No requests sent yet' : 'No results match filters'}
            </span>
          </div>
        ) : (
          grouped.map((group, groupIndex) => (
            <React.Fragment key={`${group.label}-${groupIndex}`}>
              {/* Day group header */}
              <div className="sticky top-0 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500 bg-slate-800/90 border-b border-slate-700/60 select-none z-10">
                {group.label}
              </div>
              {group.entries.map((entry: HistoryRequest) => (
                <div
                  key={entry.id}
                  onClick={() => reopenRequest(entry)}
                  className="px-3 py-2.5 border-b border-slate-800/60 cursor-pointer hover:bg-slate-800/50 transition-colors"
                >
                  {/* Row 1: method + status + time */}
                  <div className="flex items-center gap-1.5 mb-1">
                    {methodBadge(entry.method)}
                    {entry.statusCode !== null ? (
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${statusBadgeClass(entry.statusCode, !!entry.error)}`}>
                        {entry.statusCode}
                      </span>
                    ) : entry.error ? (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 text-red-400 bg-red-400/15">!</span>
                    ) : null}
                    <span className="ml-auto text-[10px] text-slate-500 tabular-nums shrink-0">
                      {entry.responseTime > 0 ? `${entry.responseTime} ms` : ''}
                    </span>
                  </div>
                  {/* Row 2: full URL */}
                  <p className="font-mono text-xs text-slate-300 break-all leading-snug">
                    {mask(entry.url)}
                  </p>
                  {/* Row 3: time + error */}
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] text-slate-600 tabular-nums shrink-0">
                      {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                    {entry.error && (
                      <span className="text-[10px] text-red-400 truncate" title={entry.error}>{entry.error}</span>
                    )}
                  </div>
                </div>
              ))}
            </React.Fragment>
          ))
        )}
      </div>
    </div>
  );
}
