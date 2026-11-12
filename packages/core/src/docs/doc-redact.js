'use strict';

/**
 * Deny-by-default credential redaction for documentation export.
 * Pure functions, no I/O. {{variable}} references are always preserved.
 */

const REDACTED = '<redacted>';
const VAR_REF = /\{\{[^{}]+\}\}/g;

// Substring patterns: distinctive enough that false positives are unlikely.
const SENSITIVE_SUBSTR = /(token|secret|passw(or)?d|passwd|pwd|api[-_ ]?key|apikey|signature|credential|private[-_ ]?key|access[-_ ]?key|session|cookie|bearer|jwt|csrf|xsrf|authoriz|authentic|oauth)/i;
// Whole-word patterns: matched only as a complete word after splitting on
// separators and camelCase, so "passenger", "bypass", "compass", "authors" and
// "monkey" are NOT flagged while "pass", "user_pass", "userPw", "auth" are.
const SENSITIVE_WORDS = new Set(['pass', 'pw', 'pwd', 'passwd', 'auth', 'sig', 'key', 'code', 'pin']);

const SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'api-key', 'apikey', 'x-auth-token', 'x-access-token',
  'x-csrf-token', 'x-xsrf-token',
]);

/** True when the name looks like it carries a credential. */
function isSensitiveName(name) {
  if (typeof name !== 'string' || !name) return false;
  if (SENSITIVE_SUBSTR.test(name)) return true;
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.some(w => SENSITIVE_WORDS.has(w.toLowerCase()));
}

function isSensitiveHeader(name) {
  if (typeof name !== 'string') return false;
  return SENSITIVE_HEADERS.has(name.trim().toLowerCase()) || isSensitiveName(name);
}

/**
 * True when the value is only variable references (optionally behind a
 * Bearer/Basic/Token scheme word) and so contains no literal credential.
 */
function isVarRefOnly(value) {
  if (typeof value !== 'string' || !value.includes('{{')) return false;
  const rest = value.replace(VAR_REF, '').trim();
  return /^(bearer|basic|token|digest)?\s*$/i.test(rest);
}

/** Redact a credential value. Variable references survive; literals do not. */
function redactValue(value, includeCredentials) {
  if (value === undefined || value === null || value === '') return '';
  const str = String(value);
  if (includeCredentials) return str;
  if (isVarRefOnly(str)) return str;
  return REDACTED;
}

/** Redact a value only when its name is sensitive. */
function redactByName(name, value, includeCredentials) {
  if (includeCredentials || !isSensitiveName(name)) return value;
  return redactValue(value, false);
}

function redactHeaderValue(name, value, includeCredentials) {
  if (includeCredentials || !isSensitiveHeader(name)) return value;
  return redactValue(value, false);
}

const SCHEME_AUTH = /^([a-z][a-z0-9+.-]*:\/\/)/i;

function isVarOnlyUserinfo(info) {
  return info.includes('{{') && info.replace(VAR_REF, '').replace(/:/g, '').trim() === '';
}

/**
 * Strip user:pass@ from a URL string. The userinfo ends at the LAST '@' before
 * the first '?' or '#' (passwords may contain '/' and '@'). A prefix that
 * contains '/' only counts as userinfo when a ':' precedes the first '/'.
 */
