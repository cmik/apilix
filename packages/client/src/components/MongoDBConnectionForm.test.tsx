// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { MongoDBConnectionConfig } from '../types';
import MongoDBConnectionForm from './MongoDBConnectionForm';

afterEach(() => {
  cleanup();
});

function makeMongoValue(overrides: Partial<MongoDBConnectionConfig> = {}): MongoDBConnectionConfig {
  return {
    _id: 'mongo-1',
    name: 'Mongo DB',
    type: 'mongodb',
    ssl: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    connectionUri: 'mongodb://localhost:27017/app',
    auth: {
      mode: 'scram',
      username: 'tester',
      password: 'secret',
      authSource: 'admin',
    },
    ...overrides,
  };
}

describe('MongoDBConnectionForm', () => {
  it('defaults to None mode and hides login/password when auth is missing', () => {
    const onChange = vi.fn();

    render(
      <MongoDBConnectionForm
        value={makeMongoValue({ auth: undefined })}
        onChange={onChange}
      />
    );

    const authModeLabel = screen.getByText('Auth Mode');
    const authModeSelect = authModeLabel.parentElement?.querySelector('select');
    expect(authModeSelect).not.toBeNull();
    expect(authModeSelect).toHaveValue('none');
    expect(screen.queryByLabelText('Login')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('clears username/password when switching to x509', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <MongoDBConnectionForm
        value={makeMongoValue()}
        onChange={onChange}
      />
    );

    const modeSelect = screen.getByDisplayValue('SCRAM (username + password)');
    await user.selectOptions(modeSelect, 'x509');

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as MongoDBConnectionConfig;
    expect(next.auth?.mode).toBe('x509');
    expect(next.auth?.username).toBeUndefined();
    expect(next.auth?.password).toBeUndefined();
    expect(next.auth?.authSource).toBe('admin');
  });

  it('keeps username/password when switching to ldap-plain', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <MongoDBConnectionForm
        value={makeMongoValue()}
        onChange={onChange}
      />
    );

    const modeSelect = screen.getByDisplayValue('SCRAM (username + password)');
    await user.selectOptions(modeSelect, 'ldap-plain');

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as MongoDBConnectionConfig;
    expect(next.auth?.mode).toBe('ldap-plain');
    expect(next.auth?.username).toBe('tester');
    expect(next.auth?.password).toBe('secret');
  });
});
