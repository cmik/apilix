// ─── HURL Utilities ──────────────────────────────────────────────────────────
// Supports parsing HURL files into collection items and generating HURL from
// request definitions.
// HURL format: https://hurl.dev/docs/hurl-file.html

import { generateId } from '../store';
import type { CollectionItem, CollectionHeader, CollectionQueryParam } from '../types';

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
  bodyGraphqlQuery: string;
  bodyGraphqlVariables: string;
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
 * Parse a HURL file (one or more entries) into an array of collection items.
 * Each HURL entry becomes one request item.
 */
export function parseHurlFile(text: string): CollectionItem[] {
  const lines = text.split(/\r?\n/);
  const entries: CollectionItem[] = [];

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

interface HurlAssert {
  raw: string;
}

// ─── Assert helpers ───────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseHurlPredicateValue(v: string): string {
  v = v.trim();
  if (v.startsWith('"') && v.endsWith('"')) return JSON.stringify(v.slice(1, -1));
  if (v === 'true' || v === 'false' || v === 'null') return v;
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  return JSON.stringify(v);
}

/** Map a HURL query keyword + optional arg to a JS expression string. */
function hurlQueryToJsExpr(queryType: string, arg: string | null): string | null {
  switch (queryType) {
    case 'status':   return 'apx.response.code';
    case 'body':     return 'apx.response.text()';
    case 'duration': return 'apx.response.responseTime';
    case 'header':   return arg ? `apx.response.headers.get(${JSON.stringify(arg)})` : null;
    case 'jsonpath': return arg ? `_jp(apx.response.json(), ${JSON.stringify(arg)})` : null;
    case 'xpath':    return arg ? `_xp(apx.response.text(), ${JSON.stringify(arg)})` : null;
    default:         return null; // version, url, ip, cookie, regex, variable, bytes, sha256, md5
  }
}

/** Convert a single HURL assert line to an apx.test() call string, or a comment if unsupported. */
function hurlAssertToPmTest(raw: string): string {
  const line = raw.trim();

  let queryExpr: string | null = null;
  let predStr = '';

  // Queries with a quoted string arg: header "X-Foo", jsonpath "$.x", xpath, regex, cookie, variable
  const argQueryRe = /^(header|cookie|jsonpath|xpath|regex|variable)\s+"([^"]*)"\s+(.+)$/;
  // Queries with no args: status, body, duration, version, url, ip, bytes, sha256, md5
  const noArgQueryRe = /^(status|body|duration|version|url|ip|bytes|sha256|md5)\s+(.+)$/;

  const argMatch = line.match(argQueryRe);
  const noArgMatch = line.match(noArgQueryRe);

  if (argMatch) {
    queryExpr = hurlQueryToJsExpr(argMatch[1], argMatch[2]);
    predStr = argMatch[3];
  } else if (noArgMatch) {
    queryExpr = hurlQueryToJsExpr(noArgMatch[1], null);
    predStr = noArgMatch[2];
  } else {
    return `// assert not translatable: ${line}`;
  }

  if (!queryExpr) {
    return `// assert type not supported in Apilix: ${line}`;
  }

  // Negation prefix (e.g. "not contains")
  predStr = predStr.trim();
  const negated = /^not\s+/.test(predStr);
  if (negated) predStr = predStr.replace(/^not\s+/, '').trim();
  const pfx = negated ? '.to.not' : '.to';

  // Match predicate operators
  const eqM     = predStr.match(/^==\s+(.+)$/);
  const neqM    = predStr.match(/^!=\s+(.+)$/);
  const gtEqM   = predStr.match(/^>=\s+(-?\d+(?:\.\d+)?)$/);
  const ltEqM   = predStr.match(/^<=\s+(-?\d+(?:\.\d+)?)$/);
  const gtM     = predStr.match(/^>\s+(-?\d+(?:\.\d+)?)$/);
  const ltM     = predStr.match(/^<\s+(-?\d+(?:\.\d+)?)$/);
  const contM   = predStr.match(/^contains\s+"([^"]*)"$/);
  const startM  = predStr.match(/^startsWith\s+"([^"]*)"$/);
  const endM    = predStr.match(/^endsWith\s+"([^"]*)"$/);
  const matchM  = predStr.match(/^matches\s+"([^"]*)"$/) ?? predStr.match(/^matches\s+\/([^/]*)\/$/);

  let chainSuffix: string | null = null;

  if (eqM)    chainSuffix = `${pfx}.equal(${parseHurlPredicateValue(eqM[1])})`;
  else if (neqM)   chainSuffix = `.to.not.equal(${parseHurlPredicateValue(neqM[1])})`;
  else if (gtEqM)  chainSuffix = `${pfx}.least(${gtEqM[1]})`;
  else if (ltEqM)  chainSuffix = `${pfx}.most(${ltEqM[1]})`;
  else if (gtM)    chainSuffix = `${pfx}.above(${gtM[1]})`;
  else if (ltM)    chainSuffix = `${pfx}.below(${ltM[1]})`;
  else if (contM)  chainSuffix = `${pfx}.include(${JSON.stringify(contM[1])})`;
  else if (startM) chainSuffix = `${pfx}.match(new RegExp('^' + ${JSON.stringify(escapeRegex(startM[1]))}))`;
  else if (endM)   chainSuffix = `${pfx}.match(new RegExp(${JSON.stringify(escapeRegex(endM[1]))} + '$'))`;
  else if (matchM) chainSuffix = `${pfx}.match(new RegExp(${JSON.stringify(matchM[1])}))`;
  else if (predStr === 'exists')      chainSuffix = `${pfx}.exist`;
  else if (predStr === 'isBoolean')   chainSuffix = `${pfx}.be.a('boolean')`;
  else if (predStr === 'isFloat' || predStr === 'isInteger') chainSuffix = `${pfx}.be.a('number')`;
  else if (predStr === 'isString')    chainSuffix = `${pfx}.be.a('string')`;
  else if (predStr === 'isCollection') chainSuffix = `${pfx}.be.an('array')`;
  else if (predStr === 'isEmpty')     chainSuffix = `${pfx}.be.empty`;

  if (!chainSuffix) return `// predicate not supported in Apilix: ${line}`;

  return `apx.test(${JSON.stringify(line)}, function() { apx.expect(${queryExpr})${chainSuffix}; });`;
}

