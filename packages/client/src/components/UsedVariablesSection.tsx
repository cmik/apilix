import { useState, useEffect, useMemo } from 'react';
import { useApp } from '../store';
import { extractUsedVariables } from '../utils/variableResolver';
import type { MongoUsedVariable, MongoUsedVarScope } from '../utils/variableResolver';
import { IconEye, IconEyeOff } from './Icons';

// ─── Scope badge helpers ─────────────────────────────────────────────────────

const SCOPE_BADGE: Record<MongoUsedVarScope, { label: string; cls: string }> = {
  ENV:            { label: 'ENV',    cls: 'bg-sky-900 text-sky-300' },
  COLL:           { label: 'COLL',   cls: 'bg-purple-900 text-purple-300' },
  GLOBAL:         { label: 'GLOBAL', cls: 'bg-slate-700 text-slate-300' },
  COLLECTION_DEF: { label: 'COL-DEF', cls: 'bg-slate-700 text-slate-400' },
  DYNAMIC:        { label: 'DYNAMIC', cls: 'bg-emerald-900 text-emerald-300' },
  UNRESOLVED:     { label: 'UNRESOLVED', cls: 'bg-red-900 text-red-300' },
};

const DEFAULT_EDIT_SCOPE: 'env' | 'coll' | 'global' = 'env';

// ─── Used Variables panel ────────────────────────────────────────────────────

