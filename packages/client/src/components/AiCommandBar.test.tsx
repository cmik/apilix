// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DEFAULT_AI_SETTINGS } from '../utils/aiDefaults';
import type { AiState, CollectionItem } from '../types';

const dispatch = vi.fn();
let ai: AiState;

const neighbor = (id: string): CollectionItem => ({ id, name: id, request: { method: 'GET', url: `https://api.test/${id}`, header: [] }, response: [{ name: 'ex', body: 'EXAMPLE-BODY' }] });
const collection = {
  _id: 'c1',
  info: { name: 'Shop', schema: 'x' },
  variable: [{ key: 'colVar', value: 'COLLECTION-SECRET-VALUE' }],
  item: [{ id: 'f1', name: 'Users', item: [neighbor('u1'), neighbor('u2')] }, neighbor('root1')],
};

vi.mock('../store', () => ({
  useApp: () => ({
    state: {
      ai,
      collections: [collection],
      environments: [
        { _id: 'e1', name: 'dev', values: [{ key: 'baseUrl', value: 'https://dev.test', enabled: true }, { key: 'token', value: 'ENV-SECRET-VALUE', enabled: true, secret: true }] },
        { _id: 'e2', name: 'prod', values: [{ key: 'prodToken', value: 'PROD-SECRET-VALUE', enabled: true, secret: true }] },
      ],
      activeEnvironmentId: 'e1',
      globalVariables: { g1: 'GLOBAL-VALUE' },
      globalVariableMeta: {},
      collectionVariables: { c1: { cv: 'CV-VALUE' } },
    },
    dispatch,
  }),
}));

const aiGenerateRequest = vi.fn();
vi.mock('../api', async () => {
  class AiApiError extends Error {
    code: string;
    constructor(message: string, code: string) { super(message); this.code = code; }
  }
  return {
    aiGenerateRequest: (...a: unknown[]) => aiGenerateRequest(...a),
    toAiApiError: (e: unknown) => (e instanceof AiApiError ? e : new AiApiError(e instanceof Error ? e.message : 'x', 'INTERNAL')),
    AiApiError,
  };
});

import AiCommandBar from './AiCommandBar';

const makeAi = (over: Partial<AiState['settings']> = {}, features: Partial<AiState['settings']['features']> = {}): AiState => ({
  settings: { ...DEFAULT_AI_SETTINGS, enabled: true, consentGiven: true, model: 'm', features: { ...DEFAULT_AI_SETTINGS.features, nlGenerate: true, ...features }, ...over },
  keyStatus: 'ok', inFlight: {}, lastError: null,
});

const okResult = () => ({
  draft: { name: 'Create user', method: 'POST', url: '{{baseUrl}}/users', headers: [], body: { mode: 'none' }, tests: "apx.test('Status is 201', () => {});" },
  validation: { validated: true, errors: [] }, warnings: [], retried: false,
});

beforeEach(() => { ai = makeAi(); dispatch.mockClear(); aiGenerateRequest.mockReset(); });
afterEach(() => cleanup());

