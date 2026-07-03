import { describe, expect, it } from 'vitest';
import type { DatabaseConnection } from '../types';
import { getMongoDatabaseFromUri, resolveMongoConnectionTemplates } from '../utils/databasePanelMongoHelpers';

describe('DatabasePanel mongo helpers', () => {
  it('extracts database from MongoDB URI path', () => {
    expect(getMongoDatabaseFromUri('mongodb://localhost:27017/app')).toBe('app');
  });

  it('returns empty string when MongoDB URI has no database path', () => {
    expect(getMongoDatabaseFromUri('mongodb://localhost:27017')).toBe('');
  });

  it('resolves template variables in Mongo connection URI', () => {
    const conn: DatabaseConnection = {
      _id: 'mongo-1',
      name: 'Mongo',
      type: 'mongodb',
      ssl: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      connectionUri: 'mongodb://localhost:27017/{{dbName}}',
    };

    const resolved = resolveMongoConnectionTemplates(conn, { dbName: 'usersdb' });

    expect(resolved).not.toBeNull();
    expect(resolved?.connectionUri).toBe('mongodb://localhost:27017/usersdb');
  });

  it('returns null for non-mongodb connections', () => {
    const conn: DatabaseConnection = {
      _id: 'pg-1',
      name: 'Postgres',
      type: 'postgres',
      ssl: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      password: 'postgres',
      database: 'app',
    };

    const resolved = resolveMongoConnectionTemplates(conn, { dbName: 'usersdb' });
    expect(resolved).toBeNull();
  });
});
