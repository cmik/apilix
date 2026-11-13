// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { DEFAULT_AI_SETTINGS } from '../utils/aiDefaults';

const { mockedUseApp, aiExplainFailure } = vi.hoisted(() => ({ mockedUseApp: vi.fn(), aiExplainFailure: vi.fn() }));

vi.mock('../store', () => ({ useApp: mockedUseApp, generateId: () => 'test-id' }));
vi.mock('../api', () => ({
  aiSuggestAssertions: vi.fn(),
  aiExplainFailure,
  toAiApiError: (e: { code?: string; message?: string }) => Object.assign(new Error(e?.message ?? 'x'), { code: e?.code ?? 'INTERNAL' }),
}));

import ResponseViewer from './ResponseViewer';

const item = {
  id: 'r1', name: 'Get', request: { method: 'GET', url: { raw: 'http://x' } },
  event: [{ listen: 'test', script: { type: 'text/javascript', exec: ["apx.test('Status is 200', () => {});"] } }],
};
const collection = { _id: 'col-1', info: { name: 'C', schema: '' }, item: [item] };
const failing = [{ name: 'Status is 200', passed: false, error: 'expected 401 to equal 200' }, { name: 'ok', passed: true, error: null }];

let lastRender: ReturnType<typeof render> | null = null;
function setup(settings: Partial<typeof DEFAULT_AI_SETTINGS>, testResults: unknown[] = failing, extraResponse: object = {}) {
  const dispatch = mockApp(settings, testResults, extraResponse);
  lastRender = render(<ResponseViewer />);
  return dispatch;
}

function mockApp(settings: Partial<typeof DEFAULT_AI_SETTINGS>, testResults: unknown[] = failing, extraResponse: object = {}) {
  const dispatch = vi.fn();
  mockedUseApp.mockReturnValue({
    state: {
      ai: { settings: { ...DEFAULT_AI_SETTINGS, ...settings, features: { ...DEFAULT_AI_SETTINGS.features, ...(settings.features ?? {}) } } },
      activeTabId: 'tab-1', activeRequest: { collectionId: 'col-1' }, isLoading: false, activeEnvironmentId: 'e1',
      collections: [collection], tabs: [{ id: 'tab-1', collectionId: 'col-1', item, response: null, isLoading: false }],
      environments: [{ _id: 'e1', name: 'dev', values: [{ key: 'k', value: 'ENV-SECRET', enabled: true, secret: true }, { key: 'baseUrl', value: 'http://x', enabled: true }] }],
      globalVariables: {}, globalVariableMeta: {}, collectionVariables: {},
      response: { status: 401, statusText: 'Unauthorized', responseTime: 12, size: 7, headers: {}, body: '{"e":1}', error: null, testResults, ...extraResponse },
    },
    dispatch,
  });
  return dispatch;
}

const ready = { enabled: true, consentGiven: true, model: 'm', features: { ...DEFAULT_AI_SETTINGS.features, diagnose: true } };
const openTests = () => userEvent.click(screen.getByRole('button', { name: /^Tests/ }));

