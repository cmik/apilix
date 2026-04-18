// ─── HAR (HTTP Archive) Utilities ────────────────────────────────────────────
// Parses .har files (browser network captures) into collection items, and
// generates HAR files from collections.
// HAR spec: https://w3c.github.io/web-performance/specs/HAR/Overview.html

import { generateId } from '../store';
import type { CollectionItem, CollectionHeader, CollectionBody } from '../types';

// ─── HAR type stubs ───────────────────────────────────────────────────────────

interface HarNameValue {
  name: string;
  value: string;
  comment?: string;
}

interface HarPostData {
  mimeType: string;
  text?: string;
  params?: Array<{ name: string; value?: string; fileName?: string; contentType?: string }>;
}

interface HarRequest {
  method: string;
  url: string;
  httpVersion?: string;
  headers?: HarNameValue[];
  queryString?: HarNameValue[];
  cookies?: HarNameValue[];
  postData?: HarPostData;
  headersSize?: number;
  bodySize?: number;
}

interface HarEntry {
  pageref?: string;
  startedDateTime?: string;
  comment?: string;
  request: HarRequest;
}

interface HarPage {
  id: string;
  title?: string;
}

interface HarLog {
  version?: string;
  entries?: HarEntry[];
  pages?: HarPage[];
}

interface HarFile {
  log: HarLog;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Pseudo-headers used in HTTP/2 and HTTP/3 that should not be forwarded. */
const SKIP_HEADERS = new Set([
  ':method', ':path', ':scheme', ':authority', ':status',
  'cookie', // cookies are managed separately in the cookie jar
]);

function nameFromRequest(method: string, rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const parts = u.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    const path = parts.length > 0 ? '/' + parts.join('/') : '/';
    return `${method} ${path}`;
  } catch {
    return `${method} ${rawUrl}`;
  }
}

