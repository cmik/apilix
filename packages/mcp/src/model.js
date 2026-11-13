'use strict';

/**
 * Collection tree helpers: listing, lookup, pruning for runs, and the redacted request view.
 * Pure functions (no I/O).
 */

const { resolveVariables } = require('@apilix/core/variable-resolver');

const MAX_DEPTH = 30;
const NON_HTTP_METHODS = new Set(['MONGO', 'MYSQL', 'POSTGRESQL', 'SQLITE', 'CASSANDRA', 'ORACLE', 'MSSQL', 'REDIS', 'DYNAMODB']);

const isFolder = (n) => !!n && Array.isArray(n.item);
const urlRaw = (u) => (typeof u === 'string' ? u : (u && typeof u.raw === 'string' ? u.raw : ''));

function isNonHttp(item) {
  const req = item && item.request;
  if (!req || typeof req !== 'object') return false;
  if (req.requestType && req.requestType !== 'http') return true;
  if (req.mongodb || req.sql || req.database) return true;
  return NON_HTTP_METHODS.has(String(req.method || '').toUpperCase());
}

/** Depth-first list of folders and requests with stable refs. pos = array of child indexes. */
function listNodes(collection) {
  const out = [];
  (function walk(items, names, pos, depth) {
    if (!Array.isArray(items) || depth > MAX_DEPTH) return;
    items.forEach((node, i) => {
      if (!node || typeof node !== 'object') return;
      const name = typeof node.name === 'string' ? node.name : '(unnamed)';
      const p = [...pos, i];
      const pathNames = [...names, name];
      const entry = {
        type: isFolder(node) ? 'folder' : 'request',
        ref: typeof node.id === 'string' && node.id ? node.id : `@${p.join('/')}`,
        path: pathNames.join('/'),
        pos: p,
        depth,
        node,
      };
      out.push(entry);
      if (isFolder(node)) walk(node.item, pathNames, p, depth + 1);
    });
  }(collection.item, [], [], 0));
  return out;
}

/**
 * Resolve a user-supplied reference: an item id, a positional "@0/2/1" ref, or a
 * "Folder/Sub/Name" path. Returns the single matching entry or throws.
 */
function findNode(collection, ref, { type } = {}) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 600) throw new Error('Invalid reference');
  const nodes = listNodes(collection).filter((n) => !type || n.type === type);
  let matches = nodes.filter((n) => n.ref === ref);
  if (matches.length === 0 && ref.startsWith('@')) {
    const all = listNodes(collection);
    matches = all.filter((n) => `@${n.pos.join('/')}` === ref && (!type || n.type === type));
  }
  if (matches.length === 0) matches = nodes.filter((n) => n.node.id === ref);
  if (matches.length === 0) matches = nodes.filter((n) => n.path === ref);
  if (matches.length === 0 && !ref.includes('/')) matches = nodes.filter((n) => n.node.name === ref);
  if (matches.length === 0) throw new Error(`No ${type || 'item'} matches "${ref.slice(0, 120)}". Use list_requests to get valid refs`);
  if (matches.length > 1) throw new Error(`"${ref.slice(0, 120)}" is ambiguous (${matches.length} matches); use the "ref" value from list_requests`);
  return matches[0];
}

function countRequests(items, depth = 0) {
  let n = 0;
  if (!Array.isArray(items) || depth > MAX_DEPTH) return 0;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (isFolder(it)) n += countRequests(it.item, depth + 1);
    else if (it.request) n += 1;
  }
  return n;
}

/**
 * Clone the collection keeping only the chain of ancestors (their folder-level scripts are merged by
 * the runner) and the full subtree of `targetPos`. With targetPos == null the whole tree is kept.
 * Non-HTTP requests are dropped and reported. Per-request settings may only make a request STRICTER than the
 * session: proxy settings are dropped; `timeout` is kept only when 0 < timeout <= the session per-request
 * timeout (0 means "no timeout" for the engine and is dropped); `followRedirects` only when false;
 * `sslVerification` only when true (a collection can never turn verification off or lengthen a timeout).
 */
