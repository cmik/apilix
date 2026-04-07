import { useState, useRef, useEffect, useMemo } from 'react';
import { useApp } from '../store';
import { runCollectionStream, pauseRun, resumeRun, stopRun } from '../api';
import type { RunnerIteration, RunnerIterationResult, CollectionItem } from '../types';
import { applyInheritedAuth, getAllRequestIds } from '../utils/treeHelpers';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract all literal setNextRequest('name') targets from a request's scripts. */
function extractSetNextRequestTargets(item: CollectionItem): string[] {
  const targets: string[] = [];
  for (const ev of item.event ?? []) {
    const exec = ev.script?.exec;
    const code = Array.isArray(exec) ? exec.join('\n') : (exec ?? '');
    for (const m of code.matchAll(/setNextRequest\(\s*['"](.*?)['"]\s*\)/g)) {
      if (m[1]) targets.push(m[1]);
    }
  }
  return [...new Set(targets)];
}

export interface ChainEntry { item: CollectionItem; autoAdded: boolean; }

/**
 * Two-level execution model:
 *   Primary  — each entry in `startIds` (user-selected execution order)
 *   Secondary — for each primary start, follow setNextRequest() chains until
 *               no target is found or a cycle within this chain is detected.
 *
 * No deduplication across chains: if T2 is selected and also reachable from T1,
 * it runs twice — once as part of T1's chain, once as its own chain.
 */
function resolveConditionalChain(
  startIds: string[],
  itemMap: Map<string, CollectionItem>,
  allByName: Map<string, CollectionItem>,
): ChainEntry[][] {
  return startIds
    .map(startId => {
      const chain: ChainEntry[] = [];
      const visitedInChain = new Set<string>();
      let currentId: string | null = startId;
      let autoAdded = false;
      while (currentId !== null) {
        if (visitedInChain.has(currentId)) break; // cycle within this chain
        const item = itemMap.get(currentId);
        if (!item) break;
        visitedInChain.add(currentId);
        chain.push({ item, autoAdded });
        const targets = extractSetNextRequestTargets(item);
        if (targets.length === 0) break;
        const nextItem = allByName.get(targets[0]);
        currentId = nextItem?.id ?? null;
        autoAdded = true;
      }
      return chain;
    })
    .filter(chain => chain.length > 0);
}

/** Flatten all request items into an id → item map */
function flattenRequestItems(items: CollectionItem[]): Map<string, CollectionItem> {
  const map = new Map<string, CollectionItem>();
  for (const item of items) {
    if (item.item) {
      for (const [k, v] of flattenRequestItems(item.item)) map.set(k, v);
    } else if (item.request && item.id) {
      map.set(item.id, item);
    }
  }
  return map;
}

// ─── Request Selection Tree ───────────────────────────────────────────────────

const METHOD_COLORS: Record<string, string> = {
  GET: 'text-green-400',
  POST: 'text-blue-400',
  PUT: 'text-yellow-400',
  PATCH: 'text-orange-400',
  DELETE: 'text-red-400',
  HEAD: 'text-purple-400',
  OPTIONS: 'text-slate-400',
};

interface SelectionNodeProps {
  item: CollectionItem;
  depth: number;
  selectedIds: Set<string>;
  onToggleRequest: (id: string) => void;
  onToggleFolder: (ids: string[], checked: boolean) => void;
}

function SelectionNode({ item, depth, selectedIds, onToggleRequest, onToggleFolder }: SelectionNodeProps) {
  const [open, setOpen] = useState(true);
  const isFolder = Array.isArray(item.item);
  const indentPx = depth * 16 + 4;

  if (isFolder) {
    const childIds = getAllRequestIds(item.item || []);
    const selectedCount = childIds.filter(id => selectedIds.has(id)).length;
    const allSelected = childIds.length > 0 && selectedCount === childIds.length;
    const someSelected = selectedCount > 0 && !allSelected;
    return (
      <div>
        <div
          className="flex items-center gap-2 py-1 hover:bg-slate-600/30 rounded cursor-pointer"
          style={{ paddingLeft: indentPx }}
        >
          <input
            type="checkbox"
            checked={allSelected}
            ref={el => { if (el) el.indeterminate = someSelected; }}
            onChange={e => onToggleFolder(childIds, e.target.checked)}
            onClick={e => e.stopPropagation()}
            className="accent-orange-500 shrink-0 cursor-pointer"
          />
          <button
            onClick={() => setOpen(o => !o)}
            className="flex items-center gap-1.5 flex-1 min-w-0 text-sm text-slate-300"
          >
            <span className="text-xs text-slate-500 shrink-0">{open ? '▾' : '▸'}</span>
            <span className="shrink-0">📁</span>
            <span className="truncate">{item.name}</span>
            {childIds.length > 0 && (
              <span className="text-xs text-slate-500 ml-1 shrink-0">({selectedCount}/{childIds.length})</span>
            )}
          </button>
        </div>
        {open && (item.item || []).map((child, i) => (
          <SelectionNode
            key={child.id || i}
            item={child}
            depth={depth + 1}
            selectedIds={selectedIds}
            onToggleRequest={onToggleRequest}
            onToggleFolder={onToggleFolder}
          />
        ))}
      </div>
    );
  }

  const method = item.request?.method ?? 'GET';
  const methodColor = METHOD_COLORS[method] ?? 'text-slate-400';
  const usesChildRequests = (item.event ?? []).some(ev => {
    const exec = ev.script?.exec;
    const code = Array.isArray(exec) ? exec.join('\n') : (exec ?? '');
    return code.includes('apx.executeRequest(');
  });
  const usesSetNextRequest = (item.event ?? []).some(ev => {
    const exec = ev.script?.exec;
    const code = Array.isArray(exec) ? exec.join('\n') : (exec ?? '');
    return code.includes('setNextRequest(');
  });
  return (
    <div
      className="flex items-center gap-2 py-1 hover:bg-slate-600/30 rounded cursor-pointer"
      style={{ paddingLeft: indentPx }}
      onClick={() => item.id && onToggleRequest(item.id)}
    >
      <input
        type="checkbox"
        checked={!!item.id && selectedIds.has(item.id)}
        onChange={() => item.id && onToggleRequest(item.id)}
        onClick={e => e.stopPropagation()}
        className="accent-orange-500 shrink-0 cursor-pointer"
      />
      <span className={`text-xs font-bold w-14 shrink-0 ${methodColor}`}>{method}</span>
      <span className="text-sm text-slate-300 truncate">{item.name}</span>
      <span className="ml-auto flex items-center gap-1 shrink-0">
        {usesChildRequests && (
          <span title="This request executes child requests via apx.executeRequest()" className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-violet-800/60 text-violet-300 border border-violet-600/50">child</span>
        )}
        {usesSetNextRequest && (
          <span title="This request controls flow via setNextRequest()" className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-800/60 text-amber-300 border border-amber-600/50">next</span>
        )}
      </span>
    </div>
  );
}

// ─── Status helper ────────────────────────────────────────────────────────────

function statusColor(status: number): string {
  if (status >= 500) return 'text-red-400';
  if (status >= 400) return 'text-yellow-400';
  if (status >= 300) return 'text-blue-400';
  if (status >= 200) return 'text-green-400';
  return 'text-slate-400';
}

type ChildEntry = { tag: 'pre' | 'test'; name: string; method: string; result: { status: number; statusText: string; responseTime: number; error: string | null; testResults?: Array<{ passed: boolean; name: string; error?: string | null }> } };

function ChildRow({ child, isLast }: { child: ChildEntry; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const tests = child.result.testResults ?? [];
  const passed = tests.filter(t => t.passed).length;
  const hasFailed = tests.some(t => !t.passed);

  return (
    <div className="relative">
      {/* Tree connector: vertical line at left, horizontal branch going right to content */}
      <div className="absolute left-0 top-0 bottom-0 w-8">
        <div className={`absolute left-1 top-0 w-px bg-slate-600/50 ${isLast ? 'h-1/2' : 'h-full'}`} />
        <div className="absolute top-1/2 left-1 right-0 h-px bg-slate-600/50" style={{ transform: 'translateY(-50%)' }} />
      </div>
      <div
        className={`ml-8 flex items-center gap-3 px-3 py-1.5 text-xs cursor-pointer hover:bg-slate-700/20 transition-colors ${
          child.result.error ? 'bg-red-900/5' : ''
        }`}
        onClick={() => tests.length > 0 && setExpanded(e => !e)}
      >
        <span className={`font-bold w-14 shrink-0 ${statusColor(child.result.status)}`}>
          {child.result.error ? 'ERR' : child.result.status}
        </span>
        <span className="font-medium text-slate-500 w-14 shrink-0">{child.method}</span>
        <span className="flex-1 text-slate-400 truncate">{child.name}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
          child.tag === 'pre' ? 'bg-blue-900/50 text-blue-400' : 'bg-purple-900/50 text-purple-400'
        }`}>{child.tag}</span>
        <span className="text-slate-600 text-xs w-16 text-right shrink-0">{child.result.responseTime} ms</span>
        {tests.length > 0 && (
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${
            hasFailed ? 'bg-red-800/60 text-red-300' : 'bg-green-800/60 text-green-300'
          }`}>
            {passed}/{tests.length}
          </span>
        )}
        {tests.length > 0 && (
          <span className="text-slate-600 text-xs ml-1">{expanded ? '▴' : '▾'}</span>
        )}
      </div>
      {expanded && (
        <div className="ml-8 px-3 pb-2 flex flex-col gap-1 bg-slate-800/20">
          {tests.map((t, i) => (
            <div key={i} className="flex items-start gap-2 text-xs py-0.5">
              <span className={t.passed ? 'text-green-400' : 'text-red-400'}>{t.passed ? '✓' : '✗'}</span>
              <span className={t.passed ? 'text-slate-300' : 'text-red-300'}>{t.name}</span>
              {!t.passed && t.error && <span className="text-red-500 font-mono ml-2">{t.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ResultRow({ result }: { result: RunnerIterationResult }) {
  const [expanded, setExpanded] = useState(false);
  const passed = result.testResults.filter(t => t.passed).length;
  const total = result.testResults.length;
  const hasFailed = result.testResults.some(t => !t.passed);

  const children: ChildEntry[] = [
    ...(result.preChildRequests ?? []).map(c => ({ tag: 'pre' as const, name: c.name, method: c.method, result: c.result })),
    ...(result.testChildRequests ?? []).map(c => ({ tag: 'test' as const, name: c.name, method: c.method, result: c.result })),
  ];
  const hasChildren = children.length > 0;

  return (
    <div className="border-b border-slate-700">
      <div
        className={`flex items-center gap-3 px-4 py-2 text-sm cursor-pointer hover:bg-slate-700/30 transition-colors ${
          result.error ? 'bg-red-900/10' : ''
        }`}
        onClick={() => (total > 0 || hasChildren) && setExpanded(e => !e)}
      >
        <span className={`font-bold w-16 shrink-0 ${statusColor(result.status)}`}>
          {result.error ? 'ERR' : result.status}
        </span>
        <span className="font-medium text-slate-400 w-16 shrink-0">{result.method}</span>
        <span className="flex-1 text-slate-300 truncate font-medium">{result.name}</span>
        {hasChildren && (
          <span className="text-xs text-slate-500 shrink-0">{children.length} child{children.length !== 1 ? 'ren' : ''}</span>
        )}
        <span className="text-slate-500 text-xs w-20 text-right shrink-0">{result.responseTime} ms</span>
        {total > 0 && (
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${
            hasFailed ? 'bg-red-800/60 text-red-300' : 'bg-green-800/60 text-green-300'
          }`}>
            {passed}/{total}
          </span>
        )}
        {(total > 0 || hasChildren) && (
          <span className="text-slate-600 text-xs ml-1">{expanded ? '▴' : '▾'}</span>
        )}
      </div>
      {expanded && (
        <>
          {/* Test results for the parent */}
          {total > 0 && (
            <div className="px-4 pb-2 flex flex-col gap-1 bg-slate-800/30">
              {result.testResults.map((t, i) => (
                <div key={i} className="flex items-start gap-2 text-xs py-0.5">
                  <span className={t.passed ? 'text-green-400' : 'text-red-400'}>
                    {t.passed ? '✓' : '✗'}
                  </span>
                  <span className={t.passed ? 'text-slate-300' : 'text-red-300'}>{t.name}</span>
                  {!t.passed && t.error && (
                    <span className="text-red-500 font-mono ml-2">{t.error}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {/* Child requests with tree connector */}
          {hasChildren && (
            <div className="relative pl-4 pb-1 bg-slate-900/20">
              {children.map((child, i) => (
                <ChildRow key={i} child={child} isLast={i === children.length - 1} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function IterationBlock({ iter }: { iter: RunnerIteration }) {
  const [open, setOpen] = useState(true);
  const allChildren = iter.results.flatMap(r => [
    ...(r.preChildRequests ?? []),
    ...(r.testChildRequests ?? []),
  ]);
  const passed = iter.results.reduce((acc, r) => acc + r.testResults.filter(t => t.passed).length, 0)
    + allChildren.reduce((acc, c) => acc + (c.result.testResults ?? []).filter(t => t.passed).length, 0);
  const total = iter.results.reduce((acc, r) => acc + r.testResults.length, 0)
    + allChildren.reduce((acc, c) => acc + (c.result.testResults ?? []).length, 0);
  const errors = iter.results.filter(r => r.error).length
    + allChildren.filter(c => c.result.error).length;
  const totalRequestCount = iter.results.length + allChildren.length;

  return (
    <div className="shrink-0 mb-2 border border-slate-700 rounded">
      <button
        className="flex items-center gap-3 px-4 py-2 w-full text-left bg-slate-800 hover:bg-slate-750 transition-colors rounded-t"
        onClick={() => setOpen(o => !o)}
      >
        <span className="text-slate-200 font-medium text-sm">Iteration #{iter.iteration}</span>
        {Object.keys(iter.dataRow).length > 0 && (
          <span className="text-xs text-slate-500">
            {Object.entries(iter.dataRow).map(([k, v]) => `${k}=${v}`).join(' | ')}
          </span>
        )}
        <span className={`ml-auto text-xs font-medium px-2 py-0.5 rounded ${
          errors > 0 ? 'text-red-300 bg-red-800/60' :
          total > 0 ? (passed === total ? 'text-green-300 bg-green-800/60' : 'text-yellow-300 bg-yellow-800/60') :
          'text-slate-400'
        }`}>
          {errors > 0 ? `${errors} error(s)` : total > 0 ? `${passed}/${total} tests` : `${totalRequestCount} request${totalRequestCount !== 1 ? 's' : ''}`}
        </span>
        <span className="text-slate-600 text-xs ml-2">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="bg-slate-900/30">
          {iter.results.map((r, i) => {
            const jump = (iter.jumps ?? []).find(j => j.afterName === r.name);
            return (
              <div key={i}>
                <ResultRow result={r} />
                {jump && (
                  <div className="flex items-center gap-2 px-4 py-1 bg-violet-900/20 border-y border-violet-700/30 text-xs text-violet-400 select-none">
                    <span>↪</span>
                    <span className="font-mono">setNextRequest</span>
                    <span className="text-violet-600">→</span>
                    <span className="font-medium text-violet-300">{jump.to}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Performance Metrics ─────────────────────────────────────────────────────

interface PerfDataPoint {
  name: string;
  method: string;
  time: number;
  isChild?: boolean;
}

interface PerfMetrics {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  totalRequests: number;
  dataPoints: PerfDataPoint[];
}

function computePerformanceMetrics(results: RunnerIteration[]): PerfMetrics | null {
  const dataPoints: PerfDataPoint[] = [];
  for (const iter of results) {
    for (const r of iter.results) {
      if (!r.error) {
        dataPoints.push({ name: r.name, method: r.method, time: r.responseTime });
      }
      for (const c of [...(r.preChildRequests ?? []), ...(r.testChildRequests ?? [])]) {
        if (!c.result.error) {
          dataPoints.push({ name: c.name, method: c.method, time: c.result.responseTime, isChild: true });
        }
      }
    }
  }
  if (dataPoints.length === 0) return null;

  const times = [...dataPoints.map(d => d.time)].sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  const percentile = (p: number) => {
    const idx = Math.ceil((p / 100) * times.length) - 1;
    return times[Math.max(0, idx)];
  };

  return {
    min: times[0],
    max: times[times.length - 1],
    avg: Math.round(sum / times.length),
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    totalRequests: dataPoints.length,
    dataPoints,
  };
}

function barColor(time: number): string {
  if (time < 200) return '#4ade80';
  if (time < 800) return '#fb923c';
  return '#f87171';
}

function childBarColor(time: number): string {
  if (time < 200) return '#67e8f9';
  if (time < 800) return '#a78bfa';
  return '#f472b6';
}

function ResponseTimeChart({ dataPoints, max }: { dataPoints: PerfDataPoint[]; max: number }) {
  const chartHeight = 100;
  const barWidth = Math.max(6, Math.min(28, Math.floor(560 / Math.max(dataPoints.length, 1)) - 2));
  const gap = 2;
  const svgWidth = Math.max(dataPoints.length * (barWidth + gap), 400);

  return (
    <div>
      <div className="flex items-center gap-4 mb-2 text-xs text-slate-400">
        <span className="text-slate-500">Parent:</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-[#4ade80]"></span>&lt;200ms</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-[#fb923c]"></span>200–800ms</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-[#f87171]"></span>&gt;800ms</span>
        <span className="border-l border-slate-600 pl-4 text-slate-500">Child:</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-[#67e8f9]"></span>&lt;200ms</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-[#a78bfa]"></span>200–800ms</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-[#f472b6]"></span>&gt;800ms</span>
      </div>
      <div className="overflow-x-auto">
      <svg height={chartHeight + 4} width={svgWidth} className="block">
        <line x1={0} y1={chartHeight} x2={svgWidth} y2={chartHeight} stroke="#475569" strokeWidth={1} />
        {dataPoints.map((d, i) => {
          const barH = max > 0 ? Math.max(2, Math.round((d.time / max) * chartHeight)) : 2;
          const x = i * (barWidth + gap);
          const y = chartHeight - barH;
          return (
            <g key={i}>
              <rect x={x} y={y} width={barWidth} height={barH} fill={d.isChild ? childBarColor(d.time) : barColor(d.time)} rx={2} opacity={0.85}>
                <title>{d.name} ({d.method}){d.isChild ? ' [child]' : ''}: {d.time}ms</title>
              </rect>
            </g>
          );
        })}
      </svg>
      </div>
    </div>
  );
}

function PerformanceMetricsPanel({ results }: { results: RunnerIteration[] }) {
  const [open, setOpen] = useState(true);
  const metrics = computePerformanceMetrics(results);
  if (!metrics) return null;

  const statCards = [
    { label: 'Min', value: metrics.min, color: 'text-green-400' },
    { label: 'Avg', value: metrics.avg, color: 'text-slate-200' },
    { label: 'Max', value: metrics.max, color: 'text-red-400' },
    { label: 'P50', value: metrics.p50, color: 'text-blue-400' },
    { label: 'P95', value: metrics.p95, color: 'text-yellow-400' },
    { label: 'P99', value: metrics.p99, color: 'text-orange-400' },
  ];

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg shrink-0">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 w-full px-4 py-3 text-left hover:bg-slate-700/40 transition-colors rounded-lg"
      >
        <span className="text-sm font-semibold text-slate-200 flex-1">⚡ Performance Metrics</span>
        {!open && (
          <span className="text-xs text-slate-500 font-mono">
            avg {metrics.avg}ms · min {metrics.min}ms · max {metrics.max}ms
          </span>
        )}
        <span className="text-slate-500 text-xs ml-2">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {statCards.map(s => (
              <div key={s.label} className="bg-slate-700/50 rounded p-2.5 text-center">
                <div className={`text-lg font-bold font-mono ${s.color}`}>
                  {s.value}
                  <span className="text-xs font-normal text-slate-500 ml-0.5">ms</span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between flex-wrap gap-1">
              <span className="text-xs text-slate-500">
                Response times · {metrics.totalRequests} request{metrics.totalRequests !== 1 ? 's' : ''}
              </span>
              <div className="flex items-center gap-3 text-xs text-slate-400">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm inline-block" style={{ background: '#4ade80' }} />
                  {'< 200ms'}
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm inline-block" style={{ background: '#fb923c' }} />
                  200–800ms
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm inline-block" style={{ background: '#f87171' }} />
                  {'> 800ms'}
                </span>
              </div>
            </div>
            <div className="bg-slate-900/40 rounded border border-slate-700 p-2">
              <ResponseTimeChart dataPoints={metrics.dataPoints} max={metrics.max} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CSV preview helper ──────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { field += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(field.trim()); field = '';
    } else {
      field += ch;
    }
  }
  result.push(field.trim());
  return result;
}

export default function RunnerPanel() {
  const { state, dispatch, getEnvironmentVars, getCollectionVars } = useApp();
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>('');
  const [selectedRequestIds, setSelectedRequestIds] = useState<Set<string>>(new Set());
  const [executionOrder, setExecutionOrder] = useState<string[]>([]);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvPreviewRows, setCsvPreviewRows] = useState<string[][]>([]);
  const [csvRowCount, setCsvRowCount] = useState(0);
  const [delay, setDelay] = useState(0);
  const [iterations, setIterations] = useState(1);
  const [executeChildRequests, setExecuteChildRequests] = useState(false);
  const [conditionalExecution, setConditionalExecution] = useState(true);
  const [results, setResults] = useState<RunnerIteration[] | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(true);
  const [useMockServer, setUseMockServer] = useState(false);
  const csvRef = useRef<HTMLInputElement>(null);
  const dragItemRef = useRef<number | null>(null);
  const dragOverRef = useRef<number | null>(null);

  const selectedCollection = state.collections.find(c => c._id === selectedCollectionId);

  // When conditional execution is on, resolve one chain per selected request
  // (primary order) by following setNextRequest() targets (secondary chains).
  const conditionalChains = useMemo<ChainEntry[][] | null>(() => {
    if (!conditionalExecution || !selectedCollection) return null;
    const flat = flattenRequestItems(selectedCollection.item);
    const allByName = new Map<string, CollectionItem>();
    for (const [, item] of flat) { if (item.name) allByName.set(item.name, item); }
    const startIds = executionOrder.filter(id => selectedRequestIds.has(id));
    if (startIds.length === 0) return null;
    const chains = resolveConditionalChain(startIds, flat, allByName);
    // Only surface the panel when at least one chain has auto-added requests
    return chains.some(c => c.some(e => e.autoAdded)) ? chains : null;
  }, [conditionalExecution, selectedCollection, executionOrder, selectedRequestIds]);

  // Consume a preselection dispatched from CollectionTree ("Execute in Runner")
  // Use a ref to signal the auto-select-all effect to skip when preselection is applied.
  const skipAutoSelectRef = useRef(false);
  useEffect(() => {
    if (!state.runnerPreselection) return;
    const { collectionId, requestIds } = state.runnerPreselection;
    skipAutoSelectRef.current = true;
    setSelectedCollectionId(collectionId);
    setSelectedRequestIds(new Set(requestIds));
    setExecutionOrder(requestIds);
    setResults(null);
    dispatch({ type: 'SET_RUNNER_PRESELECTION', payload: null });
  }, [dispatch, state.runnerPreselection]);

  // Auto-select all requests when collection changes
  useEffect(() => {
    if (skipAutoSelectRef.current) {
      skipAutoSelectRef.current = false;
      return;
    }
    if (selectedCollection) {
      const allIds = getAllRequestIds(selectedCollection.item);
      setSelectedRequestIds(new Set(allIds));
      setExecutionOrder(allIds);
    } else {
      setSelectedRequestIds(new Set());
      setExecutionOrder([]);
    }
  }, [selectedCollectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleRequest(id: string) {
    setSelectedRequestIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setExecutionOrder(prev =>
      prev.includes(id) ? prev.filter(oid => oid !== id) : [...prev, id]
    );
  }

  function toggleFolder(ids: string[], checked: boolean) {
    setSelectedRequestIds(prev => {
      const next = new Set(prev);
      ids.forEach(id => checked ? next.add(id) : next.delete(id));
      return next;
    });
    if (checked) {
      setExecutionOrder(prev => {
        const existing = new Set(prev);
        return [...prev, ...ids.filter(id => !existing.has(id))];
      });
    } else {
      const removeSet = new Set(ids);
      setExecutionOrder(prev => prev.filter(oid => !removeSet.has(oid)));
    }
  }

  function selectAll() {
    if (selectedCollection) {
      const allIds = getAllRequestIds(selectedCollection.item);
      setSelectedRequestIds(new Set(allIds));
      setExecutionOrder(allIds);
    }
  }

  function deselectAll() {
    setSelectedRequestIds(new Set());
    setExecutionOrder([]);
  }

  function handleDragEnd() {
    const from = dragItemRef.current;
    const to = dragOverRef.current;
    dragItemRef.current = null;
    dragOverRef.current = null;
    if (from === null || to === null || from === to) return;
    setExecutionOrder(prev => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  async function handleCsvChange(file: File | null) {
    setCsvFile(file);
    setCsvHeaders([]);
    setCsvPreviewRows([]);
    setCsvRowCount(0);
    if (!file) return;
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
      if (lines.length >= 1) {
        const headers = parseCSVLine(lines[0]);
        setCsvHeaders(headers);
        const dataLines = lines.slice(1);
        setCsvRowCount(dataLines.length);
        setCsvPreviewRows(dataLines.slice(0, 5).map(parseCSVLine));
      }
    } catch {
      // preview errors are non-fatal; server parses authoratively
    }
  }

  function countRequests(items: CollectionItem[]): number {
    return getAllRequestIds(items).length;
  }

  async function handleRun() {
    if (!selectedCollection) return;
    setIsRunning(true);
    setIsPaused(false);
    setRunId(null);
    setError(null);
    setResults(null);

    try {
      const envVars = getEnvironmentVars();
      const collVars = getCollectionVars(selectedCollectionId);

      // Apply inherited auth on the full tree, then extract items in execution order
      const authResolvedItems = applyInheritedAuth(selectedCollection.item, selectedCollection.auth);
      const itemMap = flattenRequestItems(authResolvedItems);

      // When conditional execution is on and chains were resolved, flatten all
      // chains in primary order (no cross-chain dedup — each chain runs in full).
      let orderedItems = conditionalChains
        ? conditionalChains.flat().map(({ item }) => itemMap.get(item.id!) ?? item)
        : executionOrder
            .filter(id => selectedRequestIds.has(id))
            .map(id => itemMap.get(id))
            .filter((item): item is CollectionItem => !!item);

      // Rewrite URLs to mock server if enabled
      if (useMockServer && state.mockServerRunning) {
        const mockBase = `http://localhost:${state.mockPort}`;
        orderedItems = orderedItems.map(item => {
          if (!item.request) return item;
          const rawUrl = typeof item.request.url === 'string' ? item.request.url : (item.request.url?.raw ?? '');
          let mockUrl: string;
          try {
            const parsed = new URL(rawUrl);
            mockUrl = mockBase + parsed.pathname + parsed.search + parsed.hash;
          } catch {
            const withSlash = rawUrl.startsWith('/') ? rawUrl : '/' + rawUrl;
            mockUrl = mockBase + withSlash;
          }
          const updatedUrl = typeof item.request.url === 'string'
            ? mockUrl
            : { ...(item.request.url as object), raw: mockUrl };
          return { ...item, request: { ...item.request, url: updatedUrl as typeof item.request.url } };
        });
      }

      const streamingResults: RunnerIteration[] = [];
      let currentIteration: RunnerIteration | null = null;

      await runCollectionStream(
        {
          collection: { ...selectedCollection, item: orderedItems },
          allCollectionItems: authResolvedItems,
          environment: envVars,
          collectionVariables: collVars,
          globals: state.globalVariables,
          cookies: state.cookieJar,
          delay,
          iterations: csvFile ? undefined : iterations,
          executeChildRequests,
          conditionalExecution,
        },
        csvFile ?? undefined,
        {
          onRunId(id) {
            setRunId(id);
          },
          onIterationStart(data) {
            currentIteration = { iteration: data.iteration, dataRow: data.dataRow, results: [] };
            streamingResults.push(currentIteration);
            setResults([...streamingResults]);
            setConfigOpen(false);
          },
          onResult(data) {
            const { iteration: _iter, ...resultData } = data;
            if (currentIteration) {
              currentIteration.results.push(resultData as RunnerIterationResult);
              setResults([...streamingResults]);
            }

            // Log to console in real-time
            const logBase = Date.now();
            let logSeq = 0;

            // Pre-request child requests (appear lowest/oldest)
            (data.preChildRequests || []).forEach(child => {
              dispatch({
                type: 'ADD_CONSOLE_LOG',
                payload: {
                  id: (logBase + logSeq).toString(36) + Math.random().toString(36).slice(2),
                  timestamp: logBase + logSeq++,
                  method: child.method,
                  url: child.result.resolvedUrl ?? child.name,
                  requestHeaders: Object.entries(child.result.requestHeaders ?? {}).map(([key, value]) => ({ key, value: String(value) })),
                  requestBody: child.result.requestBody,
                  scriptLogs: [],
                  response: {
                    status: child.result.status,
                    statusText: child.result.statusText,
                    responseTime: child.result.responseTime,
                    headers: child.result.headers ?? {},
                    body: child.result.body ?? '',
                    size: child.result.size ?? 0,
                    testResults: child.result.testResults ?? [],
                    error: child.result.error,
                  },
                },
              });
            });

            // Main request
            dispatch({
              type: 'ADD_CONSOLE_LOG',
              payload: {
                id: (logBase + logSeq).toString(36) + Math.random().toString(36).slice(2),
                timestamp: logBase + logSeq++,
                method: data.method,
                url: data.resolvedUrl ?? data.url,
                requestHeaders: Object.entries(data.requestHeaders ?? {}).map(([key, value]) => ({ key, value: String(value) })),
                requestBody: data.requestBody,
                scriptLogs: data.scriptLogs ?? [],
                response: {
                  status: data.status,
                  statusText: data.statusText,
                  responseTime: data.responseTime,
                  headers: data.headers ?? {},
                  body: data.body ?? '',
                  size: data.size ?? 0,
                  testResults: data.testResults,
                  error: data.error,
                },
              },
            });

            // Post-request (test script) child requests (appear topmost/newest)
            (data.testChildRequests || []).forEach(child => {
              dispatch({
                type: 'ADD_CONSOLE_LOG',
                payload: {
                  id: (logBase + logSeq).toString(36) + Math.random().toString(36).slice(2),
                  timestamp: logBase + logSeq++,
                  method: child.method,
                  url: child.result.resolvedUrl ?? child.name,
                  requestHeaders: Object.entries(child.result.requestHeaders ?? {}).map(([key, value]) => ({ key, value: String(value) })),
                  requestBody: child.result.requestBody,
                  scriptLogs: [],
                  response: {
                    status: child.result.status,
                    statusText: child.result.statusText,
                    responseTime: child.result.responseTime,
                    headers: child.result.headers ?? {},
                    body: child.result.body ?? '',
                    size: child.result.size ?? 0,
                    testResults: child.result.testResults ?? [],
                    error: child.result.error,
                  },
                },
              });
            });
          },
          onError(errorMsg) {
            setError(errorMsg);
          },
          onNextRequest(data) {
            if (currentIteration) {
              const lastResult = currentIteration.results[currentIteration.results.length - 1];
              if (lastResult) {
                currentIteration.jumps = [
                  ...(currentIteration.jumps ?? []),
                  { afterName: data.from, to: data.to },
                ];
                setResults([...streamingResults]);
              }
            }
          },
          onStopped() {
            // run was stopped — final state already set via streaming
          },
          onDone() {
            // final state is already set via streaming
          },
        },
      );
    } catch (e) {
      setError((e as Error).message);
    }
    setIsRunning(false);
    setIsPaused(false);
    setRunId(null);
  }

  // Summary stats
  const summary = results
    ? results.reduce(
        (acc, iter) => {
          iter.results.forEach(r => {
            acc.requests++;
            if (r.error) acc.errors++;
            r.testResults.forEach(t => {
              if (t.passed) acc.passed++;
              else acc.failed++;
            });
            [...(r.preChildRequests ?? []), ...(r.testChildRequests ?? [])].forEach(c => {
              acc.requests++;
              if (c.result.error) acc.errors++;
              (c.result.testResults ?? []).forEach(t => {
                if (t.passed) acc.passed++;
                else acc.failed++;
              });
            });
          });
          return acc;
        },
        { requests: 0, passed: 0, failed: 0, errors: 0 }
      )
    : null;

  return (
    <div className="flex-1 flex flex-col overflow-y-auto p-4 gap-4">

      {/* Config */}
      <div className="bg-slate-800 border border-slate-700 rounded-lg shrink-0">
        {/* Collapsible header */}
        <button
          onClick={() => setConfigOpen(o => !o)}
          className="flex items-center gap-2 w-full px-4 py-3 text-left hover:bg-slate-700/40 transition-colors rounded-lg"
        >
          <span className="text-white font-semibold text-base flex-1">Collection Runner</span>
          {!configOpen && selectedCollection && (
            <span className="text-xs text-slate-400 truncate max-w-[200px]">{selectedCollection.info.name}</span>
          )}
          <span className="text-slate-500 text-xs ml-2">{configOpen ? '▴' : '▾'}</span>
        </button>
        <div className={configOpen ? 'px-4 pb-4 flex flex-col gap-4' : 'hidden'}>
        {/* Collection selector */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-slate-400 font-medium">Collection</label>
          <select
            value={selectedCollectionId}
            onChange={e => setSelectedCollectionId(e.target.value)}
            className="bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
          >
            <option value="">Select a collection...</option>
            {state.collections.map(c => (
              <option key={c._id} value={c._id}>{c.info.name}</option>
            ))}
          </select>
          {selectedCollection && (
            <p className="text-xs text-slate-500">
              {countRequests(selectedCollection.item)} request{countRequests(selectedCollection.item) !== 1 ? 's' : ''} total
            </p>
          )}
        </div>

        {/* Request selection */}
        {selectedCollection && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs text-slate-400 font-medium">
                Requests
                <span className="ml-1.5 text-slate-500">
                  ({selectedRequestIds.size} of {countRequests(selectedCollection.item)} selected)
                </span>
              </label>
              <div className="flex gap-3">
                <button
                  onClick={selectAll}
                  className="text-xs text-orange-400 hover:text-orange-300 transition-colors"
                >
                  Select All
                </button>
                <button
                  onClick={deselectAll}
                  className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Deselect All
                </button>
              </div>
            </div>
            <div className="bg-slate-700/40 border border-slate-600 rounded px-2 py-1 max-h-52 overflow-y-auto">
              {selectedCollection.item.length === 0 ? (
                <p className="text-xs text-slate-500 py-2 text-center">Collection is empty</p>
              ) : (
                selectedCollection.item.map((item, i) => (
                  <SelectionNode
                    key={item.id || i}
                    item={item}
                    depth={0}
                    selectedIds={selectedRequestIds}
                    onToggleRequest={toggleRequest}
                    onToggleFolder={toggleFolder}
                  />
                ))
              )}
            </div>
          </div>
        )}

        {/* Execution order */}
        {selectedCollection && executionOrder.length > 1 && (() => {
          const itemMap = flattenRequestItems(selectedCollection.item);
          return (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs text-slate-400 font-medium">
                  Execution Order
                  <span className="ml-1.5 text-slate-500">
                    (drag to reorder)
                  </span>
                </label>
                <button
                  onClick={() => setExecutionOrder(getAllRequestIds(selectedCollection.item).filter(id => selectedRequestIds.has(id)))}
                  className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Reset Order
                </button>
              </div>
              <div className="bg-slate-700/40 border border-slate-600 rounded px-1 py-1 max-h-52 overflow-y-auto">
                {executionOrder.map((id, idx) => {
                  const item = itemMap.get(id);
                  if (!item) return null;
                  const method = item.request?.method ?? 'GET';
                  const methodColor = METHOD_COLORS[method] ?? 'text-slate-400';
                  return (
                    <div
                      key={id}
                      draggable
                      onDragStart={() => { dragItemRef.current = idx; }}
                      onDragEnter={() => { dragOverRef.current = idx; }}
                      onDragOver={e => e.preventDefault()}
                      onDragEnd={handleDragEnd}
                      className="flex items-center gap-2 py-1.5 px-2 hover:bg-slate-600/30 rounded cursor-grab active:cursor-grabbing select-none"
                    >
                      <span className="text-slate-600 text-xs shrink-0 w-5 text-right">{idx + 1}.</span>
                      <svg className="w-3.5 h-3.5 text-slate-600 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="9" cy="5" r="1.5" /><circle cx="15" cy="5" r="1.5" />
                        <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
                        <circle cx="9" cy="19" r="1.5" /><circle cx="15" cy="19" r="1.5" />
                      </svg>
                      <span className={`text-xs font-bold w-14 shrink-0 ${methodColor}`}>{method}</span>
                      <span className="text-sm text-slate-300 truncate">{item.name}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        <div className="flex flex-col gap-3">
          {/* CSV upload */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-400 font-medium">Data File (CSV)</label>
            <div className="flex gap-2">
              <input
                ref={csvRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={e => handleCsvChange(e.target.files?.[0] ?? null)}
              />
              <button
                onClick={() => csvRef.current?.click()}
                className="flex-1 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded text-slate-300 transition-colors text-left px-3"
              >
                {csvFile ? `📄 ${csvFile.name}` : '+ Select CSV file'}
              </button>
              {csvFile && (
                <button
                  onClick={() => { handleCsvChange(null); if (csvRef.current) csvRef.current.value = ''; }}
                  className="px-3 py-1.5 text-slate-500 hover:text-red-400 border border-slate-600 rounded text-sm"
                >
                  ×
                </button>
              )}
            </div>
            {!csvFile && (
              <p className="text-xs text-slate-600">One row = one iteration. Column headers become variables.</p>
            )}
            {/* CSV preview table */}
            {csvHeaders.length > 0 && (
              <div className="overflow-x-auto bg-slate-700/40 border border-slate-600 rounded">
                <table className="text-xs w-full">
                  <thead>
                    <tr className="border-b border-slate-600">
                      {csvHeaders.map(h => (
                        <th key={h} className="text-left px-2 py-1.5 text-orange-400 font-medium whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {csvPreviewRows.map((row, i) => (
                      <tr key={i} className="border-b border-slate-700 last:border-0">
                        {row.map((cell, j) => (
                          <td key={j} className="px-2 py-1 text-slate-300 max-w-[120px] truncate">{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {csvRowCount > 5 && (
                  <p className="text-xs text-slate-500 px-2 py-1">
                    ...and {csvRowCount - 5} more row{csvRowCount - 5 !== 1 ? 's' : ''}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Iterations + Delay */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-slate-400 font-medium">
                Iterations
                {csvRowCount > 0 && <span className="ml-1.5 text-orange-400 font-normal">({csvRowCount} from CSV)</span>}
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={csvRowCount > 0 ? csvRowCount : iterations}
                disabled={csvRowCount > 0}
                onChange={e => setIterations(Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1)))}
                className="bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-orange-500 disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-slate-400 font-medium">Delay (ms)</label>
              <input
                type="number"
                min={0}
                max={5000}
                value={delay}
                onChange={e => setDelay(Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
              />
            </div>
          </div>

          {/* Execute child requests toggle */}
          <div className="flex items-center gap-2">
            <input
              id="executeChildRequests"
              type="checkbox"
              checked={executeChildRequests}
              onChange={e => setExecuteChildRequests(e.target.checked)}
              className="accent-orange-500 cursor-pointer"
            />
            <label htmlFor="executeChildRequests" className="text-xs text-slate-400 cursor-pointer select-none">
              Execute child requests (<code className="text-orange-400">apx.executeRequest()</code>)
            </label>
          </div>

          {/* Conditional execution toggle */}
          <div className="flex items-center gap-2">
            <input
              id="conditionalExecution"
              type="checkbox"
              checked={conditionalExecution}
              onChange={e => setConditionalExecution(e.target.checked)}
              className="accent-orange-500 cursor-pointer"
            />
            <label htmlFor="conditionalExecution" className="text-xs text-slate-400 cursor-pointer select-none">
              Conditional execution (<code className="text-orange-400">pm.execution.skipRequest()</code> / <code className="text-orange-400">setNextRequest()</code>)
            </label>
          </div>

          {/* Resolved chains — primary (user order) × secondary (setNextRequest) */}
          {conditionalChains && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <label className="text-xs text-amber-400 font-medium">Resolved execution chains</label>
                <span className="text-xs text-slate-500">auto-detected from <code className="text-orange-400">setNextRequest()</code></span>
              </div>
              {conditionalChains.map((chain, chainIdx) => (
                <div key={chainIdx} className="flex flex-col gap-0.5">
                  {conditionalChains.length > 1 && (
                    <div className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide px-1">
                      Chain {chainIdx + 1} — starting from <span className="text-slate-400">{chain[0]?.item.name}</span>
                    </div>
                  )}
                  <div className="bg-slate-700/40 border border-amber-700/40 rounded px-2 py-1.5 flex flex-col gap-0.5">
                    {chain.map(({ item, autoAdded }, i) => {
                      const method = item.request?.method ?? 'GET';
                      const methodColor = METHOD_COLORS[method] ?? 'text-slate-400';
                      return (
                        <div key={(item.id ?? item.name) + i} className="flex items-center gap-2 py-0.5">
                          <span className="text-slate-600 text-xs w-4 text-right shrink-0">{i + 1}.</span>
                          <span className={`text-xs font-bold w-14 shrink-0 ${methodColor}`}>{method}</span>
                          <span className={`text-sm truncate ${autoAdded ? 'text-amber-300' : 'text-slate-300'}`}>{item.name}</span>
                          {autoAdded && (
                            <span title="Auto-added via setNextRequest()" className="ml-auto shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-800/60 text-amber-300 border border-amber-600/50">auto</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              <p className="text-xs text-slate-500">
                <span className="text-slate-400">Amber</span> items are auto-added. Each chain runs in full — a request selected in the primary order runs independently even if already reached by a previous chain.
              </p>
            </div>
          )}
        </div>

        {/* Environment info */}
        {state.activeEnvironmentId && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>🌍</span>
            <span>Using environment: <span className="text-slate-300">{state.environments.find(e => e._id === state.activeEnvironmentId)?.name}</span></span>
          </div>
        )}

        {/* Mock server option */}
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${useMockServer && state.mockServerRunning ? 'border-orange-500/50 bg-orange-500/5' : 'border-slate-700'}`}>
          <input
            id="useMockServer"
            type="checkbox"
            checked={useMockServer && state.mockServerRunning}
            disabled={!state.mockServerRunning}
            onChange={e => setUseMockServer(e.target.checked)}
            className="accent-orange-500 cursor-pointer disabled:cursor-not-allowed"
          />
          <label htmlFor="useMockServer" className={`text-xs cursor-pointer select-none flex items-center gap-2 ${state.mockServerRunning ? 'text-slate-300' : 'text-slate-600 cursor-not-allowed'}`}>
            <span>🎭</span>
            <span>Send all requests to Mock Server</span>
            {state.mockServerRunning
              ? <span className="font-mono text-slate-500">localhost:{state.mockPort}</span>
              : <span className="text-slate-600 italic">(start the mock server to enable)</span>
            }
          </label>
        </div>

        </div>{/* end collapsible body */}
      </div>

      {/* Run controls — always visible */}
      <div className="flex flex-col gap-2 shrink-0">

      <div className="flex items-center gap-3">
        <button
          onClick={handleRun}
          disabled={!selectedCollection || isRunning || selectedRequestIds.size === 0}
          className="px-6 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-slate-600 disabled:text-slate-400 text-white font-semibold rounded text-sm transition-colors"
        >
          {isRunning ? '⏳ Running...' : '▶ Run Collection'}
        </button>

        {isRunning && runId && (
          <>
            <button
              onClick={async () => {
                if (isPaused) {
                  await resumeRun(runId);
                  setIsPaused(false);
                } else {
                  await pauseRun(runId);
                  setIsPaused(true);
                }
              }}
              className="px-4 py-2 bg-slate-600 hover:bg-slate-500 text-white font-semibold rounded text-sm transition-colors"
            >
              {isPaused ? '▶ Resume' : '⏸ Pause'}
            </button>
            <button
              onClick={async () => {
                await stopRun(runId);
                setIsPaused(false);
              }}
              className="px-4 py-2 bg-red-700 hover:bg-red-600 text-white font-semibold rounded text-sm transition-colors"
            >
              ■ Stop
            </button>
          </>
        )}

        {isPaused && (
          <span className="text-xs text-yellow-400 font-medium animate-pulse">Paused — waiting between requests</span>
        )}
      </div>
      </div>{/* end run controls wrapper */}

      {error && (
        <div className="bg-red-900/20 border border-red-700 rounded px-3 py-2 text-red-400 text-sm shrink-0">{error}</div>
      )}

      {/* Results */}
      {results !== null && (
        <div className="flex flex-col gap-3 overflow-y-auto flex-1 min-h-0">
          {/* Summary */}
          {summary && (
            <div className="grid grid-cols-4 gap-2 shrink-0">
              {[
                { label: 'Requests', value: summary.requests, color: 'text-slate-200' },
                { label: 'Tests Passed', value: summary.passed, color: 'text-green-400' },
                { label: 'Tests Failed', value: summary.failed, color: summary.failed > 0 ? 'text-red-400' : 'text-slate-400' },
                { label: 'Errors', value: summary.errors, color: summary.errors > 0 ? 'text-red-400' : 'text-slate-400' },
              ].map(s => (
                <div key={s.label} className="bg-slate-800 border border-slate-700 rounded p-3 text-center">
                  <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
                </div>
              ))}
            </div>
          )}

          {!isRunning && results.length > 0 && (
            <PerformanceMetricsPanel results={results} />
          )}

          {results.length === 0 ? (
            <p className="text-slate-500 text-sm">No results — collection may be empty.</p>
          ) : (
            results.map(iter => <IterationBlock key={iter.iteration} iter={iter} />)
          )}
        </div>
      )}
    </div>
  );
}
