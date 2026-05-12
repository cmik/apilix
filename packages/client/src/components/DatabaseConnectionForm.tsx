import SQLConnectionForm from './SQLConnectionForm';
import MongoDBConnectionForm from './MongoDBConnectionForm';
import { makeDatabasePreset } from '../constants/databasePresets';
import type { DatabaseConnection, DatabaseType, MongoDBConnectionConfig, SQLConnectionConfig } from '../types';
import type { VariableSuggestion } from '../utils/variableAutocomplete';

interface Props {
  value: DatabaseConnection;
  onChange: (next: DatabaseConnection) => void;
  onTestConnection: () => void;
  testing: boolean;
  testResult: { ok: boolean; latencyMs?: number; error?: string } | null;
  validationErrors: string[];
  variableSuggestions?: VariableSuggestion[];
}

export default function DatabaseConnectionForm({
  value,
  onChange,
  onTestConnection,
  testing,
  testResult,
  validationErrors,
  variableSuggestions,
}: Props) {
  function setType(nextType: DatabaseType) {
    if (nextType === value.type) return;
    const preset = makeDatabasePreset(nextType);
    onChange({
      ...preset,
      _id: value._id,
      name: value.name,
      createdAt: value.createdAt,
    });
  }

  function setCommonField<K extends keyof DatabaseConnection>(key: K, nextValue: DatabaseConnection[K]) {
    onChange({ ...value, [key]: nextValue });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Connection Name</label>
          <input
            type="text"
            value={value.name}
            onChange={e => setCommonField('name', e.target.value)}
            placeholder="e.g. Production Read Replica"
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Type</label>
          <select
            value={value.type}
            onChange={e => setType(e.target.value as DatabaseType)}
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
          >
            <option value="mysql">MySQL</option>
            <option value="postgres">PostgreSQL</option>
            <option value="mongodb">MongoDB</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Connection Timeout (ms)</label>
          <input
            type="number"
            min={100}
            max={120000}
            value={value.connectionTimeout ?? 10000}
            onChange={e => setCommonField('connectionTimeout', Number(e.target.value) || 10000)}
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Query Timeout (ms)</label>
          <input
            type="number"
            min={100}
            max={600000}
            value={value.queryTimeout ?? 30000}
            onChange={e => setCommonField('queryTimeout', Number(e.target.value) || 30000)}
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Max Connections</label>
          <input
            type="number"
            min={1}
            max={50}
            value={value.maxConnections ?? 5}
            onChange={e => setCommonField('maxConnections', Number(e.target.value) || 5)}
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
          />
        </div>
      </div>

      {value.type === 'mongodb' ? (
        <MongoDBConnectionForm
          value={value as MongoDBConnectionConfig}
          onChange={next => onChange(next)}
          variableSuggestions={variableSuggestions}
        />
      ) : (
        <SQLConnectionForm
          value={value as SQLConnectionConfig}
          onChange={next => onChange(next)}
          variableSuggestions={variableSuggestions}
        />
      )}

      {validationErrors.length > 0 && (
        <div className="rounded border border-red-700/70 bg-red-900/30 px-3 py-2 text-xs text-red-300 space-y-1">
          {validationErrors.map(err => (
            <div key={err}>- {err}</div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onTestConnection}
          disabled={testing}
          className="px-3 py-1.5 text-xs rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 transition-colors disabled:opacity-40"
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>

        {testResult && (
          <span className={`text-xs px-2 py-1 rounded border ${testResult.ok ? 'bg-green-900/30 border-green-700/70 text-green-300' : 'bg-red-900/30 border-red-700/70 text-red-300'}`}>
            {testResult.ok ? `Connected (${testResult.latencyMs ?? 0} ms)` : testResult.error || 'Connection failed'}
          </span>
        )}
      </div>
    </div>
  );
}
