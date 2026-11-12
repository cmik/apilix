// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DEFAULT_AI_SETTINGS } from '../utils/aiDefaults';
import type { AiState, AppCollection } from '../types';

const dispatch = vi.fn();
let ai: AiState;
let secrets = new Set<string>();

vi.mock('../store', () => ({
  generateId: () => 'mock-id',
  useApp: () => ({
    state: { ai },
    dispatch,
    getActiveEnvironment: () => null,
    secretSet: secrets,
  }),
}));
vi.mock('./Toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }) }));
vi.mock('../utils/responseFileSave', () => ({ saveResponseToFile: vi.fn() }));

const aiDescribeDocs = vi.fn();
vi.mock('../api', async () => {
  class AiApiError extends Error {
    code: string;
    constructor(message: string, code: string) { super(message); this.code = code; }
  }
  return {
    aiDescribeDocs: (...a: unknown[]) => aiDescribeDocs(...a),
    toAiApiError: (e: unknown) => (e instanceof AiApiError ? e : new AiApiError(e instanceof Error ? e.message : 'x', 'INTERNAL')),
    AiApiError,
  };
});

import ExportDocsModal from './ExportDocsModal';

const collection = {
  info: { name: 'Shop', description: '' },
  item: [{ id: 'r1', name: 'List orders', request: { method: 'GET', url: { raw: 'https://api.test/orders?token=SUPER-SECRET-9', query: [{ key: 'limit', value: '10' }] } } }],
} as unknown as AppCollection;

function makeAi(settings: Partial<AiState['settings']>, features: Partial<AiState['settings']['features']> = {}): AiState {
  return {
    settings: { ...DEFAULT_AI_SETTINGS, ...settings, features: { ...DEFAULT_AI_SETTINGS.features, ...features } },
    keyStatus: 'ok', inFlight: {}, lastError: null,
  };
}

beforeEach(() => {
  ai = makeAi({ enabled: true, provider: 'openai-compat', model: 'm' }, { docDescribe: true });
  secrets = new Set(['SUPER-SECRET-9']);
  dispatch.mockClear();
  aiDescribeDocs.mockReset();
});
afterEach(() => cleanup());

const open = () => render(<ExportDocsModal collection={collection} onClose={() => {}} />);

describe('ExportDocsModal AI descriptions', () => {
  it('shows a hint, and no generate button, when AI is off', () => {
    ai = makeAi({ enabled: false });
    open();
    expect(screen.getByText(/AI is off/)).toBeInTheDocument();
    expect(screen.queryByText('Generate missing descriptions')).not.toBeInTheDocument();
  });

  it('shows a hint when the feature is not enabled in settings', () => {
    ai = makeAi({ enabled: true }, { docDescribe: false });
    open();
    expect(screen.getByText(/Turn on/)).toBeInTheDocument();
    expect(screen.queryByText('Generate missing descriptions')).not.toBeInTheDocument();
  });

  it('sends a masked collection, lets the user edit, and merges the text into the export', async () => {
    aiDescribeDocs.mockResolvedValue({
      descriptions: { r1: { description: 'Lists orders.', params: { limit: 'Max rows.' } } },
      warnings: [], requested: 1,
    });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }));
    fireEvent.click(screen.getByText('Generate missing descriptions'));

    await waitFor(() => expect(aiDescribeDocs).toHaveBeenCalledTimes(1));
    const payload = aiDescribeDocs.mock.calls[0][0] as { collection: unknown };
    expect(JSON.stringify(payload.collection)).not.toContain('SUPER-SECRET-9');
    expect(dispatch).toHaveBeenCalledWith({ type: 'AI_REQUEST_START', payload: 'docDescribe' });

    const desc = await screen.findByLabelText('Description for GET List orders');
    fireEvent.change(desc, { target: { value: 'Edited by the user.' } });

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(/Edited by the user\./)).toBeInTheDocument();
    expect(screen.getByText(/Max rows\. _\(AI\)_/)).toBeInTheDocument();
  });

  it('unchecking an entry removes it from the export', async () => {
    aiDescribeDocs.mockResolvedValue({ descriptions: { r1: { description: 'Lists orders.' } }, warnings: [], requested: 1 });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }));
    fireEvent.click(screen.getByText('Generate missing descriptions'));
    const row = await screen.findByLabelText('Description for GET List orders');
    expect(row).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /GET List orders/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.queryByText(/Lists orders\./)).not.toBeInTheDocument();
  });

  it('shows the error and keeps the export usable when the call fails', async () => {
    aiDescribeDocs.mockRejectedValue(Object.assign(new Error('bad key'), { code: 'AUTH' }));
    open();
    fireEvent.click(screen.getByText('Generate missing descriptions'));
    await waitFor(() => expect(screen.getByText(/bad key/)).toBeInTheDocument());
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'AI_REQUEST_FAIL' }));
    expect(screen.getByRole('button', { name: 'Save…' })).toBeEnabled();
  });

  it('says so when nothing needs describing', async () => {
    aiDescribeDocs.mockResolvedValue({ descriptions: {}, warnings: [], requested: 0 });
    open();
    fireEvent.click(screen.getByText('Generate missing descriptions'));
    await waitFor(() => expect(screen.getByText(/every entry already has a description/)).toBeInTheDocument());
  });
});
