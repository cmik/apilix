// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { DEFAULT_AI_SETTINGS } from '../utils/aiDefaults';

const { mockedUseApp, aiSuggestAssertions } = vi.hoisted(() => ({ mockedUseApp: vi.fn(), aiSuggestAssertions: vi.fn() }));

vi.mock('../store', () => ({ useApp: mockedUseApp, generateId: () => 'test-id' }));
vi.mock('../api', () => ({ aiSuggestAssertions }));

import ResponseViewer from './ResponseViewer';

const item = {
  id: 'r1', name: 'Get', request: { method: 'GET', url: { raw: 'http://x' } },
  event: [{ listen: 'test', script: { type: 'text/javascript', exec: ["apx.test('old', () => {});"] } }],
};
const collection = { _id: 'col-1', info: { name: 'C', schema: '' }, item: [item] };

function setup(settings: Partial<typeof DEFAULT_AI_SETTINGS>) {
  const dispatch = vi.fn();
  mockedUseApp.mockReturnValue({
    state: {
      ai: { settings: { ...DEFAULT_AI_SETTINGS, ...settings, features: { ...DEFAULT_AI_SETTINGS.features, ...(settings.features ?? {}) } } },
      activeTabId: 'tab-1', activeRequest: { collectionId: 'col-1' }, isLoading: false,
      collections: [collection], tabs: [{ id: 'tab-1', collectionId: 'col-1', item, response: null, isLoading: false }],
      environments: [{ _id: 'e1', name: 'dev', values: [{ key: 'k', value: 'ENV-SECRET', enabled: true, secret: true }] }],
      globalVariables: {}, globalVariableMeta: {},
      response: { status: 200, statusText: 'OK', responseTime: 12, size: 7, headers: { 'content-type': 'application/json' }, body: '{"a":1}', error: null, testResults: [] },
    },
    dispatch,
  });
  render(<ResponseViewer />);
  return dispatch;
}

describe('ResponseViewer AI suggestions wiring', () => {
  beforeEach(() => { mockedUseApp.mockReset(); aiSuggestAssertions.mockReset(); if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn(); });
  afterEach(() => cleanup());

  it('sends nothing when the panel opens; the call happens on click with the request, response and all-environment secrets', async () => {
    aiSuggestAssertions.mockResolvedValue({ suggestions: [], discarded: [], discardedCount: 0, truncated: false, shapeOnly: false });
    const dispatch = setup({ enabled: true, consentGiven: true, model: 'm', features: { ...DEFAULT_AI_SETTINGS.features, assertSuggest: true } });
    await userEvent.click(screen.getByLabelText('Suggest tests'));
    expect(aiSuggestAssertions).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Improve with AI/ }));
    await waitFor(() => expect(aiSuggestAssertions).toHaveBeenCalledTimes(1));
    const payload = aiSuggestAssertions.mock.calls[0][0];
    expect(payload.name).toBe('Get');
    expect(payload.response).toMatchObject({ status: 200, body: '{"a":1}' });
    expect(payload.existingTests).toContain("apx.test('old'");
    expect(payload.secretValues).toEqual(['ENV-SECRET']);
    expect(aiSuggestAssertions.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(dispatch.mock.calls.map(c => c[0].type)).toEqual(expect.arrayContaining(['AI_REQUEST_START', 'AI_REQUEST_DONE']));
  });

  it('offers no AI at all when AI is off, and only a hint when the feature is off', async () => {
    setup({ enabled: false });
    await userEvent.click(screen.getByLabelText('Suggest tests'));
    expect(screen.queryByRole('button', { name: /Improve with AI/ })).toBeNull();
    expect(screen.queryByText(/Settings/)).toBeNull();
    cleanup();
    setup({ enabled: true, consentGiven: true, model: 'm' });
    await userEvent.click(screen.getByLabelText('Suggest tests'));
    expect(screen.queryByRole('button', { name: /Improve with AI/ })).toBeNull();
    expect(screen.getByText(/Turn on .*Suggest assertions from a response/)).toBeInTheDocument();
    expect(aiSuggestAssertions).not.toHaveBeenCalled();
  });
});