// ─── Combined test event builder ─────────────────────────────────────────────

/**
 * Merge HURL captures (→ apx.environment.set) and asserts (→ apx.test) into a
 * single Apilix "test" event script.
 */
function buildTestEvent(
  captures: HurlCapture[],
  asserts: HurlAssert[],
): import('../types').CollectionEvent | null {
  if (captures.length === 0 && asserts.length === 0) return null;

  const needsJp = captures.some(c => c.captureType === 'jsonpath')
    || asserts.some(a => /^jsonpath\s+/.test(a.raw.trim()));

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

  const scriptLines: string[] = ['(function () {'];
  if (needsJp) scriptLines.push(...jpHelper);
  // _xp is provided by the sandbox runtime (xpath + @xmldom/xmldom)

  // Captures → apx.environment.set()
  if (captures.length > 0) {
    scriptLines.push('  // captures');
    for (const cap of captures) {
      let expr: string | null = null;
      switch (cap.captureType) {
        case 'jsonpath': expr = `String(_jp(apx.response.json(), ${JSON.stringify(cap.arg)}))`; break;
        case 'xpath':    expr = `String(_xp(apx.response.text(), ${JSON.stringify(cap.arg)}))`; break;
        case 'header':   expr = `String(apx.response.headers.get(${JSON.stringify(cap.arg)}))`; break;
        case 'status':   expr = `String(apx.response.code)`; break;
        case 'body':     expr = `apx.response.text()`; break;
        case 'regex':    expr = `(function(){ var m = apx.response.text().match(new RegExp(${JSON.stringify(cap.arg)})); return m ? (m[1] !== undefined ? String(m[1]) : String(m[0])) : ''; })()`;  break;
        default:         expr = null; break;
      }
      scriptLines.push(`  try {`);
      if (expr) {
        scriptLines.push(`    apx.environment.set(${JSON.stringify(cap.varName)}, ${expr});`);
      } else {
        scriptLines.push(`    // capture type "${cap.captureType}" not supported — skipped`);
      }
      scriptLines.push(`  } catch (_) {}`);
    }
  }

  // Asserts → apx.test()
  if (asserts.length > 0) {
    scriptLines.push('  // asserts');
    for (const a of asserts) {
      scriptLines.push('  ' + hurlAssertToPmTest(a.raw));
    }
  }

  scriptLines.push('})();');

  return {
    listen: 'test',
    script: { type: 'text/javascript', exec: scriptLines },
  };
}

