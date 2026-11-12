// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DEFAULT_AI_SETTINGS } from '../utils/aiDefaults';
import type { AiState } from '../types';

const dispatch = vi.fn();
const saveAiKey = vi.fn(async () => {});
const syncAiConfig = vi.fn(async () => {});
let ai: AiState;

vi.mock('../store', () => ({
  useApp: () => ({
    state: {
      ai,
      activeRequest: null,
      response: null,
      environments: [],
      activeEnvironmentId: null,
      globalVariables: {},
      globalVariableMeta: {},
      collectionVariables: {},
    },
    dispatch,
    saveAiKey,
    syncAiConfig,
    secretSet: new Set<string>(),
  }),
}));

const aiTest = vi.fn();
const aiPreview = vi.fn();
vi.mock('../api', async () => {
  class AiApiError extends Error {
    code: string;
    constructor(message: string, code: string) { super(message); this.code = code; }
  }
  return {
    aiTest: (...a: unknown[]) => aiTest(...a),
    aiPreview: (...a: unknown[]) => aiPreview(...a),
    toAiApiError: (e: unknown) => (e instanceof AiApiError ? e : new AiApiError(e instanceof Error ? e.message : 'x', 'INTERNAL')),
    AiApiError,
  };
});

import AiSettingsTab from './AiSettingsTab';

function makeAi(over: Partial<AiState['settings']> = {}, status: AiState['keyStatus'] = 'none'): AiState {
  return { settings: { ...DEFAULT_AI_SETTINGS, ...over }, keyStatus: status, inFlight: {}, lastError: null };
}

beforeEach(() => {
  ai = makeAi();
  dispatch.mockClear();
  saveAiKey.mockClear();
  syncAiConfig.mockClear();
  aiTest.mockReset();
  aiPreview.mockReset();
});
afterEach(() => cleanup());

