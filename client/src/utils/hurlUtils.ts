// ─── HURL Utilities ──────────────────────────────────────────────────────────
// Supports parsing HURL files into Postman items and generating HURL from
// Postman request definitions.
// HURL format: https://hurl.dev/docs/hurl-file.html

import { generateId } from '../store';
import type { PostmanItem, PostmanHeader } from '../types';
import type { CodeGenParams } from './codeGen';

// ─── HTTP methods used to detect entry boundaries ────────────────────────────

const HTTP_METHODS = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE',
  'HEAD', 'OPTIONS', 'CONNECT', 'TRACE',
]);

function isMethodLine(line: string): boolean {
  const first = line.split(/\s+/)[0]?.toUpperCase() ?? '';
  return HTTP_METHODS.has(first) && line.split(/\s+/).length >= 2;
}

function isResponseLine(line: string): boolean {
  return /^HTTP(?:\/[\d.]+)?\s+[\d*]/.test(line.trim());
}

// ─── HURL Parser ─────────────────────────────────────────────────────────────

/**
 * Parse a HURL file (one or more entries) into an array of PostmanItems.
 * Each HURL entry becomes one Postman request item.
 */
export function parseHurlFile(text: string): PostmanItem[] {
  const lines = text.split(/\r?\n/);
  const entries: PostmanItem[] = [];

  // Split file into entry blocks. A new entry starts with `METHOD URL`.
  const entryStartIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!line.startsWith('#') && isMethodLine(line)) {
      entryStartIndices.push(i);
    }
  }

  for (let e = 0; e < entryStartIndices.length; e++) {
    const startIdx = entryStartIndices[e];
    const endIdx = e + 1 < entryStartIndices.length ? entryStartIndices[e + 1] : lines.length;
    const entryLines = lines.slice(startIdx, endIdx);
    const item = parseHurlEntry(entryLines);
    if (item) entries.push(item);
  }

  return entries;
}

/** Parse a single HURL entry (lines from METHOD URL to start of next entry). */
function parseHurlEntry(lines: string[]): PostmanItem | null {
  if (lines.length === 0) return null;

  const firstLine = lines[0].trim();
  const parts = firstLine.split(/\s+/);
  if (parts.length < 2) return null;

  const method = parts[0].toUpperCase();
  const url = parts.slice(1).join(' ');

  const headers: PostmanHeader[] = [];
  const bodyLines: string[] = [];
  let inBody = false;
  let inResponse = false;

  // Section markers in HURL
  const sectionMarkers = new Set(['[QueryStringParams]', '[FormParams]', '[MultipartFormData]', '[Cookies]', '[Options]', '[Asserts]', '[Captures]']);

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // Skip comment lines
    if (line.trimStart().startsWith('#')) continue;

    // Response line ends the request section
    if (isResponseLine(line)) {
      inResponse = true;
      break;
    }

    // Section markers (e.g. [Asserts], [QueryStringParams], etc.)
    const trimmed = line.trim();
    if (sectionMarkers.has(trimmed)) {
      // Skip everything until response line for simplicity
      inBody = false;
      continue;
    }

    if (!inBody) {
      // An empty line transitions from headers to body
      if (trimmed === '') {
        inBody = true;
        continue;
      }

      // Try to parse as header: "Key: value"
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        // Heuristic: if the key contains spaces it's likely body text, not a header
        if (!key.includes(' ')) {
          headers.push({ key, value });
          continue;
        }
      }

      // If we couldn't parse as header, treat as start of body
      inBody = true;
      bodyLines.push(raw);
    } else {
      if (!inResponse) {
        bodyLines.push(raw);
      }
    }
  }

  // Trim trailing empty lines from body
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') {
    bodyLines.pop();
  }

  const rawBody = bodyLines.join('\n');

  // Determine body mode and content type
  const contentType = headers.find(h => h.key.toLowerCase() === 'content-type')?.value ?? '';
  let bodyMode: 'raw' | 'none' = rawBody ? 'raw' : 'none';
  const bodyLang: string = contentType.includes('json')
    ? 'json'
    : contentType.includes('xml')
      ? 'xml'
      : contentType.includes('html')
        ? 'html'
        : 'text';

  const item: PostmanItem = {
    id: generateId(),
    name: `${method} ${url}`,
    request: {
      method,
      url: { raw: url },
      header: headers,
      ...(bodyMode === 'raw' && rawBody
        ? {
            body: {
              mode: 'raw',
              raw: rawBody,
              options: { raw: { language: bodyLang as 'json' | 'xml' | 'html' | 'text' } },
            },
          }
        : {}),
    },
  };

  return item;
}

// ─── HURL Generator ──────────────────────────────────────────────────────────

/**
 * Generate a HURL entry string from CodeGenParams (single request).
 */
export function generateHurlEntry(p: CodeGenParams): string {
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

  // Headers
  for (const h of p.headers) {
    if (h.disabled || !h.key) continue;
    lines.push(`${h.key}: ${h.value}`);
  }

  // Body
  if (p.bodyMode === 'raw' && p.bodyRaw) {
    lines.push('');
    lines.push(p.bodyRaw);
  } else if (p.bodyMode === 'urlencoded' && p.bodyUrlEncoded.length > 0) {
    lines.push('[FormParams]');
    for (const e of p.bodyUrlEncoded) {
      if (!e.disabled && e.key) lines.push(`${e.key}: ${e.value}`);
    }
  } else if (p.bodyMode === 'formdata' && p.bodyFormData.length > 0) {
    lines.push('[MultipartFormData]');
    for (const f of p.bodyFormData) {
      if (!f.disabled && f.key) lines.push(`${f.key}: ${f.value}`);
    }
  }

  // Response assertion (wildcard — accepts any status)
  lines.push('');
  lines.push('HTTP *');

  return lines.join('\n');
}

/**
 * Generate a full HURL file from multiple Postman items (requests only, not folders).
 * Nested folders are traversed recursively.
 */
export function generateHurlFromItems(items: PostmanItem[]): string {
  const entries: string[] = [];
  collectHurlEntries(items, entries);
  return entries.join('\n\n');
}

function collectHurlEntries(items: PostmanItem[], out: string[]): void {
  for (const item of items) {
    if (Array.isArray(item.item)) {
      // Folder — recurse
      collectHurlEntries(item.item, out);
    } else if (item.request) {
      const req = item.request;
      const method = req.method?.toUpperCase() ?? 'GET';
      const url = typeof req.url === 'string' ? req.url : (req.url?.raw ?? '');
      const headers = req.header ?? [];
      const body = req.body;

      const lines: string[] = [];
      if (item.name && item.name !== `${method} ${url}`) {
        lines.push(`# ${item.name}`);
      }
      lines.push(`${method} ${url}`);

      for (const h of headers) {
        if (h.disabled || !h.key) continue;
        lines.push(`${h.key}: ${h.value}`);
      }

      if (body?.mode === 'raw' && body.raw) {
        lines.push('');
        lines.push(body.raw);
      } else if (body?.mode === 'urlencoded' && body.urlencoded?.length) {
        lines.push('[FormParams]');
        for (const e of body.urlencoded) {
          if (!e.disabled && e.key) lines.push(`${e.key}: ${e.value}`);
        }
      } else if (body?.mode === 'formdata' && body.formdata?.length) {
        lines.push('[MultipartFormData]');
        for (const f of body.formdata) {
          if (!f.disabled && f.key) lines.push(`${f.key}: ${f.value}`);
        }
      }

      lines.push('');
      lines.push('HTTP *');

      out.push(lines.join('\n'));
    }
  }
}
