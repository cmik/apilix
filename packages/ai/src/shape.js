'use strict';

/**
 * Shape-only mode (settings.sendResponseBodies = false): what leaves about headers when no values may.
 * Shared by every feature that sends a response (assert-suggest, explain-failure) and by the preview,
 * so the payload and the preview are built by the same code.
 */

const MAX_HEADERS = 25;
const MAX_HEADER_VALUE_CHARS = 150;
const MAX_REQUEST_BODY_CHARS = 800;
const MAX_URL_CHARS = 300;
const MAX_NAME_CHARS = 200;
const MAX_SHAPE_HEADER_NAMES = 50;

function clip(v, max) {
  const s = v === undefined || v === null ? '' : String(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Full-mode response headers: redacted by the caller, then bounded. */
function trimHeaders(headers) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(headers && typeof headers === 'object' ? headers : {})) {
    if (n++ >= MAX_HEADERS) break;
    out[clip(k, 100)] = clip(Array.isArray(v) ? v.join(', ') : v, MAX_HEADER_VALUE_CHARS);
  }
  return out;
}

function trimRequest(redacted, name) {
  const out = { name: clip(name, MAX_NAME_CHARS), method: redacted.method, url: clip(redacted.url, MAX_URL_CHARS) };
  if (Array.isArray(redacted.header)) {
    out.headers = redacted.header.filter(h => h && h.key && !h.disabled).slice(0, MAX_HEADERS).map(h => ({ key: clip(h.key, 100), value: clip(h.value, MAX_HEADER_VALUE_CHARS) }));
  }
  const b = redacted.body;
  if (b && b.mode === 'raw' && typeof b.raw === 'string') out.body = clip(b.raw, MAX_REQUEST_BODY_CHARS);
  else if (b && (b.mode === 'formdata' || b.mode === 'urlencoded')) {
    out.body = (b[b.mode] || []).slice(0, 20).map(p => ({ key: clip(p.key, 100) }));
  }
  return out;
}

/**
 * Shape-only header values that are protocol metadata and safe to send. Each sanitizer returns the
 * value to send, or '' to send the name only (a value that does not look as expected is never sent).
 */
const SAFE_HEADER_VALUES = {
  'content-type': v => {
    const [media, ...params] = v.split(';').map(x => x.trim());
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(media)) return '';
    const charset = params.find(p => /^charset=[\w.-]+$/i.test(p));
    return charset ? `${media}; ${charset}` : media;
  },
  'content-length': v => (/^\d{1,12}$/.test(v.trim()) ? v.trim() : ''),
  'content-encoding': v => (/^[\w, -]{1,40}$/.test(v) ? v.trim() : ''),
  'cache-control': v => (/^[\w=, -]{1,100}$/.test(v) ? v.trim() : ''),
  'www-authenticate': v => {
    const m = /^\s*([A-Za-z][\w-]{0,30})(?:\s|$)/.exec(v);
    return m ? m[1] : '';
  },
};

/** [name, value] pairs as they leave in shape-only mode: every name, values only for the allowlist. */
function shapeHeaders(pairs) {
  const names = [];
  const values = {};
  for (const [k, v] of pairs) {
    if (typeof k !== 'string' || !k) continue;
    if (names.length >= MAX_SHAPE_HEADER_NAMES) break;
    const name = clip(k, 100);
    names.push(name);
    const sanitize = SAFE_HEADER_VALUES[name.toLowerCase()];
    const raw = Array.isArray(v) ? v.join(', ') : v;
    const safe = sanitize && typeof raw === 'string' ? sanitize(raw) : '';
    if (safe) values[name] = safe;
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
  return shapeHeaders(Object.entries(headers && typeof headers === 'object' ? headers : {}));
}

/** The request as it leaves (already redacted); shape-only reduces its headers the same way. */
function prepareRequest(redReq, name, shapeOnly) {
  const out = trimRequest(redReq, name);
  if (shapeOnly && Array.isArray(redReq.header)) out.headers = shapeRequestHeaderList(redReq.header);
  return out;
}

module.exports = { clip, trimHeaders, trimRequest, shapeHeaders, shapeRequestHeaderList, prepareResponseHeaders, prepareRequest, SAFE_HEADER_VALUES };
