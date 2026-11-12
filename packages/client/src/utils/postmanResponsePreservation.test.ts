// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { AppState } from '../types';
import { appReducer, parseCollectionFile } from '../store';
import { cloneItemsWithNewIds, duplicateItem } from './treeHelpers';

const postman = {
  info: { name: 'With examples', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [
    {
      name: 'Get thing',
      request: { method: 'GET', url: { raw: 'https://x.test/thing' } },
      response: [
        { name: 'ok', originalRequest: { method: 'GET', url: { raw: 'https://x.test/thing' } }, status: 'OK', code: 200, header: [{ key: 'Content-Type', value: 'application/json' }], body: '{"a":1}' },
      ],
    },
  ],
};

describe('Postman item.response[] preservation', () => {
  it('survives import, store ingestion, clone and duplicate', async () => {
    const { collection } = await parseCollectionFile(JSON.parse(JSON.stringify(postman)));
    expect(collection.item[0].response?.[0].code).toBe(200);

    const state = appReducer({ collections: [] } as unknown as AppState, { type: 'ADD_COLLECTION', payload: collection });
    const stored = state.collections[0].item[0];
    expect(stored.id).toBeTruthy();
    expect(stored.response?.[0].body).toBe('{"a":1}');

    const cloned = cloneItemsWithNewIds(state.collections[0].item);
    expect(cloned[0].response?.[0].name).toBe('ok');
    expect(cloned[0].response).not.toBe(stored.response);

    const dup = duplicateItem(state.collections[0].item, stored.id!);
    expect(dup).toHaveLength(2);
    expect(dup[1].response?.[0].header?.[0].key).toBe('Content-Type');
  });
});
