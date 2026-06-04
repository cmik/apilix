// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { MongoDBConnectionConfig } from '../types';
import { ConnectionEditorModal } from './DatabasePanel';

afterEach(() => {
  cleanup();
});

function makeMongoInitial(overrides: Partial<MongoDBConnectionConfig> = {}): MongoDBConnectionConfig {
  return {
    _id: 'mongo-1',
    name: 'Mongo DB',
    type: 'mongodb',
    ssl: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    connectionUri: 'mongodb://localhost:27017/app',
    database: 'app',
    auth: {
      mode: 'scram',
      username: 'tester',
      password: 'secret',
      authSource: 'admin',
    },
    ...overrides,
  };
}

describe('ConnectionEditorModal', () => {
  it('does not persist hidden username/password for x509 auth mode', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(
      <ConnectionEditorModal
        initial={makeMongoInitial()}
        runtimeVars={{}}
        onSave={onSave}
        onClose={() => {}}
      />
    );

    const authModeSelect = screen.getByDisplayValue('SCRAM (username + password)');
    await user.selectOptions(authModeSelect, 'x509');

    expect(screen.queryByText('Login')).not.toBeInTheDocument();
    expect(screen.queryByText('Password')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as MongoDBConnectionConfig;
    expect(saved.auth?.mode).toBe('x509');
    expect(saved.auth?.username).toBeUndefined();
    expect(saved.auth?.password).toBeUndefined();
    expect(saved.auth?.authSource).toBe('admin');
  });

  it('persists username/password for ldap-plain auth mode', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();

    render(
      <ConnectionEditorModal
        initial={makeMongoInitial()}
        runtimeVars={{}}
        onSave={onSave}
        onClose={() => {}}
      />
    );

    const authModeSelect = screen.getByDisplayValue('SCRAM (username + password)');
    await user.selectOptions(authModeSelect, 'ldap-plain');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0][0] as MongoDBConnectionConfig;
    expect(saved.auth?.mode).toBe('ldap-plain');
    expect(saved.auth?.username).toBe('tester');
    expect(saved.auth?.password).toBe('secret');
    expect(saved.auth?.authSource).toBe('admin');
  });
});
