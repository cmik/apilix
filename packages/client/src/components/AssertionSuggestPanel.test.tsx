// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RequestResponse } from '../types';
import { INJECT_TEST_SNIPPET } from '../utils/appEvents';
import type { InjectTestSnippetDetail } from '../utils/appEvents';
import AssertionSuggestPanel from './AssertionSuggestPanel';

afterEach(() => cleanup());

const response = {
  status: 201,
  statusText: 'Created',
  responseTime: 80,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: '3f2b8c1e-8a53-4f0e-9d6a-0a7a3c5d9e11', name: 'Ada' }),
  size: 10,
  testResults: [],
} as unknown as RequestResponse;

function collectEvents() {
  const events: InjectTestSnippetDetail[] = [];
  const handler = (e: Event) => events.push((e as CustomEvent<InjectTestSnippetDetail>).detail);
  document.addEventListener(INJECT_TEST_SNIPPET, handler);
  return { events, stop: () => document.removeEventListener(INJECT_TEST_SNIPPET, handler) };
}

describe('AssertionSuggestPanel', () => {
  it('pre-checks recommended suggestions and leaves timing and captures unchecked', () => {
    render(<AssertionSuggestPanel response={response} tabId="t1" existingScript="" onClose={() => {}} />);
    expect(screen.getByRole('checkbox', { name: /Status code is 201/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Content-Type is application\/json/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Response time is below/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Save id as id/ })).not.toBeChecked();
    expect(screen.getAllByText('may change').length).toBeGreaterThan(0);
  });

  it('adds only the checked suggestions, routed to the tab, with duplicate guards', () => {
    const onClose = vi.fn();
    const { events, stop } = collectEvents();
    render(<AssertionSuggestPanel response={response} tabId="t1" existingScript="" onClose={onClose} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Content-Type is/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Add \d+ tests?$/ }));
    stop();
    expect(onClose).toHaveBeenCalled();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(e => e.tabId === 't1')).toBe(true);
    expect(events.some(e => e.snippet.includes('apx.response.code'))).toBe(true);
    expect(events.some(e => e.snippet.includes('Content-Type'))).toBe(false);
    for (const e of events) {
      expect(e.skipIfPresent && e.skipIfPresent.length).toBeGreaterThan(0);
      expect(e.skipIfPresent).toContain(e.snippet.trim());
    }
  });

  it('marks suggestions already in the saved script and does not add them', () => {
    const existing = 'apx.test("Status code is 201", () => {\n  apx.expect(apx.response.code).to.equal(201);\n});';
    const { events, stop } = collectEvents();
    render(<AssertionSuggestPanel response={response} tabId={null} existingScript={existing} onClose={() => {}} />);
    const status = screen.getByRole('checkbox', { name: /Status code is 201/ });
    expect(status).toBeDisabled();
    expect(status).not.toBeChecked();
    expect(screen.getByText('already in tests')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Select all'));
    fireEvent.click(screen.getByRole('button', { name: /^Add \d+ tests?$/ }));
    stop();
    expect(events.some(e => e.snippet.includes('Status code is 201'))).toBe(false);
  });

  it('disables Add when nothing is selected, and closes on Escape', () => {
    const onClose = vi.fn();
    render(<AssertionSuggestPanel response={response} tabId="t1" existingScript="" onClose={onClose} />);
    fireEvent.click(screen.getByText('Select none'));
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows an empty state for a response with nothing to suggest', () => {
    const bare = { ...response, status: 0, headers: {}, body: '', responseTime: undefined } as unknown as RequestResponse;
    render(<AssertionSuggestPanel response={bare} tabId={null} existingScript="" onClose={() => {}} />);
    expect(screen.getByText('No suggestions for this response.')).toBeInTheDocument();
  });
  it('shows a visible note when the body is too large to analyse', () => {
    const big = { ...response, body: JSON.stringify({ items: Array.from({ length: 200000 }, (_, i) => ({ i })) }) } as unknown as RequestResponse;
    render(<AssertionSuggestPanel response={big} tabId="t1" existingScript="" onClose={() => {}} />);
    expect(screen.getByRole('note')).toHaveTextContent(/too large to analyse/);
  });
});
