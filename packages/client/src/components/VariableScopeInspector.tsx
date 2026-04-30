import { useState, useMemo, useEffect, type ReactNode } from 'react';
import { useApp } from '../store';
import { buildVarMap } from '../utils/variableResolver';
import { IconEnvironments, IconGlobals, IconScopeInspector, IconSearch, IconCollection, IconChevronDown, IconEye, IconEyeOff } from './Icons';

const SECRET_MASK = '••••••••';

function EnvGlobalsTabBar() {
  const { state, dispatch } = useApp();
  return (
    <div className="flex border-b border-slate-700 shrink-0 -mx-4 px-4 mb-2">
      <button
        onClick={() => dispatch({ type: 'SET_VIEW', payload: 'environments' })}
        className={`mr-4 pb-2 text-xs font-medium transition-colors border-b-2 flex items-center gap-1.5 ${
          state.view === 'environments'
            ? 'text-orange-400 border-orange-400'
            : 'text-slate-400 hover:text-slate-200 border-transparent'
        }`}
      >
        <IconEnvironments className="w-3.5 h-3.5" />
        Environments
      </button>
      <button
        onClick={() => dispatch({ type: 'SET_VIEW', payload: 'globals' })}
        className={`mr-4 pb-2 text-xs font-medium transition-colors border-b-2 flex items-center gap-1.5 ${
          state.view === 'globals'
            ? 'text-orange-400 border-orange-400'
            : 'text-slate-400 hover:text-slate-200 border-transparent'
        }`}
      >
        <IconGlobals className="w-3.5 h-3.5" />
        Globals
      </button>
      <button
        onClick={() => dispatch({ type: 'SET_VIEW', payload: 'variables' })}
        className={`pb-2 text-xs font-medium transition-colors border-b-2 flex items-center gap-1.5 ${
          state.view === 'variables'
            ? 'text-orange-400 border-orange-400'
            : 'text-slate-400 hover:text-slate-200 border-transparent'
        }`}
      >
        <IconScopeInspector className="w-3.5 h-3.5" />
        Scope Inspector
      </button>
    </div>
  );
}

type ScopeBadge = 'ENV' | 'COLL' | 'GLOBAL';

const BADGE_COLORS: Record<ScopeBadge, string> = {
  ENV: 'bg-sky-900 text-sky-300',
  COLL: 'bg-purple-900 text-purple-300',
  GLOBAL: 'bg-slate-700 text-slate-300',
};