function redactUrlUserinfo(url, includeCredentials) {
  if (includeCredentials || typeof url !== 'string') return url;
  const sm = url.match(SCHEME_AUTH);
  const scheme = sm ? sm[1] : '';
  const rest = url.slice(scheme.length);
  const end = rest.search(/[?#]/);
  const seg = end >= 0 ? rest.slice(0, end) : rest;
  const at = seg.lastIndexOf('@');
  if (at < 0) return url;
  const info = seg.slice(0, at);
  const slash = info.indexOf('/');
  const colon = info.indexOf(':');
  if (slash >= 0 && !(colon >= 0 && colon < slash)) return url;
  // Scheme-less text is only treated as userinfo in the explicit user:pass@host form.
  if (!scheme && (colon < 0 || /\s/.test(info) || /^mailto:/i.test(info))) return url;
  if (!info || isVarOnlyUserinfo(info)) return url;
  return `${scheme}${REDACTED}${url.slice(scheme.length + at)}`;
}

function safeDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

function redactPairs(str) {
  return str.split('&').map(pair => {
    const i = pair.indexOf('=');
    if (i < 0) return pair;
    const key = pair.slice(0, i);
    const val = pair.slice(i + 1);
    if (!isSensitiveName(safeDecode(key)) || val === '' || isVarRefOnly(val)) return pair;
    return `${key}=${REDACTED}`;
  }).join('&');
}

/** Redact sensitive query/fragment parameter values in a URL-ish string. */
function redactUrlQuery(url, includeCredentials) {
  if (includeCredentials || typeof url !== 'string') return url;
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  if (q < 0 && h < 0) return url;
  let head = url;
  let query = '';
  let frag = '';
  let hasFrag = false;
  if (h >= 0) { frag = url.slice(h + 1); head = url.slice(0, h); hasFrag = true; }
  const q2 = head.indexOf('?');
  if (q2 >= 0) { query = head.slice(q2 + 1); head = head.slice(0, q2); }
  let out = head;
  if (q2 >= 0) out += `?${redactPairs(query)}`;
  if (hasFrag) out += `#${frag.includes('=') ? redactPairs(frag) : frag}`;
  return out;
}

/** Userinfo + sensitive query params, applied to one URL. */
function redactUrl(url, includeCredentials) {
  if (includeCredentials || typeof url !== 'string') return url;
  return redactUrlQuery(redactUrlUserinfo(url, false), false);
}

/**
 * Scrub URLs inside an arbitrary string (e.g. a Location or Link header value):
 * every scheme URL is redacted individually; otherwise the whole value is.
 */
function redactUrlsInText(text, includeCredentials) {
  if (includeCredentials || typeof text !== 'string' || text === '') return text;
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"',;]+/gi, m => redactUrl(m, false));
  }
  return redactUrl(text, false);
}

function redactJsonValue(node, includeCredentials, forced = false) {
  if (includeCredentials) return node;
  if (Array.isArray(node)) return node.map(n => redactJsonValue(n, false, forced));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = redactJsonValue(v, false, forced || isSensitiveName(k));
    return out;
  }
  if (forced && node !== null && node !== '') return redactValue(node, false);
  return node;
}

const NUM_BASE = 917000000000000;

/** Replace {{var}} with parse-safe placeholders (string-safe inside strings, numeric outside). */
function maskVars(text) {
  const vars = [];
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') { out += c + (text[i + 1] ?? ''); i++; continue; }
      if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    }
    if (c === '{' && text[i + 1] === '{') {
      const m = text.slice(i).match(/^\{\{[^{}]+\}\}/);
      if (m) {
        vars.push(m[0]);
        out += inStr ? `__APXVAR${vars.length - 1}__` : String(NUM_BASE + vars.length - 1);
        i += m[0].length - 1;
        continue;
      }
    }
    out += c;
  }
  return { masked: out, vars };
}

function restoreVars(text, vars) {
  return text
    .replace(/__APXVAR(\d+)__/g, (m, n) => vars[Number(n)] ?? m)
    .replace(/\b9170000000\d{5}\b/g, m => vars[Number(m) - NUM_BASE] ?? m);
}

const STR = '"(?:[^"\\\\]|\\\\.)*"';

