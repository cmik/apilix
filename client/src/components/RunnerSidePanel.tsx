import { useMemo, type Dispatch } from 'react';
import { useApp } from '../store';
import type { AppAction, SavedRunnerRun } from '../types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── RunEntryRow ─────────────────────────────────────────────────────────────

interface RunEntryRowProps {
  run: SavedRunnerRun;
  dispatch: Dispatch<AppAction>;
  isSaved?: boolean;
  onDelete?: (id: string) => void;
}

function RunEntryRow({ run, dispatch, isSaved, onDelete }: RunEntryRowProps) {
  const { summary } = run;

  const summaryColor =
    summary.errors > 0
      ? 'text-red-400 bg-red-400/15'
      : summary.failed > 0
      ? 'text-yellow-400 bg-yellow-400/15'
      : summary.passed > 0
      ? 'text-green-400 bg-green-400/15'
      : 'text-slate-400 bg-slate-700';

  function handleClick() {
    dispatch({ type: 'LOAD_RUNNER_RUN', payload: run });
  }

  return (
    <div
      className="px-3 py-2.5 border-b border-slate-800/60 cursor-pointer hover:bg-slate-800/50 transition-colors group"
      onClick={handleClick}
    >
      <div className="flex items-start gap-1.5">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-slate-200 truncate leading-tight">{run.name}</p>
          <p className="text-[10px] text-slate-500 truncate mt-0.5">{run.collectionName}</p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${summaryColor}`}>
            {summary.requests}req
            {summary.passed > 0 && <span className="text-green-400"> ✓{summary.passed}</span>}
            {summary.failed > 0 && <span className="text-red-400"> ✗{summary.failed}</span>}
            {summary.errors > 0 && <span className="text-red-400"> !{summary.errors}</span>}
          </span>
          {isSaved && onDelete && (
            <button
              onClick={e => { e.stopPropagation(); onDelete(run.id); }}
              className="opacity-0 group-hover:opacity-100 p-0.5 text-slate-600 hover:text-red-400 transition-all"
              title="Delete saved run"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <p className="text-[10px] text-slate-600 mt-1">{formatRelativeTime(run.timestamp)}</p>
    </div>
  );
}

// ─── RunnerSidePanel ─────────────────────────────────────────────────────────

export default function RunnerSidePanel() {
  const { state, dispatch } = useApp();
  const { recentRuns, savedRuns } = state;

  const hasAny = recentRuns.length > 0 || savedRuns.length > 0;

  // Sort recent desc by timestamp
  const sortedRecent = useMemo(
    () => [...recentRuns].sort((a, b) => b.timestamp - a.timestamp),
    [recentRuns],
  );

  // Sort saved desc by timestamp
  const sortedSaved = useMemo(
    () => [...savedRuns].sort((a, b) => b.timestamp - a.timestamp),
    [savedRuns],
  );

  return (
    <div className="flex flex-col h-full bg-slate-900 text-slate-200 overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-slate-700 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-orange-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="font-semibold text-slate-100 text-sm">Runner Runs</span>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {!hasAny ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-slate-500 select-none px-4 text-center">
            <svg className="w-10 h-10 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm">No runs yet</span>
            <span className="text-xs text-slate-600">Completed runs appear here automatically</span>
          </div>
        ) : (
          <>
            {/* Recent runs section */}
            {sortedRecent.length > 0 && (
              <>
                <div className="sticky top-0 flex items-center justify-between px-3 py-1 bg-slate-800/90 border-b border-slate-700/60 select-none z-10">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                    Recent ({sortedRecent.length}/5)
                  </span>
                  <button
                    onClick={() => dispatch({ type: 'SET_RECENT_RUNS', payload: [] })}
                    className="text-[10px] text-slate-600 hover:text-red-400 transition-colors"
                    title="Clear recent runs"
                  >
                    Clear
                  </button>
                </div>
                {sortedRecent.map(run => (
                  <RunEntryRow key={run.id} run={run} dispatch={dispatch} />
                ))}
              </>
            )}

            {/* Saved runs section */}
            {sortedSaved.length > 0 && (
              <>
                <div className="sticky top-0 px-3 py-1 bg-slate-800/90 border-b border-slate-700/60 select-none z-10">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                    Saved ({sortedSaved.length})
                  </span>
                </div>
                {sortedSaved.map(run => (
                  <RunEntryRow
                    key={run.id}
                    run={run}
                    dispatch={dispatch}
                    isSaved
                    onDelete={id => dispatch({ type: 'DELETE_SAVED_RUN', payload: id })}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
