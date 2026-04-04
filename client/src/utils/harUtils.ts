// ─── HAR (HTTP Archive) Utilities ────────────────────────────────────────────
// Parses .har files (browser network captures) into Postman items.
// HAR spec: https://w3c.github.io/web-performance/specs/HAR/Overview.html

import { generateId } from '../store';
import type { PostmanItem, PostmanHeader, PostmanBody } from '../types';

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

function buildBody(postData: HarPostData | undefined): PostmanBody | undefined {
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
  items: PostmanItem[];
  /** Page-title based folder grouping. Key = folder name, value = items. */
  grouped: boolean;
}

/**
 * Parse the text content of a .har file and return Postman items.
 * Throws if the JSON is invalid or missing the required `log.entries` array.
 */
export function parseHarFile(text: string): PostmanItem[] {
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
    const folderMap = new Map<string, PostmanItem>();
    const orphans: PostmanItem[] = [];

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

function entryToItem(entry: HarEntry): PostmanItem {
  const req = entry.request;
  const method = (req.method ?? 'GET').toUpperCase();
  const rawUrl = req.url ?? '';

  const headers: PostmanHeader[] = (req.headers ?? [])
    .filter(h => !SKIP_HEADERS.has(h.name.toLowerCase()))
    .map(h => ({ key: h.name, value: h.value }));

  const body = buildBody(req.postData);

  return {
    id: generateId(),
    name: nameFromRequest(method, rawUrl),
    request: {
      method,
      url: { raw: rawUrl },
      header: headers,
      body,
    },
  };
}
