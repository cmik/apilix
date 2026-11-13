// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AppCollection } from '../types';
import { DEFAULT_AI_SETTINGS } from '../utils/aiDefaults';

const { mockedUseApp, aiGenerateRequest } = vi.hoisted(() => ({ mockedUseApp: vi.fn(), aiGenerateRequest: vi.fn() }));

vi.mock('../store', () => ({ useApp: mockedUseApp, generateId: () => 'gen-id' }));
vi.mock('../utils/useImportFile', () => ({ useImportFile: () => vi.fn() }));
vi.mock('../api', () => ({
  aiGenerateRequest,
  toAiApiError: (e: unknown) => Object.assign(new Error(e instanceof Error ? e.message : 'x'), { code: 'INTERNAL' }),
}));

import CollectionTree from './CollectionTree';

const collection: AppCollection = {
  _id: 'col1',
  info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [
    { id: 'f1', name: 'Users', item: [{ id: 'u1', name: 'List users', request: { method: 'GET', url: 'https://x.test/users' } }] },
  ],
};

function setup(aiSettings: Partial<typeof DEFAULT_AI_SETTINGS>) {
  const dispatch = vi.fn();
  const settings = { ...DEFAULT_AI_SETTINGS, ...aiSettings, features: { ...DEFAULT_AI_SETTINGS.features, ...(aiSettings.features ?? {}) } };
  mockedUseApp.mockReturnValue({
    state: {
      collections: [collection], tabs: [], activeTabId: null, activeRequest: null,
      collectionVariables: {}, globalVariables: {}, globalVariableMeta: {}, environments: [], activeEnvironmentId: null,
      ai: { settings, keyStatus: 'ok', inFlight: {}, lastError: null },
    },
    dispatch,
    getEnvironmentVars: () => ({}),
    getCollectionVars: () => ({}),
  });
  render(<CollectionTree />);
  return dispatch;
}

function openFolderMenu() {
  // Kebab buttons, in DOM order: [collection, folder, request].
  const kebabs = screen.getAllByTitle('Actions');
  fireEvent.click(kebabs[1]);
}

beforeEach(() => { mockedUseApp.mockReset(); aiGenerateRequest.mockReset(); });
afterEach(() => cleanup());

describe('CollectionTree "Generate request here"', () => {
  it('is absent from the folder menu when AI is off', () => {
    setup({ enabled: false });
    openFolderMenu();
    expect(screen.getByText('Export documentation…')).toBeInTheDocument(); // the folder menu is open
    expect(screen.queryByText(/Generate request here/)).toBeNull();
  });

  it('opens the command bar for the folder and adds the proposal as a NEW request only after Apply', async () => {
    aiGenerateRequest.mockResolvedValue({
      draft: { name: 'Create user', method: 'POST', url: 'https://x.test/users', body: { mode: 'none' }, tests: "apx.test('ok', () => {});" },
      validation: { validated: true, errors: [] }, warnings: [], retried: false,
    });
    const dispatch = setup({ enabled: true, consentGiven: true, model: 'm', features: { ...DEFAULT_AI_SETTINGS.features, nlGenerate: true } });
    openFolderMenu();
    fireEvent.click(screen.getByText(/Generate request here/));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'create a user' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByRole('dialog', { name: 'AI proposal' });
    expect(aiGenerateRequest.mock.calls[0][0].neighbors.map((n: { id: string }) => n.id)).toEqual(['u1']);
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'UPDATE_COLLECTION' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'UPDATE_COLLECTION' })));
    const update = dispatch.mock.calls.map(c => c[0]).find(a => a.type === 'UPDATE_COLLECTION');
    const folder = update.payload.item[0];
    expect(folder.item.map((i: { name: string }) => i.name)).toEqual(['List users', 'Create user']);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'OPEN_TAB' }));
  });

  it('Ignore leaves the collection untouched', async () => {
    aiGenerateRequest.mockResolvedValue({
      draft: { name: 'X', method: 'GET', url: 'https://x.test' }, validation: { validated: true, errors: [] }, warnings: [], retried: false,
    });
    const dispatch = setup({ enabled: true, consentGiven: true, model: 'm', features: { ...DEFAULT_AI_SETTINGS.features, nlGenerate: true } });
    openFolderMenu();
    fireEvent.click(screen.getByText(/Generate request here/));
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByRole('dialog', { name: 'AI proposal' });
    fireEvent.click(screen.getByRole('button', { name: 'Ignore' }));
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'UPDATE_COLLECTION' }));
  });
});
