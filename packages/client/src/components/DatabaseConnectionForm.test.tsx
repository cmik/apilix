// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { DatabaseConnection } from '../types';
import DatabaseConnectionForm from './DatabaseConnectionForm';

afterEach(() => {
  cleanup();
});

function makeBaseConnection(overrides: Partial<DatabaseConnection>): DatabaseConnection {
  return {
    _id: 'db-1',
    name: 'Test DB',
    type: 'mysql',
    ssl: false,
    connectionTimeout: 10000,
    queryTimeout: 30000,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as DatabaseConnection;
}

describe('DatabaseConnectionForm', () => {
  it('shows all supported database types in the selector', () => {
    render(
      <DatabaseConnectionForm
        value={makeBaseConnection({ type: 'mysql', host: 'localhost', port: 3306, username: 'root', password: '', database: 'app' })}
        onChange={() => {}}
        onTestConnection={() => {}}
        testing={false}
        testResult={null}
        validationErrors={[]}
      />
    );

    expect(screen.getByRole('option', { name: 'MySQL' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'PostgreSQL' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'MongoDB' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'SQLite' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Redis' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Cassandra' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'DynamoDB' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Oracle' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'MSSQL' })).toBeInTheDocument();
  });

  it('renders sqlite-specific controls', () => {
    render(
      <DatabaseConnectionForm
        value={makeBaseConnection({
          type: 'sqlite',
          filePath: './db.sqlite',
          readonly: true,
        })}
        onChange={() => {}}
        onTestConnection={() => {}}
        testing={false}
        testResult={null}
        validationErrors={[]}
      />
    );

    expect(screen.getByText('Database File Path')).toBeInTheDocument();
    expect(screen.getByText('Open read-only')).toBeInTheDocument();
  });
});
