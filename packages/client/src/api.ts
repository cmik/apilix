import axios from 'axios';
import type { AiSuggestAssertionsResult, AiGenerateRequestResult } from './utils/ai/aiTypes';
import type { CollectionItem, BaseCollection, RequestResponse, RunnerIteration, RunnerIterationResult, ScriptLog, CookieJar, RequestSettings, AiSettings, DocAiDescription } from './types';
import type { DatabaseConnection } from './types';
import { normalizeBaseUrl } from './utils/aiDefaults';

// When loaded via file:// (packaged Electron app), relative /api won't work.
// The preload script exposes the dynamic server port via window.electronAPI.
const electronPort = (window as any).electronAPI?.serverPort;
export const API_BASE = window.location.protocol === 'file:'
  ? `http://localhost:${electronPort ?? 3001}/api`
  : '/api';

const api = axios.create({ baseURL: API_BASE });

export interface ExecutePayload {
  item: CollectionItem;
  environment: Record<string, string>;
  collectionVariables: Record<string, string>;
  globals: Record<string, string>;
  dataRow?: Record<string, string>;
  collVars?: Array<{ key: string; value: string; disabled?: boolean }>;
  cookies?: CookieJar;
  collectionItems?: CollectionItem[];
  /** When set, the server rewrites the request URL to this base after variable resolution. */
  mockBase?: string;
  /** Optional request-level network behavior overrides. */
  requestSettings?: RequestSettings;
  mongoConnections?: Record<string, { uri: string; database?: string }>;
  databases?: DatabaseConnection[];
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
  collection: BaseCollection;
  environment: Record<string, string>;
  collectionVariables: Record<string, string>;
  globals: Record<string, string>;
  cookies?: CookieJar;
  delay?: number;
  iterations?: number;
  executeChildRequests?: boolean;
  conditionalExecution?: boolean;
  allCollectionItems?: CollectionItem[];
  /** When set, the server rewrites every request URL to this base (after variable resolution). */
  mockBase?: string;
  maxRetries?: number;
  retryDelay?: number;
  retryBackoff?: 'fixed' | 'exponential';
  retryOn?: 'failures' | 'errors' | 'both';
  mongoConnections?: Record<string, { uri: string; database?: string }>;
  databases?: DatabaseConnection[];
}

