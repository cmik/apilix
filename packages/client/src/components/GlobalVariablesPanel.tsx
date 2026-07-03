import { useState, useEffect } from 'react';
import { useApp } from '../store';
import { normalizeVariableName, storageKeyError } from '../utils/variableUtils';
import { IconEnvironments, IconGlobals, IconScopeInspector, IconSearch, IconClose, IconPlus, IconDelete, IconSuccess } from './Icons';

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

interface Row {
  key: string;
  value: string;
  secret?: boolean;
}

export default function GlobalVariablesPanel() {
  const { state, dispatch } = useApp();
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(state.globalVariables).map(([key, value]) => ({
      key,
      value,
      secret: state.globalVariableMeta?.[key]?.secret === true,
    }))
  );
  const [filter, setFilter] = useState('');
  const [saved, setSaved] = useState(false);

  // Re-sync local rows if globalVariables changes externally (e.g. from a script)
  useEffect(() => {
    setRows(Object.entries(state.globalVariables).map(([key, value]) => ({
      key,
      value,
      secret: state.globalVariableMeta?.[key]?.secret === true,
    })));
  }, [state.globalVariables, state.globalVariableMeta]);

  function updateRow(i: number, field: 'key' | 'value', val: string) {
    setRows(r => r.map((row, idx) => (idx === i ? { ...row, [field]: val } : row)));
  }

  function removeRow(i: number) {
    setRows(r => r.filter((_, idx) => idx !== i));
  }

  function addRow() {
    setRows(r => [...r, { key: '', value: '' }]);
  }

  function toggleSecret(i: number) {
    setRows(r => r.map((row, idx) => (idx === i ? { ...row, secret: !row.secret } : row)));
  }

  function save() {
    const hasErrors = rows.some(r => storageKeyError(r.key) !== null);
    if (hasErrors) return;
    const result: Record<string, string> = {};
    const meta: Record<string, { secret?: boolean }> = {};
    rows.forEach(r => {
      const normalized = normalizeVariableName(r.key);
      if (normalized) {
        result[normalized] = r.value;
        if (r.secret) meta[normalized] = { secret: true };
      }
    });
    dispatch({ type: 'SET_GLOBAL_VARS_WITH_META', payload: { values: result, meta } });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function handleExport() {
    const payload = {
      id: 'globals',
      name: 'Apilix Globals',
      values: rows
        .filter(r => r.key.trim())
        .map(r => ({ key: r.key, value: r.value, enabled: true, type: 'any', secret: r.secret === true })),
      _postman_variable_scope: 'globals',
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'apilix_globals.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const parsed = JSON.parse(e.target?.result as string);
          const values: Array<{ key: string; value: string; enabled?: boolean; secret?: boolean }> =
            Array.isArray(parsed.values) ? parsed.values : [];
          const imported = values
            .filter(v => v.enabled !== false && v.key)
            .map(v => ({ key: v.key, value: v.value ?? '', secret: v.secret === true }));
          setRows(imported);
        } catch {
          alert('Failed to parse the JSON file.');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  const filteredIndices = rows
    .map((row, i) => ({ row, i }))
    .filter(({ row }) =>
      !filter.trim() ||
      row.key.toLowerCase().includes(filter.toLowerCase()) ||
      row.value.toLowerCase().includes(filter.toLowerCase())
    );

  const savedCount = Object.keys(state.globalVariables).length;

  return (
    <div className="flex-1 flex flex-col p-4 gap-4 overflow-hidden">
      {/* Tab strip */}
      <EnvGlobalsTabBar />

      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-white font-semibold text-base">Global Variables</h2>
          {savedCount > 0 && (
            <span className="bg-slate-700 text-slate-400 text-xs font-medium px-2 py-0.5 rounded-full">
              {savedCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleImport}
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 text-xs rounded font-medium transition-colors"
          >
            Import
          </button>
          <button
            onClick={handleExport}
            disabled={rows.filter(r => r.key.trim()).length === 0}
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 text-xs rounded font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Export
          </button>
          <button
            onClick={save}
            disabled={rows.some(r => storageKeyError(r.key) !== null)}
            className={`px-4 py-1.5 text-white text-sm rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 ${
              saved ? 'bg-green-600 hover:bg-green-500' : 'bg-orange-600 hover:bg-orange-500'
            }`}
          >
            {saved && <IconSuccess className="w-4 h-4" />}
            {saved ? 'Saved' : 'Save'}
          </button>
        </div>
      </div>

      {/* Description */}
      <p className="text-slate-500 text-xs shrink-0">
        Global variables are available in all requests across all collections. They are resolved after collection variables and before data rows.
      </p>

      {/* Filter */}
      {rows.length > 3 && (
        <div className="relative shrink-0">
          <IconSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 w-4 h-4 pointer-events-none" />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter variables…"
            className="w-full bg-slate-700/60 border border-slate-600 rounded px-3 py-1.5 pl-7 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-orange-500"
          />
          {filter && (
            <button
              onClick={() => setFilter('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
            >
              <IconClose className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <IconGlobals className="w-16 h-16 mb-3 text-slate-500" />
            <p className="text-slate-400 text-sm">No global variables yet</p>
            <p className="text-slate-600 text-xs mt-1">
              Add variables below or import from a Postman globals file
            </p>
            <button
              onClick={addRow}
              className="mt-4 px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white text-sm rounded font-medium transition-colors flex items-center gap-1.5"
            >
              <IconPlus className="w-4 h-4" />
              Add variable
            </button>
          </div>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 uppercase border-b border-slate-700">
                  <th className="py-1.5 text-left pr-2">Variable</th>
                  <th className="py-1.5 text-left">Value</th>
                  <th className="py-1.5 w-6" title="Secret"></th>
                  <th className="w-6"></th>
                </tr>
              </thead>
              <tbody>
                {filteredIndices.map(({ row, i }) => {
                  const keyErr = storageKeyError(row.key);
                  return (
                    <tr key={i} className="border-b border-slate-800/50 group">
                      <td className="py-1 pr-2">
                        <input
                          value={row.key}
                          onChange={e => updateRow(i, 'key', e.target.value)}
                          placeholder="variable_name"
                          title={keyErr ?? undefined}
                          className={`w-full bg-slate-700/50 border rounded px-2 py-0.5 text-slate-200 font-mono text-xs focus:outline-none placeholder-slate-600 ${
                            keyErr ? 'border-red-500 focus:border-red-400' : 'border-transparent focus:border-slate-500'
                          }`}
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          type={row.secret ? 'password' : 'text'}
                          value={row.value}
                          onChange={e => updateRow(i, 'value', e.target.value)}
                          placeholder="value"
                          className="w-full bg-slate-700/50 border border-transparent focus:border-slate-500 rounded px-2 py-0.5 text-slate-200 font-mono text-xs focus:outline-none placeholder-slate-600"
                        />
                      </td>
                      <td className="py-1 pr-1">
                        <button
                          onClick={() => toggleSecret(i)}
                          title={row.secret ? 'Secret — value is encrypted on disk (local only). Remote sync sends plaintext unless "Encrypt remote data" is enabled. Click to make plain.' : 'Make secret — value will be encrypted on disk (local only). Enable "Encrypt remote data" in sync settings to protect it remotely.'}
                          className={`p-0.5 rounded transition-colors ${
                            row.secret
                              ? 'text-orange-400 hover:text-orange-300'
                              : 'text-slate-600 hover:text-slate-400'
                          }`}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                            {row.secret ? (
                              <>
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                              </>
                            ) : (
                              <>
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                                <line x1="2" y1="2" x2="22" y2="22" />
                              </>
                            )}
                          </svg>
                        </button>
                      </td>
                      <td className="py-1">
                        <button
                          onClick={() => removeRow(i)}
                          className="text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Remove variable"
                        >
                          <IconDelete className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filter && filteredIndices.length === 0 && (
              <div className="text-center py-6 text-slate-500 text-sm">
                No variables match "{filter}"
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      {rows.length > 0 && (
        <div className="shrink-0 flex items-center justify-between border-t border-slate-700 pt-2">
          <button
            onClick={addRow}
            className="text-xs text-slate-500 hover:text-orange-400 transition-colors flex items-center gap-1.5"
          >
            <IconPlus className="w-3.5 h-3.5" />
            Add variable
          </button>
          {rows.length > 0 && (
            <span className="text-xs text-slate-600">
              {rows.filter(r => r.key.trim()).length} variable{rows.filter(r => r.key.trim()).length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
