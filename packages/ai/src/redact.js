'use strict';

/**
 * Context redaction applied to everything that may leave the machine.
 *
 * Two layers:
 *  1. By name (deny-by-default, from @apilix/core/redact): URLs, headers, bodies,
 *     auth blocks. Disabled when `redactSecrets === false`.
 *  2. By value: every known secret value (environment/global variables flagged as
 *     secret) is scrubbed from ALL text, always, even when `redactSecrets` is false.
 *
 * {{variable}} references are always preserved.
 */

const core = require('@apilix/core/redact');

const { REDACTED } = core;
const MIN_SECRET_LEN = 4;

function normalizeSecrets(secretValues) {
  const list = [];
  for (const v of secretValues || []) {
    if (typeof v !== 'string' || v.length < MIN_SECRET_LEN) continue;
    list.push(v);
    let enc = v;
    try { enc = encodeURIComponent(v); } catch { /* keep raw */ }
    if (enc !== v) list.push(enc);
    // Secrets also travel base64-encoded (Basic auth, signed payloads, custom headers).
    const b64 = Buffer.from(v, 'utf8').toString('base64');
    list.push(b64, b64.replace(/=+$/, ''), b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  }
  // Longest first so a secret containing another secret is masked entirely.
  return [...new Set(list)].sort((a, b) => b.length - a.length);
}

/** Replace each known secret value (and its URL-encoded form) by <redacted>. */
function scrubSecretValues(text, secretValues) {
  if (typeof text !== 'string' || !text) return text;
  const secrets = Array.isArray(secretValues) && secretValues._normalized
    ? secretValues
    : normalizeSecrets(secretValues);
  let out = text;
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join(REDACTED);
  }
  return out;
}

