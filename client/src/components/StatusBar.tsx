import type { ConsoleEntry } from '../types';

declare const __APP_VERSION__: string;

type ServerStatus = 'checking' | 'online' | 'offline';

interface StatusBarProps {
  consoleOpen: boolean;
  onToggleConsole: () => void;
  logCount: number;
  lastEntry: ConsoleEntry | null;
  serverStatus: ServerStatus;
}

function statusColor(status: number): string {
  if (status >= 500) return 'text-red-400';
  if (status >= 400) return 'text-yellow-400';
  if (status >= 300) return 'text-sky-400';
  if (status >= 200) return 'text-green-400';
  return 'text-red-400';
}

export default function StatusBar({
  consoleOpen,
  onToggleConsole,
  logCount,
  lastEntry,
  serverStatus,
}: StatusBarProps) {
  const serverDot =
    serverStatus === 'online'
      ? 'bg-green-500'
      : serverStatus === 'offline'
      ? 'bg-red-500'
      : 'bg-yellow-500 animate-pulse';
  const serverLabel =
    serverStatus === 'online' ? 'Server online' : serverStatus === 'offline' ? 'Server offline' : 'Checking…';
  const serverTextColor =
    serverStatus === 'online' ? 'text-green-400' : serverStatus === 'offline' ? 'text-red-400' : 'text-yellow-400';
  return (
    <div className="flex items-center h-6 px-1 bg-slate-950 border-t border-slate-800 shrink-0 select-none text-xs">
      {/* Console toggle */}
      <button
        onClick={onToggleConsole}
        title={consoleOpen ? 'Hide console' : 'Show console'}
        className={`flex items-center gap-1.5 h-full px-2.5 rounded transition-colors ${
          consoleOpen
            ? 'text-orange-400 bg-orange-900/20 hover:bg-orange-900/30'
            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
        }`}
      >
        {/* Terminal / console icon */}
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        <span>Console</span>
        {logCount > 0 && (
          <span
            className={`px-1 rounded text-[10px] font-mono ${
              consoleOpen
                ? 'bg-orange-900/50 text-orange-300'
                : 'bg-slate-800 text-slate-400'
            }`}
          >
            {logCount}
          </span>
        )}
      </button>

      {/* Separator */}
      <span className="w-px h-3.5 bg-slate-700 mx-1" />

      {/* App version */}
      <span className="font-mono text-slate-500 px-1.5" title="App version">
        v{__APP_VERSION__}
      </span>

      <div className="flex-1" />

      {/* Server status */}
      <span className="flex items-center px-2" title={serverLabel}>
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${serverDot}`} />
      </span>

      {/* Last response pill */}
      {lastEntry?.response && (
        <span className={`font-mono px-2 ${statusColor(lastEntry.response.status)}`}>
          {lastEntry.method}&nbsp;
          <span className="font-semibold">{lastEntry.response.status}</span>
          &nbsp;&mdash;&nbsp;{lastEntry.response.responseTime} ms
        </span>
      )}
    </div>
  );
}
