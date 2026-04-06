import axios from 'axios';
import type { PostmanItem, PostmanCollection, RequestResponse, RunnerIteration, RunnerIterationResult, ScriptLog, CookieJar } from './types';

// When loaded via file:// (packaged Electron app), relative /api won't work.
// The preload script exposes the dynamic server port via window.electronAPI.
const electronPort = (window as any).electronAPI?.serverPort;
export const API_BASE = window.location.protocol === 'file:'
  ? `http://localhost:${electronPort ?? 3001}/api`
  : '/api';

const api = axios.create({ baseURL: API_BASE });

export interface ExecutePayload {
  item: PostmanItem;
  environment: Record<string, string>;
  collectionVariables: Record<string, string>;
  globals: Record<string, string>;
  dataRow?: Record<string, string>;
  collVars?: Array<{ key: string; value: string; disabled?: boolean }>;
  cookies?: CookieJar;
  collectionItems?: PostmanItem[];
}

export interface ChildRequestLog {
  name: string;
  method: string;
  result: RequestResponse & {
    resolvedUrl?: string;
    requestHeaders?: Record<string, string>;
    requestBody?: string;
  };
}

export interface ExecuteResult extends Omit<RequestResponse, never> {
  updatedEnvironment?: Record<string, string>;
  updatedCollectionVariables?: Record<string, string>;
  updatedGlobals?: Record<string, string>;
  updatedCookies?: CookieJar;
  scriptLogs?: ScriptLog[];
  resolvedUrl?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  preChildRequests?: ChildRequestLog[];
  testChildRequests?: ChildRequestLog[];
}

export async function executeRequest(payload: ExecutePayload): Promise<ExecuteResult> {
  const response = await api.post<ExecuteResult>('/execute', payload);
  return response.data;
}

export interface RunPayload {
  collection: PostmanCollection;
  environment: Record<string, string>;
  collectionVariables: Record<string, string>;
  globals: Record<string, string>;
  cookies?: CookieJar;
  delay?: number;
  iterations?: number;
  executeChildRequests?: boolean;
  conditionalExecution?: boolean;
  allCollectionItems?: PostmanItem[];
}

export async function runCollection(
  payload: RunPayload,
  csvFile?: File
): Promise<{ results: RunnerIteration[] }> {
  const formData = new FormData();
  formData.append('data', JSON.stringify(payload));
  if (csvFile) {
    formData.append('csvFile', csvFile);
  }
  const response = await api.post<{ results: RunnerIteration[] }>('/run', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
}

export interface RunStreamCallbacks {
  onRunId?: (runId: string) => void;
  onIterationStart?: (data: { iteration: number; dataRow: Record<string, string> }) => void;
  onResult?: (data: RunnerIterationResult & { iteration: number }) => void;
  onIterationEnd?: (data: { iteration: number }) => void;
  onNextRequest?: (data: { from: string; to: string }) => void;
  onError?: (error: string) => void;
  onStopped?: () => void;
  onDone?: () => void;
}

export async function runCollectionStream(
  payload: RunPayload,
  csvFile: File | undefined,
  callbacks: RunStreamCallbacks,
): Promise<void> {
  const formData = new FormData();
  formData.append('data', JSON.stringify(payload));
  if (csvFile) {
    formData.append('csvFile', csvFile);
  }

  const response = await fetch(`${API_BASE}/run`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    let msg = `HTTP ${response.status}`;
    try { msg = JSON.parse(text).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events from the buffer
    const parts = buffer.split('\n\n');
    buffer = parts.pop()!; // keep incomplete chunk

    for (const part of parts) {
      let eventType = 'message';
      let data = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('event: ')) eventType = line.slice(7);
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (!data) continue;
      const parsed = JSON.parse(data);
      switch (eventType) {
        case 'run-id': callbacks.onRunId?.(parsed.runId); break;
        case 'iteration-start': callbacks.onIterationStart?.(parsed); break;
        case 'result': callbacks.onResult?.(parsed); break;
        case 'iteration-end': callbacks.onIterationEnd?.(parsed); break;
        case 'error': callbacks.onError?.(parsed.error); break;
        case 'next-request': callbacks.onNextRequest?.(parsed); break;
        case 'stopped': callbacks.onStopped?.(); break;
        case 'done': callbacks.onDone?.(); break;
      }
    }
  }
}

export async function pauseRun(runId: string): Promise<void> {
  await api.post(`/run/${runId}/pause`);
}

export async function resumeRun(runId: string): Promise<void> {
  await api.post(`/run/${runId}/resume`);
}

export async function stopRun(runId: string): Promise<void> {
  await api.post(`/run/${runId}/stop`);
}

export async function checkHealth(): Promise<boolean> {
  try {
    await api.get('/health');
    return true;
  } catch {
    return false;
  }
}

// ─── Mock Server API ──────────────────────────────────────────────────────────

import type { MockRoute } from './types';

export interface MockStatus {
  running: boolean;
  port: number;
}

export async function getMockStatus(): Promise<MockStatus> {
  const res = await api.get<MockStatus>('/mock/status');
  return res.data;
}

export async function startMockServer(port: number, routes: MockRoute[]): Promise<void> {
  await api.post('/mock/start', { port, routes });
}

export async function stopMockServer(): Promise<void> {
  await api.post('/mock/stop');
}

export async function syncMockRoutes(routes: MockRoute[]): Promise<void> {
  await api.put('/mock/routes', { routes });
}

const GRAPHQL_INTROSPECTION_QUERY = `{__schema{queryType{name}mutationType{name}subscriptionType{name}types{kind name fields(includeDeprecated:true){name type{kind name ofType{kind name ofType{kind name ofType{kind name}}}}args{name type{kind name ofType{kind name ofType{kind name}}}}}}}}`;

export async function graphqlIntrospect(
  url: string,
  headers: Array<{ key: string; value: string }>,
): Promise<ExecuteResult> {
  const item: PostmanItem = {
    name: '__introspection__',
    request: {
      method: 'POST',
      url: { raw: url },
      header: [
        { key: 'Content-Type', value: 'application/json' },
        ...headers,
      ],
      body: {
        mode: 'graphql',
        graphql: { query: GRAPHQL_INTROSPECTION_QUERY },
      },
    },
  };
  return executeRequest({
    item,
    environment: {},
    collectionVariables: {},
    globals: {},
    collVars: [],
    cookies: {},
  });
}
