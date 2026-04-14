import { useState, lazy, Suspense } from 'react';
import { useApp } from '../store';
import apilixLogo from '../assets/apilix.svg';

const WorkspaceManagerModal = lazy(() => import('./WorkspaceManagerModal'));

type View = 'request' | 'runner' | 'environments' | 'mock' | 'capture';

const NAV_ITEMS: { key: View; emoji: string; label: string }[] = [
  { key: 'request',      emoji: '⚡', label: 'Requests' },
  { key: 'environments', emoji: '🌍', label: 'Envs'     },
  { key: 'runner',       emoji: '▶',  label: 'Runner'   },
  { key: 'mock',         emoji: '🎭', label: 'Mock'     },
  { key: 'capture',      emoji: '📡', label: 'Capture'  },
];

interface Props {
  settingsTheme: 'dark' | 'light' | 'system';
  onToggleTheme: () => void;
  onOpenSettings: () => void;
}

export default function ActivityBar({ settingsTheme, onToggleTheme, onOpenSettings }: Props) {
  const { state, dispatch } = useApp();
  const [manageOpen, setManageOpen] = useState(false);

  return (
    <div className="w-[72px] shrink-0 h-full bg-slate-950 border-r border-slate-800 flex flex-col items-center py-2 overflow-hidden z-10">
      {/* Brand logo */}
      <div className="mb-2 mt-1 select-none px-2">
        <img src={apilixLogo} alt="Apilix" title="APILIX" className="w-16 h-16 object-contain" />
      </div>

      {manageOpen && (
        <Suspense fallback={null}>
          <WorkspaceManagerModal onClose={() => setManageOpen(false)} />
        </Suspense>
      )}

      {/* Nav icons */}
      <nav className="flex flex-col items-center gap-0.5 flex-1 w-full px-1">
        {NAV_ITEMS.map(({ key, emoji, label }) => {
          const active =
            state.view === key ||
            (key === 'environments' && (state.view === 'globals' || state.view === 'variables'));
          return (
            <button
              key={key}
              onClick={() => dispatch({ type: 'SET_VIEW', payload: key })}
              title={label}
              className={`relative w-full flex flex-col items-center justify-center gap-0.5 py-2.5 rounded transition-colors ${
                active
                  ? 'text-orange-400 bg-slate-800'
                  : 'text-slate-500 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              {active && (
                <span className="absolute left-0 top-2 bottom-2 w-0.5 bg-orange-400 rounded-r" />
              )}
              <span className="text-lg leading-none">{emoji}</span>
              <span className="text-[10px] font-medium leading-none mt-0.5">{label}</span>
            </button>
          );
        })}
      </nav>

      {/* Bottom: settings + theme toggle */}
      <div className="flex flex-col items-center gap-0.5 w-full px-1">
        <button
          onClick={onOpenSettings}
          title="Settings"
          className="w-full flex items-center justify-center py-2.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800/60 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
        </button>
        <button
          onClick={onToggleTheme}
          title={
            settingsTheme === 'light' ? 'Switch to dark theme' :
            settingsTheme === 'dark'  ? 'Switch to system theme' :
                                        'Switch to light theme'
          }
          className="w-full flex items-center justify-center py-2.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800/60 transition-colors"
        >
          {settingsTheme === 'light' ? (
            /* moon — clicking goes to dark */
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          ) : settingsTheme === 'dark' ? (
            /* monitor — clicking goes to system */
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 21h8M12 17v4" />
            </svg>
          ) : (
            /* sun — clicking goes to light */
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <circle cx="12" cy="12" r="4" />
              <path strokeLinecap="round" d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
