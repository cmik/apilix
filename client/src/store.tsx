import React, { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react';
import type { AppState, AppAction, AppCollection, AppEnvironment, CollectionItem, RequestTab, CookieJar, Cookie, MockRoute, MockCollection } from './types';

const STORAGE_KEY = 'apilix_persist';

function ensureIds(items: CollectionItem[]): CollectionItem[] {
  return items.map(item => ({
    ...item,
    id: item.id ?? generateId(),
    item: item.item ? ensureIds(item.item) : undefined,
  }));
}

type PersistedTabRef = { id: string; collectionId: string; itemId: string };

type PersistedState = Pick<
  AppState,
  'collections' | 'environments' | 'activeEnvironmentId' | 'collectionVariables' | 'globalVariables' | 'cookieJar' | 'mockCollections' | 'mockRoutes' | 'mockPort'
> & {
  tabSession?: { tabs: PersistedTabRef[]; activeTabId: string | null };
};

function findItemInTree(items: CollectionItem[], id: string): CollectionItem | null {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.item) {
      const found = findItemInTree(item.item, id);
      if (found) return found;
    }
  }
  return null;
}

function loadPersisted(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedState) : null;
  } catch {
    return null;
  }
}

const initialState: AppState = {
  collections: [],
  environments: [],
  activeEnvironmentId: null,
  consoleLogs: [],
  tabs: [],
  activeTabId: null,
  activeRequest: null,
  response: null,
  isLoading: false,
  view: 'request',
  runnerResults: null,
  isRunning: false,
  collectionVariables: {},
  globalVariables: {},
  cookieJar: {},
  mockCollections: [],
  mockRoutes: [],
  mockServerRunning: false,
  mockPort: 3002,
};

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'ADD_COLLECTION':
      return { ...state, collections: [...state.collections, { ...action.payload, item: ensureIds(action.payload.item) }] };

    case 'UPDATE_COLLECTION':
      return {
        ...state,
        collections: state.collections.map(c =>
          c._id === action.payload._id ? { ...action.payload, item: ensureIds(action.payload.item) } : c
        ),
      };

    case 'REMOVE_COLLECTION': {
      const colId = action.payload;
      const remainingTabs = state.tabs.filter(t => t.collectionId !== colId);
      let newActiveTabId = state.activeTabId;
      if (state.activeTabId) {
        const curTab = state.tabs.find(t => t.id === state.activeTabId);
        if (curTab?.collectionId === colId) {
          newActiveTabId = remainingTabs[0]?.id ?? null;
        }
      }
      const newActiveTab = remainingTabs.find(t => t.id === newActiveTabId) ?? null;
      return {
        ...state,
        collections: state.collections.filter(c => c._id !== colId),
        tabs: remainingTabs,
        activeTabId: newActiveTabId,
        activeRequest: newActiveTab ? { collectionId: newActiveTab.collectionId, item: newActiveTab.item } : null,
        response: newActiveTab?.response ?? null,
      };
    }

    case 'ADD_ENVIRONMENT':
      return { ...state, environments: [...state.environments, action.payload] };

    case 'REMOVE_ENVIRONMENT':
      return {
        ...state,
        environments: state.environments.filter(e => e._id !== action.payload),
        activeEnvironmentId:
          state.activeEnvironmentId === action.payload ? null : state.activeEnvironmentId,
      };

    case 'UPDATE_ENVIRONMENT':
      return {
        ...state,
        environments: state.environments.map(e =>
          e._id === action.payload._id ? action.payload : e
        ),
      };

    case 'SET_ACTIVE_ENV':
      return { ...state, activeEnvironmentId: action.payload };

    case 'SET_ACTIVE_REQUEST':
      return { ...state, activeRequest: action.payload, response: null };

    case 'OPEN_TAB': {
      const { collectionId, item } = action.payload;
      const existing = state.tabs.find(
        t => t.collectionId === collectionId && t.item.id === item.id
      );
      if (existing) {
        return {
          ...state,
          activeTabId: existing.id,
          activeRequest: { collectionId, item: existing.item },
          response: existing.response,
          isLoading: existing.isLoading,
        };
      }
      const newTab: RequestTab = {
        id: generateId(),
        collectionId,
        item,
        response: null,
        isLoading: false,
      };
      return {
        ...state,
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id,
        activeRequest: { collectionId, item },
        response: null,
        isLoading: false,
      };
    }

    case 'CLOSE_TAB': {
      const tabId = action.payload;
      const idx = state.tabs.findIndex(t => t.id === tabId);
      const newTabs = state.tabs.filter(t => t.id !== tabId);
      let newActiveTabId = state.activeTabId;
      if (state.activeTabId === tabId) {
        const newIdx = Math.min(idx, newTabs.length - 1);
        newActiveTabId = newTabs[newIdx]?.id ?? null;
      }
      const newActiveTab = newTabs.find(t => t.id === newActiveTabId) ?? null;
      return {
        ...state,
        tabs: newTabs,
        activeTabId: newActiveTabId,
        activeRequest: newActiveTab ? { collectionId: newActiveTab.collectionId, item: newActiveTab.item } : null,
        response: newActiveTab?.response ?? null,
        isLoading: newActiveTab?.isLoading ?? false,
      };
    }

    case 'SET_ACTIVE_TAB': {
      const tab = state.tabs.find(t => t.id === action.payload);
      if (!tab) return state;
      return {
        ...state,
        activeTabId: action.payload,
        activeRequest: { collectionId: tab.collectionId, item: tab.item },
        response: tab.response,
        isLoading: tab.isLoading,
      };
    }

    case 'SET_TAB_RESPONSE': {
      const { tabId, response } = action.payload;
      const updatedTabs = state.tabs.map(t => t.id === tabId ? { ...t, response } : t);
      return {
        ...state,
        tabs: updatedTabs,
        response: state.activeTabId === tabId ? response : state.response,
      };
    }

    case 'SET_TAB_LOADING': {
      const { tabId, loading } = action.payload;
      const updatedTabs = state.tabs.map(t => t.id === tabId ? { ...t, isLoading: loading } : t);
      return {
        ...state,
        tabs: updatedTabs,
        isLoading: state.activeTabId === tabId ? loading : state.isLoading,
      };
    }

    case 'UPDATE_TAB_ITEM': {
      const { tabId, item } = action.payload;
      const updatedTabs = state.tabs.map(t => t.id === tabId ? { ...t, item } : t);
      return { ...state, tabs: updatedTabs };
    }

    case 'UPDATE_TAB': {
      const { tabId, collectionId, item } = action.payload;
      const updatedTabs = state.tabs.map(t => t.id === tabId ? { ...t, collectionId, item } : t);
      return { ...state, tabs: updatedTabs };
    }

    case 'OPEN_BLANK_TAB': {
      const newTab: RequestTab = {
        id: generateId(),
        collectionId: '',
        item: {
          id: generateId(),
          name: 'New Request',
          request: { method: 'GET', url: { raw: '' }, header: [] },
        },
        response: null,
        isLoading: false,
      };
      return {
        ...state,
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id,
        activeRequest: { collectionId: '', item: newTab.item },
        response: null,
        isLoading: false,
      };
    }

    case 'REORDER_TABS': {
      const ordered = action.payload
        .map(id => state.tabs.find(t => t.id === id))
        .filter((t): t is NonNullable<typeof t> => t !== undefined);
      return { ...state, tabs: ordered };
    }

    case 'REORDER_COLLECTIONS': {
      const ordered = action.payload
        .map(id => state.collections.find(c => c._id === id))
        .filter((c): c is NonNullable<typeof c> => c !== undefined);
      return { ...state, collections: ordered };
    }

    case 'SET_RESPONSE':
      return { ...state, response: action.payload };

    case 'SET_LOADING':
      return { ...state, isLoading: action.payload };

    case 'SET_VIEW':
      return { ...state, view: action.payload };

    case 'SET_RUNNER_RESULTS':
      return { ...state, runnerResults: action.payload };

    case 'SET_RUNNING':
      return { ...state, isRunning: action.payload };

    case 'UPDATE_COLLECTION_VARS':
      return {
        ...state,
        collectionVariables: {
          ...state.collectionVariables,
          [action.payload.collectionId]: {
            ...(state.collectionVariables[action.payload.collectionId] || {}),
            ...action.payload.vars,
          },
        },
      };

    case 'UPDATE_GLOBAL_VARS':
      return { ...state, globalVariables: { ...state.globalVariables, ...action.payload } };

    case 'SET_GLOBAL_VARS':
      return { ...state, globalVariables: action.payload };

    case 'ADD_CONSOLE_LOG':
      return { ...state, consoleLogs: [action.payload, ...state.consoleLogs].slice(0, 500) };

    case 'CLEAR_CONSOLE_LOGS':
      return { ...state, consoleLogs: [] };

    case 'UPSERT_DOMAIN_COOKIES': {
      const { domain, cookies } = action.payload;
      const existing: Cookie[] = state.cookieJar[domain] ? [...state.cookieJar[domain]] : [];
      cookies.forEach(c => {
        const idx = existing.findIndex(e => e.name === c.name);
        if (idx >= 0) existing[idx] = c;
        else existing.push(c);
      });
      return { ...state, cookieJar: { ...state.cookieJar, [domain]: existing } };
    }

    case 'DELETE_COOKIE': {
      const { domain, name } = action.payload;
      const remaining = (state.cookieJar[domain] ?? []).filter(c => c.name !== name);
      const jar: CookieJar = { ...state.cookieJar };
      if (remaining.length === 0) delete jar[domain];
      else jar[domain] = remaining;
      return { ...state, cookieJar: jar };
    }

    case 'CLEAR_DOMAIN_COOKIES': {
      const jar: CookieJar = { ...state.cookieJar };
      delete jar[action.payload];
      return { ...state, cookieJar: jar };
    }

    case 'SET_COOKIE_JAR':
      return { ...state, cookieJar: action.payload };

    case 'ADD_MOCK_COLLECTION':
      return { ...state, mockCollections: [...state.mockCollections, action.payload] };

    case 'UPDATE_MOCK_COLLECTION':
      return { ...state, mockCollections: state.mockCollections.map(c => c.id === action.payload.id ? action.payload : c) };

    case 'DELETE_MOCK_COLLECTION': {
      const colId = action.payload;
      const routesWithoutCol = state.mockRoutes.map(r =>
        r.collectionId === colId ? { ...r, collectionId: undefined } : r
      );
      return { ...state, mockCollections: state.mockCollections.filter(c => c.id !== colId), mockRoutes: routesWithoutCol };
    }

    case 'ADD_MOCK_ROUTE':
      return { ...state, mockRoutes: [...state.mockRoutes, action.payload] };

    case 'UPDATE_MOCK_ROUTE':
      return { ...state, mockRoutes: state.mockRoutes.map(r => r.id === action.payload.id ? action.payload : r) };

    case 'DELETE_MOCK_ROUTE':
      return { ...state, mockRoutes: state.mockRoutes.filter(r => r.id !== action.payload) };

    case 'REORDER_MOCK_ROUTES': {
      const ordered = action.payload
        .map(id => state.mockRoutes.find(r => r.id === id))
        .filter((r): r is MockRoute => r !== undefined);
      return { ...state, mockRoutes: ordered };
    }

    case 'SET_MOCK_ROUTES':
      return { ...state, mockRoutes: action.payload };

    case 'SET_MOCK_SERVER_RUNNING':
      return { ...state, mockServerRunning: action.payload };

    case 'SET_MOCK_PORT':
      return { ...state, mockPort: action.payload };

    case 'UPDATE_ACTIVE_ENV_VARS': {
      if (!state.activeEnvironmentId) return state;
      const updatedEnvs = state.environments.map(env => {
        if (env._id !== state.activeEnvironmentId) return env;
        const updatedValues = env.values.map(v => ({
          ...v,
          value: action.payload[v.key] !== undefined ? action.payload[v.key] : v.value,
        }));
        const existingKeys = new Set(updatedValues.map(v => v.key));
        const newEntries = Object.entries(action.payload)
          .filter(([k]) => !existingKeys.has(k))
          .map(([key, value]) => ({ key, value, enabled: true }));
        return { ...env, values: [...updatedValues, ...newEntries] };
      });
      return { ...state, environments: updatedEnvs };
    }

    default:
      return state;
  }
}

