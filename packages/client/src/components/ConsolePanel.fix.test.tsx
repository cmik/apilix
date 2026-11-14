// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { AI_FIX_SCRIPT, type AiFixScriptDetail } from '../utils/appEvents';

vi.mock('../store', () => ({ useApp: vi.fn() }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { EntryDetail } from './ConsolePanel';
import type { ConsoleEntry } from '../types';

const entry = (over: Partial<ConsoleEntry> = {}, testResults: unknown[] = []): ConsoleEntry => ({
  id: 'e1', timestamp: 1, method: 'GET', url: 'http://x', requestHeaders: [], tabId: 'tab-1', scriptLogs: [],
  response: { status: 200, statusText: 'OK', responseTime: 1, headers: {}, body: '', size: 0, testResults, error: null } as unknown as ConsoleEntry['response'],
  ...over,
});

const base = { mask: (v: string) => v.replace(/ENV-SECRET/g, '****'), detailMode: 'compact' as const, onToggleDetailMode: () => {}, detailMaxHeight: 300, bodyMaxHeight: 200 };

function listen() {
  const seen: AiFixScriptDetail[] = [];
  const fn = (e: Event) => seen.push((e as CustomEvent<AiFixScriptDetail>).detail);
  document.addEventListener(AI_FIX_SCRIPT, fn);
  return { seen, stop: () => document.removeEventListener(AI_FIX_SCRIPT, fn) };
}

describe('ConsolePanel "Fix with AI"', () => {
  afterEach(() => cleanup());

  it('a test-script error offers Fix with AI; the click raises an event with the masked error and sends nothing', async () => {
    const { seen, stop } = listen();
    render(<EntryDetail {...base} aiFixReady entry={entry({}, [{ name: '__ScriptError__', passed: false, error: 'apx.nope is not a function ENV-SECRET' }])} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fix with AI' }));
    stop();
    expect(seen).toEqual([{ tabId: 'tab-1', error: 'apx.nope is not a function ****', kind: 'test' }]);
  });

  it('a console.error log is an "auto" error', async () => {
    const { seen, stop } = listen();
    render(<EntryDetail {...base} aiFixReady entry={entry({ scriptLogs: [{ level: 'error', args: ['boom', 'x'] }] })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fix with AI' }));
    stop();
    expect(seen).toEqual([{ tabId: 'tab-1', error: 'boom x', kind: 'auto' }]);
  });

  it.each([
    ['the assistant is off', { aiFixReady: false }, entry({}, [{ name: '__ScriptError__', passed: false, error: 'x' }])],
    ['no tab is known for the entry', { aiFixReady: true }, entry({ tabId: undefined }, [{ name: '__ScriptError__', passed: false, error: 'x' }])],
    ['there is no script error (an ordinary failed assertion is not one)', { aiFixReady: true }, entry({}, [{ name: 'Status is 200', passed: false, error: 'expected 500 to equal 200' }])],
    ['only a log or warn', { aiFixReady: true }, entry({ scriptLogs: [{ level: 'warn', args: ['careful'] }] })],
  ])('no button when %s', (_label, props, e) => {
    render(<EntryDetail {...base} {...props} entry={e} />);
    expect(screen.queryByRole('button', { name: 'Fix with AI' })).toBeNull();
  });
});