/** Regex fallback for JSON-like text that does not parse. */
function redactJsonLike(text) {
  const keyRe = new RegExp(`(${STR})(\\s*:\\s*)(${STR}|\\[[^\\]]*\\]|[^\\s,}\\]]+)`, 'g');
  return text.replace(keyRe, (m, key, colon, val) => {
    let name;
    try { name = JSON.parse(key); } catch { name = key.slice(1, -1); }
    if (!isSensitiveName(name)) return m;
    if (val.startsWith('[')) {
      return `${key}${colon}${val.replace(new RegExp(STR, 'g'), s => (isVarRefOnly(s.slice(1, -1)) || s === '""' ? s : `"${REDACTED}"`)).replace(/(?<=[\[,]\s*)(-?\d[\w.+-]*|true|false)(?=\s*[,\]])/g, REDACTED_TOKEN)}`;
    }
    if (val.startsWith('"')) {
      const inner = val.slice(1, -1);
      return inner === '' || isVarRefOnly(inner) ? m : `${key}${colon}"${REDACTED}"`;
    }
    if (val.startsWith('{')) return m;
    return isVarRefOnly(val) || val === 'null' ? m : `${key}${colon}"${REDACTED}"`;
  });
}
const REDACTED_TOKEN = `"${REDACTED}"`;

function redactUrlEncodedText(text) {
  return text.split('&').map(pair => {
    const i = pair.indexOf('=');
    if (i < 0) return pair;
    const val = pair.slice(i + 1);
    if (!isSensitiveName(safeDecode(pair.slice(0, i))) || val.trim() === '' || isVarRefOnly(val)) return pair;
    return `${pair.slice(0, i)}=${REDACTED}`;
  }).join('&');
}

function redactXmlText(text) {
  const elem = /<((?:[\w.-]+:)?([\w.-]+))((?:\s[^<>]*)?)>(\s*(?:<!\[CDATA\[[\s\S]*?\]\]>|[^<]*?)\s*)<\/\1\s*>/g;
  let out = text.replace(elem, (m, qname, local, attrs, inner) => {
    if (!isSensitiveName(local) || inner.trim() === '' || isVarRefOnly(inner.trim())) return m;
    return `<${qname}${attrs}>${REDACTED}</${qname}>`;
  });
  // Sensitive attributes, handled tag by tag so the tag prefix is preserved.
  out = out.replace(/<[\w.:-]+(?:\s[^<>]*)?>/g, tag => tag.replace(/([\w.:-]+)(\s*=\s*)(["'])(.*?)\3/g, (m, name, eq, q, val) => {
    const local = name.includes(':') ? name.split(':').pop() : name;
    if (name.startsWith('xmlns') || !isSensitiveName(local) || val === '' || isVarRefOnly(val)) return m;
    return `${name}${eq}${q}${REDACTED}${q}`;
  }));
  return out;
}

/**
 * Redact sensitive values inside a body text: JSON (including bodies with
 * unquoted {{vars}}), urlencoded key=value pairs, and XML/SOAP elements.
 * Unchanged text is returned byte-for-byte.
 */
function redactBodyText(text, includeCredentials) {
  if (includeCredentials || typeof text !== 'string' || text === '') return text;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed;
    let vars = [];
    let ok = false;
    try { parsed = JSON.parse(text); ok = true; } catch { /* try masked */ }
    if (!ok) {
      const m = maskVars(text);
      vars = m.vars;
      try { parsed = JSON.parse(m.masked); ok = true; } catch { /* fall through */ }
    }
    if (ok) {
      const redacted = redactJsonValue(parsed, false);
      if (JSON.stringify(redacted) === JSON.stringify(parsed)) return text;
      return restoreVars(JSON.stringify(redacted, null, 2), vars);
    }
    return redactJsonLike(text);
  }
  if (trimmed.startsWith('<')) return redactXmlText(text);
  if (/^[^\s=&]+=[^\n]*$/.test(trimmed) || trimmed.includes('&')) {
    const single = !/\n/.test(trimmed);
    if (single && trimmed.includes('=')) return redactUrlEncodedText(text);
  }
  // Last resort for anything else that still embeds JSON-ish "key": "value" pairs.
  return /"\s*:\s*/.test(text) ? redactJsonLike(text) : text;
}

module.exports = {
  REDACTED,
  isSensitiveName,
  isSensitiveHeader,
  isVarRefOnly,
  redactValue,
  redactByName,
  redactHeaderValue,
  redactUrlUserinfo,
  redactUrlQuery,
  redactUrl,
  redactUrlsInText,
  redactBodyText,
};
