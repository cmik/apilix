// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RequestResponse } from '../types';
import { INJECT_TEST_SNIPPET } from '../utils/appEvents';
import type { InjectTestSnippetDetail } from '../utils/appEvents';
import type { AiSuggestAssertionsResult } from '../utils/ai/aiTypes';
import AssertionSuggestPanel, { type AiAssistProps } from './AssertionSuggestPanel';

afterEach(() => cleanup());

const response = {
  status: 201, statusText: 'Created', responseTime: 80,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: '3f2b8c1e-8a53-4f0e-9d6a-0a7a3c5d9e11', status: 'active' }),
  size: 10, testResults: [],
} as unknown as RequestResponse;

const aiResult = (over: Partial<AiSuggestAssertionsResult> = {}): AiSuggestAssertionsResult => ({
  suggestions: [
    { id: 'ai1', title: 'Status is a known value', kind: 'body', confidence: 'high', script: "apx.test('Status is a known value', () => { apx.expect(['active','pending']).to.include(apx.response.json().status); });" },
    { id: 'ai2', title: 'Maybe flaky ![x](http://evil.test/p.png)', kind: 'body', confidence: 'low', volatile: true, script: "apx.test('flaky', () => {});" },
  ],
  discarded: [{ title: 'Wrong', reason: 'fails' }], discardedCount: 1, truncated: false, shapeOnly: false, ...over,
});

const assist = (over: Partial<AiAssistProps> = {}): AiAssistProps => ({
  enabled: true, destination: 'Anthropic', shapeOnly: false, run: vi.fn(async () => aiResult()), ...over,
});

describe('AssertionSuggestPanel AI layer', () => {
  it('does nothing on the network until the user clicks, then merges and pre-checks high-confidence AI suggestions', async () => {
    const a = assist();
    render(<AssertionSuggestPanel response={response} tabId="t1" existingScript="" onClose={() => {}} aiAssist={a} />);
    expect(a.run).not.toHaveBeenCalled();
    expect(screen.getByText(/Sends this request and a truncated copy of the response to Anthropic/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Improve with AI/ }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Status is a known value/ })).toBeChecked());
    expect(a.run).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('AI').length).toBe(2);
    expect(screen.getByRole('checkbox', { name: /Maybe flaky/ })).not.toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent('2 AI suggestions kept, 1 dropped because they failed on this response');
    // local suggestions stay
    expect(screen.getByRole('checkbox', { name: /Status code is 201/ })).toBeChecked();
  });

  it('neutralises images and links in AI titles', async () => {
    render(<AssertionSuggestPanel response={response} tabId="t1" existingScript="" onClose={() => {}} aiAssist={assist()} />);
    fireEvent.click(screen.getByRole('button', { name: /Improve with AI/ }));
    await waitFor(() => screen.getByRole('checkbox', { name: /Maybe flaky/ }));
    expect(document.body.innerHTML).not.toContain('evil.test');
    expect(document.querySelector('img')).toBeNull();
  });

  it('falls back to the local suggestions when the AI call fails', async () => {
    const a = assist({ run: vi.fn(async () => { throw new Error('Provider unreachable'); }) });
    render(<AssertionSuggestPanel response={response} tabId="t1" existingScript="" onClose={() => {}} aiAssist={a} />);
    fireEvent.click(screen.getByRole('button', { name: /Improve with AI/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Provider unreachable'));
    expect(screen.getByRole('checkbox', { name: /Status code is 201/ })).toBeChecked();
    expect(screen.queryByText('AI')).toBeNull();
  });

  it('shows only a hint (no button, no call) when the feature is off', () => {
    const a = assist({ enabled: false, hint: 'Turn on the feature in Settings.' });
    render(<AssertionSuggestPanel response={response} tabId="t1" existingScript="" onClose={() => {}} aiAssist={a} />);
    expect(screen.getByText('Turn on the feature in Settings.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Improve with AI/ })).toBeNull();
    expect(a.run).not.toHaveBeenCalled();
  });

  it('states that only the structure is sent when response bodies are off', () => {
    render(<AssertionSuggestPanel response={response} tabId="t1" existingScript="" onClose={() => {}} aiAssist={assist({ shapeOnly: true })} />);
    expect(screen.getByText(/structure of the response \(types, no values\)/)).toBeInTheDocument();
  });

  it('adds an AI suggestion only on Add, with the duplicate guard', async () => {
    const events: InjectTestSnippetDetail[] = [];
    const handler = (e: Event) => events.push((e as CustomEvent<InjectTestSnippetDetail>).detail);
    document.addEventListener(INJECT_TEST_SNIPPET, handler);
    render(<AssertionSuggestPanel response={response} tabId="t1" existingScript="" onClose={() => {}} aiAssist={assist()} />);
    fireEvent.click(screen.getByRole('button', { name: /Improve with AI/ }));
    await waitFor(() => screen.getByRole('checkbox', { name: /Status is a known value/ }));
    expect(events).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /^Add \d+ tests?$/ }));
    document.removeEventListener(INJECT_TEST_SNIPPET, handler);
    expect(events.some(e => e.snippet.includes("['active','pending']"))).toBe(true);
    expect(events.every(e => (e.skipIfPresent?.length ?? 0) > 0)).toBe(true);
  });

  it('is unchanged (no AI UI) without the aiAssist prop', () => {
    render(<AssertionSuggestPanel response={response} tabId="t1" existingScript="" onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: /Improve with AI/ })).toBeNull();
  });
});
