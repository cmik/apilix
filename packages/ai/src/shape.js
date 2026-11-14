'use strict';

/**
 * Shape-only mode (settings.sendResponseBodies = false): what leaves when no values may.
 * Shared by every feature that sends a request or response (assert-suggest, explain-failure,
 * doc-describe) and by the preview, so the payload and the preview are built by the same code.
 *
 * Everything that walks user-controlled objects here uses own keys only and writes with `setOwn`,
 * so a key such as `__proto__`, `constructor` or `toString` is plain data: it cannot throw, pollute
 * a prototype, or pick up an inherited member.
 */

const MAX_HEADERS = 25;
const MAX_HEADER_VALUE_CHARS = 150;
const MAX_REQUEST_BODY_CHARS = 800;
const MAX_URL_CHARS = 300;
const MAX_NAME_CHARS = 200;
const MAX_SHAPE_HEADER_NAMES = 50;
const MAX_SHAPE_KEYS = 50;
const MAX_MASK_INPUT_CHARS = 4000;
const MAX_TEST_TITLES = 50;
const MAX_TEST_TITLE_CHARS = 120;
const OTHER_NAME = '<other>';
const MAX_RESPONSE_TIME_MS = 600000;

function clip(v, max) {
  const s = v === undefined || v === null ? '' : String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Define an own enumerable data property, even for `__proto__` (a plain assignment would set the prototype). */
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  return obj;
}

/** Own enumerable [key, value] pairs of a plain object, or [] for anything else. */
function ownEntries(obj) {
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj).map(k => [k, obj[k]]) : [];
}

/** Observed latency in ms: a finite number in [0, 600000], rounded. Anything else is ignored (undefined). */
function normalizeLatency(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_RESPONSE_TIME_MS) return undefined;
  return Math.round(v);
}

/** Describe the structure of a JSON value: types only, never values. Object keys are capped. */
function buildShapeSchema(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (depth >= 6) return ['…'];
    return value.length ? [buildShapeSchema(value[0], depth + 1)] : [];
  }
  if (typeof value === 'object') {
    if (depth >= 6) return '{…}';
    const out = {};
    const keys = Object.keys(value);
    for (const k of keys.slice(0, MAX_SHAPE_KEYS)) setOwn(out, k, buildShapeSchema(value[k], depth + 1));
    if (keys.length > MAX_SHAPE_KEYS) setOwn(out, '…', '…');
    return out;
  }
  return typeof value;
}

/** Shape of a text body: types for JSON, `{ type: 'text', length }` for anything else. */
function shapeOfText(text) {
  const s = typeof text === 'string' ? text : '';
  try { return buildShapeSchema(JSON.parse(s)); } catch { return { type: 'text', length: s.length }; }
}

/**
 * Shape-only: a free-text field (request name, status text, assertion message) can carry real values
 * (`expected 'a@b.c' to equal 'x'`). Quoted strings, emails, URLs and numbers become placeholders; a quote
 * that is never closed hides everything after it. One linear pass over a bounded input.
 */
function maskLiterals(text) {
  if (typeof text !== 'string') return '';
  const src = text.length > MAX_MASK_INPUT_CHARS ? text.slice(0, MAX_MASK_INPUT_CHARS) : text;
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch !== "'" && ch !== '"' && ch !== '`') { out += ch; i++; continue; }
    let j = i + 1;
    let closed = false;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === ch) { closed = true; break; }
      j++;
    }
    out += '<string>';
    if (!closed) break;
    i = j + 1;
  }
  // Emails: a whitespace-delimited token with an '@' that has a character on both sides.
  out = out.split(/(\s+)/).map(tok => {
    const at = tok.indexOf('@', 1);
    return at !== -1 && at < tok.length - 1 && !/^\s/.test(tok) ? '<string>' : tok;
  }).join('');
  return out
    .replace(/https?:\/\/\S+/gi, '<string>')
    .replace(/-?\b\d+(?:\.\d+)?\b/g, '<number>');
}

/** A header / cookie / form-field / query-parameter name is sent only when it is a plain token that does not look like data. */
const SAFE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
function safeName(k) {
  const s = typeof k === 'string' ? k.trim() : '';
  if (!SAFE_NAME.test(s) || s.includes('@') || /\d{6,}/.test(s) || /[0-9a-f]{24,}/i.test(s)) return OTHER_NAME;
  return s;
}

/** Full-mode response headers: redacted by the caller, then bounded. */
function trimHeaders(headers) {
  const out = {};
  let n = 0;
  for (const [k, v] of ownEntries(headers)) {
    if (n++ >= MAX_HEADERS) break;
    setOwn(out, clip(k, 100), clip(Array.isArray(v) ? v.join(', ') : v, MAX_HEADER_VALUE_CHARS));
  }
  return out;
}

