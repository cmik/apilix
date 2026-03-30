import axios from 'axios';
import type { PostmanItem, PostmanCollection, RequestResponse, RunnerIteration, ScriptLog } from './types';

const api = axios.create({ baseURL: '/api' });

export interface ExecutePayload {
  item: PostmanItem;
  environment: Record<string, string>;
  collectionVariables: Record<string, string>;
  globals: Record<string, string>;
  dataRow?: Record<string, string>;
  collVars?: Array<{ key: string; value: string; disabled?: boolean }>;
}

export interface ExecuteResult extends Omit<RequestResponse, never> {
  updatedEnvironment?: Record<string, string>;
  updatedCollectionVariables?: Record<string, string>;
  scriptLogs?: ScriptLog[];
  resolvedUrl?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
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
  delay?: number;
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

export async function checkHealth(): Promise<boolean> {
  try {
    await api.get('/health');
    return true;
  } catch {
    return false;
  }
}
