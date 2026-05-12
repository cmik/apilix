import { describe, it, expect } from 'vitest';
import { validateDatabaseConnection } from './databaseValidator';

describe('validateDatabaseConnection', () => {
  it('accepts a valid mysql config', () => {
    const result = validateDatabaseConnection({
      name: 'Main MySQL',
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      username: 'root',
      password: 'secret',
      database: 'app',
      connectionTimeout: 10000,
      queryTimeout: 30000,
      maxConnections: 5,
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects sql config with missing required fields', () => {
    const result = validateDatabaseConnection({
      name: 'Broken SQL',
      type: 'postgres',
      host: '',
      port: 0,
      username: '',
      database: '',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Host is required.');
    expect(result.errors).toContain('Port must be between 1 and 65535.');
    expect(result.errors).toContain('Username is required.');
    expect(result.errors).toContain('Database name is required.');
  });

  it('accepts a literal mongodb URI', () => {
    const result = validateDatabaseConnection({
      name: 'Mongo',
      type: 'mongodb',
      connectionUri: 'mongodb://localhost:27017/app',
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a templated mongodb URI for runtime variable resolution', () => {
    const result = validateDatabaseConnection({
      name: 'Mongo Templated',
      type: 'mongodb',
      connectionUri: '{{mongoUri}}',
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects invalid literal mongodb URI', () => {
    const result = validateDatabaseConnection({
      name: 'Mongo Invalid',
      type: 'mongodb',
      connectionUri: 'http://localhost:27017/app',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('MongoDB URI must start with mongodb:// or mongodb+srv://.');
  });

  it('validates timeout and pool ranges', () => {
    const result = validateDatabaseConnection({
      name: 'Out of range',
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      username: 'u',
      database: 'd',
      connectionTimeout: 99,
      queryTimeout: 600001,
      maxConnections: 0,
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Connection timeout must be between 100 and 120000 ms.');
    expect(result.errors).toContain('Query timeout must be between 100 and 600000 ms.');
    expect(result.errors).toContain('Max connections must be between 1 and 50.');
  });
});
