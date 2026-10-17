// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { AppCollection, CollectionItem } from '../types';

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
            },
          ],
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

    const collectIds = (items: CollectionItem[]): string[] =>
      items.flatMap(item => [item.id!, ...(item.item ? collectIds(item.item) : [])]);
    expect(collectIds(duplicate.item)).toHaveLength(2);
    expect(collectIds(duplicate.item).some(id => collectIds(originalCollection.item).includes(id))).toBe(false);

    const updateVariablesAction = dispatch.mock.calls.find(([action]) => action.type === 'UPDATE_COLLECTION_VARS')?.[0];
    expect(updateVariablesAction).toEqual({
      type: 'UPDATE_COLLECTION_VARS',
      payload: { collectionId: 'collection-copy', vars: originalRuntimeVariables },
    });
    expect(updateVariablesAction.payload.vars).not.toBe(originalRuntimeVariables);
  });
});