function buildRunTree(collection, targetPos, limits = {}) {
  const maxTimeoutMs = Number.isFinite(limits.maxRequestTimeoutMs) ? limits.maxRequestTimeoutMs : 30000;
  const skipped = [];
  const isPrefix = (a, b) => a.length <= b.length && a.every((v, i) => v === b[i]);
  function clone(items, pos, names, inTarget, depth) {
    const out = [];
    if (!Array.isArray(items) || depth > MAX_DEPTH) return out;
    items.forEach((node, i) => {
      if (!node || typeof node !== 'object') return;
      const p = [...pos, i];
      const here = names.concat(typeof node.name === 'string' ? node.name : '(unnamed)');
      const keep = targetPos == null || inTarget || isPrefix(p, targetPos) || isPrefix(targetPos, p);
      if (!keep) return;
      const nowInTarget = targetPos == null || inTarget || (p.length === targetPos.length && isPrefix(targetPos, p));
      if (isFolder(node)) {
        const copy = { ...structuredClone({ ...node, item: undefined }), item: [] };
        delete copy.item;
        copy.item = clone(node.item, p, here, nowInTarget, depth + 1);
        out.push(copy);
      } else if (node.request) {
        if (isNonHttp(node)) { skipped.push(here.join('/')); return; }
        const copy = structuredClone(node);
        if (copy.request && copy.request.requestSettings && typeof copy.request.requestSettings === 'object') {
          const rs = copy.request.requestSettings;
          for (const k of ['proxyEnabled', 'httpProxy', 'httpsProxy', 'noProxy']) delete rs[k];
          if (!(typeof rs.timeout === 'number' && rs.timeout > 0 && rs.timeout <= maxTimeoutMs)) delete rs.timeout;
          if (rs.followRedirects !== false) delete rs.followRedirects;
          if (rs.sslVerification !== true) delete rs.sslVerification;
        }
        out.push(copy);
      }
    });
    return out;
  }
  const tree = { ...structuredClone({ ...collection, item: undefined }) };
  tree.item = clone(collection.item, [], [], false, 0);
  return { collection: tree, skippedNonHttp: skipped };
}

/** Postman header/query/formdata arrays -> [{key,value,disabled}] with redaction. */
function redactPairs(arr, redactor, kind) {
  const out = [];
  for (const row of Array.isArray(arr) ? arr.slice(0, 200) : []) {
    if (!row || typeof row !== 'object') continue;
    const key = typeof row.key === 'string' ? row.key : '';
    const entry = { key: redactor.text(key, 200) };
    if (row.type === 'file') entry.value = '(file)';
    else if (kind === 'header') entry.value = redactor.clip(redactor.header(key, row.value == null ? '' : String(row.value)), 1000);
    else entry.value = redactor.clip(redactor.byName(key, row.value == null ? '' : String(row.value)), 1000);
    if (row.disabled) entry.disabled = true;
    out.push(entry);
  }
  return out;
}

function redactAuth(auth, redactor) {
  if (!auth || typeof auth !== 'object') return undefined;
  const out = { type: String(auth.type || 'noauth') };
  const detail = auth[auth.type];
  const pairs = [];
  if (Array.isArray(detail)) {
    for (const row of detail.slice(0, 30)) if (row && typeof row.key === 'string') pairs.push([row.key, redactor.value(row.value)]);
  } else if (detail && typeof detail === 'object') {
    for (const [k, v] of Object.entries(detail).slice(0, 30)) if (typeof v !== 'object') pairs.push([k, redactor.value(v)]);
  }
  // fromEntries creates own data properties: a key such as "__proto__" cannot reach the prototype
  if (pairs.length) out.fields = Object.fromEntries(pairs);
  return out;
}

function scriptText(event, redactor, max) {
  const exec = event && event.script && event.script.exec;
  const code = Array.isArray(exec) ? exec.join('\n') : (typeof exec === 'string' ? exec : '');
  return redactor.text(code, max);
}

