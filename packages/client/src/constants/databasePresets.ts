import type { DatabaseConnection, DatabaseType, MongoDBConnectionConfig, SQLConnectionConfig } from '../types';

function nowIso(): string {
  return new Date().toISOString();
}

export function makeDatabasePreset(type: DatabaseType): DatabaseConnection {
  const base = {
    _id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
    name: '',
    type,
    ssl: false,
    connectionTimeout: 10000,
    queryTimeout: 30000,
    createdAt: nowIso(),
    sslRejectUnauthorized: true,
    maxConnections: 5,
  };

  if (type === 'mongodb') {
    const mongo: MongoDBConnectionConfig = {
      ...base,
      type: 'mongodb',
      connectionUri: 'mongodb://localhost:27017',
      authMechanism: 'SCRAM-SHA-256',
      sslCAPath: '',
      sslCertPath: '',
      sslKeyPath: '',
    };
    return mongo;
  }

  const sql: SQLConnectionConfig = {
    ...base,
    type,
    host: 'localhost',
    port: type === 'mysql' ? 3306 : 5432,
    username: '',
    password: '',
    database: '',
    sslMode: type === 'postgres' ? 'prefer' : undefined,
    sslCert: '',
  };
  return sql;
}
