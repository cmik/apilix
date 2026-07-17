import { useState, useEffect, useRef } from 'react';
import { buildJsonPathDisplayExpression } from '../utils/testSnippetUtils';

export interface VarEntry {
  name: string;
  currentValue: string;
  scope: 'environment' | 'globals' | 'collection';
}

export interface UpdateVarModalProps {
  path: (string | number)[];
  value: unknown;
  entries: VarEntry[];
  onConfirm: (name: string, scope: 'environment' | 'globals' | 'collection') => void;
  onClose: () => void;
}

function previewValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value.length > 50 ? `"${value.slice(0, 47)}..."` : `"${value}"`;
  }
  const str = String(value);
  return str.length > 50 ? str.slice(0, 47) + '...' : str;
}

export default function UpdateVarModal({ path, value, entries, onConfirm, onClose }: UpdateVarModalProps) {
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState<'update' | 'create'>('update');
  const [newVarName, setNewVarName] = useState('');
  const [newVarScope, setNewVarScope] = useState<'environment' | 'globals' | 'collection'>('environment');
  const filterInputRef = useRef<HTMLInputElement>(null);
  const newVarNameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === 'create') {
      newVarNameInputRef.current?.focus();
    } else {
      filterInputRef.current?.focus();
    }
  }, [mode]);

  // Group entries by scope
  const envVars = entries.filter(e => e.scope === 'environment');
  const collVars = entries.filter(e => e.scope === 'collection');
  const globalVars = entries.filter(e => e.scope === 'globals');

  // Filter all groups
  const filterLower = filter.toLowerCase();
  const filteredEnv = envVars.filter(e => e.name.toLowerCase().includes(filterLower));
  const filteredColl = collVars.filter(e => e.name.toLowerCase().includes(filterLower));
  const filteredGlobal = globalVars.filter(e => e.name.toLowerCase().includes(filterLower));

  const hasNoVariables = entries.length === 0;
  const hasNoMatches = filteredEnv.length === 0 && filteredColl.length === 0 && filteredGlobal.length === 0 && !hasNoVariables;

  function handleApply(name: string, scope: 'environment' | 'globals' | 'collection') {
    onConfirm(name, scope);
  }

  function handleCreateVariable() {
    if (newVarName.trim()) {
      onConfirm(newVarName.trim(), newVarScope);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full max-w-sm mx-4 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 shrink-0">
          <h2 className="text-sm font-semibold text-slate-100">Update or Create Variable</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-200 transition-colors p-1 rounded hover:bg-slate-700"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-4 gap-3">
          {/* Value preview */}
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-slate-500 uppercase tracking-wider">New value</p>
            <div className="bg-slate-800 border border-slate-700 rounded px-3 py-2 flex flex-col gap-1">
              <span className="text-xs font-mono text-orange-400">{buildJsonPathDisplayExpression(path)}</span>
              <span className="text-xs font-mono text-emerald-400 truncate">{previewValue(value)}</span>
            </div>
          </div>

          {/* Mode toggle */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMode('update')}
              className={`flex-1 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                mode === 'update'
                  ? 'bg-orange-500/80 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              Update Existing
            </button>
            <button
              type="button"
              onClick={() => setMode('create')}
              className={`flex-1 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                mode === 'create'
                  ? 'bg-orange-500/80 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              Create New
            </button>
          </div>

          {/* Create new variable section */}
          {mode === 'create' && (
            <div className="flex flex-col gap-2">
              <div>
                <label htmlFor="new-var-name" className="text-xs text-slate-400 font-medium mb-1 block">
                  Variable name
                </label>
                <input
                  id="new-var-name"
                  ref={newVarNameInputRef}
                  type="text"
                  value={newVarName}
                  onChange={e => setNewVarName(e.target.value)}
                  placeholder="e.g., apiKey, userId, token"
                  className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-orange-500 placeholder-slate-500"
                  onKeyDown={e => e.key === 'Enter' && newVarName.trim() && handleCreateVariable()}
                />
              </div>

              <div>
                <label htmlFor="new-var-scope" className="text-xs text-slate-400 font-medium mb-1 block">
                  Scope
                </label>
                <select
                  id="new-var-scope"
                  value={newVarScope}
                  onChange={e => setNewVarScope(e.target.value as 'environment' | 'globals' | 'collection')}
                  className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-orange-500"
                >
                  <option value="environment">Environment</option>
                  <option value="collection">Collection</option>
                  <option value="globals">Globals</option>
                </select>
              </div>

              <button
                type="button"
                onClick={handleCreateVariable}
                disabled={!newVarName.trim()}
                className="w-full px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-600 disabled:text-slate-500 text-white text-xs font-medium rounded transition-colors"
              >
                Create Variable
              </button>
            </div>
          )}

          {/* Update existing variable section */}
          {mode === 'update' && (
            <>
              {/* Filter input */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor="var-filter" className="text-xs text-slate-400 font-medium">
                  Filter variables
                </label>
                <input
                  id="var-filter"
                  ref={filterInputRef}
                  type="text"
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                  placeholder="Search by name…"
                  className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-orange-500 placeholder-slate-500"
                />
              </div>

              {/* Variable list */}
              {hasNoVariables ? (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-xs text-slate-500 text-center">No variables defined yet</p>
                </div>
              ) : hasNoMatches ? (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-xs text-slate-500 text-center">No matching variables</p>
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto">
                  <div className="space-y-3 pr-1">
                    {/* Environment variables */}
                    {filteredEnv.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Environment</p>
                        <div className="space-y-1">
                          {filteredEnv.map(e => (
                            <button
                              key={`${e.scope}::${e.name}`}
                              onClick={() => handleApply(e.name, e.scope)}
                              className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700/60 rounded border border-slate-700 hover:border-orange-500/50 transition-colors text-left text-xs group"
                            >
                              <span className="font-mono text-slate-200 group-hover:text-slate-100 truncate flex-1">{e.name}</span>
                              <span className="text-slate-500 group-hover:text-slate-400 text-[10px] truncate flex-shrink-0 max-w-[80px]" title={e.currentValue}>{e.currentValue}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Collection variables */}
                    {filteredColl.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Collection</p>
                        <div className="space-y-1">
                          {filteredColl.map(e => (
                            <button
                              key={`${e.scope}::${e.name}`}
                              onClick={() => handleApply(e.name, e.scope)}
                              className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700/60 rounded border border-slate-700 hover:border-orange-500/50 transition-colors text-left text-xs group"
                            >
                              <span className="font-mono text-slate-200 group-hover:text-slate-100 truncate flex-1">{e.name}</span>
                              <span className="text-slate-500 group-hover:text-slate-400 text-[10px] truncate flex-shrink-0 max-w-[80px]" title={e.currentValue}>{e.currentValue}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Global variables */}
                    {filteredGlobal.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Globals</p>
                        <div className="space-y-1">
                          {filteredGlobal.map(e => (
                            <button
                              key={`${e.scope}::${e.name}`}
                              onClick={() => handleApply(e.name, e.scope)}
                              className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700/60 rounded border border-slate-700 hover:border-orange-500/50 transition-colors text-left text-xs group"
                            >
                              <span className="font-mono text-slate-200 group-hover:text-slate-100 truncate flex-1">{e.name}</span>
                              <span className="text-slate-500 group-hover:text-slate-400 text-[10px] truncate flex-shrink-0 max-w-[80px]" title={e.currentValue}>{e.currentValue}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-slate-700 shrink-0">
          <p className="text-xs text-slate-600">
            {mode === 'create'
              ? 'Create a new variable with the response value'
              : 'Click a variable to update it with the new value'}
          </p>
        </div>
      </div>
    </div>
  );
}