// ─── Context ──────────────────────────────────────────────────────────────────

interface AppContextValue {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  getActiveEnvironment: () => AppEnvironment | null;
  getEnvironmentVars: () => Record<string, string>;
  getCollectionVars: (collectionId: string) => Record<string, string>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState, (base) => {
    const saved = loadPersisted();
    if (!saved) return base;
    const restoredCollections = (saved.collections ?? base.collections).map(col => ({
      ...col,
      item: ensureIds(col.item),
    }));

    let restoredTabs: RequestTab[] = [];
    let restoredActiveTabId: string | null = null;
    if (saved.tabSession) {
      restoredTabs = saved.tabSession.tabs
        .map(ref => {
          const col = restoredCollections.find(c => c._id === ref.collectionId);
          if (!col) return null;
          const item = findItemInTree(col.item, ref.itemId);
          if (!item || !item.request) return null;
          return { id: ref.id, collectionId: ref.collectionId, item, response: null, isLoading: false } as RequestTab;
        })
        .filter((t): t is RequestTab => t !== null);

      if (saved.tabSession.activeTabId && restoredTabs.some(t => t.id === saved.tabSession!.activeTabId)) {
        restoredActiveTabId = saved.tabSession.activeTabId;
      } else {
        restoredActiveTabId = restoredTabs[0]?.id ?? null;
      }
    }

    const activeTab = restoredTabs.find(t => t.id === restoredActiveTabId) ?? null;

    return {
      ...base,
      collections: restoredCollections,
      environments: saved.environments ?? base.environments,
      activeEnvironmentId: saved.activeEnvironmentId ?? base.activeEnvironmentId,
      collectionVariables: saved.collectionVariables ?? base.collectionVariables,
      globalVariables: saved.globalVariables ?? base.globalVariables,
      cookieJar: saved.cookieJar ?? base.cookieJar,
      mockRoutes: saved.mockRoutes ?? base.mockRoutes,
      mockCollections: saved.mockCollections ?? base.mockCollections,
      mockPort: saved.mockPort ?? base.mockPort,
      tabs: restoredTabs,
      activeTabId: restoredActiveTabId,
      activeRequest: activeTab ? { collectionId: activeTab.collectionId, item: activeTab.item } : null,
    };
  });

  useEffect(() => {
    const snapshot: PersistedState = {
      collections: state.collections,
      environments: state.environments,
      activeEnvironmentId: state.activeEnvironmentId,
      collectionVariables: state.collectionVariables,
      globalVariables: state.globalVariables,
      cookieJar: state.cookieJar,
      mockCollections: state.mockCollections,
      mockRoutes: state.mockRoutes,
      mockPort: state.mockPort,
      tabSession: {
        tabs: state.tabs
          .filter(t => t.item.id != null)
          .map(t => ({ id: t.id, collectionId: t.collectionId, itemId: t.item.id! })),
        activeTabId: state.activeTabId,
      },
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // localStorage unavailable or quota exceeded — fail silently
    }
  }, [state.collections, state.environments, state.activeEnvironmentId, state.collectionVariables, state.globalVariables, state.cookieJar, state.mockCollections, state.mockRoutes, state.mockPort, state.tabs, state.activeTabId]);

  function getActiveEnvironment(): AppEnvironment | null {
    if (!state.activeEnvironmentId) return null;
    return state.environments.find(e => e._id === state.activeEnvironmentId) ?? null;
  }

  function getEnvironmentVars(): Record<string, string> {
    const env = getActiveEnvironment();
    if (!env) return {};
    const vars: Record<string, string> = {};
    env.values.forEach(v => {
      if (v.enabled) vars[v.key] = v.value;
    });
    return vars;
  }

  function getCollectionVars(collectionId: string): Record<string, string> {
    return state.collectionVariables[collectionId] || {};
  }

  return (
    <AppContext.Provider value={{ state, dispatch, getActiveEnvironment, getEnvironmentVars, getCollectionVars }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function parseCollectionFile(json: unknown): AppCollection {
  const col = json as AppCollection;
  if (!col.info || !col.item) throw new Error('Invalid Postman Collection v2.1 JSON: expected an object with "info" and "item" properties');
  return { ...col, _id: generateId() };
}

export function parseEnvironmentFile(json: unknown): AppEnvironment {
  const env = json as AppEnvironment;
  if (!env.name || !Array.isArray(env.values)) {
    throw new Error('Not a valid environment: expected JSON with a name and a values array');
  }
  return { ...env, _id: generateId() };
}
