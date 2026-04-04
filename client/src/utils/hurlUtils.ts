// ─── HURL Utilities ──────────────────────────────────────────────────────────
// Implements parsing (import) and generation (export) of the HURL file format.
// Spec reference: https://hurl.dev

import type { PostmanItem, PostmanHeader, PostmanBody } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE']);

function isRequestLine(line: string): boolean {
  const first = line.trimStart().split(/\s+/)[0]?.toUpperCase() ?? '';
  return HTTP_METHODS.has(first) && line.trimStart().split(/\s+/).length >= 2;
}

function isResponseLine(line: string): boolean {
  return /^HTTP(?:\/[\d.]+)?\s+[\d*]/.test(line.trim());
}

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : u.hostname;
  } catch {
    const parts = url.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : url;
  }
}

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Split raw HURL text into individual entry blocks.
 * Entries start with a request line (METHOD URL) and are delimited by
 * either a `###` separator or the start of the next request line.
 */
function splitEntries(text: string): string[][] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const entries: string[][] = [];
  let current: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Explicit `###` separator
    if (line.trimStart().startsWith('###')) {
      if (current.length > 0) {
        entries.push(current);
        current = [];
      }
      continue;
    }

    // Skip comment-only lines before the first entry has started
    if (current.length === 0 && (line.startsWith('#') || line.trim() === '')) {
      continue;
    }

    // A new request line starts a new entry (only after one has already started)
    if (current.length > 0 && isRequestLine(line)) {
      entries.push(current);
      current = [line];
      continue;
    }

    current.push(line);
  }

  if (current.length > 0) entries.push(current);
  return entries;
}

/**
 * Parse a single HURL entry (array of lines) into a PostmanItem.
 */
