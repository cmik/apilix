// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AppCollection, RequestResponse } from '../types';

const { mockedUseApp } = vi.hoisted(() => ({ mockedUseApp: vi.fn() }));

vi.mock('../store', () => ({ useApp: mockedUseApp, generateId: () => 'gen-id' }));
vi.mock('../utils/useImportFile', () => ({ useImportFile: () => vi.fn() }));

import CollectionTree from './CollectionTree';

Element.prototype.scrollIntoView = vi.fn();

afterEach(() => cleanup());

function setup(opts: { response?: RequestResponse | null; tabItemName?: string } = {}) {
  const collection: AppCollection = {
    _id: 'col1',
    info: { name: 'Orders', schema: '' },
    item: [{
      id: 'r1', name: 'Get order', request: { method: 'GET', url: 'https://x/orders' },
      response: [
        { id: 'e1', name: 'Happy path', code: 200, status: 'OK', body: '{"ok":true}' },
        { id: 'e2', name: 'Not found', code: 404, status: 'Not Found', body: '' },
      ],
    }],
  };
  const tabs = [
    { id: 't1', collectionId: 'col1', item: { ...collection.item[0], name: opts.tabItemName ?? 'Get order' }, response: null, isLoading: false },
    { id: 't2', collectionId: 'col1', item: { ...collection.item[0], name: 'Second tab edit' }, response: null, isLoading: false },
  ];
  const dispatch = vi.fn();
  mockedUseApp.mockReturnValue({
    state: {
      collections: [collection], tabs, activeTabId: 't1', activeRequest: null, response: opts.response ?? null,
      collectionVariables: {}, globalVariables: {}, mockCollections: [],
    },
    dispatch,
    getEnvironmentVars: () => ({}),
    getCollectionVars: () => ({}),
  });
  const view = render(<CollectionTree />);
  return { dispatch, collection, rerender: () => view.rerender(<CollectionTree />) };
}

describe('CollectionTree examples', () => {
  it('hides examples until the toggle is clicked', () => {
    setup();
    expect(screen.queryByText('Happy path')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Show examples'));
    expect(screen.getByText('Happy path')).toBeInTheDocument();
    expect(screen.getByText('Not found')).toBeInTheDocument();
  });

  it('opens the request tab with the example response when clicked', () => {
    const { dispatch } = setup();
    fireEvent.click(screen.getByTitle('Show examples'));
    fireEvent.click(screen.getAllByTitle('View example')[0]);
    const open = dispatch.mock.calls.map(c => c[0]).find(a => a.type === 'OPEN_TAB');
    expect(open.payload.response).toMatchObject({ status: 200, body: '{"ok":true}', isExample: true });
  });

  it('highlights the selected example while it is the displayed response', () => {
    const { dispatch, rerender } = setup();
    fireEvent.click(screen.getByTitle('Show examples'));
    fireEvent.click(screen.getAllByTitle('View example')[0]);
    const shown = dispatch.mock.calls.map(c => c[0]).find(a => a.type === 'OPEN_TAB').payload.response;
    // Simulate the store now holding that response
    mockedUseApp.mockReturnValue({ ...mockedUseApp.mock.results[0].value, state: { ...mockedUseApp.mock.results[0].value.state, response: shown } });
    rerender();
    const row = screen.getByText('Happy path').closest('div')!;
    expect(row.className).toContain('bg-slate-600');
    expect(screen.getByText('Not found').closest('div')!.className).not.toContain('bg-slate-600');
  });

  it('delete asks for confirmation, then updates the collection and every open tab without touching edits', () => {
    const { dispatch } = setup();
    fireEvent.click(screen.getByTitle('Show examples'));
    fireEvent.click(screen.getAllByTitle('Delete example')[0]);
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'UPDATE_COLLECTION' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const calls = dispatch.mock.calls.map(c => c[0]);
    const col = calls.find(a => a.type === 'UPDATE_COLLECTION');
    expect(col.payload.item[0].response.map((e: { id: string }) => e.id)).toEqual(['e2']);
    const tabUpdates = calls.filter(a => a.type === 'UPDATE_TAB_ITEM');
    expect(tabUpdates.map(a => a.payload.tabId)).toEqual(['t1', 't2']);
    expect(tabUpdates[1].payload.item.name).toBe('Second tab edit');
    expect(tabUpdates[1].payload.item.response.map((e: { id: string }) => e.id)).toEqual(['e2']);
  });

  it('renames inline without window.prompt', () => {
    const prompt = vi.spyOn(window, 'prompt');
    const { dispatch } = setup();
    fireEvent.click(screen.getByTitle('Show examples'));
    fireEvent.click(screen.getAllByTitle('Rename example')[0]);
    const input = screen.getByDisplayValue('Happy path');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const col = dispatch.mock.calls.map(c => c[0]).find(a => a.type === 'UPDATE_COLLECTION');
    expect(col.payload.item[0].response[0].name).toBe('Renamed');
    expect(prompt).not.toHaveBeenCalled();
  });
});
