import VarInput from './VarInput';
import type { MongoDBConnectionConfig } from '../types';
import type { VariableSuggestion } from '../utils/variableAutocomplete';

interface Props {
  value: MongoDBConnectionConfig;
  onChange: (next: MongoDBConnectionConfig) => void;
  variableSuggestions?: VariableSuggestion[];
}

export default function MongoDBConnectionForm({ value, onChange, variableSuggestions }: Props) {
  function set<K extends keyof MongoDBConnectionConfig>(key: K, nextValue: MongoDBConnectionConfig[K]) {
    onChange({ ...value, [key]: nextValue });
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">Connection URI</label>
        <VarInput
          value={value.connectionUri}
          onChange={v => set('connectionUri', v)}
          variableSuggestions={variableSuggestions}
          placeholder="mongodb://user:pass@localhost:27017/app"
          className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
        />
        <p className="mt-1 text-[11px] text-slate-500">Supports mongodb:// and mongodb+srv:// with {'{{variables}}'}.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Auth Mechanism</label>
          <select
            value={value.authMechanism || 'SCRAM-SHA-256'}
            onChange={e => set('authMechanism', e.target.value as MongoDBConnectionConfig['authMechanism'])}
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
          >
            <option value="SCRAM-SHA-256">SCRAM-SHA-256</option>
            <option value="SCRAM-SHA-1">SCRAM-SHA-1</option>
            <option value="MONGODB-X509">MONGODB-X509</option>
            <option value="MONGODB-CR">MONGODB-CR</option>
          </select>
        </div>
        <div className="flex items-center gap-2 md:pt-6">
          <input
            id="mongo-ssl"
            type="checkbox"
            checked={value.ssl}
            onChange={e => set('ssl', e.target.checked)}
            className="accent-orange-500"
          />
          <label htmlFor="mongo-ssl" className="text-sm text-slate-300">Use TLS</label>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">CA File Path</label>
          <VarInput
            value={value.sslCAPath || ''}
            onChange={v => set('sslCAPath', v)}
            variableSuggestions={variableSuggestions}
            placeholder="/path/to/ca.pem"
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Client Cert Path</label>
          <VarInput
            value={value.sslCertPath || ''}
            onChange={v => set('sslCertPath', v)}
            variableSuggestions={variableSuggestions}
            placeholder="/path/to/client.pem"
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Client Key Path</label>
          <VarInput
            value={value.sslKeyPath || ''}
            onChange={v => set('sslKeyPath', v)}
            variableSuggestions={variableSuggestions}
            placeholder="/path/to/client.key"
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
          />
        </div>
      </div>
    </div>
  );
}