const ID_SEGMENT_HEX = /^[0-9a-f]{16,}$/i;
const ID_SEGMENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function looksLikeId(seg) {
  if (!seg || seg.includes('{{')) return false;
  if (/^\d+$/.test(seg) || ID_SEGMENT_UUID.test(seg) || ID_SEGMENT_HEX.test(seg)) return true;
  if (seg.includes('@') || /%40/i.test(seg)) return true;
  if (/\d{4,}/.test(seg)) return true;
  return seg.length >= 20 && /^[A-Za-z0-9_-]+$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg);
}

/**
 * Shape-only form of a request URL (already redacted): scheme, host and path stay; userinfo and fragment are
 * dropped, id-looking path segments become `:id`, and query parameters keep their names with `<value>`.
 */
function shapeUrl(url) {
  let s = typeof url === 'string' ? url : '';
  if (s.length > 4000) s = s.slice(0, 4000);
  const hash = s.indexOf('#');
  if (hash !== -1) s = s.slice(0, hash);
  const q = s.indexOf('?');
  const query = q === -1 ? '' : s.slice(q + 1);
  s = q === -1 ? s : s.slice(0, q);
  const schemeEnd = s.indexOf('://');
  const scheme = schemeEnd !== -1 && /^[A-Za-z][A-Za-z0-9+.-]*$/.test(s.slice(0, schemeEnd)) ? s.slice(0, schemeEnd + 3) : '';
  const rest = s.slice(scheme.length);
  const slash = rest.indexOf('/');
  let authority = slash === -1 ? rest : rest.slice(0, slash);
  const pathPart = slash === -1 ? '' : rest.slice(slash);
  const at = authority.lastIndexOf('@');
  if (at !== -1) authority = authority.slice(at + 1);
  const path = pathPart.split('/').map(seg => (looksLikeId(seg) ? ':id' : seg)).join('/');
  let out = `${scheme}${authority}${path}`;
  if (q !== -1) {
    const params = query.split('&').filter(Boolean).slice(0, 20).map(p => {
      const eq = p.indexOf('=');
      const name = safeName(eq === -1 ? p : p.slice(0, eq));
      return eq === -1 ? name : `${name}=<value>`;
    });
    out += `?${params.join('&')}`;
  }
  return out;
}

/** Shape-only form of a request body: structure for JSON, field names for forms, `{type:'text', length}` otherwise. */
function shapeRequestBody(b) {
  if (!b || typeof b !== 'object') return undefined;
  if (b.mode === 'raw' && typeof b.raw === 'string') return shapeOfText(b.raw);
  if (b.mode === 'formdata' || b.mode === 'urlencoded') {
    const names = [];
    for (const p of (Array.isArray(b[b.mode]) ? b[b.mode] : [])) {
      if (!p || typeof p !== 'object' || p.disabled || !p.key) continue;
      const n = safeName(p.key);
      if (!names.includes(n)) names.push(n);
      if (names.length >= 20) break;
    }
    return names;
  }
  return undefined;
}

function trimRequest(redacted, name, shapeOnly = false) {
  const out = shapeOnly
    ? {
      name: clip(maskLiterals(name), MAX_NAME_CHARS),
      method: /^[A-Za-z]{1,16}$/.test(String(redacted.method)) ? redacted.method : OTHER_NAME,
      url: clip(shapeUrl(redacted.url), MAX_URL_CHARS),
    }
    : { name: clip(name, MAX_NAME_CHARS), method: redacted.method, url: clip(redacted.url, MAX_URL_CHARS) };
  if (Array.isArray(redacted.header)) {
    out.headers = redacted.header.filter(h => h && h.key && !h.disabled).slice(0, MAX_HEADERS).map(h => ({ key: clip(h.key, 100), value: clip(h.value, MAX_HEADER_VALUE_CHARS) }));
  }
  const b = redacted.body;
  if (shapeOnly) {
    const shape = shapeRequestBody(b);
    if (shape !== undefined) out.body = shape;
  } else if (b && b.mode === 'raw' && typeof b.raw === 'string') out.body = clip(b.raw, MAX_REQUEST_BODY_CHARS);
  else if (b && (b.mode === 'formdata' || b.mode === 'urlencoded')) {
    out.body = (b[b.mode] || []).slice(0, 20).map(p => ({ key: clip(p.key, 100) }));
  }
  return out;
}

/**
 * Shape-only header values that are protocol metadata and safe to send. Each sanitizer returns the
 * value to send, or '' to send the name only (a value that does not look as expected is never sent).
 * Null-prototype table, looked up with Object.hasOwn: a header called `constructor` finds nothing.
 */
