'use strict';

/**
 * Redaction for everything returned to the agent.
 *
 * Two layers:
 *  1. Structural: URLs, headers, auth, bodies and variables go through @apilix/core/redact
 *     (deny-by-default on credential-looking names; {{var}} references survive).
 *  2. Known-secret scrub: every secret VALUE we know about (env vars flagged secret, env vars whose
 *     name looks sensitive, literal auth credentials found in collections) is replaced wherever it
 *     appears, in raw, JSON-escaped, URL-encoded and base64 form, in every outgoing string (see scrubDeep).
 *
 * Scrubbing never touches the protocol or the JSON structure: only string LEAVES of tool/resource data are scrubbed
 * (keys, booleans, numbers, initialize/tools/list/resources/list are left alone), and short or "banal" values of
 * merely credential-NAMED variables are not treated as secrets (see MIN_* and isBanal). Trade-off: a secret
 * shorter than 8 characters, or a value made only of 1 to 12 lowercase letters (isBanal: such words are protocol/data-model vocabulary), stored under a credential-looking name (not flagged
 * secret) is not masked; flag it as secret in the environment to get it masked from 4 characters up.
 *
 * Limits: a secret that is neither flagged, nor under a sensitive name, nor a literal auth value
 * (for instance a token printed in a free-text response field) cannot be recognised.
 */

const core = require('@apilix/core/redact');

const REDACTED = core.REDACTED;
const MIN_HARD_LENGTH = 4; // values explicitly flagged secret (secret:true / type "secret")
const MIN_SOFT_LENGTH = 8; // values only recognised by the credential-looking name of their variable
const MAX_SECRETS = 2000;
const BANAL = new Set(['true', 'false', 'null', 'undefined', 'nan', 'none', 'object', 'string', 'number', 'boolean', 'integer', 'array', 'bearer', 'basic', 'digest', 'default', 'enabled', 'disabled', 'required', 'optional', 'application/json', 'text/plain', 'application/xml']);

/** Values that are words/literals of the protocol and data model, not credentials: scrubbing them would corrupt output. */
function isBanal(v) {
  const t = v.trim().toLowerCase();
  return t === '' || BANAL.has(t) || /^[a-z]{1,12}$/.test(t);
}

function decodeSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function createRedactor({ includeCredentials = false } = {}) {
  /** values that must never be returned, whatever --include-credentials says */
  const hardSecrets = new Set();
  /** values hidden only while redaction is on */
  const softSecrets = new Set();
  let variants = null; // cache: array of [needle, replacement]

  let overflow = false;
  function add(set, value) {
    const hard = set === hardSecrets;
    if (typeof value !== 'string' || value.length < (hard ? MIN_HARD_LENGTH : MIN_SOFT_LENGTH)) return;
    if (/^\{\{[^{}]+\}\}$/.test(value.trim())) return; // a variable reference, not a literal
    if (hard ? BANAL.has(value.trim().toLowerCase()) : isBanal(value)) return;
    if (set.has(value)) return;
    if (hardSecrets.size + softSecrets.size >= MAX_SECRETS) { overflow = true; return; }
    set.add(value);
    variants = null;
  }

  /** Values of environment rows: flagged secret (hard) or named like a credential (soft). */
  function addEnvironment(values) {
    for (const row of Array.isArray(values) ? values : []) {
      if (!row || typeof row.key !== 'string') continue;
      const value = row.value == null ? '' : String(row.value);
      if (row.secret === true || row.type === 'secret') add(hardSecrets, value);
      else if (core.isSensitiveName(row.key)) add(softSecrets, value);
    }
  }

  /** Literal credentials embedded in a collection: auth blocks and credential-looking headers. */
  function addCollection(collection) {
    const seen = new WeakSet();
    const visitAuth = (auth) => {
      if (!auth || typeof auth !== 'object') return;
      for (const [k, v] of Object.entries(auth)) {
        if (k === 'type') continue;
        if (Array.isArray(v)) {
          for (const row of v) if (row && typeof row.value === 'string') add(softSecrets, row.value);
        } else if (v && typeof v === 'object') {
          for (const [k2, v2] of Object.entries(v)) if (typeof v2 === 'string' && core.isSensitiveName(k2)) add(softSecrets, v2);
        } else if (typeof v === 'string' && core.isSensitiveName(k)) {
          add(softSecrets, v);
        }
      }
    };
    const addQueryString = (qs) => {
      for (const pair of String(qs).split('&')) {
        const i = pair.indexOf('=');
        if (i > 0 && core.isSensitiveKey(pair.slice(0, i))) add(softSecrets, decodeSafe(pair.slice(i + 1)));
      }
    };
    const walkJson = (node, forced, depth) => {
      if (depth > 20) return;
      if (Array.isArray(node)) { for (const n of node) walkJson(n, forced, depth + 1); return; }
      if (node && typeof node === 'object') { for (const [k, v] of Object.entries(node)) walkJson(v, forced || core.isSensitiveKey(k), depth + 1); return; }
      if (forced && typeof node === 'string') add(softSecrets, node);
    };
    /** Literal values under credential-looking names: URL query, urlencoded/form bodies, JSON bodies. */
    const visitRequestLiterals = (req) => {
      const raw = typeof req.url === 'string' ? req.url : (req.url && typeof req.url.raw === 'string' ? req.url.raw : '');
      const q = raw.indexOf('?');
      if (q >= 0) addQueryString(raw.slice(q + 1).split('#')[0]);
      for (const row of (req.url && Array.isArray(req.url.query) ? req.url.query : [])) {
        if (row && typeof row.key === 'string' && core.isSensitiveKey(row.key) && typeof row.value === 'string') add(softSecrets, row.value);
      }
      const b = req.body;
      if (!b || typeof b !== 'object') return;
      for (const row of [...(Array.isArray(b.urlencoded) ? b.urlencoded : []), ...(Array.isArray(b.formdata) ? b.formdata : [])]) {
        if (row && typeof row.key === 'string' && core.isSensitiveKey(row.key) && typeof row.value === 'string') add(softSecrets, row.value);
      }
      if (b.mode === 'raw' && typeof b.raw === 'string' && b.raw.length < 200000) {
        const t = b.raw.trim();
        if (t.startsWith('{') || t.startsWith('[')) { try { walkJson(JSON.parse(t), false, 0); } catch { /* not JSON */ } }
        else if (t.includes('=')) addQueryString(t);
      }
    };
    const visit = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 40 || seen.has(node)) return;
      seen.add(node);
      visitAuth(node.auth);
      const req = node.request;
      if (req && typeof req === 'object') {
        visitAuth(req.auth);
        for (const h of Array.isArray(req.header) ? req.header : []) {
          if (h && typeof h.value === 'string' && core.isSensitiveHeader(h.key)) {
            add(softSecrets, h.value);
            const sp = h.value.search(/\s/); // linear: scheme, then the rest after the whitespace run
            if (sp > 0 && /^(?:bearer|basic|token)$/i.test(h.value.slice(0, sp))) {
              let k = sp;
              while (k < h.value.length && /\s/.test(h.value[k])) k += 1;
              if (k < h.value.length) add(softSecrets, h.value.slice(k));
            }
          }
        }
      }
      if (req && typeof req === 'object') visitRequestLiterals(req);
      for (const v of Array.isArray(node.variable) ? node.variable : []) {
        if (!v || typeof v.key !== 'string') continue;
        const val = v.value == null ? '' : String(v.value);
        if (v.type === 'secret' || v.secret === true) add(hardSecrets, val); // flagged secret: never returned, even with --include-credentials
        else if (core.isSensitiveName(v.key)) add(softSecrets, val);
      }
      if (Array.isArray(node.item)) for (const child of node.item) visit(child, depth + 1);
    };
    visit(collection, 0);
  }

  function activeSecrets() {
    return includeCredentials ? [...hardSecrets] : [...hardSecrets, ...softSecrets];
  }

  function buildVariants() {
    const pairs = [];
    for (const s of activeSecrets()) {
      const min = hardSecrets.has(s) ? MIN_HARD_LENGTH : MIN_SOFT_LENGTH;
      const forms = new Set([s, JSON.stringify(s).slice(1, -1), encodeURIComponent(s), Buffer.from(s, 'utf8').toString('base64')]);
      const b64 = Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '');
      forms.add(b64);
      for (const f of forms) if (f.length >= min) pairs.push(f);
    }
    pairs.sort((a, b) => b.length - a.length);
    return pairs;
  }

  /** Replace every known secret value inside a string. */
  function scrub(text) {
    if (typeof text !== 'string' || text === '') return text;
    if (variants === null) variants = buildVariants();
    let out = text;
    for (const needle of variants) {
      if (out.includes(needle)) out = out.split(needle).join(REDACTED);
    }
    return out;
  }

  /** Scrub the string LEAVES of a JSON-compatible structure. Keys, numbers, booleans and null are never touched. */
  function scrubDeep(value, depth = 0) {
    if (typeof value === 'string') return scrub(value);
    if (depth > 60 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, depth + 1);
    return out;
  }

  /** Scrub a text that is usually serialized JSON without breaking it: parse, scrub the leaves, serialize again. */
  function scrubJsonText(text) {
    if (typeof text !== 'string' || text === '') return text;
    const t = text.trimStart();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { return JSON.stringify(scrubDeep(JSON.parse(text))); } catch { /* not JSON: plain text below */ }
    }
    return scrub(text);
  }

  const clip = (s, max) => (typeof s === 'string' && s.length > max ? `${s.slice(0, max)}...[truncated ${s.length - max} chars]` : s);

  return {
    includeCredentials,
    addEnvironment,
    addCollection,
    addSecret: (v) => add(hardSecrets, v),
    scrub,
    scrubDeep,
    scrubJsonText,
    overflowed: () => overflow,
    clip,
    /** Free text (log lines, errors, test names): known secrets + Bearer/Basic + URL credentials. */
    text: (s, max = 2000) => (typeof s === 'string' ? clip(scrub(core.redactUrlsInText(s, includeCredentials)), max) : s),
    url: (s, max = 2000) => (typeof s === 'string' ? clip(scrub(core.redactUrl(s, includeCredentials)), max) : s),
    header: (name, value) => (typeof value === 'string' || typeof value === 'number' ? scrub(core.redactHeaderValue(name, String(value), includeCredentials)) : value),
    body: (s) => (typeof s === 'string' ? scrub(core.redactBodyText(s, includeCredentials)) : s),
    byName: (name, value) => (value == null ? value : scrub(core.redactByName(name, String(value), includeCredentials))),
    value: (v) => core.redactValue(v, includeCredentials),
    /** Headers object ({name: value}) -> redacted copy. */
    headers(obj) {
      const out = {};
      if (!obj || typeof obj !== 'object') return out;
      for (const [k, v] of Object.entries(obj)) {
        const val = Array.isArray(v) ? v.join(', ') : v;
        let r = this.header(k, val);
        if (typeof r === 'string' && /^(location|content-location|link|refresh|referer|origin)$/i.test(k)) r = scrub(core.redactUrlsInText(r, includeCredentials));
        out[scrub(k)] = clip(r, 1000);
      }
      return out;
    },
    isSensitiveName: core.isSensitiveName,
    isSensitiveHeader: core.isSensitiveHeader,
    secretCount: () => hardSecrets.size + softSecrets.size,
  };
}

module.exports = { createRedactor, REDACTED };