function parseEntry(lines: string[]): PostmanItem | null {
  // Trim trailing blank lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) return null;

  // ── Request line ──────────────────────────────────────────────────────────
  const requestLineIdx = lines.findIndex(l => isRequestLine(l));
  if (requestLineIdx === -1) return null;

  const requestParts = lines[requestLineIdx].trim().split(/\s+/);
  const method = requestParts[0].toUpperCase();
  let url = requestParts.slice(1).join(' ');
  let i = requestLineIdx + 1;

  // ── Sections ──────────────────────────────────────────────────────────────
  // HURL supports named sections like [QueryStringParams], [FormParams], etc.
  // We'll collect headers, detect sections, and capture the body.

  const headers: PostmanHeader[] = [];
  let bodyRaw = '';
  let bodyMode: 'raw' | 'urlencoded' | 'formdata' | 'none' = 'none';
  const urlEncoded: Array<{ key: string; value: string }> = [];
  const formData: Array<{ key: string; value: string }> = [];

  enum Phase { Headers, Body, Section, Response, Asserts }
  let phase: Phase = Phase.Headers;
  let currentSection = '';
  const bodyLines: string[] = [];

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    i++;

    // Skip inline comments
    if (trimmed.startsWith('#')) continue;

    // Response line → stop parsing request content
    if (isResponseLine(trimmed)) {
      phase = Phase.Response;
      break;
    }

    // Named section header e.g. [QueryStringParams], [FormParams], [MultipartFormData], [Asserts]
    if (/^\[.+\]$/.test(trimmed)) {
      currentSection = trimmed.slice(1, -1).toLowerCase();
      if (currentSection === 'asserts' || currentSection === 'captures') {
        phase = Phase.Asserts;
        break;
      }
      phase = Phase.Section;
      continue;
    }

    if (phase === Phase.Headers) {
      if (trimmed === '') {
        phase = Phase.Body;
        continue;
      }
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        headers.push({ key: trimmed.slice(0, colonIdx).trim(), value: trimmed.slice(colonIdx + 1).trim() });
      }
      continue;
    }

    if (phase === Phase.Body) {
      bodyLines.push(line);
      continue;
    }

    if (phase === Phase.Section) {
      if (trimmed === '') continue;
      // QueryStringParams / FormParams key: value pairs
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim();
        const value = trimmed.slice(colonIdx + 1).trim();
        if (currentSection === 'formparams' || currentSection === 'formdata') {
          urlEncoded.push({ key, value });
          bodyMode = 'urlencoded';
        } else if (currentSection === 'multipartformdata') {
          formData.push({ key, value });
          bodyMode = 'formdata';
        } else if (currentSection === 'querystringparams') {
          // Append query parameters to the URL string
          try {
            const parsedUrl = new URL(url);
            parsedUrl.searchParams.append(key, value);
            url = parsedUrl.toString();
          } catch {
            // non-parseable URL — fall back to manual concatenation
            const sep = url.includes('?') ? '&' : '?';
            url = `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
          }
        }
      }
      continue;
    }
  }

  // Finalise body
  if (bodyLines.length > 0) {
    bodyRaw = bodyLines.join('\n').trim();
    bodyMode = 'raw';
  }

  // Determine body language
  const contentTypeHeader = headers.find(h => h.key.toLowerCase() === 'content-type');
  const ct = contentTypeHeader?.value ?? '';
  let bodyLang: 'json' | 'xml' | 'html' | 'text' = 'text';
  if (ct.includes('json') || looksLikeJson(bodyRaw)) bodyLang = 'json';
  else if (ct.includes('xml')) bodyLang = 'xml';
  else if (ct.includes('html')) bodyLang = 'html';

  const body: PostmanBody | undefined =
    bodyMode === 'raw' && bodyRaw
      ? { mode: 'raw', raw: bodyRaw, options: { raw: { language: bodyLang } } }
      : bodyMode === 'urlencoded' && urlEncoded.length > 0
      ? { mode: 'urlencoded', urlencoded: urlEncoded }
      : bodyMode === 'formdata' && formData.length > 0
      ? { mode: 'formdata', formdata: formData }
      : undefined;

  const name = nameFromUrl(url) || `${method} ${url}`;

  return {
    id: generateId(),
    name,
    request: {
      method,
      url: { raw: url },
      header: headers,
      body,
    },
  };
}

/**
 * Parse a HURL file's text content and return a list of PostmanItems.
 * Throws with a human-readable message on parsing failure.
 */
export function parseHurlFile(text: string): PostmanItem[] {
  const entryBlocks = splitEntries(text);
  if (entryBlocks.length === 0) {
    throw new Error('No valid HURL entries found. A HURL file must contain at least one request (METHOD URL).');
  }

  const items: PostmanItem[] = [];
  const errors: string[] = [];

  entryBlocks.forEach((block, idx) => {
    try {
      const item = parseEntry([...block]);
      if (item) items.push(item);
    } catch (e) {
      errors.push(`Entry ${idx + 1}: ${(e as Error).message}`);
    }
  });

  if (items.length === 0) {
    const detail = errors.length > 0 ? ` Errors: ${errors.join('; ')}` : '';
    throw new Error(`Could not parse any requests from the HURL content.${detail}`);
  }

  return items;
}

// ─── Exporter ─────────────────────────────────────────────────────────────────

export interface HurlBuildParams {
  method: string;
  url: string;
  headers: Array<{ key: string; value: string; disabled?: boolean }>;
  bodyMode: string;
  bodyRaw: string;
  bodyFormData: Array<{ key: string; value: string; disabled?: boolean }>;
  bodyUrlEncoded: Array<{ key: string; value: string; disabled?: boolean }>;
  authType: string;
  authBearer: string;
  authBasicUser: string;
  authBasicPass: string;
  authApiKeyName: string;
  authApiKeyValue: string;
}

/**
 * Build a single HURL request block from the given parameters.
 */
export function buildHurlRequest(p: HurlBuildParams): string {
  const lines: string[] = [];

  // Request line
  lines.push(`${p.method} ${p.url}`);

  // Auth headers
  if (p.authType === 'bearer' && p.authBearer) {
    lines.push(`Authorization: Bearer ${p.authBearer}`);
  } else if (p.authType === 'basic' && (p.authBasicUser || p.authBasicPass)) {
    const encoded = btoa(`${p.authBasicUser}:${p.authBasicPass}`);
    lines.push(`Authorization: Basic ${encoded}`);
  } else if (p.authType === 'apikey' && p.authApiKeyName) {
    lines.push(`${p.authApiKeyName}: ${p.authApiKeyValue}`);
  }

  // Request headers
  for (const h of p.headers) {
    if (h.disabled || !h.key) continue;
    lines.push(`${h.key}: ${h.value}`);
  }

  // Body
  if (p.bodyMode === 'urlencoded' && p.bodyUrlEncoded.length > 0) {
    const active = p.bodyUrlEncoded.filter(e => !e.disabled && e.key);
    if (active.length > 0) {
      lines.push('');
      lines.push('[FormParams]');
      for (const e of active) {
        lines.push(`${e.key}: ${e.value}`);
      }
    }
  } else if (p.bodyMode === 'formdata' && p.bodyFormData.length > 0) {
    const active = p.bodyFormData.filter(f => !f.disabled && f.key);
    if (active.length > 0) {
      lines.push('');
      lines.push('[MultipartFormData]');
      for (const f of active) {
        lines.push(`${f.key}: ${f.value}`);
      }
    }
  } else if (p.bodyMode === 'raw' && p.bodyRaw) {
    lines.push('');
    lines.push(p.bodyRaw);
  }

  // Generic response assertion (any status)
  lines.push('');
  lines.push('HTTP *');

  return lines.join('\n');
}

/**
 * Convert a PostmanItem's request into HurlBuildParams suitable for buildHurlRequest.
 */
export function postmanItemToHurlParams(item: PostmanItem): HurlBuildParams | null {
  const req = item.request;
  if (!req) return null;

  const rawUrl = typeof req.url === 'string' ? req.url : (req.url?.raw ?? '');
  const headers = (req.header ?? []).map(h => ({ key: h.key, value: h.value, disabled: h.disabled }));

  const auth = req.auth;
  let authType = '';
  let authBearer = '';
  let authBasicUser = '';
  let authBasicPass = '';
  let authApiKeyName = '';
  let authApiKeyValue = '';

  if (auth) {
    authType = auth.type === 'noauth' || auth.type === 'inherit' ? '' : auth.type;
    if (auth.type === 'bearer') {
      authBearer = auth.bearer?.find(b => b.key === 'token')?.value ?? '';
    } else if (auth.type === 'basic') {
      authBasicUser = auth.basic?.find(b => b.key === 'username')?.value ?? '';
      authBasicPass = auth.basic?.find(b => b.key === 'password')?.value ?? '';
    } else if (auth.type === 'apikey') {
      authApiKeyName = auth.apikey?.find(b => b.key === 'key')?.value ?? '';
      authApiKeyValue = auth.apikey?.find(b => b.key === 'value')?.value ?? '';
    }
  }

  const body = req.body;
  const bodyMode = body?.mode ?? 'none';
  const bodyRaw = body?.raw ?? '';
  const bodyFormData = (body?.formdata ?? []).map(f => ({ key: f.key, value: f.value, disabled: f.disabled }));
  const bodyUrlEncoded = (body?.urlencoded ?? []).map(e => ({ key: e.key, value: e.value, disabled: e.disabled }));

  return {
    method: req.method,
    url: rawUrl,
    headers,
    bodyMode,
    bodyRaw,
    bodyFormData,
    bodyUrlEncoded,
    authType,
    authBearer,
    authBasicUser,
    authBasicPass,
    authApiKeyName,
    authApiKeyValue,
  };
}

/**
 * Build a full HURL file from a flat list of PostmanItems.
 * Items without a request (folders) are skipped.
 */
export function buildHurlCollection(items: PostmanItem[]): string {
  const blocks: string[] = [];

  function walk(list: PostmanItem[]) {
    for (const item of list) {
      if (item.request) {
        const params = postmanItemToHurlParams(item);
        if (params) {
          blocks.push(`# ${item.name}\n${buildHurlRequest(params)}`);
        }
      }
      if (item.item) {
        walk(item.item);
      }
    }
  }

  walk(items);
  return blocks.join('\n\n###\n\n');
}
