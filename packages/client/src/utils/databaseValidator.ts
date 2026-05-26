import type { DatabaseConnection } from '../types';

export interface DatabaseValidationResult {
  valid: boolean;
  errors: string[];
}

function isPortValid(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function supportsMaxConnections(type: DatabaseConnection['type'] | undefined): boolean {
  return !!type && ['mysql', 'postgres', 'mongodb', 'redis', 'cassandra', 'oracle', 'mssql'].includes(type);
}

export function validateDatabaseConnection(config: Partial<DatabaseConnection>): DatabaseValidationResult {
  const errors: string[] = [];

  if (!config.name || !config.name.trim()) errors.push('Connection name is required.');
  if (!config.type) errors.push('Database type is required.');

  if (config.connectionTimeout !== undefined && (config.connectionTimeout < 100 || config.connectionTimeout > 120000)) {
    errors.push('Connection timeout must be between 100 and 120000 ms.');
  }

  if (config.queryTimeout !== undefined && (config.queryTimeout < 100 || config.queryTimeout > 600000)) {
    errors.push('Query timeout must be between 100 and 600000 ms.');
  }

  if (supportsMaxConnections(config.type)) {
    const maxConnections = (config as { maxConnections?: number }).maxConnections;
    if (maxConnections !== undefined && (maxConnections < 1 || maxConnections > 50)) {
      errors.push('Max connections must be between 1 and 50.');
    }
  }

  switch (config.type) {
    case 'mysql':
    case 'postgres':
    case 'mssql': {
      const sqlConfig = config as Partial<Extract<DatabaseConnection, { type: 'mysql' | 'postgres' | 'mssql' }>>;
      if (!sqlConfig.host || !String(sqlConfig.host).trim()) errors.push('Host is required.');
      if (!isPortValid(Number(sqlConfig.port))) errors.push('Port must be between 1 and 65535.');
      if (!sqlConfig.username || !String(sqlConfig.username).trim()) errors.push('Username is required.');
      if (!sqlConfig.database || !String(sqlConfig.database).trim()) errors.push('Database name is required.');
      break;
    }
    case 'mongodb': {
      const mongoConfig = config as Partial<Extract<DatabaseConnection, { type: 'mongodb' }>>;
      const uri = String(mongoConfig.connectionUri || '').trim();
      if (!uri) {
        errors.push('MongoDB connection URI is required.');
      } else if (!uri.includes('{{') && !/^mongodb(\+srv)?:\/\//i.test(uri)) {
        errors.push('MongoDB URI must start with mongodb:// or mongodb+srv://.');
      }
      break;
    }
    case 'sqlite': {
      const sqliteConfig = config as Partial<Extract<DatabaseConnection, { type: 'sqlite' }>>;
      if (!sqliteConfig.filePath || !String(sqliteConfig.filePath).trim()) {
        errors.push('SQLite file path is required.');
      }
      break;
    }
    case 'redis': {
      const redisConfig = config as Partial<Extract<DatabaseConnection, { type: 'redis' }>>;
      const hasUri = !!String(redisConfig.connectionUri || '').trim();
      const hasHost = !!String(redisConfig.host || '').trim();
      if (!hasUri && !hasHost) {
        errors.push('Redis host or connection URI is required.');
      }
      if (redisConfig.port !== undefined && !isPortValid(Number(redisConfig.port))) {
        errors.push('Port must be between 1 and 65535.');
      }
      break;
    }
    case 'cassandra': {
      const cassandraConfig = config as Partial<Extract<DatabaseConnection, { type: 'cassandra' }>>;
      if (!Array.isArray(cassandraConfig.contactPoints) || cassandraConfig.contactPoints.length === 0) {
        errors.push('At least one Cassandra contact point is required.');
      }
      if (!cassandraConfig.localDataCenter || !String(cassandraConfig.localDataCenter).trim()) {
        errors.push('Cassandra local data center is required.');
      }
      if (cassandraConfig.port !== undefined && !isPortValid(Number(cassandraConfig.port))) {
        errors.push('Port must be between 1 and 65535.');
      }
      break;
    }
    case 'dynamodb': {
      const dynamoConfig = config as Partial<Extract<DatabaseConnection, { type: 'dynamodb' }>>;
      if (!dynamoConfig.region || !String(dynamoConfig.region).trim()) {
        errors.push('AWS region is required.');
      }
      break;
    }
    case 'oracle': {
      const oracleConfig = config as Partial<Extract<DatabaseConnection, { type: 'oracle' }>>;
      if (!oracleConfig.username || !String(oracleConfig.username).trim()) errors.push('Username is required.');
      if (!oracleConfig.password || !String(oracleConfig.password).trim()) errors.push('Password is required.');
      const hasConnectString = !!String(oracleConfig.connectString || '').trim();
      const hasHostService =
        !!String(oracleConfig.host || '').trim() &&
        (!!String(oracleConfig.serviceName || '').trim() || !!String(oracleConfig.sid || '').trim() || !!String(oracleConfig.database || '').trim());
      if (!hasConnectString && !hasHostService) {
        errors.push('Provide connectString or host with serviceName/sid/database.');
      }
      if (oracleConfig.port !== undefined && !isPortValid(Number(oracleConfig.port))) {
        errors.push('Port must be between 1 and 65535.');
      }
      break;
    }
    default:
      break;
  }

  return { valid: errors.length === 0, errors };
}
