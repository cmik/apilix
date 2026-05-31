// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import ScriptSnippetsLibrary from './ScriptSnippetsLibrary';

afterEach(() => {
  cleanup();
});

describe('ScriptSnippetsLibrary', () => {
  it('shows new pre-request snippets and inserts decode JWT code', async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();

    render(<ScriptSnippetsLibrary target="prerequest" onInsert={onInsert} />);

    await user.click(screen.getByRole('button', { name: /snippets/i }));
    await user.click(screen.getByRole('button', { name: 'Variables & Environment' }));

    expect(screen.getByText('Decode JWT Payload')).toBeInTheDocument();
    expect(screen.getByText('Random String')).toBeInTheDocument();
    expect(screen.getByText('Formatted Date (UTC)')).toBeInTheDocument();

    const cards = screen.getAllByText('Decode JWT Payload');
    const row = cards.find(el => el.closest('div')?.textContent?.includes('Decode a JWT payload and store claims for reuse'));
    const container = row?.closest('div')?.parentElement;
    const insertButton = container?.querySelector('button:last-of-type') as HTMLButtonElement;
    await user.click(insertButton);

    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert.mock.calls[0][0]).toContain("const token = apx.environment.get('jwt') ?? '';");
    expect(onInsert.mock.calls[0][0]).toContain("apx.environment.set('jwtPayload', JSON.stringify(payload));");

    await user.click(screen.getByRole('button', { name: /snippets/i }));
    await user.click(screen.getByRole('button', { name: 'SQL Databases' }));
    expect(screen.getByText('Set SQL Date Range Variables')).toBeInTheDocument();

    const sqlCards = screen.getAllByText('Set SQL Date Range Variables');
    const sqlRow = sqlCards.find(el => el.closest('div')?.textContent?.includes('Prepare start/end timestamps for SQL WHERE filters'));
    const sqlContainer = sqlRow?.closest('div')?.parentElement;
    const sqlInsertButton = sqlContainer?.querySelector('button:last-of-type') as HTMLButtonElement;
    await user.click(sqlInsertButton);

    expect(onInsert).toHaveBeenCalledTimes(2);
    expect(onInsert.mock.calls[1][0]).toContain("apx.environment.set('sqlStartAt', start.toISOString());");
  });

  it('shows new test snippets and inserts formatted date code', async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();

    render(<ScriptSnippetsLibrary target="test" onInsert={onInsert} />);

    await user.click(screen.getByRole('button', { name: /snippets/i }));
    await user.click(screen.getByRole('button', { name: 'Apilix apx.* functions' }));

    expect(screen.getByText('Decode JWT Payload')).toBeInTheDocument();
    expect(screen.getByText('Generate Random String')).toBeInTheDocument();
    expect(screen.getByText('Generate Formatted Date (UTC)')).toBeInTheDocument();

    const cards = screen.getAllByText('Generate Formatted Date (UTC)');
    const row = cards.find(el => el.closest('div')?.textContent?.includes('Generate and validate YYYY-MM-DD HH:mm:ss format in UTC'));
    const container = row?.closest('div')?.parentElement;
    const insertButton = container?.querySelector('button:last-of-type') as HTMLButtonElement;
    await user.click(insertButton);

    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(onInsert.mock.calls[0][0]).toContain("const formatted = [");
    expect(onInsert.mock.calls[0][0]).toContain("apx.environment.set('formattedDate', formatted);");
    expect(onInsert.mock.calls[0][0]).toContain("apx.test('formatted date matches YYYY-MM-DD HH:mm:ss'");

    await user.click(screen.getByRole('button', { name: /snippets/i }));
    await user.click(screen.getByRole('button', { name: 'SQL Result Assertions' }));
    expect(screen.getByText('Row count > 0')).toBeInTheDocument();

    const sqlCards = screen.getAllByText('Row count > 0');
    const sqlRow = sqlCards.find(el => el.closest('div')?.textContent?.includes('Assert query returned at least one row'));
    const sqlContainer = sqlRow?.closest('div')?.parentElement;
    const sqlInsertButton = sqlContainer?.querySelector('button:last-of-type') as HTMLButtonElement;
    await user.click(sqlInsertButton);

    expect(onInsert).toHaveBeenCalledTimes(2);
    expect(onInsert.mock.calls[1][0]).toContain("apx.expect(json.rowCount).to.be.above(0);");

    await user.click(screen.getByRole('button', { name: /snippets/i }));
    await user.click(screen.getByRole('button', { name: 'Database Requests' }));
    expect(screen.getByText('MySQL Query')).toBeInTheDocument();
    expect(screen.getByText('MongoDB find')).toBeInTheDocument();

    const dbCards = screen.getAllByText('MySQL Query');
    const dbRow = dbCards.find(el => el.closest('div')?.textContent?.includes('Run a MySQL query with positional parameters and store rows'));
    const dbContainer = dbRow?.closest('div')?.parentElement;
    const dbInsertButton = dbContainer?.querySelector('button:last-of-type') as HTMLButtonElement;
    await user.click(dbInsertButton);

    expect(onInsert).toHaveBeenCalledTimes(3);
    expect(onInsert.mock.calls[2][0]).toContain("const connectionId = apx.environment.get('mysqlConnectionId') ?? 'mysql-connection-id';");
    expect(onInsert.mock.calls[2][0]).toContain("const result = await apx.db.query(");
  });
});