function ScopeTag({ scope }: { scope: ScopeBadge }) {
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide leading-none ${BADGE_COLORS[scope]}`}>
      {scope}
    </span>
  );
}

interface ScopeSectionProps {
  title: string;
  subtitle?: string;
  vars: Record<string, string>;
  overriddenKeys: Set<string>;
  filter: string;
  defaultOpen?: boolean;
  icon?: ReactNode;
  /** Keys in this section whose values should be masked by default */
  secretKeys?: Set<string>;
}

function ScopeSection({ title, subtitle, vars, overriddenKeys, filter, defaultOpen = true, icon, secretKeys }: ScopeSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());

  // Reset revealed state when the secret key set or variable set changes (e.g. environment switch)
  useEffect(() => {
    setRevealedKeys(new Set());
  }, [secretKeys, vars]);

  function toggleReveal(key: string) {
    setRevealedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const entries = Object.entries(vars)
    .filter(([k, v]) => {
      if (!filter) return true;
      const lc = filter.toLowerCase();
      if (k.toLowerCase().includes(lc)) return true;
      // Don't leak secret values via filter match
      if (secretKeys?.has(k)) return false;
      return v.toLowerCase().includes(lc);
    })
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="mb-3 rounded-lg border border-slate-700 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between px-3 py-2 bg-slate-800 hover:bg-slate-750 text-left"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-xs font-semibold text-slate-200">{title}</span>
          {subtitle && <span className="text-xs text-slate-500">{subtitle}</span>}
          <span className="text-[10px] bg-slate-700 text-slate-400 px-1.5 py-0.5 rounded-full">{Object.keys(vars).length}</span>
        </div>
        <IconChevronDown className={`w-3.5 h-3.5 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="bg-slate-900/50">
          {entries.length === 0 ? (
            <p className="px-3 py-3 text-xs text-slate-600 italic">No variables</p>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {entries.map(([key, value]) => {
                  const overridden = overriddenKeys.has(key);
                  const isSecret = secretKeys?.has(key) ?? false;
                  const revealed = revealedKeys.has(key);
                  return (
                    <tr
                      key={key}
                      className={`border-t border-slate-800 ${overridden ? 'opacity-40' : ''}`}
                    >
                      <td className="pl-3 pr-2 py-1.5 font-mono text-slate-300 w-1/3 truncate">
                        {key}
                      </td>
                      <td className="pr-1 py-1.5 font-mono text-slate-400 truncate max-w-0 w-full">
                        {isSecret && !revealed ? SECRET_MASK : value}
                      </td>
                      <td className="pr-3 py-1.5 text-right whitespace-nowrap">
                        {isSecret && (
                          <button
                            type="button"
                            onClick={() => toggleReveal(key)}
                            aria-label={revealed ? 'Hide value' : 'Reveal value'}
                            title={revealed ? 'Hide value' : 'Reveal value'}
                            className="mr-1 p-0.5 rounded text-slate-500 hover:text-slate-300 transition-colors"
                          >
                            {revealed
                              ? <IconEyeOff className="w-3.5 h-3.5" />
                              : <IconEye className="w-3.5 h-3.5" />}
                          </button>
                        )}
                        {overridden && (
                          <span className="text-[10px] text-amber-600 font-medium">overridden</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

export default function VariableScopeInspector() {
  const { state, getEnvironmentVars, getActiveEnvironment } = useApp();
  const [filter, setFilter] = useState('');
  const [revealedResolved, setRevealedResolved] = useState<Set<string>>(new Set());

  const activeEnv = getActiveEnvironment();
  const envVars = getEnvironmentVars();

  // Set of env keys whose values are marked secret
  const secretEnvKeys = useMemo<Set<string>>(() => {
    if (!activeEnv) return new Set();
    return new Set(
      activeEnv.values
        .filter(v => v.secret && v.enabled !== false)
        .map(v => v.key)
    );
  }, [activeEnv]);

  // Reset resolved reveal state when active environment or its secret keys change
  useEffect(() => {
    setRevealedResolved(new Set());
  }, [activeEnv, secretEnvKeys]);

  const activeCollectionId = state.activeRequest?.collectionId ?? null;
  const activeCollection = activeCollectionId
    ? state.collections.find(c => c._id === activeCollectionId) ?? null
    : null;
  const collVars: Record<string, string> = activeCollectionId
    ? (state.collectionVariables[activeCollectionId] ?? {})
    : {};

  const globals = state.globalVariables;

  // Merged map: globals < collVars < envVars (dataRow excluded — not in inspector context)
  const resolved = buildVarMap(envVars, collVars, globals);

  // Determine which scope wins for each key
  const allKeys = new Set([...Object.keys(envVars), ...Object.keys(collVars), ...Object.keys(globals)]);

  // Keys overridden by a higher-priority scope
  const collOverridden = new Set<string>(Object.keys(collVars).filter(k => k in envVars));
  const globalOverridden = new Set<string>(Object.keys(globals).filter(k => k in envVars || k in collVars));

  function winningScope(key: string): ScopeBadge {
    if (key in envVars) return 'ENV';
    if (key in collVars) return 'COLL';
    return 'GLOBAL';
  }

  function isConflict(key: string): boolean {
    const sources = [key in envVars, key in collVars, key in globals].filter(Boolean).length;
    return sources > 1;
  }

  function isResolvedSecret(key: string): boolean {
    return winningScope(key) === 'ENV' && secretEnvKeys.has(key);
  }

  function toggleResolvedReveal(key: string) {
    setRevealedResolved(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const resolvedEntries = [...allKeys]
    .filter(k => {
      if (!filter) return true;
      const lc = filter.toLowerCase();
      if (k.toLowerCase().includes(lc)) return true;
      // Don't leak secret ENV values via filter match
      if (isResolvedSecret(k)) return false;
      return resolved[k]?.toLowerCase().includes(lc);
    })
    .sort((a, b) => a.localeCompare(b));

  return (
    <div className="flex flex-col h-full p-4 overflow-hidden">
      <EnvGlobalsTabBar />

      {/* Header */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <h2 className="text-sm font-semibold text-slate-200">Variable Scope Inspector</h2>
      </div>

      {/* Precedence banner */}
      <div className="flex items-center gap-1.5 mb-3 px-3 py-2 bg-slate-800/60 rounded-lg border border-slate-700 shrink-0 text-xs text-slate-400">
        <span className="font-medium text-slate-300">Resolution order:</span>
        <ScopeTag scope="ENV" />
        <span className="text-slate-600">›</span>
        <ScopeTag scope="COLL" />
        <span className="text-slate-600">›</span>
        <ScopeTag scope="GLOBAL" />
        <span className="ml-1">(leftmost wins)</span>
      </div>

      {/* Filter */}
      <div className="mb-3 shrink-0 relative">
        <IconSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 w-4 h-4 pointer-events-none" />
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter variables…"
          className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 pl-8 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-orange-500"
        />
      </div>

      <div className="flex-1 overflow-y-auto space-y-4 pr-1">
        {/* Resolved table */}
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Resolved Variables</h3>
            <span className="text-[10px] bg-slate-700 text-slate-400 px-1.5 py-0.5 rounded-full">{resolvedEntries.length}</span>
          </div>
          {resolvedEntries.length === 0 ? (
            <p className="text-xs text-slate-600 italic px-1">No variables defined yet.</p>
          ) : (
            <div className="rounded-lg border border-slate-700 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-800 text-slate-500 uppercase tracking-wide text-[10px]">
                    <th className="pl-3 pr-2 py-1.5 text-left font-medium w-1/3">Key</th>
                    <th className="pr-2 py-1.5 text-left font-medium">Value</th>
                    <th className="pr-3 py-1.5 text-right font-medium w-24">Scope</th>
                  </tr>
                </thead>
                <tbody>
                  {resolvedEntries.map(key => {
                    const secret = isResolvedSecret(key);
                    const revealed = revealedResolved.has(key);
                    return (
                    <tr key={key} className="border-t border-slate-800 hover:bg-slate-800/40 transition-colors">
                      <td className="pl-3 pr-2 py-1.5 font-mono text-slate-200 truncate">
                        <span className="flex items-center gap-1.5">
                          {isConflict(key) && (
                            <span title="Defined in multiple scopes" className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                          )}
                          {key}
                        </span>
                      </td>
                      <td className="pr-1 py-1.5 font-mono text-slate-400 truncate max-w-0 w-full">
                        {secret && !revealed ? SECRET_MASK : resolved[key]}
                      </td>
                      <td className="pr-3 py-1.5 text-right whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          {secret && (
                            <button
                              type="button"
                              onClick={() => toggleResolvedReveal(key)}
                              aria-label={revealed ? 'Hide value' : 'Reveal value'}
                              title={revealed ? 'Hide value' : 'Reveal value'}
                              className="p-0.5 rounded text-slate-500 hover:text-slate-300 transition-colors"
                            >
                              {revealed
                                ? <IconEyeOff className="w-3.5 h-3.5" />
                                : <IconEye className="w-3.5 h-3.5" />}
                            </button>
                          )}
                          <ScopeTag scope={winningScope(key)} />
                        </span>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Per-scope sections */}
        <div>
          <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wide mb-2">By Scope</h3>

          <ScopeSection
            title="Environment"
            subtitle={activeEnv ? `(${activeEnv.name})` : '(none active)'}
            vars={envVars}
            overriddenKeys={new Set()}
            filter={filter}
            icon={<IconEnvironments className="w-3.5 h-3.5" />}
            secretKeys={secretEnvKeys}
          />

          <ScopeSection
            title="Collection Variables"
            subtitle={activeCollection ? `(${activeCollection.info.name})` : '(no active request)'}
            vars={collVars}
            overriddenKeys={collOverridden}
            filter={filter}
            icon={<IconCollection className="w-3.5 h-3.5" />}
          />

          <ScopeSection
            title="Globals"
            vars={globals}
            overriddenKeys={globalOverridden}
            filter={filter}
            defaultOpen={false}
            icon={<IconGlobals className="w-3.5 h-3.5" />}
          />
        </div>
      </div>
    </div>
  );
}
