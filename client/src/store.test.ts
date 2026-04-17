import { vi, describe, it, expect } from 'vitest';

// Mock modules that access browser globals (window.*) at import time.
vi.mock('./api', () => ({ API_BASE: '/api', executeRequest: vi.fn() }));
vi.mock('./utils/storageDriver', () => ({}));
vi.mock('./utils/snapshotEngine', () => ({}));

import { appReducer, initialState } from './store';
import type { AppState, HistoryRequest, CollectionItem, Workspace, WorkspaceData } from './types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeEntry(id: string): HistoryRequest {
  return {
    id,
    timestamp: Date.now(),
    method: 'GET',
    url: 'https://example.com/api',
    collectionId: 'col1',
    itemId: 'item1',
    requestSnapshot: { id: 'item1', name: 'Test' } as CollectionItem,
    statusCode: 200,
    statusText: 'OK',
    responseTime: 100,
    error: null,
  };
}

function makeItem(id: string): CollectionItem {
  return { id, name: 'Test', request: { method: 'GET', url: 'https://example.com' } };
}

const workspace: Workspace = {
  id: 'w-new',
  name: 'New Workspace',
  createdAt: '2026-01-01T00:00:00Z',
  type: 'local',
};

const emptyWorkspaceData: WorkspaceData = {
  collections: [],
  environments: [],
  activeEnvironmentId: null,
  collectionVariables: {},
  globalVariables: {},
  cookieJar: {},
  mockCollections: [],
  mockRoutes: [],
  mockPort: 3002,
};

/** State with two history entries already present. */
function stateWithHistory(): AppState {
  return { ...initialState, requestHistory: [makeEntry('h1'), makeEntry('h2')] };
}

// ─── ADD_REQUEST_HISTORY ──────────────────────────────────────────────────────

describe('ADD_REQUEST_HISTORY', () => {
  it('prepends an entry to an empty list', () => {
    const e = makeEntry('a');
    const next = appReducer(initialState, { type: 'ADD_REQUEST_HISTORY', payload: e });
    expect(next.requestHistory).toHaveLength(1);
    expect(next.requestHistory[0].id).toBe('a');
  });

  it('prepends so the newest entry comes first', () => {
    const s = { ...initialState, requestHistory: [makeEntry('old')] };
    const next = appReducer(s, { type: 'ADD_REQUEST_HISTORY', payload: makeEntry('new') });
    expect(next.requestHistory[0].id).toBe('new');
    expect(next.requestHistory[1].id).toBe('old');
  });

  it('caps the list at 200 entries, dropping the oldest', () => {
    const full: AppState = {
      ...initialState,
      // newest-first order: e0 is at index 0 (newest), e199 is at index 199 (oldest)
      requestHistory: Array.from({ length: 200 }, (_, i) => makeEntry(`e${i}`)),
    };
    const next = appReducer(full, { type: 'ADD_REQUEST_HISTORY', payload: makeEntry('newest') });
    expect(next.requestHistory).toHaveLength(200);
    expect(next.requestHistory[0].id).toBe('newest');
    // e199 was at the tail (oldest) and should have been sliced off
    expect(next.requestHistory.find(e => e.id === 'e199')).toBeUndefined();
    // e0 (second position after prepend) should still be present
    expect(next.requestHistory.find(e => e.id === 'e0')).toBeDefined();
  });

  it('does not mutate the original state', () => {
    const s: AppState = { ...initialState };
    appReducer(s, { type: 'ADD_REQUEST_HISTORY', payload: makeEntry('a') });
    expect(s.requestHistory).toHaveLength(0);
  });
});

// ─── CLEAR_REQUEST_HISTORY ────────────────────────────────────────────────────

describe('CLEAR_REQUEST_HISTORY', () => {
  it('empties a populated history list', () => {
    const next = appReducer(stateWithHistory(), { type: 'CLEAR_REQUEST_HISTORY' });
    expect(next.requestHistory).toEqual([]);
  });

  it('is a no-op on an already-empty list', () => {
    const next = appReducer(initialState, { type: 'CLEAR_REQUEST_HISTORY' });
    expect(next.requestHistory).toEqual([]);
  });
});

// ─── SET_REQUEST_HISTORY ──────────────────────────────────────────────────────

