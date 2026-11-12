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

/**
 * Like isSensitiveName but also looks at the percent-decoded form, so keys such
 * as `api%2Dkey` or the malformed `%74oken%ZZ` are still recognised.
 */
function isSensitiveKey(name) {
  if (typeof name !== 'string' || !name) return false;
  if (isSensitiveName(name)) return true;
  return name.includes('%') || name.includes('+') ? isSensitiveName(safeDecode(name)) : false;
}

function isSensitiveHeader(name) {
  if (typeof name !== 'string') return false;
  return SENSITIVE_HEADERS.has(name.trim().toLowerCase()) || isSensitiveKey(name);
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

// A scheme (also tolerating leading junk such as '-https://') or a protocol-relative '//'.
const SCHEME_AUTH = /^((?:[a-z0-9+.-]+:)?\/\/)/i;

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

/**
 * Percent-decode a key. Falls back to a tolerant per-sequence %XX decode when
 * the string is not valid UTF-8/percent-encoding (e.g. `%E0`, `%ZZ`), so an
 * attacker cannot hide a sensitive name behind one malformed sequence. A
 * double-encoded sequence (%252D) is intentionally decoded only once.
 */
function safeDecode(s) {
  const t = String(s).replace(/\+/g, ' ');
  try { return decodeURIComponent(t); } catch {
    return t.replace(/%([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
  }
}

function redactPairs(str) {
  return str.split('&').map(pair => {
    const i = pair.indexOf('=');
    if (i < 0) return pair;
    const key = pair.slice(0, i);
    const val = pair.slice(i + 1);
    if (!isSensitiveKey(key) || val === '' || isVarRefOnly(val)) return pair;
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
// A scheme URL (tolerating leading junk like '-https://' or '9https://') or a
// protocol-relative '//host' URL. The lookbehind stops matching mid-run, so the
// scan is linear.
const URL_IN_TEXT = /(?<![a-z0-9+.\-:/])(?:[a-z0-9+.-]+:)?\/\/[^\s<>"',;]+/gi;
const BEARER_IN_TEXT = /\b(Bearer|Basic)([ \t]+)([^\s,;"']+)/gi;

/** Redact literal `Bearer <value>` / `Basic <value>` credentials in free text. */
function redactAuthSchemesInText(text) {
  return text.replace(BEARER_IN_TEXT, (m, scheme, ws, value) => (isVarRefOnly(value) ? m : `${scheme}${ws}${REDACTED}`));
}

/** Redact one URL candidate while keeping unbalanced trailing closers like ')'. */
function redactUrlCandidate(m) {
  let end = m.length;
  const pairs = { ')': '(', ']': '[', '}': '{' };
  while (end > 0 && pairs[m[end - 1]]) {
    const body = m.slice(0, end);
    const closer = m[end - 1];
    const opens = body.split(pairs[closer]).length - 1;
    const closes = body.split(closer).length - 1;
    if (closes <= opens) break;
    end--;
  }
  return redactUrl(m.slice(0, end), false) + m.slice(end);
}

/**
 * Scrub URLs inside an arbitrary string (e.g. a Location or Link header value):
 * every scheme URL is redacted individually; otherwise the whole value is.
 * Literal Bearer/Basic credentials in the text are redacted as well.
 */
function redactUrlsInText(text, includeCredentials) {
  if (includeCredentials || typeof text !== 'string' || text === '') return text;
  const scrubbed = redactAuthSchemesInText(text);
  URL_IN_TEXT.lastIndex = 0;
  if (URL_IN_TEXT.test(scrubbed)) {
    URL_IN_TEXT.lastIndex = 0;
    return scrubbed.replace(URL_IN_TEXT, redactUrlCandidate);
  }
  return redactUrl(scrubbed, false);
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
    if (!isSensitiveKey(pair.slice(0, i)) || val.trim() === '' || isVarRefOnly(val)) return pair;
    return `${pair.slice(0, i)}=${REDACTED}`;
  }).join('&');
}

/** indexOf that remembers a failed search so repeated misses stay O(1). */
function makeFinder(text) {
  const failedFrom = new Map();
  return (term, from) => {
    const f = failedFrom.get(term);
    if (f !== undefined && from >= f) return -1;
    const i = text.indexOf(term, from);
    if (i < 0) failedFrom.set(term, from);
    return i;
  };
}

const isWs = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isNameChar = c => /[\w.:-]/.test(c);

/** Redact sensitive attribute values in one opening tag (linear manual scan). */
function redactTagAttrs(tag) {
  const n = tag.length;
  let k = 1;
  while (k < n && isNameChar(tag[k])) k++;
  let out = '';
  let last = 0;
  while (k < n) {
    if (!isNameChar(tag[k])) { k++; continue; }
    const ns = k;
    while (k < n && isNameChar(tag[k])) k++;
    const name = tag.slice(ns, k);
    let p = k;
    while (p < n && isWs(tag[p])) p++;
    if (tag[p] !== '=') continue;
    p++;
    while (p < n && isWs(tag[p])) p++;
    let vs; let ve;
    const q = tag[p];
    if (q === '"' || q === "'") {
      vs = p + 1;
      ve = tag.indexOf(q, vs);
      if (ve < 0) break;
      k = ve + 1;
    } else {
      vs = p;
      ve = p;
      while (ve < n && !isWs(tag[ve]) && tag[ve] !== '>' && !(tag[ve] === '/' && tag[ve + 1] === '>')) ve++;
      k = ve;
    }
    const val = tag.slice(vs, ve);
    const local = name.includes(':') ? name.split(':').pop() : name;
    if (name.startsWith('xmlns') || !isSensitiveName(local) || val === '' || isVarRefOnly(val)) continue;
    out += tag.slice(last, vs) + REDACTED;
    last = ve;
  }
  return last === 0 ? tag : out + tag.slice(last);
}

/**
 * Linear-time XML/SOAP redactor (no backtracking regexes). Element text of a
 * sensitive leaf element (text, CDATA and comments only, in any mix) and
 * sensitive attributes are replaced; everything else is preserved byte-for-byte.
 */
function redactXmlText(text) {
  const find = makeFinder(text);
  const n = text.length;
  let out = '';
  let last = 0;
  let pos = 0;
  while (pos < n) {
    const i = text.indexOf('<', pos);
    if (i < 0) break;
    if (text.startsWith('<!--', i)) { const e = find('-->', i + 4); pos = e < 0 ? i + 1 : e + 3; continue; }
    if (text.startsWith('<![CDATA[', i)) { const e = find(']]>', i + 9); pos = e < 0 ? i + 1 : e + 3; continue; }
    if (text[i + 1] === '?') { const e = find('?>', i + 2); pos = e < 0 ? i + 1 : e + 2; continue; }
    if (text[i + 1] === '!') { const e = find('>', i + 2); pos = e < 0 ? i + 1 : e + 1; continue; }
    if (text[i + 1] === '/' || !isNameChar(text[i + 1] || ' ')) { pos = i + 1; continue; }
    // Opening tag: name, then attributes up to the first '>' (no '<' allowed).
    let k = i + 1;
    while (k < n && isNameChar(text[k])) k++;
    const qname = text.slice(i + 1, k);
    if (k < n && text[k] !== '>' && text[k] !== '/' && !isWs(text[k])) { pos = i + 1; continue; }
    let gt = -1;
    for (let j = k; j < n; j++) {
      const c = text[j];
      if (c === '>') { gt = j; break; }
      if (c === '<') break;
    }
    if (gt < 0) { pos = i + 1; continue; }
    const tagText = text.slice(i, gt + 1);
    const newTag = redactTagAttrs(tagText);
    const selfClosing = text[gt - 1] === '/';
    const local = qname.includes(':') ? qname.split(':').pop() : qname;
    if (!selfClosing && local && isSensitiveName(local)) {
      // Leaf scan: text / CDATA / comments until the matching close tag.
      let eff = '';
      let q = gt + 1;
      let closeEnd = -1;
      for (;;) {
        const lt = text.indexOf('<', q);
        if (lt < 0) break;
        eff += text.slice(q, lt);
        if (text.startsWith('<!--', lt)) {
          const e = find('-->', lt + 4);
          if (e < 0) break;
          q = e + 3;
        } else if (text.startsWith('<![CDATA[', lt)) {
          const e = find(']]>', lt + 9);
          if (e < 0) break;
          eff += text.slice(lt + 9, e);
          q = e + 3;
        } else if (text.startsWith(`</${qname}`, lt)) {
          let j = lt + 2 + qname.length;
          while (j < n && isWs(text[j])) j++;
          if (text[j] === '>') closeEnd = j + 1;
          break;
        } else {
          break;
        }
      }
      if (closeEnd >= 0) {
        const t = eff.trim();
        if (t !== '' && !isVarRefOnly(t)) {
          out += `${text.slice(last, i)}${newTag}${REDACTED}</${qname}>`;
          last = closeEnd;
          pos = closeEnd;
          continue;
        }
      }
    }
    if (newTag !== tagText) { out += text.slice(last, i) + newTag; last = gt + 1; }
    pos = gt + 1;
  }
  return out + text.slice(last);
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
  isSensitiveKey,
  safeDecode,
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
