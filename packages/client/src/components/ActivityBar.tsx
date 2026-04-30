import { useState, useEffect, lazy, Suspense } from 'react';
import { useApp } from '../store';
import apilixLogo from '../assets/apilix.svg';
import {
  IconRequests,
  IconEnvironments,
  IconHistory,
  IconRunner,
  IconMock,
  IconCapture,
  IconCookies,
  IconSettings,
  IconSun,
  IconMoon,
  IconMonitor,
} from './Icons';

const WorkspaceManagerModal = lazy(() => import('./WorkspaceManagerModal'));

type View = 'request' | 'runner' | 'environments' | 'mock' | 'capture' | 'history';

interface NavItem {
  key: View;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'request',      label: 'Requests', icon: IconRequests },
  { key: 'environments', label: 'Envs',     icon: IconEnvironments },
  { key: 'history',      label: 'History',  icon: IconHistory },
  { key: 'runner',       label: 'Runner',   icon: IconRunner },
  { key: 'mock',         label: 'Mock',     icon: IconMock },
  { key: 'capture',      label: 'Capture',  icon: IconCapture },
];

interface Props {
  settingsTheme: 'dark' | 'light' | 'system';
  cookieManagerOpen: boolean;
  onToggleCookieManager: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
}

export default function ActivityBar({
  settingsTheme,
  cookieManagerOpen,
  onToggleCookieManager,
  onToggleTheme,
  onOpenSettings,
}: Props) {
  const { state, dispatch } = useApp();
  const [manageOpen, setManageOpen] = useState(false);

  useEffect(() => {
    function onOpen() { setManageOpen(true); }
    document.addEventListener('apilix:openWorkspaceManager', onOpen);
    return () => document.removeEventListener('apilix:openWorkspaceManager', onOpen);
  }, []);

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
        {NAV_ITEMS.map(({ key, label, icon: IconComponent }) => {
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
              <IconComponent className="w-5 h-5 leading-none" />
              <span className="text-[10px] font-medium leading-none mt-0.5">{label}</span>
            </button>
          );
        })}
      </nav>

      {/* Bottom: settings + cookie manager + theme toggle */}
      <div className="flex flex-col items-center gap-0.5 w-full px-1">
        <button
          onClick={onOpenSettings}
          title="Settings"
          className="w-full flex items-center justify-center py-2.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800/60 transition-colors"
        >
          <IconSettings />
        </button>
        <button
          onClick={onToggleCookieManager}
          title="Cookie Manager"
          className={`w-full flex items-center justify-center py-2.5 rounded transition-colors ${
            cookieManagerOpen
              ? 'text-orange-400 bg-slate-800'
              : 'text-slate-500 hover:text-slate-200 hover:bg-slate-800/60'
          }`}
        >
          <IconCookies />
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
            <IconMoon />
          ) : settingsTheme === 'dark' ? (
            <IconMonitor />
          ) : (
            <IconSun />
          )}
        </button>
      </div>
    </div>
  );
}
