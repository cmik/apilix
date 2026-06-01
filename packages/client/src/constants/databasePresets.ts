import type {
  CassandraConnectionConfig,
  DatabaseConnection,
  DatabaseType,
  DynamoDBConnectionConfig,
  MongoDBConnectionConfig,
  MSSQLConnectionConfig,
  OracleConnectionConfig,
  RedisConnectionConfig,
  SQLConnectionConfig,
  SQLiteConnectionConfig,
} from '../types';

function nowIso(): string {
  return new Date().toISOString();
}

export function makeDatabasePreset(type: DatabaseType): DatabaseConnection {
  const base = {
    _id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
    name: '',
    ssl: false,
    connectionTimeout: 10000,
    queryTimeout: 30000,
    createdAt: nowIso(),
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
      sslRejectUnauthorized: true,
      maxConnections: 5,
    };
    return mongo;
  }

  if (type === 'sqlite') {
    const sqlite: SQLiteConnectionConfig = {
      ...base,
      type: 'sqlite',
      filePath: './apilix.sqlite',
      readonly: false,
    };
    return sqlite;
  }

  if (type === 'redis') {
    const redis: RedisConnectionConfig = {
      ...base,
      type: 'redis',
      host: 'localhost',
      port: 6379,
      db: 0,
      sslRejectUnauthorized: true,
      maxConnections: 5,
    };
    return redis;
  }

  if (type === 'cassandra') {
    const cassandra: CassandraConnectionConfig = {
      ...base,
      type: 'cassandra',
      contactPoints: ['localhost'],
      port: 9042,
      localDataCenter: 'datacenter1',
      maxConnections: 5,
    };
    return cassandra;
  }

  if (type === 'dynamodb') {
    const dynamodb: DynamoDBConnectionConfig = {
      ...base,
      type: 'dynamodb',
      region: 'us-east-1',
    };
    return dynamodb;
  }

  if (type === 'oracle') {
    const oracle: OracleConnectionConfig = {
      ...base,
      type: 'oracle',
      host: 'localhost',
      port: 1521,
      username: '',
      password: '',
      serviceName: 'XEPDB1',
      maxConnections: 5,
    };
    return oracle;
  }

  if (type === 'mssql') {
    const mssql: MSSQLConnectionConfig = {
      ...base,
      type: 'mssql',
      host: 'localhost',
      port: 1433,
      username: '',
      password: '',
      database: '',
      encrypt: true,
      trustServerCertificate: false,
      maxConnections: 5,
    };
    return mssql;
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