describe('AiSettingsTab', () => {
  it('is off by default and the test button is disabled', () => {
    render(<AiSettingsTab />);
    const switches = screen.getAllByRole('switch');
    expect(switches[0]).toHaveAttribute('aria-checked', 'false');
    // every feature switch starts off
    for (const sw of switches.slice(3)) expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Test connection')).toBeDisabled();
    expect(screen.getByText(/Nothing is sent anywhere until you enable this/)).toBeInTheDocument();
  });

  it('enabling for the first time asks for consent and does not enable yet', () => {
    render(<AiSettingsTab />);
    fireEvent.click(screen.getAllByRole('switch')[0]);
    expect(screen.getByText('Before you enable AI features')).toBeInTheDocument();
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ enabled: true }) }));
  });

  it('accepting consent enables the features and records consent', () => {
    render(<AiSettingsTab />);
    fireEvent.click(screen.getAllByRole('switch')[0]);
    fireEvent.click(screen.getByText('I understand, enable AI features'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'AI_SET_SETTINGS', payload: { consentGiven: true, enabled: true } });
    expect(screen.queryByText('Before you enable AI features')).not.toBeInTheDocument();
  });

  it('cancelling consent leaves AI disabled', () => {
    render(<AiSettingsTab />);
    fireEvent.click(screen.getAllByRole('switch')[0]);
    fireEvent.click(screen.getByText('Cancel'));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('with consent already given, the toggle enables directly', () => {
    ai = makeAi({ consentGiven: true });
    render(<AiSettingsTab />);
    fireEvent.click(screen.getAllByRole('switch')[0]);
    expect(dispatch).toHaveBeenCalledWith({ type: 'AI_SET_SETTINGS', payload: { enabled: true } });
  });

  it('the key field is a password input, saved through saveAiKey and then cleared', async () => {
    render(<AiSettingsTab />);
    const input = screen.getByPlaceholderText('Paste your API key') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(screen.getByText('Save key')).toBeDisabled();
    fireEvent.change(input, { target: { value: 'sk-secret-123' } });
    fireEvent.click(screen.getByText('Save key'));
    await waitFor(() => expect(saveAiKey).toHaveBeenCalledWith('sk-secret-123', { remember: true }));
    await waitFor(() => expect(input.value).toBe(''));
    // The key is never dispatched into the store.
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain('sk-secret-123');
  });

  it('"Remember on this device" off is passed to saveAiKey', async () => {
    render(<AiSettingsTab />);
    fireEvent.click(screen.getByLabelText('Remember on this device'));
    fireEvent.change(screen.getByPlaceholderText('Paste your API key'), { target: { value: 'k-1234' } });
    fireEvent.click(screen.getByText('Save key'));
    await waitFor(() => expect(saveAiKey).toHaveBeenCalledWith('k-1234', { remember: false }));
  });

  it('shows a re-entry message when the stored key cannot be decrypted', () => {
    ai = makeAi({}, 'needs-reentry');
    render(<AiSettingsTab />);
    expect(screen.getByText(/can’t be read on this installation/)).toBeInTheDocument();
    expect(screen.getByText('Remove')).toBeInTheDocument();
  });

  it('warns that the browser stores the key unencrypted', () => {
    render(<AiSettingsTab />);
    expect(screen.getByText(/unencrypted in localStorage/)).toBeInTheDocument();
  });

  it('shows a validation error and keeps Test disabled when enabled without a model', () => {
    ai = makeAi({ enabled: true, consentGiven: true, model: '' });
    render(<AiSettingsTab />);
    expect(screen.getByText('Enter a model name to enable AI features')).toBeInTheDocument();
    expect(screen.getByText('Test connection')).toBeDisabled();
  });

  it('Test connection reports success', async () => {
    ai = makeAi({ enabled: true, consentGiven: true, model: 'm' });
    aiTest.mockResolvedValue({ ok: true, model: 'm', latencyMs: 123 });
    render(<AiSettingsTab />);
    fireEvent.click(screen.getByText('Test connection'));
    expect(await screen.findByText('Connected · m · 123 ms')).toBeInTheDocument();
    expect(dispatch).toHaveBeenCalledWith({ type: 'AI_REQUEST_START', payload: 'test' });
    expect(dispatch).toHaveBeenCalledWith({ type: 'AI_REQUEST_DONE', payload: 'test' });
  });

  it('Test connection reports failure with its code', async () => {
    ai = makeAi({ enabled: true, consentGiven: true, model: 'm' });
    const { AiApiError } = await import('../api');
    aiTest.mockRejectedValue(new (AiApiError as unknown as new (m: string, c: string) => Error)('bad key', 'AUTH'));
    render(<AiSettingsTab />);
    fireEvent.click(screen.getByText('Test connection'));
    expect(await screen.findByText('bad key (AUTH)')).toBeInTheDocument();
    expect(dispatch).toHaveBeenCalledWith({ type: 'AI_REQUEST_FAIL', payload: { feature: 'test', code: 'AUTH', message: 'bad key' } });
  });

  it('Test connection re-syncs the config and retries once when the server lost it (DISABLED / NO_PROVIDER)', async () => {
    ai = makeAi({ enabled: true, consentGiven: true, model: 'm' });
    const { AiApiError } = await import('../api');
    const E = AiApiError as unknown as new (m: string, c: string) => Error;
    aiTest.mockRejectedValueOnce(new E('AI features are disabled', 'DISABLED')).mockResolvedValueOnce({ ok: true, model: 'm', latencyMs: 5 });
    render(<AiSettingsTab />);
    fireEvent.click(screen.getByText('Test connection'));
    expect(await screen.findByText('Connected · m · 5 ms')).toBeInTheDocument();
    expect(syncAiConfig).toHaveBeenCalledTimes(1);
    expect(aiTest).toHaveBeenCalledTimes(2);
  });

  it('Test connection does not re-sync on other errors', async () => {
    ai = makeAi({ enabled: true, consentGiven: true, model: 'm' });
    const { AiApiError } = await import('../api');
    aiTest.mockRejectedValue(new (AiApiError as unknown as new (m: string, c: string) => Error)('bad key', 'AUTH'));
    render(<AiSettingsTab />);
    fireEvent.click(screen.getByText('Test connection'));
    expect(await screen.findByText('bad key (AUTH)')).toBeInTheDocument();
    expect(syncAiConfig).not.toHaveBeenCalled();
    expect(aiTest).toHaveBeenCalledTimes(1);
  });

  it('"See what will be sent" opens the preview with redaction stats', async () => {
    aiPreview.mockResolvedValue({
      sections: [{ label: 'Request', text: '{"url":"https://x/?token=<redacted>"}', truncated: false }],
      estimatedTokens: 12,
      redactions: 1,
    });
    render(<AiSettingsTab />);
    fireEvent.click(screen.getByText('See what will be sent'));
    expect(await screen.findByText('Request')).toBeInTheDocument();
    expect(screen.getByText(/1 value masked/)).toBeInTheDocument();
    expect(screen.getByText(/≈ 12 tokens/)).toBeInTheDocument();
    expect(aiPreview).toHaveBeenCalledWith(expect.objectContaining({ settings: expect.objectContaining({ redactSecrets: true, sendResponseBodies: true }) }));
  });

  it('feature switches update the matching feature only', () => {
    render(<AiSettingsTab />);
    const switches = screen.getAllByRole('switch');
    // switches: enable, sendResponseBodies, redactSecrets, then 7 feature toggles
    fireEvent.click(switches[3]);
    expect(dispatch).toHaveBeenCalledWith({ type: 'AI_SET_SETTINGS', payload: { features: { nlGenerate: true } } });
  });
});