export interface TestDatabaseConnectionResponse {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export async function testDatabaseConnection(
  config: Partial<DatabaseConnection>,
  runtimeVars?: Record<string, string>,
): Promise<TestDatabaseConnectionResponse> {
  const response = await api.post<TestDatabaseConnectionResponse>('/databases/test', {
    ...config,
    variables: runtimeVars || {},
  });
  return response.data;
}

export async function openDatabasePool(config: DatabaseConnection, runtimeVars?: Record<string, string>): Promise<{ ok: boolean; poolId?: string; error?: string }> {
  const response = await api.post<{ ok: boolean; poolId?: string; error?: string }>('/databases/pool/open', { ...config, variables: runtimeVars || {} });
  return response.data;
}

export async function closeDatabasePool(poolId: string): Promise<{ ok: boolean; error?: string }> {
  const response = await api.post<{ ok: boolean; error?: string }>('/databases/pool/close', { poolId });
  return response.data;
}

export interface DbQueryResult {
  rows: Record<string, unknown>[];
  columns: string[];
  rowCount: number;
}

export interface DbMongoResult {
  result: unknown;
}

export interface DbGenericResult {
  result: unknown;
}

export async function executeDbQuery(
  connectionId: string,
  sql: string,
  params?: unknown[],
): Promise<DbQueryResult> {
  const response = await api.post<DbQueryResult & { success: boolean }>('/databases/query', {
    connectionId,
    sql,
    params,
  });
  return response.data;
}

export async function executeMongoQuery(
  connectionId: string,
  operation: string,
  document: Record<string, unknown>,
  collection?: string,
  options?: Record<string, unknown>,
): Promise<DbMongoResult> {
  const response = await api.post<DbMongoResult & { success: boolean }>('/databases/query', {
    connectionId,
    operation,
    document,
    collection,
    options,
  });
  return response.data;
}

export async function executeRedisCommand(
  connectionId: string,
  command: string,
  args?: unknown[],
): Promise<DbGenericResult> {
  const response = await api.post<DbGenericResult & { success: boolean }>('/databases/query', {
    connectionId,
    command,
    args,
  });
  return response.data;
}

export async function executeDynamoOperation(
  connectionId: string,
  operation: string,
  input: Record<string, unknown>,
): Promise<DbGenericResult> {
  const response = await api.post<DbGenericResult & { success: boolean }>('/databases/query', {
    connectionId,
    operation,
    input,
  });
  return response.data;
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
  onNextRequest?: (data: { from: string; to: string; via: 'name' | 'id'; targetId?: string }) => void;
  onConditionalFlow?: (data: { from: string; via: 'name' | 'id'; reason: 'stopped-by-script' | 'target-not-found'; attemptedTarget?: string }) => void;
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
        case 'conditional-flow': callbacks.onConditionalFlow?.(parsed); break;
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

export interface MockLogResponse {
  entries: import('./types').MockLogEntry[];
}

export async function getMockLog(): Promise<MockLogResponse> {
  const res = await api.get<MockLogResponse>('/mock-log');
  return res.data;
}

export async function clearMockLog(): Promise<void> {
  await api.delete('/mock-log');
}

export interface MockDbResponse {
  data: Record<string, unknown>;
  keys: string[];
}

export async function getMockDb(): Promise<MockDbResponse> {
  const res = await api.get<MockDbResponse>('/mock-db');
  return res.data;
}

export async function clearMockDb(): Promise<void> {
  await api.delete('/mock-db');
}

// ─── MongoDB Database API ─────────────────────────────────────────────────────

import type { MongoCollection, MongoQueryResult } from './types';

export async function testMongoDBConnection(uri: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await api.post<{ success: boolean }>('/database/test-connection', { uri });
    return res.data;
  } catch (err: any) {
    return { success: false, error: err.response?.data?.error || err.message };
  }
}

export async function fetchMongoDBCollections(uri: string, database: string): Promise<{ collections: MongoCollection[]; error?: string }> {
  try {
    const res = await api.post<{ collections: MongoCollection[] }>('/database/collections', { uri, database });
    return res.data;
  } catch (err: any) {
    return { collections: [], error: err.response?.data?.error || err.message };
  }
}

export async function executeMongoDBQuery(
  uri: string,
  database: string,
  collection: string,
  query: string,
  limit?: number,
): Promise<MongoQueryResult> {
  try {
    const res = await api.post<MongoQueryResult>('/database/query', {
      uri,
      database,
      collection,
      query,
      limit: limit || 100,
    });
    return res.data;
  } catch (err: any) {
    return {
      success: false,
      error: err.response?.data?.error || err.message,
      executionTime: 0,
    };
  }
}

const GRAPHQL_INTROSPECTION_QUERY = `{__schema{queryType{name}mutationType{name}subscriptionType{name}types{kind name fields(includeDeprecated:true){name type{kind name ofType{kind name ofType{kind name ofType{kind name}}}}args{name type{kind name ofType{kind name ofType{kind name}}}}}}}}`;

export async function graphqlIntrospect(
  url: string,
  headers: Array<{ key: string; value: string }>,
): Promise<ExecuteResult> {
  const item: CollectionItem = {
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

export async function fetchWsdl(url: string): Promise<string> {
  const response = await api.get<string>('/wsdl', {
    params: { url },
    responseType: 'text',
  });
  return response.data;
}

/** Extract a human-readable message from an axios error, preferring the server's error body. */
function extractApiError(err: unknown): Error {
  if (
    err !== null &&
    typeof err === 'object' &&
    'isAxiosError' in err &&
    (err as { isAxiosError: boolean }).isAxiosError
  ) {
    const axErr = err as { response?: { data?: { error?: string }; status?: number } };
    const msg = axErr.response?.data?.error;
    if (msg) return new Error(msg);
  }
  return err instanceof Error ? err : new Error('Request failed');
}

export interface MongoAuthOverride {
  mode?: string;
  username?: string;
  password?: string;
  authSource?: string;
}

export async function listMongoDatabases(uri?: string, connectionId?: string, auth?: MongoAuthOverride, databases?: DatabaseConnection[]): Promise<string[]> {
  try {
    const res = await api.post<{ databases: string[] }>('/mongo/introspect/databases', { uri, connectionId, auth, databases });
    return res.data.databases;
  } catch (err) {
    throw extractApiError(err);
  }
}

export async function listMongoCollections(uri: string | undefined, database: string, connectionId?: string, auth?: MongoAuthOverride, databases?: DatabaseConnection[]): Promise<string[]> {
  try {
    const res = await api.post<{ collections: string[] }>('/mongo/introspect/collections', { uri, database, connectionId, auth, databases });
    return res.data.collections;
  } catch (err) {
    throw extractApiError(err);
  }
}

// ─── AI (loopback-only server routes; the key only ever travels client → local server) ───

/** Error from /api/ai/*. `code` is one of the server's AiError codes (AUTH, RATE_LIMIT, DISABLED, TOO_LARGE…). */
export class AiApiError extends Error {
  code: string;
  status?: number;
  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = 'AiApiError';
    this.code = code;
    this.status = status;
  }
}

export function toAiApiError(err: unknown): AiApiError {
  if (err instanceof AiApiError) return err;
  if (typeof err === 'object' && err !== null && 'isAxiosError' in err) {
    const e = err as { response?: { status?: number; data?: { error?: string; code?: string } }; message?: string };
    if (e.response) {
      return new AiApiError(e.response.data?.error ?? e.message ?? 'AI request failed', e.response.data?.code ?? 'NETWORK', e.response.status);
    }
    return new AiApiError('Could not reach the local Apilix server', 'NETWORK');
  }
  return new AiApiError(err instanceof Error ? err.message : 'AI request failed', 'INTERNAL');
}

export interface AiPreviewPayload {
  item?: CollectionItem;
  response?: Pick<RequestResponse, 'status' | 'statusText' | 'headers' | 'body'>;
  variables?: Array<{ name: string; scope?: string; secret?: boolean }>;
  /** Plaintext values of secret variables; the server scrubs them from every section. */
  secretValues?: string[];
  settings?: Partial<Pick<AiSettings, 'maxContextTokens' | 'redactSecrets' | 'sendResponseBodies'>>;
}

export interface AiPreviewResult {
  sections: Array<{ label: string; text: string; truncated: boolean }>;
  /** Rough estimate (chars / 4). */
  estimatedTokens: number;
  redactions: number;
}

/** Push settings (and optionally the key) to the server. `apiKey`: undefined = keep, null = clear. */
export async function aiPutConfig(settings: AiSettings, apiKey?: string | null): Promise<{ ok: boolean; hasKey: boolean }> {
  try {
    const { consentGiven: _consentGiven, consentDestination: _consentDestination, ...rest } = settings;
    const baseUrl = normalizeBaseUrl(rest.baseUrl);
    const serverSettings = { ...rest, ...(baseUrl ? { baseUrl } : {}) };
    const res = await api.put<{ ok: boolean; hasKey: boolean }>('/ai/config', {
      settings: serverSettings,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
    return res.data;
  } catch (err) {
    throw toAiApiError(err);
  }
}

export async function aiClearConfig(): Promise<void> {
  try {
    await api.delete('/ai/config');
  } catch (err) {
    throw toAiApiError(err);
  }
}

export async function aiTest(): Promise<{ ok: boolean; model: string; latencyMs: number }> {
  try {
    const res = await api.post<{ ok: boolean; model: string; latencyMs: number }>('/ai/test', {}, { timeout: 70000 });
    return res.data;
  } catch (err) {
    throw toAiApiError(err);
  }
}

export async function aiPreview(payload: AiPreviewPayload): Promise<AiPreviewResult> {
  try {
    const res = await api.post<AiPreviewResult>('/ai/preview', payload);
    return res.data;
  } catch (err) {
    throw toAiApiError(err);
  }
}

export interface AiDescribeDocsResult {
  descriptions: Record<string, DocAiDescription>;
  warnings: string[];
  /** Number of undocumented entries that were submitted. */
  requested: number;
}

/**
 * Ask the model to describe what a collection leaves undocumented. The collection must already be
 * masked (see `maskCollectionForAi`); the server redacts it again before anything leaves the machine.
 */
export async function aiDescribeDocs(payload: {
  collection: unknown;
  folder?: string;
  language?: string;
  secretValues?: string[];
}): Promise<AiDescribeDocsResult> {
  try {
    const res = await api.post<AiDescribeDocsResult>('/ai/describe-docs', payload, { timeout: 300000 });
    return res.data;
  } catch (err) {
    throw toAiApiError(err);
  }
}

export interface AiSuggestAssertionsPayload {
  request?: CollectionItem['request'];
  name?: string;
  response: Pick<RequestResponse, 'status' | 'statusText' | 'headers' | 'body'> & { responseTime?: number };
  existingTests?: string;
  /** Plaintext values of secret variables from every environment; the server scrubs them. */
  secretValues?: string[];
  language?: string;
}

/** Ask the model for assertions; the server returns only those that pass on `response`. */
export async function aiSuggestAssertions(payload: AiSuggestAssertionsPayload, signal?: AbortSignal): Promise<AiSuggestAssertionsResult> {
  try {
    const res = await api.post<AiSuggestAssertionsResult>('/ai/suggest-assertions', payload, { timeout: 120000, signal });
    return res.data;
  } catch (err) {
    throw toAiApiError(err);
  }
}

export interface AiGenerateRequestPayload {
  instruction: string;
  /** Present = modify this request instead of creating one. */
  current?: CollectionItem;
  /** Up to 5 neighbouring requests, used as style examples. */
  neighbors?: CollectionItem[];
  /** Variable NAMES only. */
  variables?: Array<{ name: string; scope?: string; secret?: boolean }>;
  secretValues?: string[];
  language?: string;
}

export async function aiGenerateRequest(payload: AiGenerateRequestPayload, signal?: AbortSignal): Promise<AiGenerateRequestResult> {
  try {
    const res = await api.post<AiGenerateRequestResult>('/ai/generate-request', payload, { timeout: 180000, signal });
    return res.data;
  } catch (err) {
    throw toAiApiError(err);
  }
}
