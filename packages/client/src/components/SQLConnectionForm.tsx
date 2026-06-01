import VarInput from './VarInput';
import type { SQLConnectionConfig } from '../types';
import type { VariableSuggestion } from '../utils/variableAutocomplete';

interface Props {
  value: SQLConnectionConfig;
  onChange: (next: SQLConnectionConfig) => void;
  variableSuggestions?: VariableSuggestion[];
}

export default function SQLConnectionForm({ value, onChange, variableSuggestions }: Props) {
  function set<K extends keyof SQLConnectionConfig>(key: K, nextValue: SQLConnectionConfig[K]) {
    onChange({ ...value, [key]: nextValue });
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Host</label>
          <VarInput
            value={value.host}
            onChange={v => set('host', v)}
            variableSuggestions={variableSuggestions}
            placeholder="localhost"
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Port</label>
          <input
            type="number"
            min={1}
            max={65535}
            value={value.port}
            onChange={e => set('port', Number(e.target.value) || 0)}
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Username</label>
          <VarInput
            value={value.username}
            onChange={v => set('username', v)}
            variableSuggestions={variableSuggestions}
            placeholder="db_user"
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Password</label>
          <VarInput
            type="password"
            value={value.password}
            onChange={v => set('password', v)}
            variableSuggestions={variableSuggestions}
            placeholder="Supports {{variables}}"
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">Database</label>
        <VarInput
          value={value.database}
          onChange={v => set('database', v)}
          variableSuggestions={variableSuggestions}
          placeholder={value.type === 'mysql' ? 'app_db' : 'public'}
          className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="flex items-center gap-2">
          <input
            id="sql-ssl"
            type="checkbox"
            checked={value.ssl}
            onChange={e => set('ssl', e.target.checked)}
            className="accent-orange-500"
          />
          <label htmlFor="sql-ssl" className="text-sm text-slate-300">Use SSL/TLS</label>
        </div>

        {value.type === 'postgres' && (
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">SSL Mode</label>
            <select
              value={value.sslMode || 'prefer'}
              onChange={e => set('sslMode', e.target.value as SQLConnectionConfig['sslMode'])}
              className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
            >
              <option value="prefer">prefer</option>
              <option value="require">require</option>
              <option value="disable">disable</option>
            </select>
          </div>
        )}
      </div>
    </div>
  );
}
