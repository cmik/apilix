import { describe, expect, it } from 'vitest';
import type { DatabaseConnection } from '../types';
import {
  buildDatabaseConnectionsExportPackage,
  makeDuplicateConnection,
  normalizeImportedConnections,
  parseDatabaseConnectionsImportText,
} from './databaseConnectionTransfer';

const baseConn: DatabaseConnection = {
  _id: 'db-1',
  name: 'Primary DB',
  type: 'postgres',
  ssl: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  host: 'localhost',
  port: 5432,
  username: 'user',
  password: 'pass',
  database: 'app',
};

describe('databaseConnectionTransfer', () => {
  it('parses exported package format', () => {
    const payload = buildDatabaseConnectionsExportPackage([baseConn]);
    const parsed = parseDatabaseConnectionsImportText(JSON.stringify(payload));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('Primary DB');
  });

  it('parses single connection object', () => {
    const parsed = parseDatabaseConnectionsImportText(JSON.stringify(baseConn));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]._id).toBe('db-1');
  });

  it('normalizes imported ids and names to avoid collisions', () => {
    const existing = [{ ...baseConn }];
    const imported = [{ ...baseConn, testStatus: 'success' as const, lastTestedAt: '2026-01-02T00:00:00.000Z' }];
    let seq = 0;
    const normalized = normalizeImportedConnections(imported, existing, () => `new-${++seq}`);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]._id).toBe('new-1');
    expect(normalized[0].name).toBe('Primary DB (2)');
    expect(normalized[0].testStatus).toBeUndefined();
    expect(normalized[0].lastTestedAt).toBeUndefined();
  });

  it('duplicates with a unique copy name', () => {
    let seq = 0;
    const duplicated = makeDuplicateConnection(baseConn, ['Primary DB', 'Primary DB Copy'], () => `dup-${++seq}`);
    expect(duplicated._id).toBe('dup-1');
    expect(duplicated.name).toBe('Primary DB Copy (2)');
    expect(duplicated.testStatus).toBeUndefined();
  });
});
