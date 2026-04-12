import React, { createContext, useContext, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import type { AppState, AppAction, AppSettings, AppCollection, AppEnvironment, CollectionItem, RequestTab, CookieJar, Cookie, MockRoute, MockCollection, Workspace, WorkspaceData } from './types';
import * as StorageDriver from './utils/storageDriver';
import * as SnapshotEngine from './utils/snapshotEngine';
import { API_BASE } from './api';

const STORAGE_KEY = 'apilix_persist'; // legacy key — kept for migration only

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
  // ── Workspace ────────────────────────────────────────────────────────────
  workspaces: [],
  activeWorkspaceId: '',
  storageReady: false,
  syncStatus: {},
  syncConfigVersion: 0,
  // ── Data ─────────────────────────────────────────────────────────────────
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
  runnerPreselection: null,
  captureEntries: [],
  captureRunning: false,
  captureGeneration: 0,
  captureViewState: {
    search: '',
    filterDomain: '',
    filterMethod: 'ALL',
    filterStatus: 'ALL',
    filterResourceType: 'ALL',
    sortKey: 'timestamp',
    sortDirection: 'desc',
  },
  settings: {
    theme: undefined,
    requestTimeout: 30000,
    followRedirects: true,
    sslVerification: false,
    proxyEnabled: false,
    httpProxy: '',
    httpsProxy: '',
    noProxy: '',
    corsAllowedOrigins: '',
  },
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

    case 'SET_RUNNER_PRESELECTION':
      return { ...state, runnerPreselection: action.payload };

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

    // ── Workspace actions ────────────────────────────────────────────────────

    case 'SET_STORAGE_READY':
      return { ...state, storageReady: action.payload };

    case 'HYDRATE_WORKSPACE': {
      const { workspaces, activeWorkspaceId, ...data } = action.payload;
      const restoredCollections = (data.collections ?? []).map(col => ({
        ...col,
        item: ensureIds(col.item),
      }));
      return {
        ...state,
        workspaces,
        activeWorkspaceId,
        storageReady: true,
        collections: restoredCollections,
        environments: data.environments ?? [],
        activeEnvironmentId: data.activeEnvironmentId ?? null,
        collectionVariables: data.collectionVariables ?? {},
        globalVariables: data.globalVariables ?? {},
        cookieJar: data.cookieJar ?? {},
        mockCollections: data.mockCollections ?? [],
        mockRoutes: data.mockRoutes ?? [],
        mockPort: data.mockPort ?? 3002,
      };
    }

    case 'CREATE_WORKSPACE':
      return {
        ...state,
        workspaces: [...state.workspaces, action.payload],
        activeWorkspaceId: action.payload.id,
        collections: [],
        environments: [],
        activeEnvironmentId: null,
        collectionVariables: {},
        globalVariables: {},
        cookieJar: {},
        mockCollections: [],
        mockRoutes: [],
        mockPort: 3002,
        tabs: [],
        activeTabId: null,
        activeRequest: null,
        response: null,
        consoleLogs: [],
        runnerResults: null,
        isRunning: false,
        view: 'request',
        mockServerRunning: false,
      };

    case 'SWITCH_WORKSPACE': {
      const { workspace, data } = action.payload;
      const restoredCollections = (data.collections ?? []).map(col => ({
        ...col,
        item: ensureIds(col.item),
      }));
      return {
        ...state,
        activeWorkspaceId: workspace.id,
        collections: restoredCollections,
        environments: data.environments ?? [],
        activeEnvironmentId: data.activeEnvironmentId ?? null,
        collectionVariables: data.collectionVariables ?? {},
        globalVariables: data.globalVariables ?? {},
        cookieJar: data.cookieJar ?? {},
        mockCollections: data.mockCollections ?? [],
        mockRoutes: data.mockRoutes ?? [],
        mockPort: data.mockPort ?? 3002,
        tabs: [],
        activeTabId: null,
        activeRequest: null,
        response: null,
        consoleLogs: [],
        runnerResults: null,
        isRunning: false,
        view: 'request',
        mockServerRunning: false,
      };
    }

    case 'RENAME_WORKSPACE':
      return {
        ...state,
        workspaces: state.workspaces.map(w =>
          w.id === action.payload.id ? { ...w, name: action.payload.name } : w
        ),
      };

    case 'SET_WORKSPACE_COLOR':
      return {
        ...state,
        workspaces: state.workspaces.map(w =>
          w.id === action.payload.id ? { ...w, color: action.payload.color } : w
        ),
      };

    case 'DELETE_WORKSPACE': {
      const { id, fallbackId } = action.payload;
      const remaining = state.workspaces.filter(w => w.id !== id);
      return { ...state, workspaces: remaining, activeWorkspaceId: state.activeWorkspaceId === id ? fallbackId : state.activeWorkspaceId };
    }

    case 'DUPLICATE_WORKSPACE': {
      const { workspace, data } = action.payload;
      const restoredCollections = (data.collections ?? []).map(col => ({
        ...col,
        item: ensureIds(col.item),
      }));
      return {
        ...state,
        workspaces: [...state.workspaces, workspace],
        activeWorkspaceId: workspace.id,
        collections: restoredCollections,
        environments: data.environments ?? [],
        activeEnvironmentId: data.activeEnvironmentId ?? null,
        collectionVariables: data.collectionVariables ?? {},
        globalVariables: data.globalVariables ?? {},
        cookieJar: data.cookieJar ?? {},
        mockCollections: data.mockCollections ?? [],
        mockRoutes: data.mockRoutes ?? [],
        mockPort: data.mockPort ?? 3002,
        tabs: [],
        activeTabId: null,
        activeRequest: null,
        response: null,
        consoleLogs: [],
        runnerResults: null,
        isRunning: false,
        view: 'request',
        mockServerRunning: false,
      };
    }

    case 'SET_SYNC_STATUS':
      return {
        ...state,
        syncStatus: { ...state.syncStatus, [action.payload.workspaceId]: action.payload.status },
      };

    case 'BUMP_SYNC_CONFIG_VERSION':
      return { ...state, syncConfigVersion: state.syncConfigVersion + 1 };

    case 'RESTORE_SNAPSHOT': {
      const data = action.payload;
      const restoredCollections = (data.collections ?? []).map(col => ({
        ...col,
        item: ensureIds(col.item),
      }));
      return {
        ...state,
        collections: restoredCollections,
        environments: data.environments ?? [],
        activeEnvironmentId: data.activeEnvironmentId ?? null,
        collectionVariables: data.collectionVariables ?? {},
        globalVariables: data.globalVariables ?? {},
        cookieJar: data.cookieJar ?? {},
        mockCollections: data.mockCollections ?? [],
        mockRoutes: data.mockRoutes ?? [],
        mockPort: data.mockPort ?? 3002,
      };
    }

    case 'CAPTURE_ADD_ENTRY':
      if (action.payload.generation !== state.captureGeneration) return state;
      return {
        ...state,
        captureEntries: state.captureEntries.some(entry => entry.id === action.payload.entry.id)
          ? state.captureEntries.map(entry => entry.id === action.payload.entry.id ? { ...entry, ...action.payload.entry } : entry)
          : [...state.captureEntries, action.payload.entry],
      };

    case 'CAPTURE_UPDATE_ENTRY':
      if (action.payload.generation !== undefined && action.payload.generation !== state.captureGeneration) return state;
      return {
        ...state,
        captureEntries: state.captureEntries.map(e =>
          e.id === action.payload.entry.id ? { ...e, ...action.payload.entry } : e
        ),
      };

    case 'CAPTURE_CLEAR':
      return { ...state, captureEntries: [], captureGeneration: state.captureGeneration + 1 };

    case 'SET_CAPTURE_RUNNING':
      return { ...state, captureRunning: action.payload };

    case 'SET_CAPTURE_VIEW_STATE':
      return {
        ...state,
        captureViewState: {
          ...state.captureViewState,
          ...action.payload,
        },
      };

    case 'SET_SETTINGS':
      return { ...state, settings: action.payload };

    case 'UPDATE_SETTINGS':
      return { ...state, settings: { ...state.settings, ...action.payload } };

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
  const [state, dispatch] = useReducer(appReducer, initialState);
  // Track whether a debounced write is in flight to avoid unnecessary I/O
  const [saveTimer, setSaveTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  // ── Async init ───────────────────────────────────────────────────────────
  useEffect(() => {
    async function init() {
      let manifest = await StorageDriver.readManifest();

      // ── Migration: old apilix_persist → Default workspace ────────────────
      if (!manifest) {
        const legacy = loadPersisted();
        if (legacy) {
          const defaultId = generateId();
          const defaultWorkspace: Workspace = {
            id: defaultId,
            name: 'Default',
            createdAt: new Date().toISOString(),
            type: 'local',
          };
          const workspaceData: WorkspaceData = {
            collections: legacy.collections ?? [],
            environments: legacy.environments ?? [],
            activeEnvironmentId: legacy.activeEnvironmentId ?? null,
            collectionVariables: legacy.collectionVariables ?? {},
            globalVariables: legacy.globalVariables ?? {},
            cookieJar: legacy.cookieJar ?? {},
            mockCollections: legacy.mockCollections ?? [],
            mockRoutes: legacy.mockRoutes ?? [],
            mockPort: legacy.mockPort ?? 3002,
          };
          manifest = { workspaces: [defaultWorkspace], activeWorkspaceId: defaultId };
          await StorageDriver.writeManifest(manifest);
          await StorageDriver.writeWorkspace(defaultId, workspaceData);
          try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
        }
      }

      // ── First-ever launch: create Default workspace ───────────────────────
      if (!manifest) {
        const defaultId = generateId();
        const defaultWorkspace: Workspace = {
          id: defaultId,
          name: 'Default',
          createdAt: new Date().toISOString(),
          type: 'local',
        };
        manifest = { workspaces: [defaultWorkspace], activeWorkspaceId: defaultId };
        await StorageDriver.writeManifest(manifest);
      }

      const workspaceData = await StorageDriver.readWorkspace(manifest.activeWorkspaceId);
      dispatch({
        type: 'HYDRATE_WORKSPACE',
        payload: {
          workspaces: manifest.workspaces,
          activeWorkspaceId: manifest.activeWorkspaceId,
          ...(workspaceData ?? {
            collections: [],
            environments: [],
            activeEnvironmentId: null,
            collectionVariables: {},
            globalVariables: {},
            cookieJar: {},
            mockCollections: [],
            mockRoutes: [],
            mockPort: 3002,
          }),
        },
      });

      // Load global settings — fall back to legacy apilix_theme key for migration
      const savedSettings = await StorageDriver.readSettings();
      const legacyTheme = localStorage.getItem('apilix_theme');
      const mergedSettings: AppSettings = {
        ...initialState.settings,
        ...(savedSettings ?? {}),
      };
      if (!mergedSettings.theme && (legacyTheme === 'dark' || legacyTheme === 'light')) {
        mergedSettings.theme = legacyTheme;
      }
      dispatch({ type: 'SET_SETTINGS', payload: mergedSettings });
    }
    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Debounced workspace persistence ──────────────────────────────────────
  useEffect(() => {
    if (!state.storageReady) return;
    if (saveTimer) clearTimeout(saveTimer);
    const t = setTimeout(async () => {
      const workspaceData: WorkspaceData = {
        collections: state.collections,
        environments: state.environments,
        activeEnvironmentId: state.activeEnvironmentId,
        collectionVariables: state.collectionVariables,
        globalVariables: state.globalVariables,
        cookieJar: state.cookieJar,
        mockCollections: state.mockCollections,
        mockRoutes: state.mockRoutes,
        mockPort: state.mockPort,
      };
      await StorageDriver.writeWorkspace(state.activeWorkspaceId, workspaceData);
      await StorageDriver.writeManifest({ workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId });
      // Create a snapshot for history
      await SnapshotEngine.createSnapshot(state.activeWorkspaceId, workspaceData);
    }, 300);
    setSaveTimer(t);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.collections, state.environments, state.activeEnvironmentId, state.collectionVariables, state.globalVariables, state.cookieJar, state.mockCollections, state.mockRoutes, state.mockPort, state.workspaces, state.activeWorkspaceId, state.storageReady]);

  // ── Debounced settings persistence ───────────────────────────────────────
  const settingsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!state.storageReady) return;
    if (settingsSaveTimerRef.current) clearTimeout(settingsSaveTimerRef.current);
    settingsSaveTimerRef.current = setTimeout(() => {
      StorageDriver.writeSettings(state.settings);
    }, 300);
    return () => {
      if (settingsSaveTimerRef.current) clearTimeout(settingsSaveTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.settings, state.storageReady]);

  // ── Push proxy + CORS settings to the local API server ───────────────────
  useEffect(() => {
    if (!state.storageReady) return;
    const { proxyEnabled, httpProxy, httpsProxy, noProxy, corsAllowedOrigins,
            requestTimeout, followRedirects, sslVerification } = state.settings;
    fetch(`${API_BASE}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proxy: { enabled: proxyEnabled ?? false, httpProxy: httpProxy ?? '', httpsProxy: httpsProxy ?? '', noProxy: noProxy ?? '' },
        cors: { allowedOrigins: corsAllowedOrigins ?? '' },
        requests: { timeout: requestTimeout ?? 30000, followRedirects: followRedirects !== false, sslVerification: sslVerification ?? false },
      }),
    }).catch(() => { /* server may not be up yet; safe to ignore */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.settings.proxyEnabled, state.settings.httpProxy, state.settings.httpsProxy, state.settings.noProxy,
      state.settings.corsAllowedOrigins, state.settings.requestTimeout, state.settings.followRedirects,
      state.settings.sslVerification, state.storageReady]);

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

  // Show a simple loading screen until storage has been read from disk
  if (!state.storageReady) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#1a1a2e', color: '#ccc', fontFamily: 'sans-serif', fontSize: 14 }}>
        Loading…
      </div>
    );
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
