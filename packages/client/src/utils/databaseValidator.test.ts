import { describe, it, expect } from 'vitest';
import { validateDatabaseConnection } from './databaseValidator';
import { makeDatabasePreset } from '../constants/databasePresets';

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

  it('accepts mongodb auth settings with scram credentials', () => {
    const result = validateDatabaseConnection({
      name: 'Mongo Auth',
      type: 'mongodb',
      connectionUri: 'mongodb://localhost:27017/app',
      auth: {
        mode: 'scram',
        username: '{{mongoUser}}',
        password: '{{mongoPassword}}',
        authSource: 'admin',
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects mongodb auth settings with invalid mode', () => {
    const result = validateDatabaseConnection({
      name: 'Mongo Bad Auth',
      type: 'mongodb',
      connectionUri: 'mongodb://localhost:27017/app',
      auth: {
        mode: 'bad-mode' as 'scram',
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('MongoDB auth mode must be one of: scram, x509, ldap-plain, oidc.');
  });

  it('rejects scram auth settings when username/password are missing', () => {
    const result = validateDatabaseConnection({
      name: 'Mongo Missing Creds',
      type: 'mongodb',
      connectionUri: 'mongodb://localhost:27017/app',
      auth: {
        mode: 'scram',
      },
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('MongoDB auth username is required for SCRAM/LDAP auth.');
    expect(result.errors).toContain('MongoDB auth password is required for SCRAM/LDAP auth.');
  });

  it('accepts the default mongodb preset without requiring auth credentials', () => {
    const preset = { ...makeDatabasePreset('mongodb'), name: 'Mongo Preset' };
    const result = validateDatabaseConnection(preset);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
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
