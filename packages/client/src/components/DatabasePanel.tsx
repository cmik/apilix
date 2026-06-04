import { useState, useCallback, useEffect, useRef } from 'react';
import { useApp, generateId } from '../store';
import { useDatabaseConnectionActions } from '../hooks/useDatabaseConnectionActions';
import type {
  DatabaseConnection,
  SQLConnectionConfig,
  MongoDBConnectionConfig,
  MongoConnectionAuthSettings,
  SQLiteConnectionConfig,
  RedisConnectionConfig,
  CassandraConnectionConfig,
  DynamoDBConnectionConfig,
  OracleConnectionConfig,
  MSSQLConnectionConfig,
} from '../types';
import {
  testDatabaseConnection,
  openDatabasePool,
  closeDatabasePool,
  executeDbQuery,
  executeMongoQuery,
  executeRedisCommand,
  executeDynamoOperation,
  listMongoDatabases,
  listMongoCollections,
  type MongoAuthOverride,
  type DbQueryResult,
  type DbMongoResult,
  type DbGenericResult,
} from '../api';
import { IconDatabase, IconSuccess, IconError } from './Icons';
import { getMongoDatabaseFromUri, resolveMongoConnectionTemplates } from '../utils/databasePanelMongoHelpers';
import {
  buildDatabaseConnectionsExportPackage,
} from '../utils/databaseConnectionTransfer';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function methodBadge(type: string): string {
  if (type === 'mysql') return 'text-blue-400 bg-blue-400/15';
  if (type === 'postgres') return 'text-sky-400 bg-sky-400/15';
  if (type === 'mongodb') return 'text-green-400 bg-green-400/15';
  if (type === 'sqlite') return 'text-amber-400 bg-amber-400/15';
  if (type === 'redis') return 'text-red-400 bg-red-400/15';
  if (type === 'cassandra') return 'text-cyan-400 bg-cyan-400/15';
  if (type === 'dynamodb') return 'text-emerald-400 bg-emerald-400/15';
  if (type === 'oracle') return 'text-yellow-400 bg-yellow-400/15';
  if (type === 'mssql') return 'text-indigo-400 bg-indigo-400/15';
  return 'text-slate-400 bg-slate-400/15';
}

function methodLabel(type: string): string {
  if (type === 'mysql') return 'MySQL';
  if (type === 'postgres') return 'PG';
  if (type === 'mongodb') return 'Mongo';
  if (type === 'sqlite') return 'SQLite';
  if (type === 'redis') return 'Redis';
  if (type === 'cassandra') return 'Cassandra';
  if (type === 'dynamodb') return 'DynamoDB';
  if (type === 'oracle') return 'Oracle';
  if (type === 'mssql') return 'MSSQL';
  return type.toUpperCase();
}

function connPreview(conn: DatabaseConnection): string {
  if (conn.type === 'mongodb') {
    const uri = (conn as MongoDBConnectionConfig).connectionUri || '';
    try {
      const u = new URL(uri);
      return u.hostname + (u.port ? ':' + u.port : '');
    } catch {
      return uri.slice(0, 40);
    }
  }
  if (conn.type === 'sqlite') {
    return (conn as SQLiteConnectionConfig).filePath || '';
  }
  if (conn.type === 'redis') {
    const redis = conn as RedisConnectionConfig;
    if (redis.connectionUri) return redis.connectionUri.slice(0, 60);
    return `${redis.host || ''}:${redis.port || 6379}/db${redis.db ?? 0}`;
  }
  if (conn.type === 'cassandra') {
    const cass = conn as CassandraConnectionConfig;
    return `${(cass.contactPoints || []).join(',')}:${cass.port || 9042}`;
  }
  if (conn.type === 'dynamodb') {
    const dyn = conn as DynamoDBConnectionConfig;
    return dyn.endpoint ? `${dyn.region} @ ${dyn.endpoint}` : dyn.region;
  }
  if (conn.type === 'oracle') {
    const ora = conn as OracleConnectionConfig;
    if (ora.connectString) return ora.connectString;
    return `${ora.host || ''}:${ora.port || 1521}/${ora.serviceName || ora.database || ''}`;
  }
  if (conn.type === 'mssql') {
    const ms = conn as MSSQLConnectionConfig;
    return `${ms.host || ''}:${ms.port || 1433}/${ms.database || ''}`;
  }
  const sql = conn as SQLConnectionConfig;
  return `${sql.host || ''}:${sql.port || ''}/${sql.database || ''}`;
}

const MONGO_OPS = [
  'find', 'findOne', 'insertOne', 'insertMany',
  'updateOne', 'updateMany', 'deleteOne', 'deleteMany',
  'countDocuments', 'distinct', 'aggregate',
] as const;

const DYNAMO_OPS = ['GetItem', 'PutItem', 'UpdateItem', 'DeleteItem', 'Query', 'Scan'] as const;

// ─── Connection Editor Modal ──────────────────────────────────────────────────

interface EditorProps {
  initial?: DatabaseConnection;
  runtimeVars: Record<string, string>;
  onSave: (conn: DatabaseConnection) => void;
  onClose: () => void;
}

