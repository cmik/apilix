import { vi, describe, it, expect } from 'vitest';

vi.mock('./api', () => ({ API_BASE: '/api', executeRequest: vi.fn() }));
vi.mock('./utils/storageDriver', () => ({}));
vi.mock('./utils/snapshotEngine', () => ({}));

import { appReducer, initialState, parseCollectionFile } from './store';
import type { AppState, AppCollection, ResponseSchema, WorkspaceData } from './types';

const schema = (id: string, name: string): ResponseSchema => ({ id, name, schema: { type: 'object' }, version: 1 });

function withCollection(state: AppState): AppState {
  const col: AppCollection = {
    _id: 'c1',
    info: { name: 'C', schema: 'x' },
    item: [{ id: 'r1', name: 'R1', request: { method: 'GET', url: { raw: 'http://x' } } }],
  };
  return { ...state, collections: [col] };
}

describe('schema validation time limit setting', () => {
  it('defaults to 2000 ms and is updated through UPDATE_SETTINGS', () => {
    expect(initialState.settings.schemaValidationTimeoutMs).toBe(2000);
    const s = appReducer(initialState, { type: 'UPDATE_SETTINGS', payload: { schemaValidationTimeoutMs: 500 } });
    expect(s.settings.schemaValidationTimeoutMs).toBe(500);
  });
});

describe('response schema reducer', () => {
  it('starts empty with warn mode', () => {
    expect(initialState.responseSchemas).toEqual([]);
    expect(initialState.schemaRunMode).toBe('warn');
  });

  it('SCHEMA_ADD / UPDATE / DELETE with unique names, version++ and history', () => {
    let s = appReducer(initialState, { type: 'SCHEMA_ADD', payload: schema('a', 'User') });
    s = appReducer(s, { type: 'SCHEMA_ADD', payload: schema('b', 'user') }); // duplicate name: ignored
    expect(s.responseSchemas).toHaveLength(1);
    s = appReducer(s, { type: 'SCHEMA_UPDATE', payload: { id: 'a', patch: { schema: { type: 'array' } } } });
    expect(s.responseSchemas[0].version).toBe(2);
    expect(s.responseSchemas[0].history).toHaveLength(1);
    s = appReducer(s, { type: 'SCHEMA_DELETE', payload: 'a' });
    expect(s.responseSchemas).toEqual([]);
  });

  it('REQUEST_SET_SCHEMA_LINKS updates the collection tree and open tabs; DELETE strips links', () => {
    let s = withCollection({ ...initialState, responseSchemas: [schema('a', 'User')] });
    const item = s.collections[0].item[0];
    s = { ...s, tabs: [{ id: 't1', collectionId: 'c1', item, response: null, isLoading: false }], activeTabId: 't1', activeRequest: { collectionId: 'c1', item } };
    s = appReducer(s, { type: 'REQUEST_SET_SCHEMA_LINKS', payload: { collectionId: 'c1', requestId: 'r1', links: [{ schemaId: 'a', match: '200' }] } });
    expect(s.collections[0].item[0].request!.apilix!.schemaLinks).toEqual([{ schemaId: 'a', match: '200' }]);
    expect(s.tabs[0].item.request!.apilix!.schemaLinks).toHaveLength(1);
    expect(s.activeRequest!.item.request!.apilix!.schemaLinks).toHaveLength(1);
    s = appReducer(s, { type: 'SCHEMA_DELETE', payload: 'a' });
    expect(s.collections[0].item[0].request!.apilix).toBeUndefined();
  });

  it('SCHEMA_DELETE also strips the links from open tabs and the active request, keeping other links', () => {
    let s = withCollection({ ...initialState, responseSchemas: [schema('a', 'User'), schema('b', 'Other')] });
    s = appReducer(s, { type: 'REQUEST_SET_SCHEMA_LINKS', payload: { collectionId: 'c1', requestId: 'r1', links: [{ schemaId: 'a', match: '200' }, { schemaId: 'b', match: '4xx' }] } });
    const item = s.collections[0].item[0];
    s = { ...s, tabs: [{ id: 't1', collectionId: 'c1', item, response: null, isLoading: false }], activeTabId: 't1', activeRequest: { collectionId: 'c1', item } };
    s = appReducer(s, { type: 'SCHEMA_DELETE', payload: 'a' });
    expect(s.tabs[0].item.request!.apilix!.schemaLinks).toEqual([{ schemaId: 'b', match: '4xx' }]);
    expect(s.activeRequest!.item.request!.apilix!.schemaLinks).toEqual([{ schemaId: 'b', match: '4xx' }]);
    s = appReducer(s, { type: 'SCHEMA_DELETE', payload: 'b' });
    expect(s.tabs[0].item.request!.apilix).toBeUndefined();
    expect(s.activeRequest!.item.request!.apilix).toBeUndefined();
  });

  it('SET_SCHEMA_RUN_MODE and SCHEMA_SET_ALL', () => {
    let s = appReducer(initialState, { type: 'SET_SCHEMA_RUN_MODE', payload: 'strict' });
    expect(s.schemaRunMode).toBe('strict');
    s = appReducer(s, { type: 'SCHEMA_SET_ALL', payload: [schema('a', 'A')] });
    expect(s.responseSchemas).toHaveLength(1);
  });

  it('workspace switch / snapshot restore carry schemas; old data without them yields []', () => {
    const data = { collections: [], environments: [], activeEnvironmentId: null, collectionVariables: {}, globalVariables: {}, cookieJar: {}, mockCollections: [], mockRoutes: [], mockPort: 3002 } as WorkspaceData;
    expect(appReducer(initialState, { type: 'RESTORE_SNAPSHOT', payload: data }).responseSchemas).toEqual([]);
    const restored = appReducer(initialState, { type: 'RESTORE_SNAPSHOT', payload: { ...data, responseSchemas: [schema('a', 'A')] } });
    expect(restored.responseSchemas).toHaveLength(1);
    const ws = { id: 'w', name: 'W', createdAt: '', type: 'local' as const };
    const switched = appReducer(initialState, { type: 'SWITCH_WORKSPACE', payload: { workspace: ws, data: { ...data, responseSchemas: [schema('a', 'A')] } } });
    expect(switched.responseSchemas).toHaveLength(1);
    expect(appReducer(switched, { type: 'CREATE_WORKSPACE', payload: ws }).responseSchemas).toEqual([]);
  });
});

describe('parseCollectionFile with the apilix extension', () => {
  it('moves apilix.schemas to the result and keeps request links', async () => {
    const json = {
      info: { name: 'X', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'R', request: { method: 'GET', url: 'http://x', apilix: { schemaLinks: [{ schemaId: 's1', match: '200' }] } } }],
      apilix: { schemas: [{ id: 's1', name: 'Pet', version: 1, schema: { type: 'object' } }] },
    };
    const res = await parseCollectionFile(json);
    expect(res.validationWarnings).toEqual([]);
    expect(res.schemas.map(s => s.name)).toEqual(['Pet']);
    expect((res.collection as unknown as { apilix?: unknown }).apilix).toBeUndefined();
    expect(res.collection.item[0].request!.apilix!.schemaLinks).toHaveLength(1);
  });
});
