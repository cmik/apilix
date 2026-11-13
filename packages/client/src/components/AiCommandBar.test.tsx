// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
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

const collection2 = {
  _id: 'c2',
  info: { name: 'Billing', schema: 'x' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: 'LITERAL-BEARER-TOKEN', type: 'string' }] },
  variable: [{ key: 'billVar', value: 'v' }],
  item: [{ id: 'bf', name: 'Invoices', item: [{ id: 'bf2', name: 'Archive', item: [neighbor('inv1')] }] }, neighbor('bill-root')],
};

vi.mock('../store', () => ({
  useApp: () => ({
    state: {
      ai,
      collections: [collection, collection2],
      environments: [
        { _id: 'e1', name: 'dev', values: [{ key: 'baseUrl', value: 'https://dev.test', enabled: true }, { key: 'token', value: 'ENV-SECRET-VALUE', enabled: true, secret: true }] },
        { _id: 'e2', name: 'prod', values: [{ key: 'prodToken', value: 'PROD-SECRET-VALUE', enabled: true, secret: true }] },
      ],
      activeEnvironmentId: 'e1',
      globalVariables: { g1: 'GLOBAL-VALUE' },
      globalVariableMeta: {},
      collectionVariables: { c1: { cv: 'CV-VALUE' }, c2: { cv2: 'CV2-VALUE' } },
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

  describe('destination picker', () => {
    const pick = (value: string) => fireEvent.change(screen.getByLabelText('Destination'), { target: { value } });
    const generate = async () => {
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
      fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
      await screen.findByRole('dialog', { name: 'AI proposal' });
    };

    it('lists collections and nested folders and defaults to the opening location', () => {
      render(<AiCommandBar collectionId="c1" folderId="f1" onApply={vi.fn()} onClose={vi.fn()} />);
      const select = screen.getByLabelText('Destination') as HTMLSelectElement;
      const labels = Array.from(select.options).map(o => o.textContent!.replace(/\u00a0/g, ' ').trim());
      expect(labels).toEqual(['Shop', '\u21b3 Shop / Users', 'Billing', '\u21b3 Billing / Invoices', '\u21b3 Billing / Invoices / Archive']);
      expect(select.options[select.selectedIndex].textContent).toContain('Shop / Users');
    });

    it('preselects the collection root when folderId is null', () => {
      render(<AiCommandBar collectionId="c2" folderId={null} onApply={vi.fn()} onClose={vi.fn()} />);
      const select = screen.getByLabelText('Destination') as HTMLSelectElement;
      expect(select.options[select.selectedIndex].textContent).toBe('Billing');
    });

    it('offers a new-unsaved-tab option when opened without a collection', async () => {
      aiGenerateRequest.mockResolvedValue(okResult());
      const onApply = vi.fn();
      render(<AiCommandBar collectionId="" folderId={null} targetLabel="a new unsaved tab" onApply={onApply} onClose={vi.fn()} />);
      const select = screen.getByLabelText('Destination') as HTMLSelectElement;
      expect(select.options[select.selectedIndex].textContent).toBe('A new unsaved tab');
      await generate();
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
      expect(onApply.mock.calls[0][2]).toEqual({ collectionId: '', folderId: null });
    });

    it('a different destination drives the context, the proposal label and the destination passed to onApply', async () => {
      aiGenerateRequest.mockResolvedValue(okResult());
      const onApply = vi.fn();
      render(<AiCommandBar collectionId="c1" folderId="f1" targetLabel={'the folder \u201cUsers\u201d'} onApply={onApply} onClose={vi.fn()} />);
      const select = screen.getByLabelText('Destination') as HTMLSelectElement;
      pick(Array.from(select.options).find(o => o.textContent!.includes('Billing / Invoices / Archive'))!.value);
      await generate();
      const payload = aiGenerateRequest.mock.calls[0][0];
      expect(payload.neighbors.map((n: CollectionItem) => n.id)).toEqual(['inv1']);
      expect(payload.variables).toEqual(expect.arrayContaining([
        { name: 'cv2', scope: 'collection', secret: false },
        { name: 'billVar', scope: 'collection', secret: false },
      ]));
      expect(payload.variables).not.toEqual(expect.arrayContaining([{ name: 'cv', scope: 'collection', secret: false }]));
      expect(screen.getByRole('dialog', { name: 'AI proposal' })).toHaveTextContent('the folder \u201cArchive\u201d');
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
      expect(onApply.mock.calls[0][2]).toEqual({ collectionId: 'c2', folderId: 'bf2' });
    });

    it('the collection root of another collection is labelled as the collection and passes folderId null', async () => {
      aiGenerateRequest.mockResolvedValue(okResult());
      const onApply = vi.fn();
      render(<AiCommandBar collectionId="c1" folderId="f1" onApply={onApply} onClose={vi.fn()} />);
      const select = screen.getByLabelText('Destination') as HTMLSelectElement;
      pick(Array.from(select.options).find(o => o.textContent === 'Billing')!.value);
      await generate();
      expect(aiGenerateRequest.mock.calls[0][0].neighbors.map((n: CollectionItem) => n.id)).toEqual(['bill-root', 'inv1']);
      expect(screen.getByRole('dialog', { name: 'AI proposal' })).toHaveTextContent('the collection \u201cBilling\u201d');
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
      expect(onApply.mock.calls[0][2]).toEqual({ collectionId: 'c2', folderId: null });
    });

    it('keeps the unchanged opening location (and label) when nothing was picked', async () => {
      aiGenerateRequest.mockResolvedValue(okResult());
      const onApply = vi.fn();
      render(<AiCommandBar collectionId="c1" folderId="f1" targetLabel="LABEL-FROM-CALLER" onApply={onApply} onClose={vi.fn()} />);
      await generate();
      expect(screen.getByRole('dialog', { name: 'AI proposal' })).toHaveTextContent('LABEL-FROM-CALLER');
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
      expect(onApply.mock.calls[0][2]).toEqual({ collectionId: 'c1', folderId: 'f1' });
    });

    it('Regenerate keeps the chosen destination', async () => {
      aiGenerateRequest.mockResolvedValue(okResult());
      render(<AiCommandBar collectionId="c1" folderId="f1" onApply={vi.fn()} onClose={vi.fn()} />);
      const select = screen.getByLabelText('Destination') as HTMLSelectElement;
      pick(Array.from(select.options).find(o => o.textContent === 'Billing')!.value);
      await generate();
      fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
      await waitFor(() => expect(aiGenerateRequest).toHaveBeenCalledTimes(2));
      expect(aiGenerateRequest.mock.calls[1][0].neighbors.map((n: CollectionItem) => n.id)).toEqual(['bill-root', 'inv1']);
    });

    it('is disabled while generating', () => {
      aiGenerateRequest.mockImplementation(() => new Promise(() => {}));
      render(<AiCommandBar collectionId="c1" folderId="f1" onApply={vi.fn()} onClose={vi.fn()} />);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
      fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
      expect(screen.getByLabelText('Destination')).toBeDisabled();
    });

    it('is not shown in modify mode, and the destination stays the opening location', async () => {
      aiGenerateRequest.mockResolvedValue(okResult());
      const onApply = vi.fn();
      render(<AiCommandBar collectionId="c1" folderId="f1" current={neighbor('u1')} initialMode="modify" onApply={onApply} onClose={vi.fn()} />);
      expect(screen.queryByLabelText('Destination')).toBeNull();
      await generate();
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
      expect(onApply.mock.calls[0][1]).toBe('modify');
      expect(onApply.mock.calls[0][2]).toEqual({ collectionId: 'c1', folderId: 'f1' });
    });

    it('security: the exfiltration warning uses the CHOSEN destination (its bearer auth and known hosts)', async () => {
      aiGenerateRequest.mockResolvedValue({
        ...okResult(),
        draft: { ...okResult().draft, url: 'https://evil.example/collect' },
      });
      render(<AiCommandBar collectionId="c1" folderId="f1" onApply={vi.fn()} onClose={vi.fn()} />);
      // c1 has no auth: no warning there
      await generate();
      expect(screen.queryByText(/send secrets to an unfamiliar host/)).toBeNull();
      cleanup();
      render(<AiCommandBar collectionId="c1" folderId="f1" onApply={vi.fn()} onClose={vi.fn()} />);
      const select = screen.getByLabelText('Destination') as HTMLSelectElement;
      pick(Array.from(select.options).find(o => o.textContent!.includes('Billing / Invoices'))!.value);
      await generate();
      expect(screen.getByText(/send secrets to an unfamiliar host/)).toBeInTheDocument();
      expect(screen.getByText(/credential written in its/)).toBeInTheDocument();
    });
  });

  describe('cancel while generating', () => {
    let signal: AbortSignal;
    const start = (onClose = vi.fn()) => {
      aiGenerateRequest.mockImplementation((_b: unknown, sig: AbortSignal) => {
        signal = sig;
        return new Promise((_res, rej) => sig.addEventListener('abort', () => rej(new Error('aborted'))));
      });
      render(<AiCommandBar collectionId="c1" folderId={null} onApply={vi.fn()} onClose={onClose} />);
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'my text' } });
      fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
      return onClose;
    };
    const expectCancelled = async (onClose: ReturnType<typeof vi.fn>) => {
      expect(signal.aborted).toBe(true);
      expect(await screen.findByRole('button', { name: 'Generate' })).toBeInTheDocument();
      expect(screen.getByRole('textbox')).toHaveValue('my text');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(dispatch).toHaveBeenCalledWith({ type: 'AI_REQUEST_DONE', payload: 'nlGenerate' });
      expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'AI_REQUEST_FAIL' }));
      expect(onClose).not.toHaveBeenCalled();
    };

    it('counts elapsed seconds and shows the slow hint after 30s', () => {
      vi.useFakeTimers();
      try {
        start();
        expect(screen.getByRole('button', { name: 'Generating… 0s' })).toBeDisabled();
        act(() => { vi.advanceTimersByTime(12000); });
        expect(screen.getByRole('button', { name: 'Generating… 12s' })).toBeInTheDocument();
        expect(screen.queryByRole('status')).toBeNull();
        act(() => { vi.advanceTimersByTime(18000); });
        expect(screen.getByRole('status')).toHaveTextContent('you can cancel');
      } finally { vi.useRealTimers(); }
    });

    it('Cancel aborts, keeps the text and shows no error', async () => {
      const onClose = start();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await expectCancelled(onClose);
    });

    it('Escape cancels the generation instead of closing', async () => {
      const onClose = start();
      fireEvent.keyDown(document, { key: 'Escape' });
      await expectCancelled(onClose);
    });
  });
});
