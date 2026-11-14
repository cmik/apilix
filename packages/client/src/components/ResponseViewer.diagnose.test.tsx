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

const item = { id: 'r1', name: 'Get', request: { method: 'GET', url: { raw: 'http://x' } } };
const collection = { _id: 'col-1', info: { name: 'C', schema: '' }, item: [item] };
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const expiredJwt = `${b64({ alg: 'none' })}.${b64({ exp: 1 })}.sig`;

function setup(settings: Partial<typeof DEFAULT_AI_SETTINGS>, response: object) {
  mockedUseApp.mockReturnValue({
    state: {
      ai: { settings: { ...DEFAULT_AI_SETTINGS, ...settings, features: { ...DEFAULT_AI_SETTINGS.features, ...(settings.features ?? {}) } } },
      activeTabId: 'tab-1', activeRequest: { collectionId: 'col-1' }, isLoading: false, activeEnvironmentId: 'e1',
      collections: [collection], tabs: [{ id: 'tab-1', collectionId: 'col-1', item, response: null, isLoading: false }],
      environments: [{ _id: 'e1', name: 'dev', values: [{ key: 'baseUrl', value: 'http://x', enabled: true }] }],
      globalVariables: {}, globalVariableMeta: {}, collectionVariables: {},
      response: { status: 200, statusText: 'OK', responseTime: 12, size: 7, headers: {}, body: '', error: null, testResults: [], ...response },
    },
    dispatch: vi.fn(),
  });
  return render(<ResponseViewer />);
}

const off = { enabled: false };
const ready = { enabled: true, consentGiven: true, model: 'm', features: { ...DEFAULT_AI_SETTINGS.features, diagnose: true } };
const refused = { status: 0, statusText: 'Request Failed', error: 'connect ECONNREFUSED 127.0.0.1:3000', body: 'connect ECONNREFUSED 127.0.0.1:3000', resolvedUrl: 'http://localhost:3000/x' };

describe('ResponseViewer probable cause (local, no AI)', () => {
  beforeEach(() => { mockedUseApp.mockReset(); aiExplainFailure.mockReset(); if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn(); });
  afterEach(() => cleanup());

  it('shows the cause of a refused connection with AI turned off, and calls nothing', () => {
    setup(off, refused);
    expect(screen.getByTestId('local-diagnosis-connection-refused')).toHaveTextContent('The connection was refused');
    expect(screen.queryByRole('button', { name: /Explain with AI/ })).toBeNull();
    expect(aiExplainFailure).not.toHaveBeenCalled();
  });

  it('flags an unresolved variable left in the resolved URL', () => {
    setup(off, { status: 404, statusText: 'Not Found', resolvedUrl: 'http://x/{{userId}}/a' });
    expect(screen.getByTestId('local-diagnosis-unresolved-variable')).toHaveTextContent('{{userId}}');
  });

  it('flags an expired bearer token on a 401, from the headers actually sent', () => {
    setup(off, { status: 401, statusText: 'Unauthorized', resolvedUrl: 'http://x', requestHeaders: { Authorization: `Bearer ${expiredJwt}` } });
    expect(screen.getByTestId('local-diagnosis-jwt-expired')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(expiredJwt);
  });

  it('shows nothing for a healthy response', () => {
    setup(off, { resolvedUrl: 'http://x/{{never}}' });
    expect(screen.queryByTestId('local-diagnosis')).toBeNull();
  });

  it('Explain on a transport failure sends the rule ids and a synthetic failure, only on click', async () => {
    aiExplainFailure.mockResolvedValue({ summary: 'Nothing listens', likelyCauses: [], suggestedFixes: [], truncated: false, shapeOnly: false });
    setup(ready, refused);
    expect(aiExplainFailure).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Explain with AI/ }));
    await waitFor(() => expect(aiExplainFailure).toHaveBeenCalledTimes(1));
    const p = aiExplainFailure.mock.calls[0][0];
    expect(p.localDiagnosis).toEqual(['connection-refused']);
    expect(p.failures).toEqual([{ name: 'Request failed', error: 'connect ECONNREFUSED 127.0.0.1:3000' }]);
    expect(p.response.status).toBe(0);
    expect(await screen.findByText('Nothing listens')).toBeInTheDocument();
  });

  it('Explain for failed tests also carries the local diagnosis, from the Tests tab', async () => {
    aiExplainFailure.mockResolvedValue({ summary: 'Expired', likelyCauses: [], suggestedFixes: [], truncated: false, shapeOnly: false });
    setup(ready, {
      status: 401, statusText: 'Unauthorized', resolvedUrl: 'http://x', requestHeaders: { Authorization: `Bearer ${expiredJwt}` },
      testResults: [{ name: 'Status is 200', passed: false, error: 'expected 401 to equal 200' }],
    });
    await userEvent.click(screen.getByRole('button', { name: /^Tests/ }));
    await userEvent.click(screen.getByRole('button', { name: /Explain with AI/ }));
    await waitFor(() => expect(aiExplainFailure).toHaveBeenCalledTimes(1));
    expect(aiExplainFailure.mock.calls[0][0].localDiagnosis).toEqual(['jwt-expired']);
    expect(aiExplainFailure.mock.calls[0][0].failures).toEqual([{ name: 'Status is 200', error: 'expected 401 to equal 200' }]);
  });

  it('Explain is offered for a failed request even when no rule matched, without a cause box', async () => {
    setup(ready, { status: 500, statusText: 'Server Error', resolvedUrl: 'http://x' });
    expect(screen.getByRole('button', { name: /Explain with AI/ })).toBeInTheDocument();
    expect(screen.queryByText('Probable cause')).toBeNull();
  });

  it('a passing 4xx with a test (the user expects it) gets no Explain button', () => {
    setup(ready, { status: 404, statusText: 'Not Found', resolvedUrl: 'http://x', testResults: [{ name: 'is 404', passed: true, error: null }] });
    expect(screen.queryByRole('button', { name: /Explain with AI/ })).toBeNull();
  });
});