describe('ResponseViewer "Explain with AI"', () => {
  beforeEach(() => { mockedUseApp.mockReset(); aiExplainFailure.mockReset(); if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn(); });
  afterEach(() => cleanup());

  it('is shown for failed tests when AI is on, consented and the feature is enabled', async () => {
    setup(ready);
    await openTests();
    expect(screen.getByRole('button', { name: /Explain with AI/ })).toBeInTheDocument();
  });

  it.each([
    ['AI is off', { ...ready, enabled: false }, failing],
    ['no consent', { ...ready, consentGiven: false }, failing],
    ['the feature is off', { ...ready, features: { ...DEFAULT_AI_SETTINGS.features, diagnose: false, assertSuggest: true } }, failing],
    ['no test failed', ready, [{ name: 'ok', passed: true, error: null }]],
  ])('is absent when %s', async (_label, settings, results) => {
    setup(settings, results);
    await openTests();
    expect(screen.queryByRole('button', { name: /Explain with AI/ })).toBeNull();
  });

  it('sends the failures, script and variable names on click, never the secret values in plain text fields', async () => {
    aiExplainFailure.mockResolvedValue({ summary: 'Token rejected', likelyCauses: [], suggestedFixes: [], truncated: false, shapeOnly: false });
    const dispatch = setup(ready);
    await openTests();
    expect(aiExplainFailure).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Explain with AI/ }));
    await waitFor(() => expect(aiExplainFailure).toHaveBeenCalledTimes(1));
    const p = aiExplainFailure.mock.calls[0][0];
    expect(p.failures).toEqual([{ name: 'Status is 200', error: 'expected 401 to equal 200' }]);
    expect(p.testScript).toContain("apx.test('Status is 200'");
    expect(p.variableNames).toEqual(expect.arrayContaining(['k', 'baseUrl']));
    expect(p.variableNames).not.toContain('http://x');
    expect(p.secretValues).toEqual(['ENV-SECRET']);
    expect(aiExplainFailure.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(await screen.findByText('Token rejected')).toBeInTheDocument();
    expect(dispatch.mock.calls.map(c => c[0].type)).toEqual(expect.arrayContaining(['AI_REQUEST_START', 'AI_REQUEST_DONE']));
  });

  it('records a failure with the mapped code, but not a cancellation', async () => {
    aiExplainFailure.mockRejectedValue(Object.assign(new Error('Too large'), { code: 'TOO_LARGE' }));
    const dispatch = setup(ready);
    await openTests();
    await userEvent.click(screen.getByRole('button', { name: /Explain with AI/ }));
    await waitFor(() => expect(dispatch.mock.calls.map(c => c[0].type)).toContain('AI_REQUEST_FAIL'));
    expect(dispatch.mock.calls.find(c => c[0].type === 'AI_REQUEST_FAIL')![0].payload).toMatchObject({ feature: 'diagnose', code: 'TOO_LARGE' });
    cleanup();
    aiExplainFailure.mockImplementation((_p: unknown, signal: AbortSignal) => new Promise((_res, rej) => {
      signal.addEventListener('abort', () => rej(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })));
    }));
    const d2 = setup(ready);
    await openTests();
    await userEvent.click(screen.getByRole('button', { name: /Explain with AI/ }));
    await waitFor(() => expect(aiExplainFailure).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(d2.mock.calls.map(c => c[0].type)).toContain('AI_REQUEST_DONE'));
    expect(d2.mock.calls.map(c => c[0].type)).not.toContain('AI_REQUEST_FAIL');
  });

  it('a new response clears the previous explanation and aborts a call in flight; the same response keeps its state', async () => {
    aiExplainFailure.mockResolvedValueOnce({ summary: 'First answer', likelyCauses: [], suggestedFixes: [], truncated: false, shapeOnly: false });
    setup(ready);
    await openTests();
    await userEvent.click(screen.getByRole('button', { name: /Explain with AI/ }));
    expect(await screen.findByText('First answer')).toBeInTheDocument();
    // Same response (new object, same identity): state is kept.
    mockApp(ready);
    lastRender!.rerender(<ResponseViewer />);
    expect(screen.getByText('First answer')).toBeInTheDocument();
    // New response (another run): the answer disappears.
    mockApp(ready, [{ name: 'Status is 200', passed: false, error: 'expected 500 to equal 200' }], { status: 500, responseTime: 99 });
    lastRender!.rerender(<ResponseViewer />);
    expect(screen.queryByText('First answer')).toBeNull();
    expect(screen.getByRole('button', { name: /Explain with AI/ })).toBeInTheDocument();
  });

  it('a call in flight is aborted when the response changes', async () => {
    let signal!: AbortSignal;
    aiExplainFailure.mockImplementation((_p: unknown, s: AbortSignal) => { signal = s; return new Promise(() => { /* pending */ }); });
    setup(ready);
    await openTests();
    await userEvent.click(screen.getByRole('button', { name: /Explain with AI/ }));
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal.aborted).toBe(false);
    mockApp(ready, failing, { status: 403, responseTime: 7 });
    lastRender!.rerender(<ResponseViewer />);
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole('button', { name: /Explain with AI/ })).toBeEnabled();
  });

  it('remounts when only the body content changes (same length), keeps state for an identical response', async () => {
    let signal!: AbortSignal;
    aiExplainFailure.mockImplementation((_p: unknown, s: AbortSignal) => { signal = s; return new Promise(() => { /* pending */ }); });
    setup(ready, failing, { body: '{"e":1}' });
    await openTests();
    await userEvent.click(screen.getByRole('button', { name: /Explain with AI/ }));
    await waitFor(() => expect(signal).toBeDefined());
    mockApp(ready, failing, { body: '{"e":1}' });
    lastRender!.rerender(<ResponseViewer />);
    expect(signal.aborted).toBe(false);
    mockApp(ready, failing, { body: '{"e":2}' });
    lastRender!.rerender(<ResponseViewer />);
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole('button', { name: /Explain with AI/ })).toBeEnabled();
  });

  it('clears a finished explanation when only the body content changes', async () => {
    aiExplainFailure.mockResolvedValueOnce({ summary: 'Body answer', likelyCauses: [], suggestedFixes: [], truncated: false, shapeOnly: false });
    setup(ready, failing, { body: '{"e":1}' });
    await openTests();
    await userEvent.click(screen.getByRole('button', { name: /Explain with AI/ }));
    expect(await screen.findByText('Body answer')).toBeInTheDocument();
    mockApp(ready, failing, { body: '{"e":9}' });
    lastRender!.rerender(<ResponseViewer />);
    expect(screen.queryByText('Body answer')).toBeNull();
  });
});
