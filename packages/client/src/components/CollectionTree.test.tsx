// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { AppCollection, CollectionItem, RequestTab } from '../types';

const { mockedUseApp, mockedGenerateId } = vi.hoisted(() => ({
  mockedUseApp: vi.fn(),
  mockedGenerateId: vi.fn(),
}));

vi.mock('../store', () => ({
  useApp: mockedUseApp,
  generateId: mockedGenerateId,
}));
vi.mock('../utils/useImportFile', () => ({
  useImportFile: () => vi.fn(),
}));

import CollectionTree from './CollectionTree';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setupSearchTree() {
  const collection: AppCollection = {
    _id: 'col1',
    info: {
      name: 'Orders',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      { id: 'request-one', name: 'Get order', request: { method: 'GET', url: 'https://example.com/orders' } },
      { id: 'request-two', name: 'List orders', request: { method: 'GET', url: 'https://example.com/orders/all' } },
    ],
  };
  const state = {
    collections: [collection],
    tabs: [] as RequestTab[],
    activeTabId: null,
    activeRequest: null,
    collectionVariables: {},
    globalVariables: {},
  };
  const dispatch = vi.fn();
  mockedUseApp.mockReturnValue({
    state,
    dispatch,
    getEnvironmentVars: () => ({}),
    getCollectionVars: () => ({}),
  });
  render(<CollectionTree filter="order" />);
  return { dispatch, state };
}

describe('CollectionTree search preview tabs', () => {
  beforeEach(() => {
    mockedUseApp.mockReset();
    vi.useFakeTimers();
  });

  it('opens the first preview after two seconds and cancels if the pointer leaves first', () => {
    const { dispatch } = setupSearchTree();
    dispatch.mockClear();
    const result = screen.getByRole('button', { name: /Get order/ });

    fireEvent.mouseEnter(result);
    act(() => vi.advanceTimersByTime(1999));
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'PREVIEW_TAB' }));
    fireEvent.mouseLeave(result);
    act(() => vi.advanceTimersByTime(1));
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'PREVIEW_TAB' }));

    fireEvent.mouseEnter(result);
    act(() => vi.advanceTimersByTime(2000));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'PREVIEW_TAB',
      payload: expect.objectContaining({ item: expect.objectContaining({ id: 'request-one' }) }),
    }));
  });

  it('switches an open preview immediately and closes it when leaving the results area', () => {
    const { dispatch, state } = setupSearchTree();
    dispatch.mockClear();
    state.tabs.push({
      id: 'preview-tab',
      collectionId: 'col1',
      item: state.collections[0].item[0],
      response: null,
      isLoading: false,
      isPreview: true,
    });
    const result = screen.getByRole('button', { name: /List orders/ });

    fireEvent.mouseEnter(result);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'PREVIEW_TAB',
      payload: expect.objectContaining({ item: expect.objectContaining({ id: 'request-two' }) }),
    }));

    fireEvent.mouseLeave(result.parentElement as HTMLElement);
    expect(dispatch).toHaveBeenCalledWith({ type: 'CLOSE_PREVIEW_TAB' });
  });
});

describe('CollectionTree collection duplication', () => {
  beforeEach(() => {
    mockedUseApp.mockReset();
    mockedGenerateId.mockReset().mockReturnValue('collection-copy');
  });

  it('dispatches a new collection with fresh item IDs and copies runtime variables independently', async () => {
    const originalCollection: AppCollection = {
      _id: 'collection-original',
      info: {
        name: 'Orders',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          id: 'folder-original',
          name: 'Reads',
          item: [
            {
              id: 'request-original',
              name: 'Get order',
              request: { method: 'GET', url: 'https://example.com/orders' },
              event: [{
                listen: 'test',
                script: {
                  type: 'text/javascript',
                  exec: ["apx.execution.setNextRequestById('request-target');"],
                },
              }],
            },
          ],
        },
        {
          id: 'request-target',
          name: 'Next order',
          request: { method: 'GET', url: 'https://example.com/orders/next' },
        },
      ],
    };
    const originalRuntimeVariables = { token: 'runtime-token' };
    const state = {
      collections: [originalCollection],
      collectionVariables: { [originalCollection._id]: originalRuntimeVariables },
      globalVariables: {},
    };
    const dispatch = vi.fn();
    mockedUseApp.mockReturnValue({
      state,
      dispatch,
      getEnvironmentVars: () => ({}),
      getCollectionVars: (collectionId: string) => state.collectionVariables[collectionId] ?? {},
    });

    const user = userEvent.setup();
    render(<CollectionTree collapseSignal={1} />);

    await user.click(screen.getByTitle('Actions'));
    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    const addCollectionAction = dispatch.mock.calls.find(([action]) => action.type === 'ADD_COLLECTION')?.[0];
    expect(addCollectionAction).toBeDefined();
    const duplicate = addCollectionAction.payload as AppCollection;
    expect(duplicate._id).toBe('collection-copy');
    expect(duplicate.info.name).toBe('Copy of Orders');
    expect(duplicate.info._postman_id).toBe('collection-copy');
    expect(duplicate.item[0].name).toBe('Reads');
    expect(duplicate.item[0].item?.[0].request).toEqual(originalCollection.item[0].item?.[0].request);
    expect(duplicate.item[0].item?.[0].event?.[0].script.exec).toEqual([
      `apx.execution.setNextRequestById('${duplicate.item[1].id}');`,
    ]);

    const collectIds = (items: CollectionItem[]): string[] =>
      items.flatMap(item => [item.id!, ...(item.item ? collectIds(item.item) : [])]);
    expect(collectIds(duplicate.item)).toHaveLength(3);
    expect(collectIds(duplicate.item).some(id => collectIds(originalCollection.item).includes(id))).toBe(false);

    const updateVariablesAction = dispatch.mock.calls.find(([action]) => action.type === 'UPDATE_COLLECTION_VARS')?.[0];
    expect(updateVariablesAction).toEqual({
      type: 'UPDATE_COLLECTION_VARS',
      payload: { collectionId: 'collection-copy', vars: originalRuntimeVariables },
    });
    expect(updateVariablesAction.payload.vars).not.toBe(originalRuntimeVariables);
  });
});