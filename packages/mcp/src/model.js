'use strict';

/**
 * Collection tree helpers: listing, lookup, pruning for runs, and the redacted request view.
 * Pure functions (no I/O).
 */

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
 * Non-HTTP requests are dropped and reported; per-request proxy settings are stripped.
 */
function buildRunTree(collection, targetPos) {
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
          for (const k of ['proxyEnabled', 'httpProxy', 'httpsProxy', 'noProxy']) delete copy.request.requestSettings[k];
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
  const fields = {};
  if (Array.isArray(detail)) {
    for (const row of detail.slice(0, 30)) if (row && typeof row.key === 'string') fields[row.key] = redactor.value(row.value);
  } else if (detail && typeof detail === 'object') {
    for (const [k, v] of Object.entries(detail).slice(0, 30)) if (typeof v !== 'object') fields[k] = redactor.value(v);
  }
  if (Object.keys(fields).length) out.fields = fields;
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

module.exports = { listNodes, findNode, countRequests, buildRunTree, describeRequest, isNonHttp, isFolder, urlRaw, redactAuth };