// obj.set('name', 'literal') — apx.environment.set / globals.set / variables.set …
const SET_CALL = new RegExp(String.raw`(\.set\(\s*)(['"\`])([^'"\`]+)\2(\s*,\s*)(['"\`])((?:\\.|(?!\5).)*)\5`, 'g');
// "Authorization": "literal" / headers.add('X-Api-Key', 'literal') style header literals
const HEADER_LITERAL = new RegExp(
  String.raw`((['"\`])(?:authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token)\2\s*[:,]\s*)(['"\`])((?:\\.|(?!\3).)*)\3`,
  'gi',
);
// key: 'literal' / key = 'literal' with a sensitive key
const ASSIGN_LITERAL = new RegExp(String.raw`(['"]?)([A-Za-z_][\w-]*)\1(\s*[:=]\s*)(['"\`])((?:\\.|(?!\4).)*)\4`, 'g');
const AUTH_SCHEME_LITERAL = /\b(Bearer|Basic|Token|Digest)\s+(?!\{\{)[A-Za-z0-9._~+/=-]{8,}/g;

/** Mask credential literals in a pre-request / test script. */
function redactScript(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  out = out.replace(SET_CALL, (m, pre, q1, name, sep, q2, value) => {
    if (!core.isSensitiveKey(name) || !value || core.isVarRefOnly(value)) return m;
    return `${pre}${q1}${name}${q1}${sep}${q2}${REDACTED}${q2}`;
  });
  out = out.replace(HEADER_LITERAL, (m, pre, _q1, q2, value) => {
    if (!value || core.isVarRefOnly(value)) return m;
    return `${pre}${q2}${REDACTED}${q2}`;
  });
  out = out.replace(ASSIGN_LITERAL, (m, kq, key, sep, q, value) => {
    if (!core.isSensitiveKey(key) || !value || value === REDACTED || core.isVarRefOnly(value)) return m;
    return `${kq}${key}${kq}${sep}${q}${REDACTED}${q}`;
  });
  out = out.replace(AUTH_SCHEME_LITERAL, (_m, scheme) => `${scheme} ${REDACTED}`);
  // user:pass@host and ?token=… inside URL literals (the by-name pass above only sees assignments).
  if (/https?:\/\//i.test(out)) out = core.redactUrlsInText(out, false);
  return out;
}

// Well-known credential shapes, masked wherever they appear (header values, bodies, scripts,
// free text), whatever the surrounding field is called.
const TOKEN_PATTERNS = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,                    // JWT
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,                 // GitHub
  /\bsk-[A-Za-z0-9_-]{16,}/g,                                                       // sk-… (OpenAI, Anthropic, Stripe live)
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                                                // Slack
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,                                                // AWS access key id
];
const AUTH_SCHEME_ANYWHERE = /\b(Bearer|Basic|Token|Digest)(\s+)(?!\{\{)([A-Za-z0-9._~+/=-]{8,})/g;

/** Mask well-known credential shapes in any text. Pure; {{variables}} are untouched. */
function scrubTokenPatterns(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(AUTH_SCHEME_ANYWHERE, (m, scheme, ws, cred) => {
    // "Basic authentication" is prose; only mask non-Bearer schemes that look like a credential.
    if (scheme !== 'Bearer' && !/[\d=+/]/.test(cred)) return m;
    return `${scheme}${ws}${REDACTED}`;
  });
  return out;
}

function makeState({ secretValues, redactSecrets } = {}) {
  const secrets = normalizeSecrets(secretValues);
  secrets._normalized = true;
  return { count: 0, include: redactSecrets === false, secrets };
}

function countMarks(s) {
  return typeof s === 'string' ? s.split(REDACTED).length - 1 : 0;
}

/** Run `fn` on a string, always followed by the by-value scrub; track redaction count. */
function apply(st, str, fn) {
  if (typeof str !== 'string' || !str) return str === undefined || str === null ? '' : String(str);
  const before = countMarks(str);
  let out = fn ? fn(str) : str;
  if (!st.include) out = scrubTokenPatterns(out);
  const scrubbed = scrubSecretValues(out, st.secrets);
  st.count += Math.max(0, countMarks(scrubbed) - before);
  return scrubbed;
}

/** Body text: by-name JSON/XML/form redaction, then URLs embedded in values (?code=…, user:pass@). */
function redactBodyWithUrls(text, include) {
  const out = core.redactBodyText(text, include);
  return typeof out === 'string' && /https?:\/\//i.test(out) ? core.redactUrlsInText(out, include) : out;
}

function redactPairs(list, st) {
  if (!Array.isArray(list)) return [];
  return list.map(p => ({
    key: p.key,
    value: apply(st, p.value, v => core.redactByName(p.key, v, st.include)),
    ...(p.disabled ? { disabled: true } : {}),
  }));
}

function redactHeaders(headers, st) {
  if (Array.isArray(headers)) {
    return headers.map(h => ({
      key: h.key,
      value: apply(st, h.value, v => core.redactHeaderValue(h.key, v, st.include)),
      ...(h.disabled ? { disabled: true } : {}),
    }));
  }
  if (headers && typeof headers === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
      out[k] = apply(st, String(v), x => core.redactHeaderValue(k, x, st.include));
    }
    return out;
  }
  return headers;
}

function redactDeepByName(node, st) {
  if (Array.isArray(node)) return node.map(n => redactDeepByName(n, st));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = v && typeof v === 'object' ? redactDeepByName(v, st) : apply(st, v, x => core.redactByName(k, x, st.include));
    }
    return out;
  }
  return node;
}

function redactAuth(auth, st) {
  if (!auth || typeof auth !== 'object') return auth;
  const out = { type: auth.type };
  for (const key of ['bearer', 'basic', 'apikey']) {
    if (Array.isArray(auth[key])) {
      out[key] = auth[key].map(e => ({
        key: e.key,
        // Auth fields are credentials whatever their key is named ("value", "token"…).
        value: apply(st, e.value, v => core.redactValue(v, st.include)),
      }));
    }
  }
  if (auth.oauth2) out.oauth2 = redactDeepByName(auth.oauth2, st);
  return out;
}

function redactBody(body, st) {
  if (!body || typeof body !== 'object') return body;
  const out = { mode: body.mode };
  if (body.raw !== undefined) out.raw = apply(st, body.raw, v => redactBodyWithUrls(v, st.include));
  if (body.urlencoded) out.urlencoded = redactPairs(body.urlencoded, st);
  if (body.formdata) out.formdata = redactPairs(body.formdata, st);
  if (body.graphql) {
    out.graphql = {
      query: apply(st, body.graphql.query),
      variables: apply(st, body.graphql.variables, v => redactBodyWithUrls(v, st.include)),
    };
  }
  return out;
}

/** Redact a collection request (Postman-like shape). */
function redactRequest(request, opts = {}) {
  const st = opts._state || makeState(opts);
  if (!request || typeof request !== 'object') return request;
  const rawUrl = typeof request.url === 'string' ? request.url : request.url && request.url.raw;
  const out = {
    method: request.method,
    url: apply(st, rawUrl || '', v => core.redactUrl(v, st.include)),
  };
  if (request.header) out.header = redactHeaders(request.header, st);
  if (request.body) out.body = redactBody(request.body, st);
  if (request.auth) out.auth = redactAuth(request.auth, st);
  if (request.description) out.description = apply(st, request.description);
  return out;
}

/** Redact an HTTP response ({ status, headers, body }). */
function redactResponse(response, opts = {}) {
  const st = opts._state || makeState(opts);
  if (!response || typeof response !== 'object') return response;
  const out = { status: response.status, statusText: response.statusText };
  if (response.headers) out.headers = redactHeaders(response.headers, st);
  if (response.body !== undefined) out.body = apply(st, response.body, v => redactBodyWithUrls(v, st.include));
  return out;
}

/**
 * Redact a whole context object. Recognised keys:
 *   request, response, scripts (name → source), text (free text), variableNames.
 * Returns `{ value, redactions }`.
 */
function redactContext(ctx, opts = {}) {
  const st = makeState(opts);
  const out = {};
  if (!ctx || typeof ctx !== 'object') return { value: out, redactions: 0 };
  if (ctx.request) out.request = redactRequest(ctx.request, { _state: st });
  if (ctx.response) out.response = redactResponse(ctx.response, { _state: st });
  if (ctx.scripts) {
    out.scripts = {};
    for (const [name, src] of Object.entries(ctx.scripts)) out.scripts[name] = apply(st, src, redactScript);
  }
  if (ctx.text !== undefined) {
    out.text = apply(st, ctx.text, v => core.redactUrlsInText(core.redactBodyText(v, st.include), st.include));
  }
  if (ctx.variableNames) out.variableNames = [...ctx.variableNames];
  return { value: out, redactions: st.count };
}

module.exports = {
  REDACTED,
  scrubSecretValues,
  redactScript,
  scrubTokenPatterns,
  redactRequest,
  redactResponse,
  redactContext,
};
