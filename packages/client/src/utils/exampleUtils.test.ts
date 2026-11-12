import { describe, it, expect } from 'vitest';
import type { CollectionItem, RequestResponse } from '../types';
import {
  buildExampleFromResponse, addExampleToItem, renameExampleOnItem,
  removeExampleFromItem, exampleToResponse, withExamples, exampleSaveBlocker, MAX_EXAMPLE_BODY_CHARS,
} from './exampleUtils';

const response: RequestResponse = {
  status: 200, statusText: 'OK', responseTime: 5, size: 7,
  headers: { 'Content-Type': 'application/json' }, body: '{"a":1}', testResults: [], error: null,
};
const item: CollectionItem = { id: 'i1', name: 'Get', request: { method: 'GET', url: { raw: 'http://x' } } };

describe('exampleUtils', () => {
  it('builds an example from a response', () => {
    const ex = buildExampleFromResponse(response, item, 'e1');
    expect(ex).toMatchObject({ id: 'e1', name: '200 OK', code: 200, status: 'OK', body: '{"a":1}', _postman_previewlanguage: 'json' });
    expect(ex.header).toEqual([{ key: 'Content-Type', value: 'application/json' }]);
    expect(ex.originalRequest).toEqual(item.request);
    expect(ex.originalRequest).not.toBe(item.request);
  });

  it('drops binary bodies', () => {
    expect(buildExampleFromResponse({ ...response, bodyBase64: 'AAA=' }, item, 'e1').body).toBe('');
  });

  it('adds, renames and removes examples', () => {
    const ex = buildExampleFromResponse(response, item, 'e1', 'Happy path');
    const added = addExampleToItem(item, ex);
    expect(added.response).toHaveLength(1);
    expect(item.response).toBeUndefined();
    expect(renameExampleOnItem(added, 'e1', 'Renamed').response![0].name).toBe('Renamed');
    expect(removeExampleFromItem(added, 'e1').response).toBeUndefined();
  });

  it('converts an example back to a response', () => {
    const back = exampleToResponse(buildExampleFromResponse(response, item, 'e1'));
    expect(back).toMatchObject({ status: 200, statusText: 'OK', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } });
  });
});

describe('withExamples / edge cases', () => {
  it('replaces examples without touching other fields', () => {
    const edited: CollectionItem = { ...item, name: 'Unsaved edit', response: [{ id: 'old' }] };
    const out = withExamples(edited, [{ id: 'new' }]);
    expect(out.name).toBe('Unsaved edit');
    expect(out.response).toEqual([{ id: 'new' }]);
    expect(withExamples(edited, []).response).toBeUndefined();
  });

  it('keeps remaining examples when removing one of several', () => {
    const a = addExampleToItem(addExampleToItem(item, { id: 'a' }), { id: 'b' });
    expect(removeExampleFromItem(a, 'a').response).toEqual([{ id: 'b' }]);
  });

  it('handles empty headers and unknown content types', () => {
    const ex = buildExampleFromResponse({ ...response, headers: {}, body: 'hello' }, item, 'e1');
    expect(ex.header).toEqual([]);
    expect(ex._postman_previewlanguage).toBe('text');
  });
});

describe('exampleSaveBlocker', () => {
  it('allows normal text responses', () => expect(exampleSaveBlocker(response)).toBeNull());
  it('blocks binary, oversized and example-derived responses', () => {
    expect(exampleSaveBlocker({ ...response, bodyBase64: 'AAA=' })).toMatch(/Binary/);
    expect(exampleSaveBlocker({ ...response, body: 'x'.repeat(MAX_EXAMPLE_BODY_CHARS + 1) })).toMatch(/too large/);
    expect(exampleSaveBlocker(exampleToResponse(buildExampleFromResponse(response, item, 'e1')))).toMatch(/already/);
  });
});