export function ConnectionEditorModal({ initial, runtimeVars, onSave, onClose }: EditorProps) {
  const [type, setType] = useState<DatabaseConnection['type']>((initial?.type as DatabaseConnection['type']) ?? 'postgres');
  const [name, setName] = useState(initial?.name ?? '');
  // Common host-auth fields
  const [host, setHost] = useState((initial as SQLConnectionConfig)?.host ?? '');
  const [port, setPort] = useState(String((initial as SQLConnectionConfig)?.port ?? 5432));
  const [username, setUsername] = useState((initial as SQLConnectionConfig)?.username ?? '');
  const [password, setPassword] = useState((initial as SQLConnectionConfig)?.password ?? '');
  const [database, setDatabase] = useState((initial as SQLConnectionConfig)?.database ?? '');

  // Mongo
  const [uri, setUri] = useState((initial as MongoDBConnectionConfig)?.connectionUri ?? '');
  const [mongoDatabase, setMongoDatabase] = useState((initial as MongoDBConnectionConfig)?.database ?? '');
  const [mongoAuthMode, setMongoAuthMode] = useState<string>((initial as MongoDBConnectionConfig)?.auth?.mode ?? '');
  const [mongoAuthUsername, setMongoAuthUsername] = useState((initial as MongoDBConnectionConfig)?.auth?.username ?? '');
  const [mongoAuthPassword, setMongoAuthPassword] = useState((initial as MongoDBConnectionConfig)?.auth?.password ?? '');
  const [mongoAuthSource, setMongoAuthSource] = useState((initial as MongoDBConnectionConfig)?.auth?.authSource ?? '');

  // SQLite
  const [filePath, setFilePath] = useState((initial as SQLiteConnectionConfig)?.filePath ?? '');
  const [sqliteReadonly, setSqliteReadonly] = useState((initial as SQLiteConnectionConfig)?.readonly ?? false);

  // Redis
  const [redisUri, setRedisUri] = useState((initial as RedisConnectionConfig)?.connectionUri ?? '');
  const [redisDb, setRedisDb] = useState(String((initial as RedisConnectionConfig)?.db ?? 0));

  // Cassandra
  const [contactPoints, setContactPoints] = useState(Array.isArray((initial as CassandraConnectionConfig)?.contactPoints)
    ? (initial as CassandraConnectionConfig).contactPoints.join(',')
    : '');
  const [localDataCenter, setLocalDataCenter] = useState((initial as CassandraConnectionConfig)?.localDataCenter ?? '');
  const [keyspace, setKeyspace] = useState((initial as CassandraConnectionConfig)?.keyspace ?? '');

  // DynamoDB
  const [region, setRegion] = useState((initial as DynamoDBConnectionConfig)?.region ?? '');
  const [endpoint, setEndpoint] = useState((initial as DynamoDBConnectionConfig)?.endpoint ?? '');
  const [accessKeyId, setAccessKeyId] = useState((initial as DynamoDBConnectionConfig)?.accessKeyId ?? '');
  const [secretAccessKey, setSecretAccessKey] = useState((initial as DynamoDBConnectionConfig)?.secretAccessKey ?? '');
  const [sessionToken, setSessionToken] = useState((initial as DynamoDBConnectionConfig)?.sessionToken ?? '');

  // Oracle
  const [serviceName, setServiceName] = useState((initial as OracleConnectionConfig)?.serviceName ?? '');
  const [sid, setSid] = useState((initial as OracleConnectionConfig)?.sid ?? '');
  const [connectString, setConnectString] = useState((initial as OracleConnectionConfig)?.connectString ?? '');

  // MSSQL
  const [instanceName, setInstanceName] = useState((initial as MSSQLConnectionConfig)?.instanceName ?? '');
  const [encrypt, setEncrypt] = useState((initial as MSSQLConnectionConfig)?.encrypt ?? true);
  const [trustServerCertificate, setTrustServerCertificate] = useState((initial as MSSQLConnectionConfig)?.trustServerCertificate ?? false);

  const [ssl, setSsl] = useState(initial?.ssl ?? false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs?: number; error?: string } | null>(null);
  const [saveError, setSaveError] = useState('');

  // Update default port when type changes
  function onTypeChange(t: DatabaseConnection['type']) {
    setType(t);
    if (!initial) {
      if (t === 'mysql') setPort('3306');
      else if (t === 'postgres') setPort('5432');
      else if (t === 'redis') setPort('6379');
      else if (t === 'cassandra') setPort('9042');
      else if (t === 'oracle') setPort('1521');
      else if (t === 'mssql') setPort('1433');
      else if (t === 'mongodb') setPort('27017');
    }
    setTestResult(null);
  }

  function onMongoAuthModeChange(nextMode: string) {
    setMongoAuthMode(nextMode);
    if (nextMode === 'x509' || nextMode === 'oidc') {
      // Avoid carrying hidden SCRAM/LDAP credentials into non-password auth modes.
      setMongoAuthUsername('');
      setMongoAuthPassword('');
    }
  }

  function buildConfig(): DatabaseConnection {
    const base = {
      _id: initial?._id ?? generateId(),
      name: name.trim() || 'Untitled',
      ssl,
      createdAt: initial?.createdAt ?? new Date().toISOString(),
      connectionTimeout: initial?.connectionTimeout,
      queryTimeout: initial?.queryTimeout,
    };

    switch (type) {
      case 'mongodb': {
        const includePasswordCredentials = mongoAuthMode === 'scram' || mongoAuthMode === 'ldap-plain';
        const mongoAuth: MongoConnectionAuthSettings | undefined = mongoAuthMode
          ? {
              mode: mongoAuthMode as MongoConnectionAuthSettings['mode'],
              username: includePasswordCredentials ? (mongoAuthUsername || undefined) : undefined,
              password: includePasswordCredentials ? (mongoAuthPassword || undefined) : undefined,
              authSource: mongoAuthSource || undefined,
            }
          : undefined;
        return {
          ...base,
          type: 'mongodb',
          connectionUri: uri,
          database: mongoDatabase || undefined,
          auth: mongoAuth,
        } as MongoDBConnectionConfig;
      }
      case 'sqlite':
        return { ...base, type: 'sqlite', filePath, readonly: sqliteReadonly } as SQLiteConnectionConfig;
      case 'redis':
        return {
          ...base,
          type: 'redis',
          host: host || undefined,
          port: Number(port) || 6379,
          username: username || undefined,
          password: password || undefined,
          connectionUri: redisUri || undefined,
          db: Number(redisDb) || 0,
          sslRejectUnauthorized: true,
        } as RedisConnectionConfig;
      case 'cassandra':
        return {
          ...base,
          type: 'cassandra',
          contactPoints: contactPoints.split(',').map(cp => cp.trim()).filter(Boolean),
          port: Number(port) || 9042,
          localDataCenter,
          keyspace: keyspace || undefined,
          username: username || undefined,
          password: password || undefined,
        } as CassandraConnectionConfig;
      case 'dynamodb':
        return {
          ...base,
          type: 'dynamodb',
          region,
          endpoint: endpoint || undefined,
          accessKeyId: accessKeyId || undefined,
          secretAccessKey: secretAccessKey || undefined,
          sessionToken: sessionToken || undefined,
        } as DynamoDBConnectionConfig;
      case 'oracle':
        return {
          ...base,
          type: 'oracle',
          host: host || undefined,
          port: Number(port) || 1521,
          username,
          password,
          database: database || undefined,
          serviceName: serviceName || undefined,
          sid: sid || undefined,
          connectString: connectString || undefined,
        } as OracleConnectionConfig;
      case 'mssql':
        return {
          ...base,
          type: 'mssql',
          host,
          port: Number(port) || 1433,
          username,
          password,
          database,
          instanceName: instanceName || undefined,
          encrypt,
          trustServerCertificate,
        } as MSSQLConnectionConfig;
      default:
        return {
          ...base,
          type,
          host,
          port: Number(port) || (type === 'mysql' ? 3306 : 5432),
          username,
          password,
          database,
        } as SQLConnectionConfig;
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testDatabaseConnection(buildConfig(), runtimeVars);
      setTestResult(result);
    } catch (err: unknown) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  function handleSave() {
    if (!name.trim()) { setSaveError('Name is required'); return; }
    if (type === 'mongodb' && !uri.trim()) { setSaveError('Connection URI is required'); return; }
    if (type === 'sqlite' && !filePath.trim()) { setSaveError('SQLite file path is required'); return; }
    if (type === 'redis' && !redisUri.trim() && !host.trim()) { setSaveError('Redis host or URI is required'); return; }
    if (type === 'cassandra') {
      if (!contactPoints.trim()) { setSaveError('Cassandra contact points are required'); return; }
      if (!localDataCenter.trim()) { setSaveError('Cassandra local datacenter is required'); return; }
    }
    if (type === 'dynamodb' && !region.trim()) { setSaveError('DynamoDB region is required'); return; }
    if (type === 'oracle') {
      if (!username.trim()) { setSaveError('Username is required'); return; }
      if (!connectString.trim() && !host.trim()) { setSaveError('Connect string or host is required'); return; }
    }
    if (type === 'mssql' || type === 'mysql' || type === 'postgres') {
      if (!host.trim()) { setSaveError('Host is required'); return; }
      if (!database.trim()) { setSaveError('Database is required'); return; }
    }
    setSaveError('');
    onSave(buildConfig());
  }

  const inputClass = 'w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500';
  const labelClass = 'block text-xs text-slate-400 mb-1';

  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center">
      <div className="w-[480px] max-h-[90vh] overflow-y-auto bg-slate-900 border border-slate-700 rounded-lg shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 shrink-0">
          <span className="text-sm font-medium text-slate-100">
            {initial ? 'Edit Connection' : 'New Connection'}
          </span>
          <button onClick={onClose} className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-4 flex flex-col gap-3 flex-1">
          {/* Connection type */}
          <div>
            <label className={labelClass}>Type</label>
            <div className="grid grid-cols-3 gap-2">
              {(['mysql', 'postgres', 'mongodb', 'sqlite', 'redis', 'cassandra', 'dynamodb', 'oracle', 'mssql'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => onTypeChange(t)}
                  className={`flex-1 py-1.5 rounded text-xs font-medium border transition-colors ${
                    type === t
                      ? 'bg-orange-600 border-orange-500 text-white'
                      : 'bg-slate-800 border-slate-600 text-slate-400 hover:text-slate-200 hover:bg-slate-700'
                  }`}
                >
                  {methodLabel(t)}
                </button>
              ))}
            </div>
          </div>

          {/* Name */}
          <div>
            <label className={labelClass}>Name</label>
            <input className={inputClass} value={name} onChange={e => setName(e.target.value)} placeholder="My Database" />
          </div>

          {/* MongoDB */}
          {type === 'mongodb' && (
            <>
              <div>
                <label className={labelClass}>Connection URI</label>
                <input className={inputClass} value={uri} onChange={e => setUri(e.target.value)} placeholder="mongodb://user:pass@host:27017/db" />
              </div>
              <div>
                <label className={labelClass}>Default Database (optional)</label>
                <input className={inputClass} value={mongoDatabase} onChange={e => setMongoDatabase(e.target.value)} placeholder="app" />
              </div>
              <div className="rounded border border-slate-700 bg-slate-900/60 px-3 py-3 space-y-3">
                <div className="text-xs font-medium text-slate-300">Authentication Settings</div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelClass}>Auth Mode</label>
                    <select
                      value={mongoAuthMode}
                      onChange={e => onMongoAuthModeChange(e.target.value)}
                      className={inputClass}
                    >
                      <option value="">None (use URI credentials)</option>
                      <option value="scram">SCRAM (username + password)</option>
                      <option value="x509">X.509 certificate</option>
                      <option value="ldap-plain">LDAP / PLAIN</option>
                      <option value="oidc">OIDC workload identity</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>Auth Source DB</label>
                    <input className={inputClass} value={mongoAuthSource} onChange={e => setMongoAuthSource(e.target.value)} placeholder="admin" />
                  </div>
                </div>
                {(!mongoAuthMode || mongoAuthMode === 'scram' || mongoAuthMode === 'ldap-plain') && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={labelClass}>Login</label>
                      <input className={inputClass} value={mongoAuthUsername} onChange={e => setMongoAuthUsername(e.target.value)} placeholder="{{mongoUser}}" />
                    </div>
                    <div>
                      <label className={labelClass}>Password</label>
                      <input className={inputClass} type="password" value={mongoAuthPassword} onChange={e => setMongoAuthPassword(e.target.value)} placeholder="••••••••" />
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* SQLite */}
          {type === 'sqlite' && (
            <>
              <div>
                <label className={labelClass}>Database File Path</label>
                <div className="flex gap-2">
                  <input className={inputClass} value={filePath} onChange={e => setFilePath(e.target.value)} placeholder="/path/to/database.sqlite" />
                  <button
                    onClick={async () => {
                      const eAPI = (window as any).electronAPI ?? null;
                      if (eAPI?.openFileDialog) {
                        try {
                          const selected: string | null = await eAPI.openFileDialog([
                            { name: 'SQLite files', extensions: ['db', 'sqlite', 'sqlite3'] },
                            { name: 'All files', extensions: ['*'] },
                          ]);
                          if (selected) setFilePath(selected);
                        } catch (err: unknown) {
                          console.error('File dialog error:', err instanceof Error ? err.message : String(err));
                        }
                      }
                    }}
                    className="px-2 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-slate-100 text-xs rounded font-medium transition-colors shrink-0"
                  >
                    Browse
                  </button>
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="accent-orange-500" checked={sqliteReadonly} onChange={e => setSqliteReadonly(e.target.checked)} />
                <span className="text-xs text-slate-300">Open read-only</span>
              </label>
            </>
          )}

          {/* Redis */}
          {type === 'redis' && (
            <>
              <div>
                <label className={labelClass}>Connection URI (optional)</label>
                <input className={inputClass} value={redisUri} onChange={e => setRedisUri(e.target.value)} placeholder="redis://user:pass@localhost:6379/0" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className={labelClass}>Host</label>
                  <input className={inputClass} value={host} onChange={e => setHost(e.target.value)} placeholder="localhost" />
                </div>
                <div>
                  <label className={labelClass}>Port</label>
                  <input className={inputClass} value={port} onChange={e => setPort(e.target.value)} placeholder="6379" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelClass}>Username</label>
                  <input className={inputClass} value={username} onChange={e => setUsername(e.target.value)} placeholder="default" />
                </div>
                <div>
                  <label className={labelClass}>Password</label>
                  <input className={inputClass} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
                </div>
              </div>
              <div>
                <label className={labelClass}>DB Index</label>
                <input className={inputClass} value={redisDb} onChange={e => setRedisDb(e.target.value)} placeholder="0" />
              </div>
            </>
          )}

          {/* Cassandra */}
          {type === 'cassandra' && (
            <>
              <div>
                <label className={labelClass}>Contact Points (comma-separated)</label>
                <input className={inputClass} value={contactPoints} onChange={e => setContactPoints(e.target.value)} placeholder="127.0.0.1,127.0.0.2" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelClass}>Port</label>
                  <input className={inputClass} value={port} onChange={e => setPort(e.target.value)} placeholder="9042" />
                </div>
                <div>
                  <label className={labelClass}>Local Datacenter</label>
                  <input className={inputClass} value={localDataCenter} onChange={e => setLocalDataCenter(e.target.value)} placeholder="datacenter1" />
                </div>
              </div>
              <div>
                <label className={labelClass}>Keyspace (optional)</label>
                <input className={inputClass} value={keyspace} onChange={e => setKeyspace(e.target.value)} placeholder="app_keyspace" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelClass}>Username</label>
                  <input className={inputClass} value={username} onChange={e => setUsername(e.target.value)} placeholder="cassandra" />
                </div>
                <div>
                  <label className={labelClass}>Password</label>
                  <input className={inputClass} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
                </div>
              </div>
            </>
          )}

          {/* DynamoDB */}
          {type === 'dynamodb' && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelClass}>Region</label>
                  <input className={inputClass} value={region} onChange={e => setRegion(e.target.value)} placeholder="us-east-1" />
                </div>
                <div>
                  <label className={labelClass}>Endpoint (optional)</label>
                  <input className={inputClass} value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="http://localhost:8000" />
                </div>
              </div>
              <div>
                <label className={labelClass}>Access Key ID (optional)</label>
                <input className={inputClass} value={accessKeyId} onChange={e => setAccessKeyId(e.target.value)} placeholder="AKIA..." />
              </div>
              <div>
                <label className={labelClass}>Secret Access Key (optional)</label>
                <input className={inputClass} type="password" value={secretAccessKey} onChange={e => setSecretAccessKey(e.target.value)} placeholder="••••••••" />
              </div>
              <div>
                <label className={labelClass}>Session Token (optional)</label>
                <input className={inputClass} value={sessionToken} onChange={e => setSessionToken(e.target.value)} placeholder="session token" />
              </div>
            </>
          )}

          {/* Oracle */}
          {type === 'oracle' && (
            <>
              <div>
                <label className={labelClass}>Connect String (optional)</label>
                <input className={inputClass} value={connectString} onChange={e => setConnectString(e.target.value)} placeholder="host:1521/service" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className={labelClass}>Host</label>
                  <input className={inputClass} value={host} onChange={e => setHost(e.target.value)} placeholder="localhost" />
                </div>
                <div>
                  <label className={labelClass}>Port</label>
                  <input className={inputClass} value={port} onChange={e => setPort(e.target.value)} placeholder="1521" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelClass}>Service Name</label>
                  <input className={inputClass} value={serviceName} onChange={e => setServiceName(e.target.value)} placeholder="XEPDB1" />
                </div>
                <div>
                  <label className={labelClass}>SID</label>
                  <input className={inputClass} value={sid} onChange={e => setSid(e.target.value)} placeholder="XE" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelClass}>Username</label>
                  <input className={inputClass} value={username} onChange={e => setUsername(e.target.value)} placeholder="system" />
                </div>
                <div>
                  <label className={labelClass}>Password</label>
                  <input className={inputClass} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
                </div>
              </div>
              <div>
                <label className={labelClass}>Database (optional)</label>
                <input className={inputClass} value={database} onChange={e => setDatabase(e.target.value)} placeholder="orclpdb1" />
              </div>
            </>
          )}

          {/* MSSQL / MySQL / PostgreSQL */}
          {(type === 'mssql' || type === 'mysql' || type === 'postgres') && (
            <>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className={labelClass}>Host</label>
                  <input className={inputClass} value={host} onChange={e => setHost(e.target.value)} placeholder="localhost" />
                </div>
                <div>
                  <label className={labelClass}>Port</label>
                  <input className={inputClass} value={port} onChange={e => setPort(e.target.value)} placeholder={type === 'mysql' ? '3306' : type === 'postgres' ? '5432' : '1433'} />
                </div>
              </div>
              <div>
                <label className={labelClass}>Database</label>
                <input className={inputClass} value={database} onChange={e => setDatabase(e.target.value)} placeholder="mydb" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelClass}>Username</label>
                  <input className={inputClass} value={username} onChange={e => setUsername(e.target.value)} placeholder="admin" />
                </div>
                <div>
                  <label className={labelClass}>Password</label>
                  <input className={inputClass} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
                </div>
              </div>
              {type === 'mssql' && (
                <>
                  <div>
                    <label className={labelClass}>Instance Name (optional)</label>
                    <input className={inputClass} value={instanceName} onChange={e => setInstanceName(e.target.value)} placeholder="SQLEXPRESS" />
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" className="accent-orange-500" checked={encrypt} onChange={e => setEncrypt(e.target.checked)} />
                    <span className="text-xs text-slate-300">Encrypt connection</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" className="accent-orange-500" checked={trustServerCertificate} onChange={e => setTrustServerCertificate(e.target.checked)} />
                    <span className="text-xs text-slate-300">Trust server certificate</span>
                  </label>
                </>
              )}
            </>
          )}

          {/* SSL */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="accent-orange-500" checked={ssl} onChange={e => setSsl(e.target.checked)} />
            <span className="text-xs text-slate-300">Enable SSL</span>
          </label>

          {/* Test result */}
          {testResult && (
            <div className={`flex items-center gap-2 px-3 py-2 rounded text-xs ${testResult.ok ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'}`}>
              {testResult.ok
                ? <><IconSuccess className="w-3.5 h-3.5 shrink-0" /> Connected{testResult.latencyMs != null ? ` (${testResult.latencyMs}ms)` : ''}</>
                : <><IconError className="w-3.5 h-3.5 shrink-0" /> {testResult.error || 'Connection failed'}</>}
            </div>
          )}

          {saveError && <p className="text-xs text-red-400">{saveError}</p>}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-slate-700 flex items-center justify-between shrink-0">
          <button
            onClick={handleTest}
            disabled={testing}
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 text-xs rounded font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 text-xs rounded font-medium transition-colors">
              Cancel
            </button>
            <button onClick={handleSave} className="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded font-medium transition-colors">
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Query Result Grid ─────────────────────────────────────────────────────────

function ResultGrid({ result }: { result: DbQueryResult }) {
  const { rows, columns, rowCount } = result;
  if (!columns.length) {
    return <p className="text-xs text-slate-500 px-3 py-2">Query executed — {rowCount} row(s) affected.</p>;
  }
  return (
    <div className="overflow-auto flex-1">
      <table className="w-full text-xs border-collapse min-w-full">
        <thead>
          <tr className="bg-slate-800 sticky top-0">
            {columns.map(col => (
              <th key={col} className="px-3 py-2 text-left font-medium text-slate-300 border-b border-slate-700 whitespace-nowrap">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={i % 2 === 0 ? 'bg-slate-900' : 'bg-slate-950'}>
              {columns.map(col => (
                <td key={col} className="px-3 py-1.5 text-slate-300 border-b border-slate-800/50 font-mono whitespace-nowrap max-w-[300px] overflow-hidden text-ellipsis">
                  {row[col] == null ? <span className="text-slate-600">null</span> : String(row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Query Editor ──────────────────────────────────────────────────────────────

interface QueryEditorProps {
  selectedConn: DatabaseConnection | null;
  runtimeVars: Record<string, string>;
}

function QueryEditor({ selectedConn, runtimeVars }: QueryEditorProps) {
  const [poolReadyId, setPoolReadyId] = useState<string | null>(null);
  const [sql, setSql] = useState('');
  const [params, setParams] = useState('');
  const [mongoOp, setMongoOp] = useState<string>('find');
  const [mongoDoc, setMongoDoc] = useState('{}');
  const [mongoOpts, setMongoOpts] = useState('{}');
  const [mongoDatabase, setMongoDatabase] = useState('');
  const [mongoDatabases, setMongoDatabases] = useState<string[]>([]);
  const [mongoDatabasesLoading, setMongoDatabasesLoading] = useState(false);
  const [mongoDatabasesError, setMongoDatabasesError] = useState('');
  const [mongoCollection, setMongoCollection] = useState('');
  const [mongoCollections, setMongoCollections] = useState<string[]>([]);
  const [mongoCollectionsLoading, setMongoCollectionsLoading] = useState(false);
  const [mongoCollectionsError, setMongoCollectionsError] = useState('');
  const [redisCommand, setRedisCommand] = useState('GET');
  const [redisArgs, setRedisArgs] = useState('[]');
  const [dynamoOp, setDynamoOp] = useState<string>('GetItem');
  const [dynamoInput, setDynamoInput] = useState('{}');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [sqlResult, setSqlResult] = useState<DbQueryResult | null>(null);
  const [mongoResult, setMongoResult] = useState<DbMongoResult | null>(null);
  const [genericResult, setGenericResult] = useState<DbGenericResult | null>(null);
  const [poolStatus, setPoolStatus] = useState<'idle' | 'connecting' | 'ready' | 'error'>('idle');
  const [poolReadyRuntimeKey, setPoolReadyRuntimeKey] = useState<string | null>(null);

  const isMongo = selectedConn?.type === 'mongodb';
  const isRedis = selectedConn?.type === 'redis';
  const isDynamo = selectedConn?.type === 'dynamodb';
  const runtimeKey = JSON.stringify(runtimeVars);

  useEffect(() => {
    if (!selectedConn) {
      setPoolReadyId(null);
      setPoolReadyRuntimeKey(null);
      setPoolStatus('idle');
      return;
    }

    if (poolReadyId === selectedConn._id && poolReadyRuntimeKey === runtimeKey) {
      setPoolStatus('ready');
      return;
    }
    
    // Reset pool status when connection changes
    setPoolReadyId(null);
    setPoolReadyRuntimeKey(null);
    setPoolStatus('idle');
  }, [selectedConn, runtimeKey]);

  useEffect(() => {
    if (!selectedConn || selectedConn.type !== 'mongodb') {
      setMongoDatabase('');
      setMongoDatabases([]);
      setMongoDatabasesLoading(false);
      setMongoDatabasesError('');
      setMongoCollection('');
      setMongoCollections([]);
      setMongoCollectionsLoading(false);
      setMongoCollectionsError('');
      return;
    }

    const resolvedConn = resolveMongoConnectionTemplates(selectedConn, runtimeVars);
    if (!resolvedConn) {
      setMongoDatabase('');
      setMongoDatabases([]);
      setMongoDatabasesLoading(false);
      setMongoDatabasesError('Selected connection is not MongoDB');
      setMongoCollections([]);
      setMongoCollection('');
      setMongoCollectionsLoading(false);
      setMongoCollectionsError('');
      return;
    }

    const preferredDatabase = (resolvedConn.database || '').trim() || getMongoDatabaseFromUri(resolvedConn.connectionUri || '');
    const resolvedAuth: MongoAuthOverride | undefined = resolvedConn.auth?.mode
      ? {
          mode: resolvedConn.auth.mode,
          username: resolvedConn.auth.username,
          password: resolvedConn.auth.password,
          authSource: resolvedConn.auth.authSource,
        }
      : undefined;
    let cancelled = false;
    setMongoDatabasesLoading(true);
    setMongoDatabasesError('');

    listMongoDatabases(undefined, selectedConn._id, resolvedAuth, [resolvedConn])
      .then((databases) => {
        if (cancelled) return;
        setMongoDatabases(databases);
        setMongoDatabase((prev) => {
          if (prev && databases.includes(prev)) return prev;
          if (preferredDatabase && databases.includes(preferredDatabase)) return preferredDatabase;
          return databases[0] || preferredDatabase || '';
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMongoDatabases([]);
        setMongoDatabase(preferredDatabase || '');
        setMongoDatabasesError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setMongoDatabasesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedConn, runtimeKey]);

  useEffect(() => {
    if (!selectedConn || selectedConn.type !== 'mongodb') {
      setMongoCollection('');
      setMongoCollections([]);
      setMongoCollectionsLoading(false);
      setMongoCollectionsError('');
      return;
    }

    if (!mongoDatabase.trim()) {
      setMongoCollection('');
      setMongoCollections([]);
      setMongoCollectionsLoading(false);
      setMongoCollectionsError('');
      return;
    }

    const resolvedConn = resolveMongoConnectionTemplates(selectedConn, runtimeVars);
    if (!resolvedConn) {
      setMongoCollection('');
      setMongoCollections([]);
      setMongoCollectionsLoading(false);
      setMongoCollectionsError('Selected connection is not MongoDB');
      return;
    }

    const resolvedAuth: MongoAuthOverride | undefined = resolvedConn.auth?.mode
      ? {
          mode: resolvedConn.auth.mode,
          username: resolvedConn.auth.username,
          password: resolvedConn.auth.password,
          authSource: resolvedConn.auth.authSource,
        }
      : undefined;

    let cancelled = false;
    setMongoCollectionsLoading(true);
    setMongoCollectionsError('');

    listMongoCollections(undefined, mongoDatabase.trim(), selectedConn._id, resolvedAuth, [resolvedConn])
      .then((collections) => {
        if (cancelled) return;
        setMongoCollections(collections);
        setMongoCollection((prev) => {
          if (prev && collections.includes(prev)) return prev;
          return collections[0] || '';
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMongoCollections([]);
        setMongoCollectionsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setMongoCollectionsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedConn, mongoDatabase, runtimeKey]);

  const ensurePool = useCallback(async (conn: DatabaseConnection) => {
    if (!conn) return;
    // Skip if pool is already ready for this connection
    if (poolReadyId === conn._id && poolReadyRuntimeKey === runtimeKey) {
      setPoolStatus('ready');
      return;
    }
    setPoolStatus('connecting');
    try {
      await openDatabasePool(conn, runtimeVars);
      setPoolReadyId(conn._id);
      setPoolReadyRuntimeKey(runtimeKey);
      setPoolStatus('ready');
    } catch (err: unknown) {
      setPoolStatus('error');
      setPoolReadyId(null);
      setPoolReadyRuntimeKey(null);
      throw err;
    }
  }, [poolReadyId, poolReadyRuntimeKey, runtimeKey, runtimeVars]);

  async function handleRun() {
    if (!selectedConn) { setError('Select a connection first'); return; }
    setRunning(true);
    setError('');
    setSqlResult(null);
    setMongoResult(null);
    setGenericResult(null);
    try {
      await ensurePool(selectedConn);
      if (isMongo) {
        let doc: Record<string, unknown> = {};
        let opts: Record<string, unknown> = {};
        try { doc = JSON.parse(mongoDoc || '{}'); } catch { throw new Error('Invalid JSON in document'); }
        try { opts = JSON.parse(mongoOpts || '{}'); } catch { throw new Error('Invalid JSON in options'); }
        const selectedDatabase = mongoDatabase.trim() || (typeof doc.database === 'string' ? doc.database.trim() : '');
        if (!selectedDatabase) {
          throw new Error('Select a MongoDB database before running the query');
        }
        const selectedCollection = mongoCollection.trim() || (typeof doc.collection === 'string' ? doc.collection.trim() : '');
        if (!selectedCollection && mongoOp !== 'aggregate') {
          throw new Error('Select a MongoDB collection before running the query');
        }
        if (!doc.database) {
          doc.database = selectedDatabase;
        }
        if (!doc.collection && selectedCollection) {
          doc.collection = selectedCollection;
        }
        const res = await executeMongoQuery(selectedConn._id, mongoOp, doc, selectedCollection || undefined, opts);
        setMongoResult(res);
      } else if (isRedis) {
        let parsedArgs: unknown[] = [];
        if (redisArgs.trim()) {
          try { parsedArgs = JSON.parse(redisArgs); } catch { throw new Error('Invalid JSON in redis args'); }
          if (!Array.isArray(parsedArgs)) throw new Error('Redis args must be a JSON array');
        }
        const res = await executeRedisCommand(selectedConn._id, redisCommand, parsedArgs);
        setGenericResult(res);
      } else if (isDynamo) {
        let parsedInput: Record<string, unknown> = {};
        if (dynamoInput.trim()) {
          try { parsedInput = JSON.parse(dynamoInput); } catch { throw new Error('Invalid JSON in DynamoDB input'); }
          if (parsedInput === null || typeof parsedInput !== 'object' || Array.isArray(parsedInput)) {
            throw new Error('DynamoDB input must be a JSON object');
          }
        }
        const res = await executeDynamoOperation(selectedConn._id, dynamoOp, parsedInput);
        setGenericResult(res);
      } else {
        let parsedParams: unknown[] = [];
        if (params.trim()) {
          try { parsedParams = JSON.parse(params); } catch { throw new Error('Invalid JSON in params'); }
          if (!Array.isArray(parsedParams)) throw new Error('Params must be a JSON array');
        }
        const res = await executeDbQuery(selectedConn._id, sql, parsedParams.length ? parsedParams : undefined);
        setSqlResult(res);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setPoolReadyId(null);
      setPoolReadyRuntimeKey(null);
      setPoolStatus('idle');
    } finally {
      setRunning(false);
    }
  }

  if (!selectedConn) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
        Select a connection from the sidebar first
      </div>
    );
  }

  const textareaClass = 'w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-orange-500 resize-none';

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Controls */}
      <div className="flex flex-col gap-2 px-4 py-3 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex-1 text-xs text-slate-300">
            <span className="font-medium">{selectedConn.name}</span>
            <span className="text-slate-500 ml-1">({selectedConn.type})</span>
          </div>
          {poolStatus === 'ready' && <span className="text-xs text-green-400">● connected</span>}
          {poolStatus === 'connecting' && <span className="text-xs text-yellow-400">● connecting…</span>}
          {poolStatus === 'error' && <span className="text-xs text-red-400">● error</span>}
        </div>

        {isMongo ? (
          <>
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-400 shrink-0">Database</label>
              <select
                value={mongoDatabase}
                onChange={e => setMongoDatabase(e.target.value)}
                disabled={mongoDatabasesLoading || mongoDatabases.length === 0}
                className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-orange-500 min-w-[180px]"
              >
                {mongoDatabases.length === 0 ? (
                  <option value="">{mongoDatabasesLoading ? 'Loading databases…' : 'No databases found'}</option>
                ) : (
                  mongoDatabases.map(db => <option key={db} value={db}>{db}</option>)
                )}
              </select>
            </div>
            {mongoDatabasesError && (
              <p className="text-xs text-amber-400">{mongoDatabasesError}</p>
            )}
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-400 shrink-0">Operation</label>
              <select
                value={mongoOp}
                onChange={e => setMongoOp(e.target.value)}
                className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-orange-500"
              >
                {MONGO_OPS.map(op => <option key={op} value={op}>{op}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-400 shrink-0">Collection</label>
              <select
                value={mongoCollection}
                onChange={e => setMongoCollection(e.target.value)}
                disabled={!mongoDatabase || mongoCollectionsLoading || mongoCollections.length === 0}
                className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-orange-500 min-w-[180px]"
              >
                {mongoCollections.length === 0 ? (
                  <option value="">{mongoCollectionsLoading ? 'Loading collections…' : (mongoDatabase ? 'No collections found' : 'Select database first')}</option>
                ) : (
                  mongoCollections.map(col => <option key={col} value={col}>{col}</option>)
                )}
              </select>
            </div>
            {mongoCollectionsError && (
              <p className="text-xs text-amber-400">{mongoCollectionsError}</p>
            )}
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Document / Filter (JSON)</label>
              <textarea rows={4} className={textareaClass} value={mongoDoc} onChange={e => setMongoDoc(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Options (JSON)</label>
              <textarea rows={2} className={textareaClass} value={mongoOpts} onChange={e => setMongoOpts(e.target.value)} />
            </div>
          </>
        ) : isRedis ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Command</label>
                <input
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-orange-500"
                  value={redisCommand}
                  onChange={e => setRedisCommand(e.target.value)}
                  placeholder="GET"
                />
              </div>
              <div className="col-span-2">
                <label className="text-xs text-slate-400 mb-1 block">Args (JSON array)</label>
                <input
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-orange-500"
                  value={redisArgs}
                  onChange={e => setRedisArgs(e.target.value)}
                  placeholder='["key"]'
                />
              </div>
            </div>
          </>
        ) : isDynamo ? (
          <>
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-400 shrink-0">Operation</label>
              <select
                value={dynamoOp}
                onChange={e => setDynamoOp(e.target.value)}
                className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-orange-500"
              >
                {DYNAMO_OPS.map(op => <option key={op} value={op}>{op}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Input (JSON object)</label>
              <textarea rows={6} className={textareaClass} value={dynamoInput} onChange={e => setDynamoInput(e.target.value)} />
            </div>
          </>
        ) : (
          <>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Query (SQL / CQL)</label>
              <textarea rows={5} className={textareaClass} value={sql} onChange={e => setSql(e.target.value)} placeholder="SELECT * FROM users WHERE id = $1" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Params (JSON array)</label>
              <input
                className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-orange-500"
                value={params}
                onChange={e => setParams(e.target.value)}
                placeholder='["value1", 42]'
              />
            </div>
          </>
        )}

        <div className="flex items-center justify-between">
          <button
            onClick={handleRun}
            disabled={running}
            className="px-4 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {running ? 'Running…' : '▶ Run'}
          </button>
          {(sqlResult || mongoResult || genericResult) && (
            <div className="flex gap-2">
              {sqlResult && (
                <button
                  onClick={() => {
                    const csv = [sqlResult.columns.join(','), ...sqlResult.rows.map(r => sqlResult.columns.map(c => JSON.stringify(r[c] ?? '')).join(','))].join('\n');
                    const blob = new Blob([csv], { type: 'text/csv' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'result.csv';
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded transition-colors"
                >
                  Export CSV
                </button>
              )}
              <button
                onClick={() => navigator.clipboard.writeText(JSON.stringify(sqlResult?.rows ?? mongoResult?.result ?? genericResult?.result, null, 2))}
                className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded transition-colors"
              >
                Copy JSON
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Results */}
      {error && (
        <div className="px-4 py-2 bg-red-900/30 border-b border-red-800/50">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}
      {sqlResult && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="px-4 py-1.5 border-b border-slate-800 shrink-0">
            <span className="text-xs text-slate-500">{sqlResult.rowCount} row{sqlResult.rowCount !== 1 ? 's' : ''}</span>
          </div>
          <ResultGrid result={sqlResult} />
        </div>
      )}
      {mongoResult && (
        <div className="flex-1 overflow-auto px-4 py-3">
          <pre className="text-xs font-mono text-slate-300 whitespace-pre-wrap">
            {JSON.stringify(mongoResult.result, null, 2)}
          </pre>
        </div>
      )}
      {genericResult && (
        <div className="flex-1 overflow-auto px-4 py-3">
          <pre className="text-xs font-mono text-slate-300 whitespace-pre-wrap">
            {JSON.stringify(genericResult.result, null, 2)}
          </pre>
        </div>
      )}
      {!error && !sqlResult && !mongoResult && !genericResult && (
        <div className="flex-1 flex items-center justify-center text-slate-600 text-xs">
          Run a query to see results
        </div>
      )}
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

type PanelTab = 'connection' | 'query';

export default function DatabasePanel() {
  const { state, dispatch, getEnvironmentVars } = useApp();
  const [tab, setTab] = useState<PanelTab>('connection');
  const [editorOpen, setEditorOpen] = useState(false);

  const databases = state.databases ?? [];
  const activeDatabaseId = state.activeDatabaseId;
  const selectedConn = databases.find(c => c._id === activeDatabaseId);

  // Build runtime variables from environment and globals for template resolution
  const runtimeVars = {
    ...state.globalVariables,
    ...getEnvironmentVars(),
  };

  const { handleEdit: onEditFromHook, handleTest, testingId } = useDatabaseConnectionActions(
    (conn: DatabaseConnection) => {
      setEditorOpen(true);
    }
  );

  function handleSave(conn: DatabaseConnection) {
    if (selectedConn) {
      dispatch({ type: 'UPDATE_DATABASE', payload: conn });
    } else {
      dispatch({ type: 'ADD_DATABASE', payload: conn });
      dispatch({ type: 'SET_ACTIVE_DATABASE', payload: conn._id });
    }
    setEditorOpen(false);
  }

  function handleExportSelected() {
    if (!selectedConn) return;
    const payload = buildDatabaseConnectionsExportPackage([selectedConn]);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = selectedConn.name.replace(/[^a-z0-9_\-. ]/gi, '_') || 'connection';
    a.download = `apilix-db-${safeName}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden bg-slate-900">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <IconDatabase className="w-4 h-4 text-orange-400" />
          <span className="text-sm font-medium text-slate-100">Database</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportSelected}
            disabled={!selectedConn}
            className="px-3 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 text-xs rounded font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Export
          </button>
          {selectedConn && tab === 'connection' && (
            <button
              onClick={() => handleTest(selectedConn)}
              disabled={testingId === selectedConn._id}
              className="px-3 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 text-xs rounded font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {testingId === selectedConn._id ? 'Testing…' : 'Test Connection'}
            </button>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-slate-800 shrink-0">
        {(['connection', 'query'] as PanelTab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-xs font-medium transition-colors capitalize ${
              tab === t
                ? 'text-orange-400 border-b-2 border-orange-400'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t === 'connection' ? 'Connection' : 'Query Editor'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === 'connection' && (
          <div className="flex-1 overflow-auto">
            {!selectedConn ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-500">
                <IconDatabase className="w-10 h-10 opacity-30" />
                <p className="text-sm">No connection selected</p>
                <p className="text-xs">Select a connection from the sidebar</p>
              </div>
            ) : (
              <div className="px-4 py-4 space-y-3">
                <div>
                  <p className="text-xs text-slate-400 mb-2">Connection: <span className="text-slate-200 font-medium">{selectedConn.name}</span></p>
                  <p className="text-xs text-slate-500">Type: <span className="text-slate-400">{methodLabel(selectedConn.type)}</span></p>
                </div>
                <button
                  onClick={() => {
                    setEditorOpen(true);
                  }}
                  className="px-3 py-2 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded font-medium transition-colors"
                >
                  Edit Connection
                </button>

                {/* Test result */}
                {selectedConn.testStatus && (
                  <div className={`flex items-center gap-2 px-3 py-2 rounded text-xs ${
                    selectedConn.testStatus === 'success'
                      ? 'bg-green-900/40 text-green-300'
                      : 'bg-red-900/40 text-red-300'
                  }`}>
                    {selectedConn.testStatus === 'success' ? (
                      <><IconSuccess className="w-3.5 h-3.5 shrink-0" /> Connected{selectedConn.lastTestedAt ? ` (${new Date(selectedConn.lastTestedAt).toLocaleString()})` : ''}</>
                    ) : (
                      <><IconError className="w-3.5 h-3.5 shrink-0" /> {selectedConn.testError || 'Connection failed'}</>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'query' && <QueryEditor selectedConn={selectedConn ?? null} runtimeVars={runtimeVars} />}
      </div>

      {editorOpen && (
        <ConnectionEditorModal
          initial={selectedConn}
          runtimeVars={runtimeVars}
          onSave={handleSave}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  );
}
