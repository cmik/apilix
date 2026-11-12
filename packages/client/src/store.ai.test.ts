import { vi, describe, it, expect } from 'vitest';

vi.mock('./api', () => ({ API_BASE: '/api', executeRequest: vi.fn() }));
vi.mock('./utils/storageDriver', () => ({}));
vi.mock('./utils/snapshotEngine', () => ({}));

import { appReducer, initialState } from './store';
import { DEFAULT_AI_SETTINGS } from './utils/aiDefaults';
import type { AppAction, AppState, WorkspaceData } from './types';

describe('AI state slice', () => {
  it('starts disabled, with no key and every feature off', () => {
    expect(initialState.ai.settings.enabled).toBe(false);
    expect(initialState.ai.keyStatus).toBe('none');
    expect(initialState.ai.inFlight).toEqual({});
    expect(initialState.ai.lastError).toBeNull();
    expect(Object.values(initialState.ai.settings.features).every(v => v === false)).toBe(true);
  });

  it('AI_SET_SETTINGS revokes consent and disables AI when the destination changes', () => {
    const s1 = appReducer(initialState, { type: 'AI_SET_SETTINGS', payload: { consentGiven: true, enabled: true, model: 'm' } });
    expect(s1.ai.settings.consentGiven).toBe(true);
    const s2 = appReducer(s1, { type: 'AI_SET_SETTINGS', payload: { baseUrl: 'https://other.example' } });
    expect(s2.ai.settings.consentGiven).toBe(false);
    expect(s2.ai.settings.enabled).toBe(false);
  });

  it('AI_SET_SETTINGS merges fields and deep-merges features', () => {
    const s1 = appReducer(initialState, { type: 'AI_SET_SETTINGS', payload: { enabled: true, model: 'm', features: { diagnose: true } } });
    expect(s1.ai.settings.enabled).toBe(true);
    expect(s1.ai.settings.model).toBe('m');
    expect(s1.ai.settings.features.diagnose).toBe(true);
    expect(s1.ai.settings.features.nlGenerate).toBe(false);
    const s2 = appReducer(s1, { type: 'AI_SET_SETTINGS', payload: { features: { nlGenerate: true } } });
    expect(s2.ai.settings.features).toMatchObject({ diagnose: true, nlGenerate: true, dataGen: false });
    expect(s2.ai.settings.model).toBe('m');
  });

  it('AI_SET_SETTINGS does not mutate the shared defaults', () => {
    appReducer(initialState, { type: 'AI_SET_SETTINGS', payload: { features: { diagnose: true } } });
    expect(DEFAULT_AI_SETTINGS.features.diagnose).toBe(false);
  });

  it('AI_SET_KEY_STATUS only changes the status', () => {
    const s = appReducer(initialState, { type: 'AI_SET_KEY_STATUS', payload: 'needs-reentry' });
    expect(s.ai.keyStatus).toBe('needs-reentry');
    expect(s.ai.settings).toBe(initialState.ai.settings);
  });

  it('request lifecycle toggles inFlight and records the last error', () => {
    const started = appReducer(initialState, { type: 'AI_REQUEST_START', payload: 'test' });
    expect(started.ai.inFlight.test).toBe(true);
    const failed = appReducer(started, { type: 'AI_REQUEST_FAIL', payload: { feature: 'test', code: 'AUTH', message: 'bad key' } });
    expect(failed.ai.inFlight.test).toBe(false);
    expect(failed.ai.lastError).toEqual({ code: 'AUTH', message: 'bad key' });
    const restarted = appReducer(failed, { type: 'AI_REQUEST_START', payload: 'test' });
    expect(restarted.ai.lastError).toBeNull();
    const done = appReducer(restarted, { type: 'AI_REQUEST_DONE', payload: 'test' });
    expect(done.ai.inFlight.test).toBe(false);
    expect(appReducer(failed, { type: 'AI_CLEAR_ERROR' }).ai.lastError).toBeNull();
  });

  it('HYDRATE_WORKSPACE (workspace switch) leaves AI state untouched', () => {
    const configured: AppState = appReducer(initialState, { type: 'AI_SET_SETTINGS', payload: { enabled: true, model: 'm' } });
    const payload = {
      workspaces: [{ id: 'w2', name: 'W2', createdAt: 0 }],
      activeWorkspaceId: 'w2',
      collections: [], environments: [], activeEnvironmentId: null, collectionVariables: {}, globalVariables: {},
      cookieJar: {}, mockCollections: [], mockRoutes: [], mockPort: 3002,
    } as unknown as WorkspaceData & { workspaces: never; activeWorkspaceId: string };
    const next = appReducer(configured, { type: 'HYDRATE_WORKSPACE', payload } as AppAction);
    expect(next.ai).toBe(configured.ai);
  });

  it('no AI action type carries an API key', () => {
    const samples: AppAction[] = [
      { type: 'AI_SET_SETTINGS', payload: { enabled: true } },
      { type: 'AI_SET_KEY_STATUS', payload: 'ok' },
      { type: 'AI_REQUEST_START', payload: 'test' },
      { type: 'AI_REQUEST_DONE', payload: 'test' },
      { type: 'AI_REQUEST_FAIL', payload: { feature: 'test', code: 'X', message: 'm' } },
      { type: 'AI_CLEAR_ERROR' },
    ];
    for (const a of samples) expect(JSON.stringify(a).toLowerCase()).not.toContain('apikey');
    expect(Object.keys(initialState.ai.settings).some(k => k.toLowerCase().includes('key') && k !== 'keyStatus')).toBe(false);
  });
});
