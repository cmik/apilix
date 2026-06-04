import VarInput from './VarInput';
import type { MongoDBConnectionConfig } from '../types';
import type { VariableSuggestion } from '../utils/variableAutocomplete';

interface Props {
  value: MongoDBConnectionConfig;
  onChange: (next: MongoDBConnectionConfig) => void;
  variableSuggestions?: VariableSuggestion[];
}

type AuthMode = NonNullable<MongoDBConnectionConfig['auth']>['mode'];
type AuthModeSelectValue = AuthMode | 'none';

export default function MongoDBConnectionForm({ value, onChange, variableSuggestions }: Props) {
  const selectedAuthMode: AuthModeSelectValue = value.auth?.mode || 'none';

  function set<K extends keyof MongoDBConnectionConfig>(key: K, nextValue: MongoDBConnectionConfig[K]) {
    onChange({ ...value, [key]: nextValue });
  }

  function setAuthField<K extends keyof NonNullable<MongoDBConnectionConfig['auth']>>(key: K, nextValue: NonNullable<MongoDBConnectionConfig['auth']>[K]) {
    onChange({
      ...value,
      auth: {
        mode: value.auth?.mode || 'scram',
        ...(value.auth || {}),
        [key]: nextValue,
      },
    });
  }

  function setAuthMode(nextMode: AuthModeSelectValue) {
    if (nextMode === 'none') {
      onChange({
        ...value,
        auth: undefined,
      });
      return;
    }

    const nextAuth: NonNullable<MongoDBConnectionConfig['auth']> = {
      ...(value.auth || {}),
      mode: nextMode,
    };

    if (nextMode === 'x509' || nextMode === 'oidc') {
      // Keep non-password auth modes clean to avoid stale hidden credentials.
      delete nextAuth.username;
      delete nextAuth.password;
    }

    onChange({
      ...value,
      auth: nextAuth,
    });
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

      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">Default Database</label>
        <VarInput
          value={value.database || ''}
          onChange={v => set('database', v)}
          variableSuggestions={variableSuggestions}
          placeholder="app  or  {{mongoDb}}"
          className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
        />
      </div>

      <div className="rounded border border-slate-700 bg-slate-900/60 px-3 py-3 space-y-3">
        <div className="text-xs font-medium text-slate-300">Authentication Settings</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Auth Mode</label>
            <select
              value={selectedAuthMode}
              onChange={e => setAuthMode(e.target.value as AuthModeSelectValue)}
              className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
            >
              <option value="none">None</option>
              <option value="scram">SCRAM (username + password)</option>
              <option value="x509">X.509 certificate</option>
              <option value="ldap-plain">LDAP / PLAIN</option>
              <option value="oidc">OIDC workload identity</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Auth Source DB</label>
            <VarInput
              value={value.auth?.authSource || ''}
              onChange={v => setAuthField('authSource', v)}
              variableSuggestions={variableSuggestions}
              placeholder="admin"
              className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
            />
          </div>
        </div>
        {(selectedAuthMode === 'scram' || selectedAuthMode === 'ldap-plain') && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Login</label>
              <VarInput
                value={value.auth?.username || ''}
                onChange={v => setAuthField('username', v)}
                variableSuggestions={variableSuggestions}
                placeholder="{{mongoUser}}"
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Password</label>
              <VarInput
                value={value.auth?.password || ''}
                onChange={v => setAuthField('password', v)}
                variableSuggestions={variableSuggestions}
                placeholder="{{mongoPassword}}"
                className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
              />
            </div>
          </div>
        )}
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