const CACHE_DIRECTIVE = /^(?:no-cache|no-store|no-transform|public|private|must-revalidate|proxy-revalidate|immutable|max-age=\d{1,10}|s-maxage=\d{1,10}|stale-while-revalidate=\d{1,10}|stale-if-error=\d{1,10})$/i;
const CONTENT_CODING = /^(?:gzip|deflate|br|zstd|compress|identity)$/i;
const SAFE_HEADER_VALUES = Object.assign(Object.create(null), {
  'content-type': v => {
    const [media, ...params] = v.split(';').map(x => x.trim());
    if (media.length > 100 || !/^[\w.+-]+\/[\w.+-]+$/.test(media)) return '';
    const charset = params.find(p => /^charset=[\w.-]{1,40}$/i.test(p));
    return charset ? `${media}; ${charset}` : media;
  },
  'content-length': v => (/^\d{1,12}$/.test(v.trim()) ? v.trim() : ''),
  'content-encoding': v => v.split(',').map(x => x.trim()).filter(x => CONTENT_CODING.test(x)).join(', '),
  'cache-control': v => v.split(',').map(x => x.trim()).filter(x => CACHE_DIRECTIVE.test(x)).join(', '),
  'www-authenticate': v => {
    const m = /^\s*([A-Za-z][\w-]{0,30})(?:\s|$)/.exec(v);
    return m ? m[1] : '';
  },
});

/**
 * [name, value] pairs as they leave in shape-only mode: every distinct name (case-insensitive, first wins),
 * values only for the allowlist. A name that is not a plain token is replaced by `<other>`, once.
 */
function shapeHeaders(pairs) {
  const names = [];
  const values = {};
  const seen = new Set();
  for (const [k, v] of pairs) {
    if (typeof k !== 'string' || !k) continue;
    const name = safeName(k);
    const id = name.toLowerCase();
    if (seen.has(id)) continue;
    if (names.length >= MAX_SHAPE_HEADER_NAMES) break;
    seen.add(id);
    names.push(name);
    if (name === OTHER_NAME || !Object.hasOwn(SAFE_HEADER_VALUES, id)) continue;
    const sanitize = SAFE_HEADER_VALUES[id];
    const raw = Array.isArray(v) ? v.join(', ') : v;
    const safe = typeof sanitize === 'function' && typeof raw === 'string' ? sanitize(raw) : '';
    if (safe) setOwn(values, name, safe);
  }
  return { names, values };
}

/** Shape-only form of a Postman request header list (enabled headers only). */
function shapeRequestHeaderList(list) {
  return shapeHeaders((Array.isArray(list) ? list : []).filter(h => h && h.key && !h.disabled).map(h => [h.key, h.value]));
}

/** Response headers as they leave (already redacted): trimmed in full mode, names + allowlist in shape-only. */
function prepareResponseHeaders(headers, shapeOnly) {
  if (!shapeOnly) return trimHeaders(headers);
  return shapeHeaders(ownEntries(headers));
}

/** The request as it leaves (already redacted); shape-only reduces URL, headers, body and name to structure. */
function prepareRequest(redReq, name, shapeOnly) {
  const out = trimRequest(redReq, name, shapeOnly);
  if (shapeOnly && Array.isArray(redReq.header)) out.headers = shapeRequestHeaderList(redReq.header);
  return out;
}

/** Response status, status text and headers as they leave, plus the latency when it is a sane number. */
function prepareResponseHead(redRes, rawResponse, shapeOnly) {
  const head = {
    status: redRes.status,
    statusText: clip(shapeOnly ? maskLiterals(redRes.statusText) : redRes.statusText, 80),
    headers: prepareResponseHeaders(redRes.headers, shapeOnly),
  };
  const latency = normalizeLatency(rawResponse && rawResponse.responseTime);
  if (latency !== undefined) head.responseTimeMs = latency;
  return head;
}

/** Titles of the `apx.test("...")` / `pm.test("...")` calls in a script: the only thing shape-only sends of existing tests. */
function extractTestTitles(script) {
  const src = typeof script === 'string' ? script : '';
  const titles = [];
  for (const prefix of ['apx.test(', 'pm.test(']) {
    let from = 0;
    for (;;) {
      const at = src.indexOf(prefix, from);
      if (at === -1) break;
      let i = at + prefix.length;
      from = i;
      while (i < src.length && /\s/.test(src[i])) i++;
      const q = src[i];
      if (q !== "'" && q !== '"' && q !== '`') continue;
      let j = i + 1;
      let title = '';
      while (j < src.length && src[j] !== q && title.length < 400) {
        if (src[j] === '\\') j++;
        else title += src[j];
        j++;
      }
      if (src[j] === q) titles.push({ at, title });
    }
  }
  return titles.sort((a, b) => a.at - b.at).slice(0, MAX_TEST_TITLES).map(t => clip(maskLiterals(t.title), MAX_TEST_TITLE_CHARS));
}

/** Existing tests as they leave: the (clipped) redacted script in full mode, masked titles only in shape-only. */
function prepareExistingTests(redactedScript, shapeOnly, maxChars) {
  if (shapeOnly) return { existingTestTitles: extractTestTitles(redactedScript) };
  return { existingTests: clip(redactedScript, maxChars) };
}

module.exports = {
  clip, setOwn, ownEntries, normalizeLatency, buildShapeSchema, shapeOfText, maskLiterals, safeName, shapeUrl,
  shapeRequestBody, trimHeaders, trimRequest, shapeHeaders, shapeRequestHeaderList, prepareResponseHeaders,
  prepareRequest, prepareResponseHead, extractTestTitles, prepareExistingTests, SAFE_HEADER_VALUES,
};