function buildBody(postData: HarPostData | undefined): CollectionBody | undefined {
  if (!postData) return undefined;

  const mimeType = postData.mimeType ?? '';
  const text = postData.text ?? '';

  if (mimeType.includes('application/json')) {
    return {
      mode: 'raw',
      raw: text,
      options: { raw: { language: 'json' } },
    };
  }

  if (mimeType.includes('application/x-www-form-urlencoded')) {
    const params = postData.params ?? [];
    // Prefer params array; fall back to parsing the text string
    const urlencoded =
      params.length > 0
        ? params.map(p => ({ key: p.name, value: p.value ?? '' }))
        : text
            .split('&')
            .filter(Boolean)
            .map(pair => {
              const eq = pair.indexOf('=');
              return eq === -1
                ? { key: decodeURIComponent(pair), value: '' }
                : { key: decodeURIComponent(pair.slice(0, eq)), value: decodeURIComponent(pair.slice(eq + 1)) };
            });
    return { mode: 'urlencoded', urlencoded };
  }

  if (mimeType.includes('multipart/form-data')) {
    const params = postData.params ?? [];
    return {
      mode: 'formdata',
      formdata: params.map(p => ({ key: p.name, value: p.value ?? '' })),
    };
  }

  if (mimeType.includes('application/xml') || mimeType.includes('text/xml')) {
    return { mode: 'raw', raw: text, options: { raw: { language: 'xml' } } };
  }

  if (mimeType.includes('text/html')) {
    return { mode: 'raw', raw: text, options: { raw: { language: 'html' } } };
  }

  if (!text) return undefined;

  return { mode: 'raw', raw: text, options: { raw: { language: 'text' } } };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface HarImportResult {
  items: CollectionItem[];
  /** Page-title based folder grouping. Key = folder name, value = items. */
  grouped: boolean;
}

/**
 * Parse the text content of a .har file and return collection items.
 * Throws if the JSON is invalid or missing the required `log.entries` array.
 */
export function parseHarFile(text: string): CollectionItem[] {
  let har: HarFile;
  try {
    har = JSON.parse(text) as HarFile;
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`);
  }

  if (!har?.log?.entries) {
    throw new Error('Not a valid HAR file — missing "log.entries".');
  }

  const pages: HarPage[] = har.log.pages ?? [];
  const pageMap = new Map<string, string>(
    pages.map(p => [p.id, p.title ?? p.id])
  );

  const entries = har.log.entries;
  if (entries.length === 0) return [];

  // If there are multiple pages, group by page title
  const useGroups = pages.length > 1 && entries.some(e => e.pageref);

  if (useGroups) {
    // Build a folder per page
    const folderMap = new Map<string, CollectionItem>();
    const orphans: CollectionItem[] = [];

    for (const entry of entries) {
      const item = entryToItem(entry);
      const pageTitle = entry.pageref ? (pageMap.get(entry.pageref) ?? entry.pageref) : null;
      if (pageTitle) {
        if (!folderMap.has(pageTitle)) {
          folderMap.set(pageTitle, {
            id: generateId(),
            name: pageTitle,
            item: [],
          });
        }
        folderMap.get(pageTitle)!.item!.push(item);
      } else {
        orphans.push(item);
      }
    }

    return [...folderMap.values(), ...orphans];
  }

  return entries.map(entryToItem);
}

function entryToItem(entry: HarEntry): CollectionItem {
  const req = entry.request;
  const method = (req.method ?? 'GET').toUpperCase();
  const rawUrl = req.url ?? '';

  const headers: CollectionHeader[] = (req.headers ?? [])
    .filter(h => !SKIP_HEADERS.has(h.name.toLowerCase()))
    .map(h => ({ key: h.name, value: h.value }));

  const body = buildBody(req.postData);

  return {
    id: generateId(),
    name: entry.comment?.trim() || nameFromRequest(method, rawUrl),
    request: {
      method,
      url: { raw: rawUrl },
      header: headers,
      body,
    },
  };
}

// ─── HAR Export ───────────────────────────────────────────────────────────────

interface HarExportEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    cookies: [];
    headers: Array<{ name: string; value: string }>;
    queryString: Array<{ name: string; value: string }>;
    postData?: { mimeType: string; text?: string; params?: Array<{ name: string; value: string }> };
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: [];
    headers: [];
    content: { size: number; mimeType: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  comment?: string;
}

function collectionItemToHarEntry(item: CollectionItem): HarExportEntry | null {
  if (!item.request) return null;

  const req = item.request;
  const rawUrl = typeof req.url === 'string' ? req.url : (req.url?.raw ?? '');
  const method = (req.method ?? 'GET').toUpperCase();

  const headers: Array<{ name: string; value: string }> = (req.header ?? [])
    .filter(h => !h.disabled)
    .map(h => ({ name: h.key, value: h.value }));

  // Auth → header
  const auth = req.auth;
  if (auth?.type === 'bearer') {
    const token = auth.bearer?.find(b => b.key === 'token')?.value ?? '';
    if (token) headers.push({ name: 'Authorization', value: `Bearer ${token}` });
  } else if (auth?.type === 'basic') {
    const user = auth.basic?.find(b => b.key === 'username')?.value ?? '';
    const pass = auth.basic?.find(b => b.key === 'password')?.value ?? '';
    if (user || pass) {
      const encoded = btoa(`${user}:${pass}`);
      headers.push({ name: 'Authorization', value: `Basic ${encoded}` });
    }
  } else if (auth?.type === 'apikey') {
    const key = auth.apikey?.find(b => b.key === 'key')?.value ?? '';
    const value = auth.apikey?.find(b => b.key === 'value')?.value ?? '';
    const addTo = auth.apikey?.find(b => b.key === 'in')?.value ?? 'header';
    if (key && addTo === 'header') headers.push({ name: key, value });
  }

  // Query string from URL object
  const urlObj = typeof req.url === 'string' ? null : req.url;
  const queryString: Array<{ name: string; value: string }> = (urlObj?.query ?? [])
    .filter(q => !q.disabled)
    .map(q => ({ name: q.key, value: q.value }));

  // Body
  let postData: HarExportEntry['request']['postData'] | undefined;
  if (req.body && req.body.mode !== 'none') {
    if (req.body.mode === 'raw') {
      const lang = req.body.options?.raw?.language ?? 'text';
      const mimeMap: Record<string, string> = {
        json: 'application/json',
        xml: 'application/xml',
        html: 'text/html',
        javascript: 'application/javascript',
        text: 'text/plain',
      };
      postData = { mimeType: mimeMap[lang] ?? 'text/plain', text: req.body.raw ?? '' };
    } else if (req.body.mode === 'urlencoded') {
      postData = {
        mimeType: 'application/x-www-form-urlencoded',
        params: (req.body.urlencoded ?? [])
          .filter(p => !p.disabled)
          .map(p => ({ name: p.key, value: p.value })),
      };
    } else if (req.body.mode === 'formdata') {
      postData = {
        mimeType: 'multipart/form-data',
        params: (req.body.formdata ?? [])
          .filter(p => !p.disabled)
          .map(p => ({ name: p.key, value: p.value })),
      };
    } else if (req.body.mode === 'graphql') {
      const gql = req.body.graphql;
      postData = {
        mimeType: 'application/json',
        text: JSON.stringify({ query: gql?.query ?? '', variables: gql?.variables ? JSON.parse(gql.variables) : undefined }),
      };
    }
  }

  const hasBody = postData !== undefined;

  return {
    startedDateTime: new Date(0).toISOString(),
    time: 0,
    request: {
      method,
      url: rawUrl,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers,
      queryString,
      ...(hasBody ? { postData } : {}),
      headersSize: -1,
      bodySize: hasBody ? -1 : 0,
    },
    response: {
      status: 0,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      content: { size: 0, mimeType: 'text/plain' },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
    comment: item.name,
  };
}

function collectHarEntries(items: CollectionItem[], out: HarExportEntry[]): void {
  for (const item of items) {
    if (item.item) {
      collectHarEntries(item.item, out);
    } else {
      const entry = collectionItemToHarEntry(item);
      if (entry) out.push(entry);
    }
  }
}

/**
 * Generate a HAR file JSON string from an array of collection items.
 * Nested folders are traversed recursively and flattened into HAR entries.
 */
export function generateHarFromItems(items: CollectionItem[], collectionName = 'Export'): string {
  const entries: HarExportEntry[] = [];
  collectHarEntries(items, entries);

  const har = {
    log: {
      version: '1.2',
      creator: { name: 'Apilix', version: '1.0', comment: '' },
      pages: [
        {
          startedDateTime: new Date(0).toISOString(),
          id: 'page_1',
          title: collectionName,
          pageTimings: { onContentLoad: 0, onLoad: 0 },
        },
      ],
      entries: entries.map(e => ({ ...e, pageref: 'page_1' })),
    },
  };

  return JSON.stringify(har, null, 2);
}