describe('SET_REQUEST_HISTORY', () => {
  it('replaces an empty list with the given entries', () => {
    const entries = [makeEntry('x'), makeEntry('y')];
    const next = appReducer(initialState, { type: 'SET_REQUEST_HISTORY', payload: entries });
    expect(next.requestHistory).toHaveLength(2);
    expect(next.requestHistory.map(e => e.id)).toEqual(['x', 'y']);
  });

  it('replaces a non-empty list entirely', () => {
    const next = appReducer(stateWithHistory(), {
      type: 'SET_REQUEST_HISTORY',
      payload: [makeEntry('only')],
    });
    expect(next.requestHistory).toHaveLength(1);
    expect(next.requestHistory[0].id).toBe('only');
  });

  it('accepts an empty array, clearing existing history', () => {
    const next = appReducer(stateWithHistory(), { type: 'SET_REQUEST_HISTORY', payload: [] });
    expect(next.requestHistory).toEqual([]);
  });
});

// ─── OPEN_HISTORY_SNAPSHOT ────────────────────────────────────────────────────

describe('OPEN_HISTORY_SNAPSHOT', () => {
  it('always creates a new tab (no deduplication)', () => {
    const item = makeItem('item1');
    const payload = { collectionId: 'col1', item };
    const s1 = appReducer(initialState, { type: 'OPEN_HISTORY_SNAPSHOT', payload });
    const s2 = appReducer(s1, { type: 'OPEN_HISTORY_SNAPSHOT', payload });
    expect(s2.tabs).toHaveLength(2);
  });

  it('creates a new tab even when OPEN_TAB would have deduped the same item', () => {
    const item = makeItem('item1');
    const afterTab = appReducer(initialState, {
      type: 'OPEN_TAB',
      payload: { collectionId: 'col1', item },
    });
    expect(afterTab.tabs).toHaveLength(1);

    const afterSnap = appReducer(afterTab, {
      type: 'OPEN_HISTORY_SNAPSHOT',
      payload: { collectionId: 'col1', item },
    });
    expect(afterSnap.tabs).toHaveLength(2);
  });

  it('sets activeTabId to the new tab', () => {
    const item = makeItem('item1');
    const next = appReducer(initialState, {
      type: 'OPEN_HISTORY_SNAPSHOT',
      payload: { collectionId: 'col1', item },
    });
    expect(next.activeTabId).toBe(next.tabs[0].id);
  });

  it('sets activeRequest to the payload item', () => {
    const item = makeItem('item1');
    const next = appReducer(initialState, {
      type: 'OPEN_HISTORY_SNAPSHOT',
      payload: { collectionId: 'col1', item },
    });
    expect(next.activeRequest).toEqual({ collectionId: 'col1', item });
  });

  it('initialises the new tab with null response and isLoading false', () => {
    const item = makeItem('item1');
    const next = appReducer(initialState, {
      type: 'OPEN_HISTORY_SNAPSHOT',
      payload: { collectionId: 'col1', item },
    });
    expect(next.tabs[0].response).toBeNull();
    expect(next.tabs[0].isLoading).toBe(false);
  });

  it('sets fromHistory: true on the new tab', () => {
    const item = makeItem('item1');
    const next = appReducer(initialState, {
      type: 'OPEN_HISTORY_SNAPSHOT',
      payload: { collectionId: 'col1', item },
    });
    expect(next.tabs[0].fromHistory).toBe(true);
  });
});

// ─── CLEAR_TAB_HISTORY_FLAG ───────────────────────────────────────────────────

describe('CLEAR_TAB_HISTORY_FLAG', () => {
  it('sets fromHistory to false on the matching tab', () => {
    const item = makeItem('item1');
    const withTab = appReducer(initialState, {
      type: 'OPEN_HISTORY_SNAPSHOT',
      payload: { collectionId: 'col1', item },
    });
    const tabId = withTab.tabs[0].id;
    const next = appReducer(withTab, { type: 'CLEAR_TAB_HISTORY_FLAG', payload: tabId });
    expect(next.tabs[0].fromHistory).toBe(false);
  });

  it('leaves other tabs unchanged', () => {
    const item1 = makeItem('item1');
    const item2 = makeItem('item2');
    const s1 = appReducer(initialState, { type: 'OPEN_HISTORY_SNAPSHOT', payload: { collectionId: 'col1', item: item1 } });
    const s2 = appReducer(s1, { type: 'OPEN_HISTORY_SNAPSHOT', payload: { collectionId: 'col1', item: item2 } });
    const tabId = s2.tabs[0].id; // clear flag on the first tab only
    const next = appReducer(s2, { type: 'CLEAR_TAB_HISTORY_FLAG', payload: tabId });
    expect(next.tabs[0].fromHistory).toBe(false);
    expect(next.tabs[1].fromHistory).toBe(true);
  });

  it('OPEN_HISTORY_SNAPSHOT followed by CLEAR_TAB_HISTORY_FLAG results in fromHistory: false', () => {
    const item = makeItem('item1');
    const s1 = appReducer(initialState, { type: 'OPEN_HISTORY_SNAPSHOT', payload: { collectionId: 'col1', item } });
    expect(s1.tabs[0].fromHistory).toBe(true);
    const s2 = appReducer(s1, { type: 'CLEAR_TAB_HISTORY_FLAG', payload: s1.tabs[0].id });
    expect(s2.tabs[0].fromHistory).toBe(false);
  });
});

