import type { CollectionExample, CollectionItem, RequestResponse } from '../types';

function previewLanguage(headers: Record<string, string>, body: string): string {
  const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1]?.toLowerCase() ?? '';
  if (ct.includes('json')) return 'json';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('html')) return 'html';
  if (!ct) {
    try { JSON.parse(body); return 'json'; } catch { /* not json */ }
  }
  return 'text';
}

/** Bodies above this many characters are not saved as examples (they bloat snapshots and sync). */
export const MAX_EXAMPLE_BODY_CHARS = 1_000_000;

/** Why a response can't be saved as an example, or null when it can. */
export function exampleSaveBlocker(response: RequestResponse): string | null {
  if (response.isExample) return 'This is already a saved example';
  if (response.bodyBase64) return "Binary responses can't be saved as examples";
  if (response.body.length > MAX_EXAMPLE_BODY_CHARS) return 'Response is too large to save as an example (over 1 MB)';
  return null;
}

/** Build a Postman-compatible example from a live response. Binary bodies are not stored. */
export function buildExampleFromResponse(
  response: RequestResponse,
  item: CollectionItem,
  id: string,
  name?: string,
): CollectionExample {
  const binary = !!response.bodyBase64;
  return {
    id,
    name: name?.trim() || `${response.status} ${response.statusText}`.trim() || 'Example',
    status: response.statusText,
    code: response.status,
    _postman_previewlanguage: previewLanguage(response.headers, response.body),
    header: Object.entries(response.headers).map(([key, value]) => ({ key, value })),
    body: binary ? '' : response.body,
    cookie: [],
    originalRequest: item.request ? JSON.parse(JSON.stringify(item.request)) : undefined,
  };
}

export function addExampleToItem(item: CollectionItem, example: CollectionExample): CollectionItem {
  return { ...item, response: [...(item.response ?? []), example] };
}

export function renameExampleOnItem(item: CollectionItem, exampleId: string, name: string): CollectionItem {
  return {
    ...item,
    response: (item.response ?? []).map(e => (e.id === exampleId ? { ...e, name } : e)),
  };
}

export function removeExampleFromItem(item: CollectionItem, exampleId: string): CollectionItem {
  const response = (item.response ?? []).filter(e => e.id !== exampleId);
  const { response: _drop, ...rest } = item;
  return response.length ? { ...rest, response } : rest;
}

/** Convert a saved example back into a RequestResponse for viewing. */
export function exampleToResponse(example: CollectionExample): RequestResponse {
  const headers: Record<string, string> = {};
  for (const h of example.header ?? []) if (!h.disabled) headers[h.key] = h.value;
  const body = example.body ?? '';
  return {
    isExample: true,
    status: example.code ?? 0,
    statusText: example.status ?? '',
    responseTime: 0,
    headers,
    body,
    size: body.length,
    testResults: [],
    error: null,
  };
}

/** Replace only the examples on an item (used to sync tabs without touching unsaved request edits). */
export function withExamples(item: CollectionItem, response: CollectionExample[] | undefined): CollectionItem {
  const { response: _drop, ...rest } = item;
  return response && response.length ? { ...rest, response } : rest;
}
