import type { DatabaseConnection } from '../types';

export interface DatabaseValidationResult {
  valid: boolean;
  errors: string[];
}

function isPortValid(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
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

  if (config.maxConnections !== undefined && (config.maxConnections < 1 || config.maxConnections > 50)) {
    errors.push('Max connections must be between 1 and 50.');
  }

  if (config.type === 'mysql' || config.type === 'postgres') {
    if (!config.host || !String(config.host).trim()) errors.push('Host is required.');
    if (!isPortValid(Number(config.port))) errors.push('Port must be between 1 and 65535.');
    if (!config.username || !String(config.username).trim()) errors.push('Username is required.');
    if (!config.database || !String(config.database).trim()) errors.push('Database name is required.');
  }

  if (config.type === 'mongodb') {
    const uri = String(config.connectionUri || '').trim();
    if (!uri) {
      errors.push('MongoDB connection URI is required.');
    } else if (!uri.includes('{{') && !/^mongodb(\+srv)?:\/\//i.test(uri)) {
      errors.push('MongoDB URI must start with mongodb:// or mongodb+srv://.');
    }
  }

  return { valid: errors.length === 0, errors };
}
