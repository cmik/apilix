import { useApp } from '../store';
import apilixLogo from '../assets/apilix.svg';

type View = 'request' | 'runner' | 'environments' | 'mock';

const NAV_ITEMS: { key: View; emoji: string; label: string }[] = [
  { key: 'request',      emoji: '⚡', label: 'Requests' },
  { key: 'runner',       emoji: '▶',  label: 'Runner'   },
  { key: 'environments', emoji: '🌍', label: 'Envs'     },
  { key: 'mock',         emoji: '🎭', label: 'Mock'     },
];

interface Props {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

export default function ActivityBar({ theme, onToggleTheme }: Props) {
  const { state, dispatch } = useApp();

  return (
    <div className="w-[72px] shrink-0 h-full bg-slate-950 border-r border-slate-800 flex flex-col items-center py-2 overflow-hidden z-10">
      {/* Brand logo */}
      <div className="mb-4 mt-1 select-none px-2">
        <img src={apilixLogo} alt="Apilix" title="APILIX" className="w-16 h-16 object-contain" />
      </div>

      {/* Nav icons */}
      <nav className="flex flex-col items-center gap-0.5 flex-1 w-full px-1">
        {NAV_ITEMS.map(({ key, emoji, label }) => {
          const active =
            state.view === key ||
            (key === 'environments' && state.view === 'globals');
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

      {/* Bottom: theme toggle */}
      <div className="flex flex-col items-center gap-0.5 w-full px-1">
        <button
          onClick={onToggleTheme}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          className="w-full flex items-center justify-center py-2.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800/60 transition-colors"
        >
          {theme === 'dark' ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <circle cx="12" cy="12" r="4" />
              <path strokeLinecap="round" d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
