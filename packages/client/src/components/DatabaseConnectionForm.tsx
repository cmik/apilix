import SQLConnectionForm from './SQLConnectionForm';
import MongoDBConnectionForm from './MongoDBConnectionForm';
import { makeDatabasePreset } from '../constants/databasePresets';
import type { DatabaseConnection, DatabaseType, MongoDBConnectionConfig, SQLConnectionConfig } from '../types';
import type { VariableSuggestion } from '../utils/variableAutocomplete';

const MAX_CONNECTIONS_TYPES: DatabaseType[] = ['mysql', 'postgres', 'mongodb', 'redis', 'cassandra', 'oracle', 'mssql'];
const TYPE_OPTIONS: Array<{ value: DatabaseType; label: string }> = [
  { value: 'mysql', label: 'MySQL' },
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'mongodb', label: 'MongoDB' },
  { value: 'sqlite', label: 'SQLite' },
  { value: 'redis', label: 'Redis' },
  { value: 'cassandra', label: 'Cassandra' },
  { value: 'dynamodb', label: 'DynamoDB' },
  { value: 'oracle', label: 'Oracle' },
  { value: 'mssql', label: 'MSSQL' },
];

function supportsMaxConnections(type: DatabaseType): boolean {
  return MAX_CONNECTIONS_TYPES.includes(type);
}

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

  const inputClass = 'w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500';
  const labelClass = 'block text-xs font-medium text-slate-400 mb-1';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Connection Name</label>
          <input
            type="text"
            value={value.name}
            onChange={e => setCommonField('name', e.target.value)}
            placeholder="e.g. Production Read Replica"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Type</label>
          <select
            value={value.type}
            onChange={e => setType(e.target.value as DatabaseType)}
            className={inputClass}
          >
            {TYPE_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className={labelClass}>Connection Timeout (ms)</label>
          <input
            type="number"
            min={100}
            max={120000}
            value={value.connectionTimeout ?? 10000}
            onChange={e => setCommonField('connectionTimeout', Number(e.target.value) || 10000)}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Query Timeout (ms)</label>
          <input
            type="number"
            min={100}
            max={600000}
            value={value.queryTimeout ?? 30000}
            onChange={e => setCommonField('queryTimeout', Number(e.target.value) || 30000)}
            className={inputClass}
          />
        </div>
        {supportsMaxConnections(value.type) && (
          <div>
            <label className={labelClass}>Max Connections</label>
            <input
              type="number"
              min={1}
              max={50}
              value={('maxConnections' in value ? value.maxConnections : undefined) ?? 5}
              onChange={e => onChange({ ...value, maxConnections: Number(e.target.value) || 5 } as DatabaseConnection)}
              className={inputClass}
            />
          </div>
        )}
      </div>

      {value.type === 'mongodb' ? (
        <MongoDBConnectionForm
          value={value as MongoDBConnectionConfig}
          onChange={next => onChange(next)}
          variableSuggestions={variableSuggestions}
        />
      ) : (value.type === 'mysql' || value.type === 'postgres') ? (
        <SQLConnectionForm
          value={value as SQLConnectionConfig}
          onChange={next => onChange(next)}
          variableSuggestions={variableSuggestions}
        />
      ) : value.type === 'sqlite' ? (
        <div className="space-y-3 rounded border border-slate-700 bg-slate-900/60 px-3 py-3">
          <div>
            <label className={labelClass}>Database File Path</label>
            <input
              type="text"
              value={(value as Extract<DatabaseConnection, { type: 'sqlite' }>).filePath}
              onChange={e => onChange({ ...value, filePath: e.target.value })}
              placeholder="/path/to/database.sqlite"
              className={inputClass}
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
            <input
              type="checkbox"
              className="accent-orange-500"
              checked={(value as Extract<DatabaseConnection, { type: 'sqlite' }>).readonly ?? false}
              onChange={e => onChange({ ...value, readonly: e.target.checked })}
            />
            <span>Open read-only</span>
          </label>
        </div>
      ) : value.type === 'redis' ? (
        <div className="space-y-3 rounded border border-slate-700 bg-slate-900/60 px-3 py-3">
          <div>
            <label className={labelClass}>Connection URI (optional)</label>
            <input
              type="text"
              value={(value as Extract<DatabaseConnection, { type: 'redis' }>).connectionUri ?? ''}
              onChange={e => onChange({ ...value, connectionUri: e.target.value })}
              placeholder="redis://user:pass@localhost:6379/0"
              className={inputClass}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className={labelClass}>Host</label>
              <input type="text" value={(value as Extract<DatabaseConnection, { type: 'redis' }>).host ?? ''} onChange={e => onChange({ ...value, host: e.target.value })} placeholder="localhost" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Port</label>
              <input type="number" value={(value as Extract<DatabaseConnection, { type: 'redis' }>).port ?? 6379} onChange={e => onChange({ ...value, port: Number(e.target.value) || 6379 })} placeholder="6379" className={inputClass} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Username</label>
              <input type="text" value={(value as Extract<DatabaseConnection, { type: 'redis' }>).username ?? ''} onChange={e => onChange({ ...value, username: e.target.value })} placeholder="default" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Password</label>
              <input type="password" value={(value as Extract<DatabaseConnection, { type: 'redis' }>).password ?? ''} onChange={e => onChange({ ...value, password: e.target.value })} placeholder="••••••••" className={inputClass} />
            </div>
          </div>
          <div>
            <label className={labelClass}>DB Index</label>
            <input type="number" value={(value as Extract<DatabaseConnection, { type: 'redis' }>).db ?? 0} onChange={e => onChange({ ...value, db: Number(e.target.value) || 0 })} placeholder="0" className={inputClass} />
          </div>
        </div>
      ) : value.type === 'cassandra' ? (
        <div className="space-y-3 rounded border border-slate-700 bg-slate-900/60 px-3 py-3">
          <div>
            <label className={labelClass}>Contact Points</label>
            <input
              type="text"
              value={(value as Extract<DatabaseConnection, { type: 'cassandra' }>).contactPoints.join(', ')}
              onChange={e => onChange({ ...value, contactPoints: e.target.value.split(',').map(v => v.trim()).filter(Boolean) })}
              placeholder="127.0.0.1, 127.0.0.2"
              className={inputClass}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Port</label>
              <input type="number" value={(value as Extract<DatabaseConnection, { type: 'cassandra' }>).port ?? 9042} onChange={e => onChange({ ...value, port: Number(e.target.value) || 9042 })} placeholder="9042" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Local Datacenter</label>
              <input type="text" value={(value as Extract<DatabaseConnection, { type: 'cassandra' }>).localDataCenter} onChange={e => onChange({ ...value, localDataCenter: e.target.value })} placeholder="datacenter1" className={inputClass} />
            </div>
          </div>
          <div>
            <label className={labelClass}>Keyspace (optional)</label>
            <input type="text" value={(value as Extract<DatabaseConnection, { type: 'cassandra' }>).keyspace ?? ''} onChange={e => onChange({ ...value, keyspace: e.target.value })} placeholder="app_keyspace" className={inputClass} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Username</label>
              <input type="text" value={(value as Extract<DatabaseConnection, { type: 'cassandra' }>).username ?? ''} onChange={e => onChange({ ...value, username: e.target.value })} placeholder="cassandra" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Password</label>
              <input type="password" value={(value as Extract<DatabaseConnection, { type: 'cassandra' }>).password ?? ''} onChange={e => onChange({ ...value, password: e.target.value })} placeholder="••••••••" className={inputClass} />
            </div>
          </div>
        </div>
      ) : value.type === 'dynamodb' ? (
        <div className="space-y-3 rounded border border-slate-700 bg-slate-900/60 px-3 py-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Region</label>
              <input type="text" value={(value as Extract<DatabaseConnection, { type: 'dynamodb' }>).region} onChange={e => onChange({ ...value, region: e.target.value })} placeholder="us-east-1" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Endpoint (optional)</label>
              <input type="text" value={(value as Extract<DatabaseConnection, { type: 'dynamodb' }>).endpoint ?? ''} onChange={e => onChange({ ...value, endpoint: e.target.value })} placeholder="http://localhost:8000" className={inputClass} />
            </div>
          </div>
          <div>
            <label className={labelClass}>Access Key ID (optional)</label>
            <input type="text" value={(value as Extract<DatabaseConnection, { type: 'dynamodb' }>).accessKeyId ?? ''} onChange={e => onChange({ ...value, accessKeyId: e.target.value })} placeholder="AKIA..." className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Secret Access Key (optional)</label>
            <input type="password" value={(value as Extract<DatabaseConnection, { type: 'dynamodb' }>).secretAccessKey ?? ''} onChange={e => onChange({ ...value, secretAccessKey: e.target.value })} placeholder="••••••••" className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Session Token (optional)</label>
            <input type="text" value={(value as Extract<DatabaseConnection, { type: 'dynamodb' }>).sessionToken ?? ''} onChange={e => onChange({ ...value, sessionToken: e.target.value })} placeholder="session token" className={inputClass} />
          </div>
        </div>
      ) : value.type === 'oracle' ? (
        <div className="space-y-3 rounded border border-slate-700 bg-slate-900/60 px-3 py-3">
          <div>
            <label className={labelClass}>Connect String (optional)</label>
            <input type="text" value={(value as Extract<DatabaseConnection, { type: 'oracle' }>).connectString ?? ''} onChange={e => onChange({ ...value, connectString: e.target.value })} placeholder="host:1521/service" className={inputClass} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className={labelClass}>Host</label>
              <input type="text" value={(value as Extract<DatabaseConnection, { type: 'oracle' }>).host ?? ''} onChange={e => onChange({ ...value, host: e.target.value })} placeholder="localhost" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Port</label>
              <input type="number" value={(value as Extract<DatabaseConnection, { type: 'oracle' }>).port ?? 1521} onChange={e => onChange({ ...value, port: Number(e.target.value) || 1521 })} placeholder="1521" className={inputClass} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Service Name</label>
              <input type="text" value={(value as Extract<DatabaseConnection, { type: 'oracle' }>).serviceName ?? ''} onChange={e => onChange({ ...value, serviceName: e.target.value })} placeholder="XEPDB1" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>SID</label>
              <input type="text" value={(value as Extract<DatabaseConnection, { type: 'oracle' }>).sid ?? ''} onChange={e => onChange({ ...value, sid: e.target.value })} placeholder="XE" className={inputClass} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Username</label>
              <input type="text" value={(value as Extract<DatabaseConnection, { type: 'oracle' }>).username} onChange={e => onChange({ ...value, username: e.target.value })} placeholder="system" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Password</label>
              <input type="password" value={(value as Extract<DatabaseConnection, { type: 'oracle' }>).password} onChange={e => onChange({ ...value, password: e.target.value })} placeholder="••••••••" className={inputClass} />
            </div>
          </div>
          <div>
            <label className={labelClass}>Database (optional)</label>
            <input type="text" value={(value as Extract<DatabaseConnection, { type: 'oracle' }>).database ?? ''} onChange={e => onChange({ ...value, database: e.target.value })} placeholder="orclpdb1" className={inputClass} />
          </div>
        </div>
      ) : value.type === 'mssql' ? (
        <div className="space-y-3 rounded border border-slate-700 bg-slate-900/60 px-3 py-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className={labelClass}>Host</label>
              <input type="text" value={(value as Extract<DatabaseConnection, { type: 'mssql' }>).host} onChange={e => onChange({ ...value, host: e.target.value })} placeholder="localhost" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Port</label>
              <input type="number" value={(value as Extract<DatabaseConnection, { type: 'mssql' }>).port ?? 1433} onChange={e => onChange({ ...value, port: Number(e.target.value) || 1433 })} placeholder="1433" className={inputClass} />
            </div>
          </div>
          <div>
            <label className={labelClass}>Database</label>
            <input type="text" value={(value as Extract<DatabaseConnection, { type: 'mssql' }>).database} onChange={e => onChange({ ...value, database: e.target.value })} placeholder="mydb" className={inputClass} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Username</label>
              <input type="text" value={(value as Extract<DatabaseConnection, { type: 'mssql' }>).username} onChange={e => onChange({ ...value, username: e.target.value })} placeholder="admin" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Password</label>
              <input type="password" value={(value as Extract<DatabaseConnection, { type: 'mssql' }>).password} onChange={e => onChange({ ...value, password: e.target.value })} placeholder="••••••••" className={inputClass} />
            </div>
          </div>
          <div>
            <label className={labelClass}>Instance Name (optional)</label>
            <input type="text" value={(value as Extract<DatabaseConnection, { type: 'mssql' }>).instanceName ?? ''} onChange={e => onChange({ ...value, instanceName: e.target.value })} placeholder="SQLEXPRESS" className={inputClass} />
          </div>
          <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
            <input type="checkbox" className="accent-orange-500" checked={(value as Extract<DatabaseConnection, { type: 'mssql' }>).encrypt ?? true} onChange={e => onChange({ ...value, encrypt: e.target.checked })} />
            <span>Encrypt connection</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
            <input type="checkbox" className="accent-orange-500" checked={(value as Extract<DatabaseConnection, { type: 'mssql' }>).trustServerCertificate ?? false} onChange={e => onChange({ ...value, trustServerCertificate: e.target.checked })} />
            <span>Trust server certificate</span>
          </label>
        </div>
      ) : (
        <div className="rounded border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs text-slate-400">
          Detailed editing for this connection type is available in the Activity Bar Database panel.
        </div>
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
