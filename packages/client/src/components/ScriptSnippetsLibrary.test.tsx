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
    expect(onInsert.mock.calls[0][0]).toContain("apx.test('formatted date matches YYYY-MM-DD HH:mm:ss'",);
  });
});