export function UsedVariablesSection({
  usedVars,
  hasActiveEnv,
  secretKeys,
  onVarEdit,
}: {
  usedVars: MongoUsedVariable[];
  hasActiveEnv: boolean;
  /** Keys whose values should be masked (bullets) until the user reveals them */
  secretKeys?: Set<string>;
  onVarEdit: (name: string, value: string, scope: 'env' | 'coll' | 'global') => void;
}) {
  const [open, setOpen] = useState(true);
  const [pendingEdits, setPendingEdits] = useState<Record<string, string>>({});
  const [createScopes, setCreateScopes] = useState<Record<string, 'env' | 'coll' | 'global'>>({});
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());

  // Reset revealed state whenever the active environment changes (secretKeys reference changes)
  useEffect(() => { setRevealedKeys(new Set()); }, [secretKeys]);

  if (usedVars.length === 0) return null;

  const unresolvedCount = usedVars.filter(v => v.scope === 'UNRESOLVED').length;

  function scopeForVar(v: MongoUsedVariable): 'env' | 'coll' | 'global' {
    if (v.scope === 'ENV')    return 'env';
    if (v.scope === 'COLL')   return 'coll';
    if (v.scope === 'GLOBAL') return 'global';
    // UNRESOLVED — use user-chosen scope or sensible default
    return createScopes[v.name] ?? (hasActiveEnv ? DEFAULT_EDIT_SCOPE : 'global');
  }

  function handleApply(v: MongoUsedVariable) {
    const value = pendingEdits[v.name] ?? v.resolvedValue;
    onVarEdit(v.name, value, scopeForVar(v));
    setPendingEdits(prev => { const next = { ...prev }; delete next[v.name]; return next; });
  }

  function handleKeyDown(e: React.KeyboardEvent, v: MongoUsedVariable) {
    if (e.key === 'Enter') { e.preventDefault(); handleApply(v); }
  }

  function toggleReveal(name: string) {
    setRevealedKeys(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  return (
    <div className="border-t border-slate-700 shrink-0">
      {open && (
        <div className="bg-slate-900/40 max-h-64 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 uppercase tracking-wide text-[10px] border-b border-slate-800">
                <th className="pl-3 pr-2 py-1.5 text-left font-medium w-32">Variable</th>
                <th className="pr-2 py-1.5 text-left font-medium w-24">Scope</th>
                <th className="pr-3 py-1.5 text-left font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {usedVars.map(v => {
                const badge = SCOPE_BADGE[v.scope];
                const pendingValue = pendingEdits[v.name];
                const displayValue = pendingValue !== undefined ? pendingValue : v.resolvedValue;
                const isDirty = pendingValue !== undefined && pendingValue !== v.resolvedValue;
                const isSecret = secretKeys?.has(v.name) ?? false;
                const isRevealed = revealedKeys.has(v.name);

                return (
                  <tr key={v.name} className="border-t border-slate-800 hover:bg-slate-800/30">
                    {/* Name */}
                    <td className="pl-3 pr-2 py-1.5 font-mono text-slate-200 truncate max-w-0 w-32">
                      <span title={v.name} className="truncate block">{v.name}</span>
                    </td>

                    {/* Scope badge */}
                    <td className="pr-2 py-1.5 w-24">
                      {v.scope === 'UNRESOLVED' ? (
                        <select
                          value={createScopes[v.name] ?? (hasActiveEnv ? 'env' : 'global')}
                          onChange={e => setCreateScopes(prev => ({ ...prev, [v.name]: e.target.value as 'env' | 'coll' | 'global' }))}
                          className="bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-[10px] text-slate-300 focus:outline-none focus:border-orange-500"
                        >
                          {hasActiveEnv && <option value="env">ENV</option>}
                          <option value="coll">COLL</option>
                          <option value="global">GLOBAL</option>
                        </select>
                      ) : (
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase leading-none ${badge.cls}`}>
                          {badge.label}
                        </span>
                      )}
                    </td>

                    {/* Value / action */}
                    <td className="pr-3 py-1.5">
                      {v.scope === 'DYNAMIC' ? (
                        <span className="text-slate-500 italic">auto-generated at send</span>
                      ) : v.scope === 'COLLECTION_DEF' ? (
                        <span className="font-mono text-slate-400 text-[11px]" title={v.resolvedValue}>
                          {v.resolvedValue || <span className="italic text-slate-600">empty</span>}
                          <span className="ml-2 text-slate-600 non-italic">(collection settings)</span>
                        </span>
                      ) : (
                        <div className="flex items-center gap-1">
                          <input
                            type={isSecret && !isRevealed ? 'password' : 'text'}
                            value={displayValue}
                            onChange={e => setPendingEdits(prev => ({ ...prev, [v.name]: e.target.value }))}
                            onKeyDown={e => handleKeyDown(e, v)}
                            placeholder={v.scope === 'UNRESOLVED' ? 'enter value…' : undefined}
                            className={`flex-1 bg-slate-800 border rounded px-2 py-0.5 font-mono text-[11px] text-slate-200 focus:outline-none min-w-0 ${
                              v.scope === 'UNRESOLVED'
                                ? 'border-red-700 focus:border-red-500'
                                : isDirty
                                  ? 'border-orange-600 focus:border-orange-400'
                                  : 'border-slate-600 focus:border-orange-500'
                            }`}
                          />
                          {isSecret && (
                            <button
                              type="button"
                              onClick={() => toggleReveal(v.name)}
                              aria-label={isRevealed ? 'Hide value' : 'Reveal value'}
                              title={isRevealed ? 'Hide value' : 'Reveal value'}
                              className="shrink-0 p-0.5 rounded text-slate-500 hover:text-slate-300 transition-colors"
                            >
                              {isRevealed
                                ? <IconEyeOff className="w-3 h-3" />
                                : <IconEye className="w-3 h-3" />}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleApply(v)}
                            title={v.scope === 'UNRESOLVED' ? 'Create variable' : 'Apply value'}
                            aria-label={v.scope === 'UNRESOLVED' ? 'Create variable' : 'Apply value'}
                            className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                              v.scope === 'UNRESOLVED'
                                ? 'bg-orange-700 hover:bg-orange-600 text-white'
                                : isDirty
                                  ? 'bg-orange-700 hover:bg-orange-600 text-white'
                                  : 'bg-slate-700 hover:bg-slate-600 text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {v.scope === 'UNRESOLVED' ? 'Create' : 'Apply'}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {/* Section header */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 bg-slate-800 hover:bg-slate-750 text-left"
      >
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
          </svg>
          <span className="text-xs font-semibold text-slate-300">Used Variables</span>
          <span className="text-[10px] bg-slate-700 text-slate-400 px-1.5 py-0.5 rounded-full">{usedVars.length}</span>
          {unresolvedCount > 0 && (
            <span className="text-[10px] bg-red-900 text-red-300 px-1.5 py-0.5 rounded-full">
              {unresolvedCount} unresolved
            </span>
          )}
        </div>
        <svg className={`w-3.5 h-3.5 text-slate-500 transition-transform ${open ? '' : 'rotate-180'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

    </div>
  );
}

/**
 * Used Variables dock for a whole request: scans `text` for `{{vars}}`, resolves them
 * against the active scopes and writes edits back to the right store scope.
 */
export function RequestUsedVariables({
  text,
  collectionId,
  envVars,
  collVars,
  collectionDefinitionVars,
}: {
  text: string;
  collectionId?: string;
  envVars: Record<string, string>;
  collVars: Record<string, string>;
  collectionDefinitionVars: Record<string, string>;
}) {
  const { state, dispatch, getActiveEnvironment } = useApp();
  const globals = state.globalVariables;

  const usedVars = useMemo(
    () => extractUsedVariables(text, envVars, collVars, globals, collectionDefinitionVars),
    [text, envVars, collVars, globals, collectionDefinitionVars],
  );
  const secretKeys = useMemo<Set<string>>(() => {
    const keys = new Set<string>();
    const activeEnv = getActiveEnvironment();
    if (activeEnv) {
      for (const v of activeEnv.values) {
        if (v.secret && v.enabled !== false) keys.add(v.key);
      }
    }
    for (const [key, meta] of Object.entries(state.globalVariableMeta ?? {})) {
      if (meta?.secret === true) keys.add(key);
    }
    return keys;
  }, [getActiveEnvironment, state.globalVariableMeta]);

  return (
    <UsedVariablesSection
      usedVars={usedVars}
      hasActiveEnv={!!state.activeEnvironmentId}
      secretKeys={secretKeys}
      onVarEdit={(name, value, scope) => {
        if (scope === 'env') {
          dispatch({ type: 'UPDATE_ACTIVE_ENV_VARS', payload: { [name]: value } });
        } else if (scope === 'coll' && collectionId) {
          dispatch({ type: 'UPDATE_COLLECTION_VARS', payload: { collectionId, vars: { [name]: value } } });
        } else {
          dispatch({ type: 'UPDATE_GLOBAL_VARS', payload: { [name]: value } });
        }
      }}
    />
  );
}