function redactEvents(events, redactor) {
  const out = {};
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev && (ev.listen === 'prerequest' || ev.listen === 'test')) out[ev.listen === 'test' ? 'tests' : 'preRequest'] = scriptText(ev, redactor, 4000);
  }
  return out;
}

/** Redacted, bounded detail of one request item. Collection content is untrusted data. */
function describeRequest(entry, redactor) {
  const node = entry.node;
  const req = node.request || {};
  const out = {
    type: 'request',
    ref: entry.ref,
    path: redactor.text(entry.path, 600),
    name: redactor.text(String(node.name || ''), 200),
    method: String(req.method || 'GET').toUpperCase(),
    url: redactor.url(urlRaw(req.url)),
    protocol: isNonHttp(node) ? 'non-http (not runnable through MCP)' : 'http',
  };
  if (req.url && typeof req.url === 'object') {
    const query = redactPairs(req.url.query, redactor, 'query');
    if (query.length) out.query = query;
  }
  const headers = redactPairs(req.header, redactor, 'header');
  if (headers.length) out.headers = headers;
  const auth = redactAuth(req.auth, redactor);
  if (auth) out.auth = auth;
  const b = req.body;
  if (b && typeof b === 'object' && b.mode) {
    const body = { mode: String(b.mode) };
    if (b.mode === 'raw') body.raw = redactor.clip(redactor.body(String(b.raw || '')), 8000);
    else if (b.mode === 'urlencoded') body.urlencoded = redactPairs(b.urlencoded, redactor, 'query');
    else if (b.mode === 'formdata') body.formdata = redactPairs(b.formdata, redactor, 'query');
    else if (b.mode === 'graphql' && b.graphql) {
      body.graphql = { query: redactor.clip(redactor.text(String(b.graphql.query || ''), 8000), 8000), variables: redactor.clip(redactor.body(String(b.graphql.variables || '')), 4000) };
    } else if (b.mode === 'file') body.file = '(file)';
    out.body = body;
  }
  const events = redactEvents(node.event, redactor);
  if (events.preRequest || events.tests) out.scripts = events;
  if (typeof node.description === 'string' && node.description) out.description = redactor.text(node.description, 2000);
  const examples = Array.isArray(node.response) ? node.response.slice(0, 20).map((r) => ({
    name: redactor.text(String((r && r.name) || ''), 200), status: r && r.code, statusText: r && r.status,
  })) : [];
  if (examples.length) out.savedExamples = examples;
  return out;
}

