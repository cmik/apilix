// ─── HURL Utilities ──────────────────────────────────────────────────────────
// Supports parsing HURL files into Postman items and generating HURL from
// Postman request definitions.
// HURL format: https://hurl.dev/docs/hurl-file.html

import { generateId } from '../store';
import type { PostmanItem, PostmanHeader, PostmanQueryParam } from '../types';

// ─── Request params for HURL generation ──────────────────────────────────────
// Compatible with CodeGenParams in codeGen.ts — defined here to avoid circular deps.

export interface HurlRequestParams {
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

// ─── HTTP methods used to detect entry boundaries ────────────────────────────

export const HTTP_METHODS = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE',
  'HEAD', 'OPTIONS', 'CONNECT', 'TRACE',
]);

/** Regex that matches a line starting with an HTTP method followed by whitespace. */
export const HURL_METHOD_REGEX = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)\s/m;

function isMethodLine(line: string): boolean {
  const first = line.split(/\s+/)[0] ?? '';
  return HTTP_METHODS.has(first.toUpperCase()) && line.split(/\s+/).length >= 2;
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

// ─── Captures helpers ─────────────────────────────────────────────────────────

interface HurlCapture {
  varName: string;
  captureType: string;
  arg: string | null;
}

/**
 * Convert an array of HURL captures into a Postman test-script event that
 * calls `pm.environment.set()` for each captured variable.
 */
function capturesEventFromHurl(captures: HurlCapture[]): import('../types').PostmanEvent | null {
  if (captures.length === 0) return null;

  // Minimal JSONPath traversal for expressions like $.foo, $.items[0].name
  const jpHelper = [
    '  function _jp(obj, path) {',
    '    var segs = path.replace(/^\\$\\.?/, \'\').match(/[^.\\[\\]]+|\\[\\d+\\]/g) || [];',
    '    var cur = obj;',
    '    for (var i = 0; i < segs.length; i++) {',
    '      if (cur == null) return undefined;',
    '      var m = segs[i].match(/^\\[(\\d+)\\]$/);',
    '      cur = m ? cur[+m[1]] : cur[segs[i]];',
    '    }',
    '    return cur;',
    '  }',
  ];

  const scriptLines: string[] = [
    '// HURL captures — auto-generated',
    '(function () {',
    ...jpHelper,
  ];

  for (const cap of captures) {
    let expr: string | null = null;
    switch (cap.captureType) {
      case 'jsonpath':
        expr = `String(_jp(pm.response.json(), ${JSON.stringify(cap.arg)}))`;
        break;
      case 'header':
        expr = `String(pm.response.headers.get(${JSON.stringify(cap.arg)}))`;
        break;
      case 'status':
        expr = `String(pm.response.code)`;
        break;
      case 'body':
        expr = `pm.response.text()`;
        break;
      case 'regex':
        expr = `(function(){ var m = pm.response.text().match(new RegExp(${JSON.stringify(cap.arg)})); return m ? (m[1] !== undefined ? String(m[1]) : String(m[0])) : ''; })()`;
        break;
      default:
        // xpath, url, duration, sha256, md5, bytes, variable — not supported in sandbox
        expr = null;
    }

    scriptLines.push(`  try {`);
    if (expr) {
      scriptLines.push(`    pm.environment.set(${JSON.stringify(cap.varName)}, ${expr});`);
    } else {
      scriptLines.push(`    // capture type "${cap.captureType}" is not supported in Apilix scripts — skipped`);
    }
    scriptLines.push(`  } catch (_) {}`);
  }

  scriptLines.push('})();');

  return {
    listen: 'test',
    script: {
      type: 'text/javascript',
      exec: scriptLines,
    },
  };
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
  const captures: HurlCapture[] = [];
  const queryParams: PostmanQueryParam[] = [];
  let inBody = false;
  let inResponse = false;
  let currentSection: string | null = null;

  // Section markers in HURL
  // Both current short names ([Query], [Form], [Multipart]) and legacy names accepted
  const sectionMarkers = new Set([
    '[Query]', '[QueryStringParams]',
    '[Form]', '[FormParams]',
    '[Multipart]', '[MultipartFormData]',
    '[Cookies]', '[BasicAuth]', '[Options]', '[Asserts]', '[Captures]',
  ]);

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // Skip comment lines
    if (line.trimStart().startsWith('#')) continue;

    // Response line transitions to response section — do NOT break, captures come after it
    if (isResponseLine(line)) {
      inResponse = true;
      currentSection = null;
      continue;
    }

    // Section markers (e.g. [Asserts], [QueryStringParams], [Captures], etc.)
    const trimmed = line.trim();
    if (sectionMarkers.has(trimmed)) {
      currentSection = trimmed;
      inBody = false;
      continue;
    }

    // Parse [Query] / [QueryStringParams] section lines: "key: value"
    if (currentSection === '[Query]' || currentSection === '[QueryStringParams]') {
      if (trimmed !== '') {
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx > 0) {
          queryParams.push({
            key: trimmed.slice(0, colonIdx).trim(),
            value: trimmed.slice(colonIdx + 1).trim(),
          });
        }
      }
      continue;
    }

    // Parse [Captures] section lines: "varName: type" or "varName: type "arg""
    if (currentSection === '[Captures]') {
      if (trimmed !== '') {
        const captureMatch = trimmed.match(/^(\w+)\s*:\s*(\w+)(?:\s+"([^"]*)")?/);
        if (captureMatch) {
          captures.push({
            varName: captureMatch[1],
            captureType: captureMatch[2],
            arg: captureMatch[3] ?? null,
          });
        }
      }
      continue;
    }

    // Skip lines in other non-body/non-response sections, or plain response header lines
    if (currentSection !== null || inResponse) {
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
      bodyLines.push(raw);
    }
  }

  // Trim trailing empty lines from body
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') {
    bodyLines.pop();
  }

  const rawBody = bodyLines.join('\n');

  // Determine body mode and content type
  const contentType = headers.find(h => h.key.toLowerCase() === 'content-type')?.value ?? '';
  const bodyMode: 'raw' | 'none' = rawBody ? 'raw' : 'none';
  const bodyLang: string = contentType.includes('json')
    ? 'json'
    : contentType.includes('xml')
      ? 'xml'
      : contentType.includes('html')
        ? 'html'
        : 'text';

  const captureEvent = capturesEventFromHurl(captures);

  // Build the raw URL with query params appended
  let rawUrl = url;
  if (queryParams.length > 0) {
    const qs = queryParams.map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
    rawUrl = url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
  }

  const item: PostmanItem = {
    id: generateId(),
    name: `${method} ${rawUrl}`,
    request: {
      method,
      url: {
        raw: rawUrl,
        ...(queryParams.length > 0 ? { query: queryParams } : {}),
      },
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
    ...(captureEvent ? { event: [captureEvent] } : {}),
  };

  return item;
}

// ─── HURL Generator ──────────────────────────────────────────────────────────

/**
 * Generate a HURL entry string from HurlRequestParams (single request).
 */
export function generateHurlEntry(p: HurlRequestParams): string {
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