describe('AiCommandBar', () => {
  it('explains how to enable the feature and makes no call when it is off', () => {
    ai = makeAi({}, { nlGenerate: false });
    render(<AiCommandBar collectionId="c1" folderId="f1" onApply={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/Turn on .*Generate requests and tests from a description/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate' })).toBeNull();
    expect(aiGenerateRequest).not.toHaveBeenCalled();
    cleanup();
    ai = makeAi({ enabled: false });
    render(<AiCommandBar collectionId="c1" folderId="f1" onApply={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/AI features are off/)).toBeInTheDocument();
  });

  it('sends the instruction, variable NAMES, folder neighbours and all-environment secrets, never values', async () => {
    aiGenerateRequest.mockResolvedValue(okResult());
    render(<AiCommandBar collectionId="c1" folderId="f1" onApply={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'POST /users with a name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(aiGenerateRequest).toHaveBeenCalledTimes(1));
    const payload = aiGenerateRequest.mock.calls[0][0];
    expect(payload.instruction).toBe('POST /users with a name');
    expect(payload.current).toBeUndefined();
    expect(payload.neighbors.map((n: CollectionItem) => n.id)).toEqual(['u1', 'u2']);
    expect(JSON.stringify(payload.neighbors)).not.toContain('EXAMPLE-BODY');
    expect(payload.variables).toEqual(expect.arrayContaining([
      { name: 'baseUrl', scope: 'environment', secret: false },
      { name: 'token', scope: 'environment', secret: true },
      { name: 'g1', scope: 'global', secret: false },
      { name: 'cv', scope: 'collection', secret: false },
      { name: 'colVar', scope: 'collection', secret: false },
    ]));
    // names only: no value of any variable is in `variables`
    expect(JSON.stringify(payload.variables)).not.toMatch(/SECRET-VALUE|GLOBAL-VALUE|CV-VALUE|COLLECTION-SECRET/);
    // the secrets of every environment (not only the active one) go to the server for scrubbing
    expect(payload.secretValues).toEqual(expect.arrayContaining(['ENV-SECRET-VALUE', 'PROD-SECRET-VALUE']));
    expect(dispatch).toHaveBeenCalledWith({ type: 'AI_REQUEST_START', payload: 'nlGenerate' });
    await screen.findByRole('dialog', { name: 'AI proposal' });
  });

  it('applies only after the user clicks Apply in the proposal, then closes', async () => {
    aiGenerateRequest.mockResolvedValue(okResult());
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<AiCommandBar collectionId="c1" folderId="f1" onApply={onApply} onClose={onClose} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByRole('dialog', { name: 'AI proposal' });
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][1]).toBe('create');
    expect(onApply.mock.calls[0][0].name).toBe('Create user');
    expect(onClose).toHaveBeenCalled();
  });

  it('Ignore closes without applying; Regenerate asks again', async () => {
    aiGenerateRequest.mockResolvedValue(okResult());
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<AiCommandBar collectionId="c1" folderId="f1" onApply={onApply} onClose={onClose} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByRole('dialog', { name: 'AI proposal' });
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(aiGenerateRequest).toHaveBeenCalledTimes(2));
    await screen.findByRole('dialog', { name: 'AI proposal' });
    fireEvent.click(screen.getByRole('button', { name: 'Ignore' }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a provider error and stays on the input', async () => {
    aiGenerateRequest.mockRejectedValue(new Error('Provider rejected the key ![x](http://evil.test/a.png)'));
    render(<AiCommandBar collectionId="c1" folderId={null} onApply={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Provider rejected the key');
    expect(document.body.innerHTML).not.toContain('evil.test');
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'AI_REQUEST_FAIL' }));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('modify mode sends the current request and excludes it from the neighbours', async () => {
    aiGenerateRequest.mockResolvedValue(okResult());
    const current = neighbor('u1');
    render(<AiCommandBar collectionId="c1" folderId="f1" current={current} initialMode="modify" onApply={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Modify selected request' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'add a header' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(aiGenerateRequest).toHaveBeenCalled());
    const payload = aiGenerateRequest.mock.calls[0][0];
    expect(payload.current.id).toBe('u1');
    expect(payload.neighbors.map((n: CollectionItem) => n.id)).toEqual(['u2']);
  });

  it('refuses to modify a non-REST request (create only)', () => {
    const gql: CollectionItem = { id: 'g', name: 'g', request: { method: 'POST', url: 'https://x', body: { mode: 'graphql', graphql: { query: '{a}' } } } };
    render(<AiCommandBar collectionId="c1" folderId={null} current={gql} initialMode="modify" onApply={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('Escape closes the bar', () => {
    const onClose = vi.fn();
    render(<AiCommandBar collectionId="c1" folderId={null} onApply={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
