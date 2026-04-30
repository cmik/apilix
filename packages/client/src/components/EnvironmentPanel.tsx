import { useState } from 'react';
import { useApp, generateId } from '../store';
import type { AppEnvironment } from '../types';
import ConfirmModal from './ConfirmModal';
import { normalizeVariableName, storageKeyError } from '../utils/variableUtils';
import { IconEnvironments, IconGlobals, IconScopeInspector, IconSearch, IconClose, IconPlus, IconDownload, IconDelete } from './Icons';

interface EnvEditorProps {
  env: AppEnvironment;
  onSave: (updated: AppEnvironment) => void;
  onCancel: () => void;
}

function EnvEditor({ env, onSave, onCancel }: EnvEditorProps) {
  const [name, setName] = useState(env.name);
  const [rows, setRows] = useState(
    env.values.map(v => ({ ...v }))
  );

  function updateRow(i: number, field: 'key' | 'value', val: string) {
    setRows(r => r.map((row, idx) => (idx === i ? { ...row, [field]: val } : row)));
  }
  function toggleRow(i: number) {
    setRows(r => r.map((row, idx) => (idx === i ? { ...row, enabled: !row.enabled } : row)));
  }
  function removeRow(i: number) {
    setRows(r => r.filter((_, idx) => idx !== i));
  }
  function addRow() {
    setRows(r => [...r, { key: '', value: '', enabled: true, secret: false }]);
  }
  function toggleSecret(i: number) {
    setRows(r => r.map((row, idx) => (idx === i ? { ...row, secret: !row.secret } : row)));
  }

  const hasErrors = rows.some(r => storageKeyError(r.key) !== null);

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Environment name"
          className="flex-1 bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500"
        />
        <button
          onClick={() => onSave({ ...env, name, values: rows.filter(r => r.key.trim()).map(r => ({ ...r, key: normalizeVariableName(r.key) })) })}
          disabled={hasErrors}
          className="px-4 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-sm rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Save
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 text-slate-200 text-sm rounded transition-colors"
        >
          Cancel
        </button>
      </div>
      {hasErrors && (
        <p className="text-xs text-red-400">Fix variable name errors before saving.</p>
      )}

      <div className="overflow-y-auto flex-1">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500 uppercase border-b border-slate-700">
              <th className="py-1.5 text-left w-8"></th>
              <th className="py-1.5 text-left pr-2">Variable</th>
              <th className="py-1.5 text-left">Current Value</th>
              <th className="py-1.5 w-6" title="Secret"></th>
              <th className="w-6"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-slate-800/50">
                <td className="py-1 pr-2">
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    onChange={() => toggleRow(i)}
                    className="accent-orange-500"
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    value={row.key}
                    onChange={e => updateRow(i, 'key', e.target.value)}
                    placeholder="key"
                    title={storageKeyError(row.key) ?? undefined}
                    className={`w-full bg-slate-700/50 border rounded px-2 py-0.5 text-slate-200 font-mono focus:outline-none ${
                      storageKeyError(row.key)
                        ? 'border-red-500 focus:border-red-400'
                        : 'border-transparent focus:border-slate-500'
                    } ${
                      !row.enabled ? 'opacity-40' : ''
                    }`}
                  />
                </td>
                <td className="py-1 pr-2">
                  <input
                    type={row.secret ? 'password' : 'text'}
                    value={row.value}
                    onChange={e => updateRow(i, 'value', e.target.value)}
                    placeholder="value"
                    className={`w-full bg-slate-700/50 border border-transparent focus:border-slate-500 rounded px-2 py-0.5 text-slate-200 font-mono focus:outline-none ${
                      !row.enabled ? 'opacity-40' : ''
                    }`}
                  />
                </td>
                <td className="py-1 pr-1">
                  <button
                    onClick={() => toggleSecret(i)}
                    title={row.secret ? 'Secret — value is encrypted on disk (local only). Remote sync sends plaintext unless \"Encrypt remote data\" is enabled. Click to make plain.' : 'Make secret — value will be encrypted on disk (local only). Enable \"Encrypt remote data\" in sync settings to protect it remotely.'}
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
                  <button onClick={() => removeRow(i)} className="text-slate-600 hover:text-red-400 transition-colors">
                    <IconDelete className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          onClick={addRow}
          className="mt-2 text-xs text-slate-500 hover:text-orange-400 transition-colors flex items-center gap-1.5"
        >
          <IconPlus className="w-3.5 h-3.5" />
          Add variable
        </button>
      </div>
    </div>
  );
}

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

