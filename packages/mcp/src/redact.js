'use strict';

/**
 * Redaction for everything returned to the agent.
 *
 * Two layers:
 *  1. Structural: URLs, headers, auth, bodies and variables go through @apilix/core/redact
 *     (deny-by-default on credential-looking names; {{var}} references survive).
 *  2. Known-secret scrub: every secret VALUE we know about (env vars flagged secret, env vars whose
 *     name looks sensitive, literal auth credentials found in collections) is replaced wherever it
 *     appears, in raw, URL-encoded and base64 form, in every outgoing string (see scrubDeep).
 *
 * Limits: a secret that is neither flagged, nor under a sensitive name, nor a literal auth value
 * (for instance a token printed in a free-text response field) cannot be recognised.
 */

const core = require('@apilix/core/redact');

const REDACTED = core.REDACTED;
const MIN_SECRET_LENGTH = 4;
const MAX_SECRETS = 2000;

function createRedactor({ includeCredentials = false } = {}) {
  /** values that must never be returned, whatever --include-credentials says */
  const hardSecrets = new Set();
  /** values hidden only while redaction is on */
  const softSecrets = new Set();
  let variants = null; // cache: array of [needle, replacement]

  function add(set, value) {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return;
    if (/^\{\{[^{}]+\}\}$/.test(value.trim())) return; // a variable reference, not a literal
    if (hardSecrets.size + softSecrets.size >= MAX_SECRETS) return;
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
            const m = /^(?:bearer|basic|token)\s+(.+)$/i.exec(h.value);
            if (m) add(softSecrets, m[1]);
          }
        }
      }
      for (const v of Array.isArray(node.variable) ? node.variable : []) {
        if (v && typeof v.key === 'string' && (v.type === 'secret' || core.isSensitiveName(v.key))) add(softSecrets, v.value == null ? '' : String(v.value));
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
      const forms = new Set([s, encodeURIComponent(s), Buffer.from(s, 'utf8').toString('base64')]);
      const b64 = Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '');
      if (b64.length >= MIN_SECRET_LENGTH) forms.add(b64);
      for (const f of forms) if (f.length >= MIN_SECRET_LENGTH) pairs.push(f);
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

  /** Deep-scrub every string (values and keys) of a JSON-compatible structure. */
  function scrubDeep(value, depth = 0) {
    if (typeof value === 'string') return scrub(value);
    if (depth > 60 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[scrub(k)] = scrubDeep(v, depth + 1);
    return out;
  }

  const clip = (s, max) => (typeof s === 'string' && s.length > max ? `${s.slice(0, max)}...[truncated ${s.length - max} chars]` : s);

  return {
    includeCredentials,
    addEnvironment,
    addCollection,
    addSecret: (v) => add(hardSecrets, v),
    scrub,
    scrubDeep,
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