// ─── OPEN_TAB deduplication (regression) ─────────────────────────────────────

describe('OPEN_TAB', () => {
  it('focuses the existing tab when the same collectionId + item.id already open', () => {
    const item = makeItem('item1');
    const s1 = appReducer(initialState, { type: 'OPEN_TAB', payload: { collectionId: 'col1', item } });
    const existingTabId = s1.activeTabId;

    // Open same item again — should NOT add a second tab
    const s2 = appReducer(s1, { type: 'OPEN_TAB', payload: { collectionId: 'col1', item } });
    expect(s2.tabs).toHaveLength(1);
    expect(s2.activeTabId).toBe(existingTabId);
  });
});

// ─── Workspace transitions reset history ──────────────────────────────────────

describe('workspace transitions reset requestHistory', () => {
  it('CREATE_WORKSPACE resets requestHistory to []', () => {
    const next = appReducer(stateWithHistory(), {
      type: 'CREATE_WORKSPACE',
      payload: workspace,
    });
    expect(next.requestHistory).toEqual([]);
  });

  it('SWITCH_WORKSPACE resets requestHistory to []', () => {
    const next = appReducer(stateWithHistory(), {
      type: 'SWITCH_WORKSPACE',
      payload: { workspace, data: emptyWorkspaceData },
    });
    expect(next.requestHistory).toEqual([]);
  });

  it('DUPLICATE_WORKSPACE resets requestHistory to []', () => {
    const next = appReducer(stateWithHistory(), {
      type: 'DUPLICATE_WORKSPACE',
      payload: { workspace, data: emptyWorkspaceData },
    });
    expect(next.requestHistory).toEqual([]);
  });
});

// ─── CLEAR_WORKSPACE_COLLECTIONS ─────────────────────────────────────────────
//
// Feature: "Empty workspace" button in Manage Workspaces → Workspaces tab.
//
// The `CLEAR_WORKSPACE_COLLECTIONS` action is dispatched by the
// `handleClearCollections` handler inside `WorkspacesTab` when the user
// confirms the "Empty workspace" dialog.  It is only dispatched for the
// *active* workspace — inactive workspaces are cleared at the storage layer
// (StorageDriver.writeWorkspace) without touching UI state.
//
// Responsibility of this action (reducer scope):
//   • Zero out `collections` and `collectionVariables`.
//   • Close all open tabs: `tabs`, `activeTabId`.
//   • Nullify derived UI state that would become stale: `activeRequest`,
//     `response`, `runnerResults`.
//
// Intentionally NOT cleared by this action (design boundaries):
//   • `mockCollections` / `mockRoutes` — the Mock Server panel manages its own
//     data set independently of API collections.
//   • `environments` / `globalVariables` / `cookieJar` — not collection data.
//   • `workspaces` / `activeWorkspaceId` — structural, not content.
//   • `isRunning` / `activeEnvironmentId` / any other flag-style state.
//
// Suite structure:
//   stateWithCollections() — local fixture builder: one collection, one
//   collectionVariable entry, one open tab, an activeRequest, a response,
//   and a non-null runnerResults array.