export default function EnvironmentPanel() {
  const { state, dispatch } = useApp();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const [sortAZ, setSortAZ] = useState(false);
  const [pendingDeleteEnv, setPendingDeleteEnv] = useState<AppEnvironment | null>(null);

  const editingEnv = editingId ? state.environments.find(e => e._id === editingId) : null;

  function handleSave(updated: AppEnvironment) {
    dispatch({ type: 'UPDATE_ENVIRONMENT', payload: updated });
    setEditingId(null);
  }

  function handleCreate(env: AppEnvironment) {
    dispatch({ type: 'ADD_ENVIRONMENT', payload: env });
    setCreating(false);
  }

  function handleDelete(id: string) {
    const env = state.environments.find(e => e._id === id);
    if (!env) return;
    setPendingDeleteEnv(env);
  }

  function confirmDeleteEnvironment() {
    if (!pendingDeleteEnv) return;
    dispatch({ type: 'REMOVE_ENVIRONMENT', payload: pendingDeleteEnv._id });
    setPendingDeleteEnv(null);
  }

  if (creating) {
    const blank: AppEnvironment = { _id: generateId(), name: 'New Environment', values: [] };
    return (
      <div className="flex-1 flex flex-col p-4 gap-4 overflow-hidden">
        <EnvGlobalsTabBar />
        <h2 className="text-white font-semibold text-base">New Environment</h2>
        <EnvEditor env={blank} onSave={handleCreate} onCancel={() => setCreating(false)} />
      </div>
    );
  }

  if (editingEnv) {
    return (
      <div className="flex-1 flex flex-col p-4 gap-4 overflow-hidden">
        <EnvGlobalsTabBar />
        <h2 className="text-white font-semibold text-base">Edit: {editingEnv.name}</h2>
        <EnvEditor env={editingEnv} onSave={handleSave} onCancel={() => setEditingId(null)} />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col p-4 gap-4 overflow-hidden">
      <EnvGlobalsTabBar />
      <div className="flex items-center justify-between">
        <h2 className="text-white font-semibold text-base">Environments</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSortAZ(s => !s)}
            disabled={state.environments.length <= 1}
            aria-label={sortAZ ? 'Sorted A–Z (click to restore original order)' : 'Sort environments A–Z'}
            aria-pressed={sortAZ}
            title={sortAZ ? 'Sorted A–Z (click to restore)' : 'Sort A–Z'}
            className={`px-2 py-1.5 text-xs rounded font-medium transition-colors border disabled:opacity-30 disabled:cursor-not-allowed ${
              sortAZ
                ? 'bg-orange-600/20 border-orange-500 text-orange-400'
                : 'bg-slate-700 border-slate-600 text-slate-400 hover:text-slate-200 hover:bg-slate-600'
            }`}
          >
            A–Z
          </button>
          <button
            onClick={() => setCreating(true)}
            className="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-sm rounded font-medium transition-colors flex items-center gap-1.5"
          >
            <IconPlus className="w-4 h-4" />
            New
          </button>
        </div>
      </div>

      {state.environments.length > 0 && (
        <div className="relative">
          <IconSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 w-4 h-4 pointer-events-none" />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter environments…"
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

      {state.environments.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <IconEnvironments className="w-16 h-16 mb-3 text-slate-500" />
          <p className="text-slate-400 text-sm">No environments yet</p>
          <p className="text-slate-600 text-xs mt-1">Import one or create a new one</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2 overflow-y-auto flex-1">
          {state.environments.filter(e => e.name.toLowerCase().includes(filter.toLowerCase())).length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-8">
              <IconSearch className="w-10 h-10 mb-2 text-slate-500" />
              <p className="text-slate-400 text-sm">No environments match</p>
              <p className="text-slate-600 text-xs mt-1">"{filter}"</p>
            </div>
          ) : (
          (sortAZ
            ? [...state.environments].sort((a, b) => a.name.localeCompare(b.name))
            : state.environments
          ).filter(e => e.name.toLowerCase().includes(filter.toLowerCase())).map(env => {
            const isActive = state.activeEnvironmentId === env._id;
            return (
              <div
                key={env._id}
                className={`flex items-center gap-3 p-3 border rounded-lg transition-colors ${
                  isActive ? 'border-orange-500 bg-orange-900/10' : 'border-slate-700 bg-slate-800'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-slate-100 text-sm font-medium truncate">{env.name}</p>
                  <p className="text-slate-500 text-xs mt-0.5">{env.values.filter(v => v.enabled).length} active variable{env.values.filter(v => v.enabled).length !== 1 ? 's' : ''}</p>
                </div>
                <button
                  onClick={() => dispatch({ type: 'SET_ACTIVE_ENV', payload: isActive ? null : env._id })}
                  className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
                    isActive
                      ? 'bg-orange-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  {isActive ? 'Active ✓' : 'Activate'}
                </button>
                <button
                  onClick={() => setEditingId(env._id)}
                  className="px-2 py-1 text-xs text-slate-400 hover:text-white bg-slate-700 hover:bg-slate-600 rounded transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => {
                    const exported = {
                      id: env._id,
                      name: env.name,
                      values: env.values,
                      _postman_variable_scope: 'environment',
                    };
                    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${env.name.replace(/[^a-z0-9_\-. ]/gi, '_')}.postman_environment.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="px-2 py-1 text-xs text-slate-400 hover:text-white bg-slate-700 hover:bg-slate-600 rounded transition-colors"
                  title="Export environment"
                >
                  <IconDownload className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDelete(env._id)}
                  className="px-2 py-1 text-xs text-slate-500 hover:text-red-400 border border-slate-600 hover:border-red-500 rounded transition-colors"
                >
                  <IconDelete className="w-4 h-4" />
                </button>
              </div>
            );
          })
          )}
        </div>
      )}

      {pendingDeleteEnv && (
        <ConfirmModal
          title="Delete environment?"
          message={<>Delete environment <strong className="text-slate-200">{pendingDeleteEnv.name}</strong>? This cannot be undone.</>}
          confirmLabel="Delete"
          danger={true}
          onConfirm={confirmDeleteEnvironment}
          onCancel={() => setPendingDeleteEnv(null)}
        />
      )}
    </div>
  );
}
