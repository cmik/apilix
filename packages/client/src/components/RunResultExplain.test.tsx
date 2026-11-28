// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { DEFAULT_AI_SETTINGS } from '../utils/aiDefaults';
import type { AppCollection, RunnerIterationResult } from '../types';

const { mockedUseApp, aiExplainFailure } = vi.hoisted(() => ({ mockedUseApp: vi.fn(), aiExplainFailure: vi.fn() }));
vi.mock('../store', () => ({ useApp: mockedUseApp }));
vi.mock('../api', () => ({
  aiExplainFailure,
  toAiApiError: (e: { code?: string; message?: string }) => Object.assign(new Error(e?.message ?? 'x'), { code: e?.code ?? 'INTERNAL' }),
}));
vi.mock('./AiPreviewDialog', () => ({ default: () => <div role="dialog" aria-label="preview" /> }));

import RunResultExplain from './RunResultExplain';
import { runResultFailures, findResultItem } from '../utils/ai/runResultExplain';

const ready = { enabled: true, consentGiven: true, model: 'm', features: { ...DEFAULT_AI_SETTINGS.features, diagnose: true } };
const collection = {
  _id: 'c1', info: { name: 'C' },
  item: [
    { id: 'a', name: 'Login', request: { method: 'POST', url: '{{base}}/login' }, event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => {})'] } }] },
    { id: 'b', name: 'Dup', request: { method: 'GET', url: '{{base}}/x' } },
    { id: 'c', name: 'Dup', request: { method: 'GET', url: '{{base}}/x' } },
  ],
} as unknown as AppCollection;
const result = (over: object = {}) => ({
  name: 'Login', method: 'POST', url: '{{base}}/login', resolvedUrl: 'https://api.test/login?token=RESOLVED-SECRET',
  requestHeaders: { Authorization: 'Bearer RESOLVED-SECRET' }, requestBody: 'password=RESOLVED-SECRET',
  status: 401, statusText: 'Unauthorized', responseTime: 12, headers: { 'content-type': 'application/json' }, body: '{"error":"no"}',
  testResults: [{ name: 'Status is 200', passed: false, error: 'expected 401 to equal 200' }], error: null, ...over,
}) as unknown as RunnerIterationResult;

function mockApp(settings: object = ready) {
  const dispatch = vi.fn();
  mockedUseApp.mockReturnValue({
    state: {
      ai: { settings: { ...DEFAULT_AI_SETTINGS, ...settings, features: { ...DEFAULT_AI_SETTINGS.features, ...((settings as { features?: object }).features ?? {}) } } },
      environments: [], globalVariables: {}, globalVariableMeta: {}, collectionVariables: {}, activeEnvironmentId: null,
    },
    dispatch,
  });
  return dispatch;
}

describe('runResultFailures / findResultItem', () => {
  it('lists failed tests, or the failed request when there is no test', () => {
    expect(runResultFailures(result())).toEqual([{ name: 'Status is 200', error: 'expected 401 to equal 200' }]);
    expect(runResultFailures(result({ testResults: [], status: 500 }))[0].name).toBe('Request failed');
    expect(runResultFailures(result({ testResults: [], status: 200 }))).toEqual([]);
    expect(runResultFailures(result({ protocol: 'sql' }))).toEqual([]);
  });
  it('matches an item only when it is unambiguous', () => {
    expect(findResultItem(collection, result())?.id).toBe('a');
    expect(findResultItem(collection, result({ name: 'Dup', method: 'GET', url: '{{base}}/x' }))).toBeNull();
    expect(findResultItem(undefined, result())).toBeNull();
  });
});

describe('RunResultExplain', () => {
  beforeEach(() => { mockedUseApp.mockReset(); aiExplainFailure.mockReset(); });
  afterEach(() => cleanup());

  it('renders nothing when the feature is off or nothing failed', () => {
    mockApp({ ...ready, features: { diagnose: false } });
    expect(render(<RunResultExplain result={result()} collection={collection} />).container).toBeEmptyDOMElement();
    cleanup();
    mockApp(ready);
    expect(render(<RunResultExplain result={result({ status: 200, testResults: [] })} collection={collection} />).container).toBeEmptyDOMElement();
  });

  it('sends nothing until the click, then the template request (never the resolved URL, headers or body)', async () => {
    aiExplainFailure.mockResolvedValue({ summary: 'Wrong credentials.', likelyCauses: [], suggestedFixes: [], shapeOnly: false });
    const dispatch = mockApp(ready);
    render(<RunResultExplain result={result()} collection={collection} />);
    expect(aiExplainFailure).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Explain with AI/ }));
    await waitFor(() => expect(aiExplainFailure).toHaveBeenCalledTimes(1));
    const payload = aiExplainFailure.mock.calls[0][0];
    expect(payload.request).toEqual(collection.item[0].request);
    expect(payload.testScript).toContain('pm.test');
    expect(payload.failures).toEqual([{ name: 'Status is 200', error: 'expected 401 to equal 200' }]);
    expect(JSON.stringify(payload)).not.toContain('RESOLVED-SECRET');
    expect(dispatch).toHaveBeenCalledWith({ type: 'AI_REQUEST_START', payload: 'diagnose' });
    await waitFor(() => expect(screen.getByText(/Wrong credentials/)).toBeInTheDocument());
  });

  it('falls back to the method and URL template when the item is ambiguous', async () => {
    aiExplainFailure.mockResolvedValue({ summary: 's', likelyCauses: [], suggestedFixes: [], shapeOnly: false });
    mockApp(ready);
    render(<RunResultExplain result={result({ name: 'Dup', method: 'GET', url: '{{base}}/x' })} collection={collection} />);
    await userEvent.click(screen.getByRole('button', { name: /Explain with AI/ }));
    await waitFor(() => expect(aiExplainFailure).toHaveBeenCalled());
    const payload = aiExplainFailure.mock.calls[0][0];
    expect(payload.request).toEqual({ method: 'GET', url: '{{base}}/x' });
    expect(payload.testScript).toBe('');
  });
});