const UNRESOLVED_RE = /\{\{/;
const CONTROL_RE = /[\u0000-\u0020\u007f]/;
const SCHEMES = new Set(['http', 'https', 'ws', 'wss']);

/**
 * Read a RESOLVED URL string the way the HTTP client (axios, i.e. the WHATWG URL parser) will.
 * The authority segment is cut out FIRST (text between the scheme separator and the first of / ? # \, as the
 * WHATWG parser does for http(s)), and only a placeholder left in the HOST part of that segment makes the URL
 * "unresolved" (a `{{x}}` in the path or query does not). Anything ambiguous is flagged "refuse":
 * control characters / spaces / tab / newline in the scheme or authority (the parser silently drops some of
 * them), an authority the parser and an isolated parse of the host part disagree about, an unparseable one.
 * @returns {{kind:'host',host:string}|{kind:'unresolved',text:string}|{kind:'refuse',text:string}|{kind:'invalid'}}
 */
function classifyUrl(resolved) {
  if (typeof resolved !== 'string') return { kind: 'invalid' };
  // linear trim of control characters and spaces (a regex with two anchored alternatives is quadratic on long runs)
  let a = 0;
  let b = resolved.length;
  while (a < b && resolved.charCodeAt(a) <= 32) a++;
  while (b > a && resolved.charCodeAt(b - 1) <= 32) b--;
  const s = resolved.slice(a, b);
  if (s === '') return { kind: 'invalid' };
  const m = /^([^:/?#\\]*):([/\\]*)/.exec(s);
  if (!m) return UNRESOLVED_RE.test(s) ? { kind: 'unresolved', text: s } : { kind: 'invalid' };
  let scheme = m[1].toLowerCase();
  if (UNRESOLVED_RE.test(scheme)) {
    // the scheme itself is a placeholder: still read the authority when it is introduced by "//"
    if (!s.slice(m[1].length + 1).startsWith('//')) return { kind: 'unresolved', text: s };
    scheme = 'http';
  } else if (CONTROL_RE.test(scheme)) {
    return { kind: 'refuse', text: s }; // "ht\ttp://": the parser drops the tab; the WHOLE text is kept so a changed authority is never taken for "unchanged"
  } else if (!SCHEMES.has(scheme)) {
    return { kind: 'invalid' };
  }
  const rest = s.slice(m[0].length);
  const end = rest.search(/[/?#\\]/);
  const region = end < 0 ? rest : rest.slice(0, end);
  const hostPart = region.slice(region.lastIndexOf('@') + 1);
  if (UNRESOLVED_RE.test(hostPart)) return { kind: 'unresolved', text: hostPart.toLowerCase() };
  if (hostPart === '' || CONTROL_RE.test(region)) return { kind: 'refuse', text: region };
  try {
    const full = new URL(`${scheme}://${rest}`).host;
    const alone = new URL(`${scheme}://${hostPart}/`).host;
    if (!full || full !== alone) return { kind: 'refuse', text: region };
    return { kind: 'host', host: full };
  } catch {
    return { kind: 'refuse', text: region };
  }
}

/** Mirror of the engine's applyPathVariables (:name segments of url.variable). */
function applyPathVariables(url, variables, vars) {
  let out = url;
  for (const v of Array.isArray(variables) ? variables : []) {
    if (!v || v.disabled) continue;
    const key = resolveVariables(v.key || '', vars);
    if (!key) continue;
    const value = encodeURIComponent(resolveVariables(v.value || '', vars));
    out = out.replace(new RegExp(`:${String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=/|$|\\?|#)`, 'g'), value);
  }
  return out;
}

// dynamic tokens ({{$guid}}, ...) are random: replace them so baseline and effective strings stay comparable
const neutralize = (raw) => (typeof raw === 'string' ? raw.replace(/\{\{\s*\$[^{}]*\}\}/g, 'dyn') : raw);

/** (vars) => resolved URL string, exactly as the engine's resolveUrl builds it. null when there is no URL. */
function requestUrlResolver(req) {
  const u = req && req.url;
  if (typeof u === 'string') return u === '' ? null : (vars) => resolveVariables(neutralize(u), vars);
  if (!u || typeof u !== 'object') return null;
  if (typeof u.raw === 'string' && u.raw) return (vars) => applyPathVariables(resolveVariables(neutralize(u.raw), vars), u.variable, vars);
  const protocol = String(u.protocol || 'https').replace('://', '');
  const host = (Array.isArray(u.host) ? u.host.join('.') : u.host) || '';
  const path = (Array.isArray(u.path) ? u.path.join('/') : u.path) || '';
  if (!host) return null;
  return (vars) => applyPathVariables(resolveVariables(neutralize(`${protocol}://${host}/${String(path).replace(/^\//, '')}`), vars), u.variable, vars);
}

/** URL-valued fields of an auth block that the engine resolves with the variables (tokenUrl, authorizationUrl, refreshUrl, ...). */
function authUrlResolvers(auth) {
  const out = [];
  if (!auth || typeof auth !== 'object') return out;
  for (const [type, detail] of Object.entries(auth)) {
    if (type === 'type' || !detail || typeof detail !== 'object') continue;
    const pairs = Array.isArray(detail)
      ? detail.filter((r) => r && typeof r.key === 'string').map((r) => [r.key, r.value])
      : Object.entries(detail);
    for (const [key, value] of pairs.slice(0, 50)) {
      if (typeof value !== 'string' || value === '' || !/url|uri/i.test(key)) continue;
      out.push({ field: `auth.${type}.${key}`, resolve: (vars) => resolveVariables(neutralize(value), vars) });
    }
  }
  return out;
}

const enabledVars = (rows) => {
  const out = {};
  for (const v of Array.isArray(rows) ? rows : []) if (v && typeof v.key === 'string' && v.key && !v.disabled) out[v.key] = v.value == null ? '' : String(v.value);
  return out;
};

const describeSide = (c) => (c.kind === 'host' ? c.host : (c.kind === 'unresolved' ? '(not defined by the collection or environment)' : '(an ambiguous or unparseable authority)'));

/**
 * Agent-supplied `variables` / `data` must not redirect a request, nor an auth endpoint (OAuth tokenUrl, ...),
 * to another host. BEST EFFORT, not a security boundary: it covers the URL of every request and the URL fields
 * of every auth block (request, folder, collection), NOT what scripts do with pm.variables / pm.sendRequest.
 * For each of those URLs the host (WHATWG parse, the one the HTTP client uses) obtained with the agent's values
 * is compared with the host obtained WITHOUT them (collection variables + environment).
 *  - same host: fine (the agent may change a path/query placeholder, never the authority);
 *  - different host, or an ambiguous authority (control characters, parser disagreement): refused;
 *  - no baseline (the host is defined only by the agent's values): refused with `anyHost` (nothing but the
 *    agent vouches for it, the --allow-host list does not exist); with --allow-host the list stays the only authority.
 * Precedence mirrors the engine: collection vars < agent variables < environment < data row.
 * @returns {{request:string, field:string, from:string, to:string, noBaseline?:boolean}|null} the first violation
 */
function findHostOverride(collection, { environment = {}, variables = {}, dataRows = [null], anyHost = false } = {}) {
  const collVars = enabledVars(collection && collection.variable);
  const base = { ...collVars, ...environment };
  const fulls = (dataRows && dataRows.length ? dataRows : [null]).map((row) => ({ ...collVars, ...variables, ...environment, ...(row || {}) }));
  const check = (label, field, resolve) => {
    const from = classifyUrl(resolve(base));
    for (const full of fulls) {
      const to = classifyUrl(resolve(full));
      if (to.kind === 'invalid' && from.kind !== 'host') continue;
      if (to.kind === 'host' && from.kind === 'host' && to.host === from.host) continue;
      if ((to.kind === 'unresolved' || to.kind === 'refuse') && to.kind === from.kind && to.text === from.text) continue; // the agent changed nothing here
      if (to.kind === 'host' && (from.kind === 'unresolved' || from.kind === 'invalid')) {
        if (!anyHost) continue; // --allow-host: the list is the authority
        return { request: label, field, from: describeSide(from), to: to.host, noBaseline: true };
      }
      if (to.kind === 'unresolved' && from.kind === 'invalid') continue;
      return { request: label, field, from: describeSide(from), to: describeSide(to) };
    }
    return null;
  };
  let hit = null;
  const checkAuth = (auth, label) => {
    for (const r of authUrlResolvers(auth)) { hit = hit || check(label, r.field, r.resolve); }
  };
  checkAuth(collection && collection.auth, '(collection)');
  (function walk(items, names, depth) {
    if (hit || !Array.isArray(items) || depth > MAX_DEPTH) return;
    for (const node of items) {
      if (hit) return;
      if (!node || typeof node !== 'object') continue;
      const here = names.concat(typeof node.name === 'string' ? node.name : '(unnamed)');
      const label = here.join('/');
      if (isFolder(node)) {
        checkAuth(node.auth, label);
        walk(node.item, here, depth + 1);
        continue;
      }
      const resolve = requestUrlResolver(node.request);
      if (resolve) hit = check(label, 'url', resolve);
      if (!hit) checkAuth(node.request && node.request.auth, label);
    }
  }(collection && collection.item, [], 0));
  return hit;
}

module.exports = { findHostOverride, classifyUrl, listNodes, findNode, countRequests, buildRunTree, describeRequest, isNonHttp, isFolder, urlRaw, redactAuth };
