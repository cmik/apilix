import { useMemo, useState } from 'react';
import { useApp } from '../store';
import type { DatabaseConnection } from '../types';
import { makeDatabasePreset } from '../constants/databasePresets';
import { validateDatabaseConnection } from '../utils/databaseValidator';
import { testDatabaseConnection } from '../api';
import { buildAllVariableSuggestions } from '../utils/variableAutocomplete';
import DatabaseConnectionForm from './DatabaseConnectionForm';

function formatLastTest(value?: string): string {
  if (!value) return 'Never';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Never';
  return d.toLocaleString();
}

function typeBadge(type: DatabaseConnection['type']): string {
  if (type === 'mysql') return 'text-sky-300 bg-sky-700/30 border-sky-600/70';
  if (type === 'postgres') return 'text-emerald-300 bg-emerald-700/30 border-emerald-600/70';
  return 'text-orange-300 bg-orange-700/30 border-orange-600/70';
}

export default function DatabasesTab() {
  const { state, dispatch } = useApp();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DatabaseConnection>(makeDatabasePreset('mysql'));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [formTesting, setFormTesting] = useState(false);
  const [formTestResult, setFormTestResult] = useState<{ ok: boolean; latencyMs?: number; error?: string } | null>(null);

  const variableSuggestions = useMemo(() => {
    const activeEnv = state.environments.find(env => env._id === state.activeEnvironmentId) || null;
    const envVars: Record<string, string> = {};
    (activeEnv?.values || []).forEach(v => {
      if (v.enabled && v.key) envVars[v.key] = v.value;
    });
    const globals: Record<string, string> = {};
    Object.entries(state.globalVariables || {}).forEach(([k, v]) => {
      globals[k] = v;
    });
    return buildAllVariableSuggestions({ ...envVars, ...globals });
  }, [state.activeEnvironmentId, state.environments, state.globalVariables]);

  const runtimeVars = useMemo(() => {
    const activeEnv = state.environments.find(env => env._id === state.activeEnvironmentId) || null;
    const envVars: Record<string, string> = {};
    (activeEnv?.values || []).forEach(v => {
      if (v.enabled && v.key) envVars[v.key] = v.value;
    });
    return {
      ...envVars,
      ...(state.globalVariables || {}),
    };
  }, [state.activeEnvironmentId, state.environments, state.globalVariables]);

  function openCreate() {
    setEditingId(null);
    setDraft(makeDatabasePreset('mysql'));
    setValidationErrors([]);
    setFormTestResult(null);
    setOpen(true);
  }

  function openEdit(db: DatabaseConnection) {
    setEditingId(db._id);
    setDraft({ ...db });
    setValidationErrors([]);
    setFormTestResult(null);
    setOpen(true);
  }

  async function runRowTest(db: DatabaseConnection) {
    setTestingId(db._id);
    try {
      const result = await testDatabaseConnection(db, runtimeVars);
      dispatch({
        type: 'SET_DATABASE_TEST_RESULT',
        payload: {
          databaseId: db._id,
          status: result.ok ? 'success' : 'failed',
          error: result.error,
        },
      });
    } finally {
      setTestingId(null);
    }
  }

  async function runFormTest() {
    const check = validateDatabaseConnection(draft);
    if (!check.valid) {
      setValidationErrors(check.errors);
      setFormTestResult(null);
      return;
    }

    setValidationErrors([]);
    setFormTesting(true);
    try {
      const result = await testDatabaseConnection(draft, runtimeVars);
      setFormTestResult(result);
      if (editingId) {
        dispatch({
          type: 'SET_DATABASE_TEST_RESULT',
          payload: {
            databaseId: editingId,
            status: result.ok ? 'success' : 'failed',
            error: result.error,
          },
        });
      }
    } catch (err) {
      setFormTestResult({ ok: false, error: err instanceof Error ? err.message : 'Connection test failed' });
    } finally {
      setFormTesting(false);
    }
  }

  function saveDraft() {
    const check = validateDatabaseConnection(draft);
    if (!check.valid) {
      setValidationErrors(check.errors);
      return;
    }

    const now = new Date().toISOString();
    const next: DatabaseConnection = {
      ...draft,
      createdAt: draft.createdAt || now,
    };

    if (editingId) {
      dispatch({ type: 'UPDATE_DATABASE', payload: next });
    } else {
      dispatch({ type: 'ADD_DATABASE', payload: next });
    }

    setOpen(false);
    setValidationErrors([]);
    setFormTestResult(null);
    setEditingId(null);
  }

  function remove(dbId: string) {
    dispatch({ type: 'REMOVE_DATABASE', payload: dbId });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Database Connections</h3>
          <p className="text-xs text-slate-400 mt-0.5">Use these connections in scripts via apx.db.query() and apx.db.mongoQuery().</p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="px-3 py-1.5 text-xs rounded bg-orange-600 hover:bg-orange-500 text-white font-medium transition-colors"
        >
          Add Connection
        </button>
      </div>

      {state.databases.length === 0 ? (
        <div className="rounded border border-slate-700 bg-slate-900/50 px-3 py-6 text-center text-sm text-slate-400">
          No database connections yet.
        </div>
      ) : (
        <div className="border border-slate-700 rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-800/70 text-slate-400">
              <tr>
                <th className="text-left px-3 py-2">Name</th>
                <th className="text-left px-3 py-2">Type</th>
                <th className="text-left px-3 py-2">Host / URI</th>
                <th className="text-left px-3 py-2">Last Tested</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-right px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {state.databases.map(db => (
                <tr key={db._id} className="border-t border-slate-800 text-slate-300">
                  <td className="px-3 py-2">{db.name}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 ${typeBadge(db.type)}`}>
                      {db.type}
                    </span>
                  </td>
                  <td className="px-3 py-2 truncate max-w-[250px]" title={db.type === 'mongodb' ? db.connectionUri : `${db.host}:${db.port}/${db.database}`}>
                    {db.type === 'mongodb' ? db.connectionUri : `${db.host}:${db.port}/${db.database}`}
                  </td>
                  <td className="px-3 py-2 text-slate-400">{formatLastTest(db.lastTestedAt)}</td>
                  <td className="px-3 py-2">
                    {db.testStatus === 'success' && <span className="text-green-300 bg-green-900/40 border border-green-700/70 rounded px-1.5 py-0.5">ok</span>}
                    {db.testStatus === 'failed' && <span className="text-red-300 bg-red-900/40 border border-red-700/70 rounded px-1.5 py-0.5" title={db.testError || 'Connection failed'}>failed</span>}
                    {!db.testStatus && <span className="text-slate-500">-</span>}
                  </td>
                  <td className="px-3 py-2 text-right space-x-1">
                    <button
                      type="button"
                      onClick={() => runRowTest(db)}
                      disabled={testingId === db._id}
                      className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 disabled:opacity-40"
                    >
                      {testingId === db._id ? '...' : 'Test'}
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(db)}
                      className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(db._id)}
                      className="px-2 py-1 rounded bg-slate-700 hover:bg-red-800/60 border border-slate-600 text-slate-300 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4">
          <div className="w-full max-w-4xl bg-slate-900 border border-slate-700 rounded-lg shadow-2xl max-h-[90vh] overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-slate-100">{editingId ? 'Edit Connection' : 'Add Connection'}</h4>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                Close
              </button>
            </div>

            <div className="p-4 overflow-y-auto max-h-[calc(90vh-108px)]">
              <DatabaseConnectionForm
                value={draft}
                onChange={setDraft}
                onTestConnection={runFormTest}
                testing={formTesting}
                testResult={formTestResult}
                validationErrors={validationErrors}
                variableSuggestions={variableSuggestions}
              />
            </div>

            <div className="px-4 py-3 border-t border-slate-700 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-3 py-1.5 text-xs rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveDraft}
                className="px-3 py-1.5 text-xs rounded bg-orange-600 hover:bg-orange-500 text-white"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