describe('CLEAR_WORKSPACE_COLLECTIONS', () => {
  function stateWithCollections(): AppState {
    const collection = {
      _id: 'col1',
      info: { name: 'My Collection', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [makeItem('req1')],
    };
    const tab = {
      id: 'tab1',
      collectionId: 'col1',
      item: makeItem('req1'),
      isDirty: false,
      response: null,
      isLoading: false,
    };
    return {
      ...initialState,
      collections: [collection],
      collectionVariables: { col1: { baseUrl: 'http://localhost' } },
      tabs: [tab],
      activeTabId: 'tab1',
      activeRequest: { collectionId: 'col1', item: makeItem('req1') },
      response: { status: 200, statusText: 'OK', headers: {}, body: '', responseTime: 10, size: 0, testResults: [], error: null } as AppState['response'],
      runnerResults: [],
    };
  }

  it('sets collections to []', () => {
    const next = appReducer(stateWithCollections(), { type: 'CLEAR_WORKSPACE_COLLECTIONS' });
    expect(next.collections).toEqual([]);
  });

  it('sets collectionVariables to {}', () => {
    const next = appReducer(stateWithCollections(), { type: 'CLEAR_WORKSPACE_COLLECTIONS' });
    expect(next.collectionVariables).toEqual({});
  });

  it('sets tabs to [] and activeTabId to null', () => {
    const next = appReducer(stateWithCollections(), { type: 'CLEAR_WORKSPACE_COLLECTIONS' });
    expect(next.tabs).toEqual([]);
    expect(next.activeTabId).toBeNull();
  });

  it('sets activeRequest and response to null', () => {
    const next = appReducer(stateWithCollections(), { type: 'CLEAR_WORKSPACE_COLLECTIONS' });
    expect(next.activeRequest).toBeNull();
    expect(next.response).toBeNull();
  });

  it('sets runnerResults to null', () => {
    const next = appReducer(stateWithCollections(), { type: 'CLEAR_WORKSPACE_COLLECTIONS' });
    expect(next.runnerResults).toBeNull();
  });

  it('does not mutate workspaces or environments', () => {
    const s = stateWithCollections();
    const ws: AppState['workspaces'] = [workspace];
    const env = { _id: 'env1', name: 'Dev', values: [] };
    const withExtras = { ...s, workspaces: ws, environments: [env], globalVariables: { HOST: 'http://api' } };
    const next = appReducer(withExtras, { type: 'CLEAR_WORKSPACE_COLLECTIONS' });
    expect(next.workspaces).toBe(ws);
    expect(next.environments).toEqual([env]);
    expect(next.globalVariables).toEqual({ HOST: 'http://api' });
  });

  it('is idempotent — dispatching on an already-empty state produces no error', () => {
    const next = appReducer(initialState, { type: 'CLEAR_WORKSPACE_COLLECTIONS' });
    expect(next.collections).toEqual([]);
    expect(next.collectionVariables).toEqual({});
    expect(next.tabs).toEqual([]);
    expect(next.activeTabId).toBeNull();
    expect(next.activeRequest).toBeNull();
    expect(next.response).toBeNull();
    expect(next.runnerResults).toBeNull();
  });

  it('clears all tabs regardless of which collections they belong to', () => {
    const col1 = {
      _id: 'col1',
      info: { name: 'A', schema: '' },
      item: [makeItem('r1')],
    };
    const col2 = {
      _id: 'col2',
      info: { name: 'B', schema: '' },
      item: [makeItem('r2')],
    };
    const tabs = [
      { id: 'tab1', collectionId: 'col1', item: makeItem('r1'), isDirty: false, response: null, isLoading: false },
      { id: 'tab2', collectionId: 'col2', item: makeItem('r2'), isDirty: true,  response: null, isLoading: false },
    ];
    const s: AppState = {
      ...initialState,
      collections: [col1, col2],
      collectionVariables: { col1: { k: 'v' }, col2: { k2: 'v2' } },
      tabs,
      activeTabId: 'tab1',
    };
    const next = appReducer(s, { type: 'CLEAR_WORKSPACE_COLLECTIONS' });
    expect(next.collections).toEqual([]);
    expect(next.collectionVariables).toEqual({});
    expect(next.tabs).toEqual([]);
    expect(next.activeTabId).toBeNull();
  });

  it('preserves mockCollections and mockRoutes — they are out of scope for this action', () => {
    const mockCol = { id: 'mc1', name: 'Mock API', enabled: true, description: '' };
    const mockRoute = {
      id: 'mr1', enabled: true, method: 'GET', path: '/ping',
      statusCode: 200, responseHeaders: [], responseBody: '{}', delay: 0, description: '',
    };
    const s: AppState = {
      ...stateWithCollections(),
      mockCollections: [mockCol],
      mockRoutes: [mockRoute],
    };
    const next = appReducer(s, { type: 'CLEAR_WORKSPACE_COLLECTIONS' });
    expect(next.mockCollections).toEqual([mockCol]);
    expect(next.mockRoutes).toEqual([mockRoute]);
  });

  it('preserves isRunning and activeEnvironmentId', () => {
    const s: AppState = {
      ...stateWithCollections(),
      isRunning: true,
      activeEnvironmentId: 'env-42',
    };
    const next = appReducer(s, { type: 'CLEAR_WORKSPACE_COLLECTIONS' });
    expect(next.isRunning).toBe(true);
    expect(next.activeEnvironmentId).toBe('env-42');
  });
});