/** Parse a single HURL entry (lines from METHOD URL to start of next entry). */
function parseHurlEntry(lines: string[]): CollectionItem | null {
  if (lines.length === 0) return null;

  const firstLine = lines[0].trim();
  const parts = firstLine.split(/\s+/);
  if (parts.length < 2) return null;

  const method = parts[0].toUpperCase();
  const url = parts.slice(1).join(' ');

  const headers: CollectionHeader[] = [];
  const bodyLines: string[] = [];
  const captures: HurlCapture[] = [];
  const asserts: HurlAssert[] = [];
  const queryParams: CollectionQueryParam[] = [];
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

    // Response line transitions to response section — do NOT break, captures/asserts come after it
    if (isResponseLine(line)) {
      inResponse = true;
      currentSection = null;
      // Extract the expected status code and add it as an implicit assert
      const statusCapture = line.trim().match(/^HTTP(?:\/[\d.]+)?\s+(\d+)/);
      if (statusCapture) {
        asserts.unshift({ raw: `status == ${statusCapture[1]}` });
      }
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

    // Parse [Asserts] section lines
    if (currentSection === '[Asserts]') {
      if (trimmed !== '') asserts.push({ raw: trimmed });
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

  // Detect graphql multiline body (```graphql ... ```)
  const graphqlFenceMatch = rawBody.match(/^```graphql\n([\s\S]*?)(?:\nvariables\s*\{([\s\S]*?)\})?\n```\s*$/);

  const testEvent = buildTestEvent(captures, asserts);

  // Build the raw URL with query params appended
  let rawUrl = url;
  if (queryParams.length > 0) {
    const qs = queryParams.map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
    rawUrl = url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
  }

  let bodyDef: import('../types').CollectionBody | undefined;

  if (graphqlFenceMatch) {
    const gqlQuery = graphqlFenceMatch[1] ?? '';
    const gqlVars = graphqlFenceMatch[2]?.trim() ?? '';
    bodyDef = {
      mode: 'graphql',
      graphql: { query: gqlQuery, ...(gqlVars ? { variables: gqlVars } : {}) },
    };
  } else {
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
    bodyDef = bodyMode === 'raw' && rawBody
      ? { mode: 'raw', raw: rawBody, options: { raw: { language: bodyLang as 'json' | 'xml' | 'html' | 'text' } } }
      : undefined;
  }

  const item: CollectionItem = {
    id: generateId(),
    name: `${method} ${rawUrl}`,
    request: {
      method,
      url: {
        raw: rawUrl,
        ...(queryParams.length > 0 ? { query: queryParams } : {}),
      },
      header: headers,
      ...(bodyDef ? { body: bodyDef } : {}),
    },
    ...(testEvent ? { event: [testEvent] } : {}),
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
  } else if (p.bodyMode === 'graphql' && p.bodyGraphqlQuery) {
    lines.push('');
    lines.push('```graphql');
    lines.push(p.bodyGraphqlQuery);
    if (p.bodyGraphqlVariables) {
      lines.push('variables {');
      lines.push(p.bodyGraphqlVariables);
      lines.push('}');
    }
    lines.push('```');
  }

  // Response assertion (wildcard — accepts any status)
  lines.push('');
  lines.push('HTTP *');

  return lines.join('\n');
}

/**
 * Generate a full HURL file from multiple collection items (requests only, not folders).
 * Nested folders are traversed recursively.
 */
export function generateHurlFromItems(items: CollectionItem[]): string {
  const entries: string[] = [];
  collectHurlEntries(items, entries);
  return entries.join('\n\n');
}

/**
 * Check whether a string looks like a valid HURL assert line
 * (i.e. it was originally produced by hurlAssertToPmTest and stored as the apx.test name).
 */
function isHurlAssertLine(line: string): boolean {
  const t = line.trim();
  const argQuery   = /^(header|cookie|jsonpath|xpath|regex|variable)\s+"[^"]*"\s+.+/;
  const noArgQuery = /^(status|body|duration|version|url|ip|bytes|sha256|md5)\s+.+/;
  return argQuery.test(t) || noArgQuery.test(t);
}

/**
 * Extract HURL assert strings that were embedded as apx.test() / pm.test() names when the
 * HURL file was originally imported (see hurlAssertToPmTest).
 */
function extractHurlAssertsFromScript(execLines: string[]): string[] {
  const script = execLines.join('\n');
  const asserts: string[] = [];
  // Match both apx.test(...) and pm.test(...) for backward compatibility with older scripts
  const re = /(?:apx|pm)\.test\(("(?:[^"\\]|\\.)*"),/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    try {
      const name = JSON.parse(m[1]) as string;
      if (isHurlAssertLine(name)) asserts.push(name);
    } catch {
      // skip malformed
    }
  }
  return asserts;
}

function collectHurlEntries(items: CollectionItem[], out: string[]): void {
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
      } else if (body?.mode === 'graphql' && body.graphql?.query) {
        lines.push('');
        lines.push('```graphql');
        lines.push(body.graphql.query);
        if (body.graphql.variables) {
          lines.push('variables {');
          lines.push(body.graphql.variables);
          lines.push('}');
        }
        lines.push('```');
      }

      // Extract assertions from the item's test event script
      const testEvent = item.event?.find(e => e.listen === 'test');
      const execLines: string[] = Array.isArray(testEvent?.script?.exec)
        ? (testEvent!.script.exec as string[])
        : (testEvent?.script?.exec ? (testEvent.script.exec as string).split('\n') : []);
      const hurlAsserts = extractHurlAssertsFromScript(execLines);

      // Use the status assert to produce a concrete HTTP status line when possible
      const statusAssert = hurlAsserts.find(a => /^status\s*==\s*\d+$/.test(a.trim()));
      const statusCode   = statusAssert?.match(/^status\s*==\s*(\d+)/)?.[1];

      lines.push('');
      lines.push(statusCode ? `HTTP ${statusCode}` : 'HTTP *');

      // Remaining asserts go into the [Asserts] section
      const otherAsserts = statusCode
        ? hurlAsserts.filter(a => a !== statusAssert)
        : hurlAsserts;
      if (otherAsserts.length > 0) {
        lines.push('[Asserts]');
        for (const a of otherAsserts) {
          lines.push(a);
        }
      }

      out.push(lines.join('\n'));
    }
  }
}
