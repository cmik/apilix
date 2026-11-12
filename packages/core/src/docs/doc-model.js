'use strict';

/**
 * Build a neutral, redacted documentation model from a Postman-style collection.
 * Pure: no I/O, no clocks, no randomness. Every renderer consumes this model.
 */

const redact = require('./doc-redact');

const NON_HTTP_TYPES = new Set(['mongodb', 'sql', 'database']);
const NON_HTTP_METHODS = new Set(['MONGO', 'MYSQL', 'POSTGRESQL', 'SQLITE', 'CASSANDRA', 'ORACLE', 'MSSQL', 'REDIS', 'DYNAMODB']);

function descText(d) {
  if (!d) return '';
  if (typeof d === 'string') return d;
  if (typeof d === 'object' && typeof d.content === 'string') return d.content;
  return '';
}

function isEnabled(entry) {
  return entry && entry.disabled !== true && entry.enabled !== false;
}

function authParam(list, key) {
  if (!Array.isArray(list)) return '';
  const hit = list.find(e => e && e.key === key);
  return hit && hit.value != null ? String(hit.value) : '';
}

/** Build a variable resolver that never touches secrets and never emits dynamic values. */
function createResolver(options) {
  if (options.variableMode !== 'resolve') return s => s;
  const blocked = new Set(options.secretVariableKeys || []);
  const vars = options.variables || {};
  return function resolve(str) {
    if (typeof str !== 'string' || !str.includes('{{')) return str;
    return str.replace(/\{\{([^{}]+)\}\}/g, (match, key) => {
      const name = key.trim();
      if (name.startsWith('$')) return match;
      if (blocked.has(name) || redact.isSensitiveName(name)) return match;
      return Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined ? String(vars[name]) : match;
    });
  };
}

function splitUrl(raw) {
  let text = String(raw || '').trim();
  const hash = text.indexOf('#');
  if (hash >= 0) text = text.slice(0, hash);
  const q = text.indexOf('?');
  const queryString = q >= 0 ? text.slice(q + 1) : '';
  const beforeQuery = q >= 0 ? text.slice(0, q) : text;
  const m = beforeQuery.match(/^((?:[a-z][a-z0-9+.-]*:\/\/)?[^/]*)(\/.*)?$/i);
  const base = m ? m[1] : '';
  const path = (m && m[2]) || '/';
  return { base, path, queryString };
}

function parseQueryString(qs) {
  if (!qs) return [];
  return qs.split('&').filter(Boolean).map(pair => {
    const i = pair.indexOf('=');
    return i < 0 ? { key: pair, value: '' } : { key: pair.slice(0, i), value: pair.slice(i + 1) };
  });
}

function buildAuth(auth, source, options) {
  if (!auth || !auth.type || auth.type === 'inherit') return null;
  const inc = options.includeCredentials === true;
  const out = { type: auth.type, source };
  const field = (key, value) => ({ key, value: redact.redactValue(value, inc) });
  switch (auth.type) {
    case 'bearer':
      out.fields = [field('token', authParam(auth.bearer, 'token'))];
      break;
    case 'basic':
      out.fields = [field('username', authParam(auth.basic, 'username')), field('password', authParam(auth.basic, 'password'))];
      break;
    case 'apikey': {
      out.name = authParam(auth.apikey, 'key') || 'X-API-Key';
      out.in = authParam(auth.apikey, 'in') === 'query' ? 'query' : 'header';
      out.fields = [field('value', authParam(auth.apikey, 'value'))];
      break;
    }
    case 'oauth2': {
      const o = auth.oauth2 || {};
      out.oauth2 = {
        grantType: o.grantType || 'authorization_code',
        authorizationUrl: o.authorizationUrl ? redact.redactUrl(String(o.authorizationUrl), inc) : undefined,
        tokenUrl: o.tokenUrl ? redact.redactUrl(String(o.tokenUrl), inc) : undefined,
        scopes: Array.isArray(o.scopes) ? o.scopes.filter(Boolean) : undefined,
      };
      out.fields = [];
      if (o.clientId) out.fields.push(field('clientId', o.clientId));
      if (o.clientSecret) out.fields.push(field('clientSecret', o.clientSecret));
      if (o.accessToken) out.fields.push(field('accessToken', o.accessToken));
      break;
    }
    default:
      break;
  }
  return out;
}

function buildBody(body, resolve, options) {
  if (!body || !body.mode || body.mode === 'none') return null;
  const inc = options.includeCredentials === true;
  const kv = list => (Array.isArray(list) ? list : []).filter(isEnabled).map(f => {
    const entry = { key: String(f.key ?? ''), value: '' };
    const isFile = f.type === 'file';
    if (isFile) entry.type = 'file';
    const rawVal = f.value == null ? '' : String(f.value);
    entry.value = redact.isSensitiveName(entry.key) && !inc ? redact.redactValue(rawVal, false) : resolve(rawVal);
    if (f.description) entry.description = descText(f.description);
    return entry;
  });
  const text = t => redact.redactBodyText(resolve(String(t ?? '')), inc);
  switch (body.mode) {
    case 'raw':
      return { mode: 'raw', language: (body.options && body.options.raw && body.options.raw.language) || 'text', raw: text(body.raw) };
    case 'urlencoded':
      return { mode: 'urlencoded', fields: kv(body.urlencoded) };
    case 'formdata':
      return { mode: 'formdata', fields: kv(body.formdata) };
    case 'file':
      return { mode: 'file' };
    case 'graphql':
      return {
        mode: 'graphql',
        graphql: {
          query: resolve(String((body.graphql && body.graphql.query) || '')),
          variables: body.graphql && body.graphql.variables ? text(body.graphql.variables) : undefined,
        },
      };
    default:
      return null;
  }
}

function buildExamples(item, options) {
  if (options.includeExamples === false || !Array.isArray(item.response)) return [];
  const inc = options.includeCredentials === true;
  return item.response.filter(r => r && typeof r === 'object').map((r, i) => {
    const headers = (Array.isArray(r.header) ? r.header : []).filter(isEnabled).map(h => ({
      key: String(h.key ?? ''),
      value: redact.redactUrlsInText(redact.redactHeaderValue(h.key, h.value == null ? '' : String(h.value), inc), inc),
    }));
    const ex = {
      name: r.name ? String(r.name) : `Example ${i + 1}`,
      status: r.status ? String(r.status) : undefined,
      code: typeof r.code === 'number' ? r.code : undefined,
      headers,
      body: typeof r.body === 'string' ? redact.redactBodyText(r.body, inc) : undefined,
      language: r._postman_previewlanguage ? String(r._postman_previewlanguage) : undefined,
    };
    if (r.originalRequest && typeof r.originalRequest === 'object') {
      const o = r.originalRequest;
      const url = typeof o.url === 'string' ? o.url : (o.url && o.url.raw) || '';
      ex.originalRequest = {
        method: o.method ? String(o.method) : undefined,
        url: url ? redact.redactUrl(String(url), inc).split('?')[0] : undefined,
        body: o.body && o.body.mode === 'raw' ? redact.redactBodyText(String(o.body.raw ?? ''), inc) : undefined,
      };
    }
    return ex;
  });
}

function buildRequest(item, ctx) {
  const { options, resolve, folderPath, auth, authSource, index } = ctx;
  const inc = options.includeCredentials === true;
  const req = item.request;
  const urlObj = typeof req.url === 'string' ? { raw: req.url } : (req.url || { raw: '' });
  // Resolve, then strip userinfo over the WHOLE raw URL before splitting, so
  // passwords containing '/' or '@' cannot leak through the base/path split.
  const safeRaw = redact.redactUrlUserinfo(resolve(String(urlObj.raw || '')), inc);
  const { base, path, queryString } = splitUrl(safeRaw);

  const baseUrl = base;
  const pathStr = path;

  const rawQuery = Array.isArray(urlObj.query) && urlObj.query.length ? urlObj.query : parseQueryString(queryString);
  const query = rawQuery.filter(isEnabled).map(q => {
    const key = String(q.key ?? '');
    const val = q.value == null ? '' : String(q.value);
    const e = { key, value: redact.isSensitiveName(key) && !inc ? redact.redactValue(val, false) : resolve(val) };
    if (q.description) e.description = descText(q.description);
    return e;
  });

  const pathVarDefs = Array.isArray(urlObj.variable) ? urlObj.variable : [];
  const pathVariables = [];
  const seen = new Set();
  const addPathVar = (key, value, desc) => {
    if (seen.has(key)) return;
    seen.add(key);
    const val = value == null ? '' : String(value);
    const e = { key, value: redact.isSensitiveName(key) && !inc ? redact.redactValue(val, false) : resolve(val) };
    if (desc) e.description = descText(desc);
    pathVariables.push(e);
  };
  for (const seg of pathStr.split('/')) {
    const m = seg.match(/^:([A-Za-z_][\w-]*)$/);
    if (!m) continue;
    const def = pathVarDefs.find(v => v && v.key === m[1]);
    addPathVar(m[1], def ? def.value : '', def && def.description);
  }

  const headers = (Array.isArray(req.header) ? req.header : []).filter(isEnabled).map(h => {
    const key = String(h.key ?? '');
    const val = h.value == null ? '' : String(h.value);
    const e = { key, value: redact.isSensitiveHeader(key) && !inc ? redact.redactValue(val, false) : redact.redactUrlsInText(resolve(val), inc) };
    if (h.description) e.description = descText(h.description);
    return e;
  });

  const url = `${baseUrl}${pathStr === '/' && baseUrl ? '' : pathStr}` || '/';
  const qs = query.map(q => (q.value === '' ? q.key : `${q.key}=${q.value}`)).join('&');

  return {
    id: item.id ? String(item.id) : `item-${index}`,
    name: String(item.name ?? ''),
    method: String(req.method || 'GET').toUpperCase(),
    url,
    fullUrl: qs ? `${url}?${qs}` : url,
    baseUrl,
    path: pathStr,
    folderPath: folderPath.slice(),
    description: descText(req.description) || descText(item.description),
    headers,
    query,
    pathVariables,
    body: buildBody(req.body, resolve, options),
    auth: buildAuth(auth, authSource, options),
    examples: buildExamples(item, options),
  };
}

function isNonHttp(item) {
  const r = item.request;
  if (r.requestType && NON_HTTP_TYPES.has(r.requestType)) return true;
  return NON_HTTP_METHODS.has(String(r.method || '').toUpperCase());
}

function findFolder(items, spec, trail) {
  const wanted = String(spec).split('/').map(s => s.trim()).filter(Boolean);
  for (const it of items || []) {
    if (!Array.isArray(it.item)) continue;
    const here = trail.concat(it.name);
    if ((it.id && String(it.id) === spec) || (wanted.length > 1 && here.join('/') === wanted.join('/')) || (wanted.length === 1 && it.name === wanted[0])) {
      return it;
    }
    const deeper = findFolder(it.item, spec, here);
    if (deeper) return deeper;
  }
  return null;
}

function buildDocModel(collection, options = {}) {
  if (!collection || !collection.info || !Array.isArray(collection.item)) {
    throw new Error('Collection must contain info and item[]');
  }
  const opts = options || {};
  const resolve = createResolver(Object.assign({}, opts, {
    variables: Object.assign({}, collectionVarMap(collection), opts.variables || {}),
  }));
  const warnings = [];
  const requests = [];
  let counter = 0;

  let target = null;
  if (opts.folder) {
    target = findFolder(collection.item, opts.folder, []);
    if (!target) throw new Error(`Folder not found: ${opts.folder}`);
  }

  let folderCounter = 0;

  function walk(items, folderPath, inheritedAuth, inheritedSource, inScope) {
    const nodes = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (Array.isArray(item.item)) {
        const own = item.auth && item.auth.type && item.auth.type !== 'inherit' ? item.auth : null;
        const isTarget = item === target;
        const childScope = inScope || isTarget;
        const childPath = childScope ? folderPath.concat(String(item.name ?? '')) : [];
        const folderId = item.id ? String(item.id) : `folder-${++folderCounter}`;
        const children = walk(item.item, childPath, own || inheritedAuth, own ? 'folder' : inheritedSource, childScope);
        if (isTarget || !childScope) {
          // The scoped root is hoisted; out-of-scope ancestors only pass descendants through.
          nodes.push(...children);
        } else {
          nodes.push({ type: 'folder', id: folderId, name: String(item.name ?? ''), description: descText(item.description), children });
        }
      } else if (item.request && inScope) {
        if (isNonHttp(item)) {
          warnings.push(`Skipped non-HTTP request "${item.name}" (${item.request.requestType || item.request.method}).`);
          continue;
        }
        const own = item.request.auth && item.request.auth.type && item.request.auth.type !== 'inherit' ? item.request.auth : null;
        const model = buildRequest(item, {
          options: opts,
          resolve,
          folderPath,
          auth: own || inheritedAuth,
          authSource: own ? 'request' : inheritedSource,
          index: ++counter,
        });
        requests.push(model);
        nodes.push({ type: 'request', id: model.id, name: model.name, request: model });
      }
    }
    return nodes;
  }

  const rootAuth = collection.auth && collection.auth.type && collection.auth.type !== 'inherit' ? collection.auth : null;
  const tree = walk(collection.item, [], rootAuth, 'collection', !target);

  const variables = (Array.isArray(collection.variable) ? collection.variable : []).filter(v => v && v.key && isEnabled(v)).map(v => {
    const val = v.value == null ? '' : String(v.value);
    const secretKey = Array.isArray(opts.secretVariableKeys) && opts.secretVariableKeys.includes(String(v.key));
    const e = { key: String(v.key), value: (redact.isSensitiveName(v.key) || secretKey) && !opts.includeCredentials ? redact.redactValue(val, false) : val };
    if (v.description) e.description = descText(v.description);
    return e;
  });

  const baseTitle = opts.title || String(collection.info.name || 'API Documentation');
  return {
    title: opts.title || (target ? `${baseTitle} / ${target.name}` : baseTitle),
    description: descText(collection.info.description) + (target && descText(target.description) ? `\n\n${descText(target.description)}` : ''),
    auth: buildAuth(rootAuth, 'collection', opts),
    variables,
    tree,
    requests,
    warnings,
  };
}

function collectionVarMap(collection) {
  const out = {};
  for (const v of Array.isArray(collection.variable) ? collection.variable : []) {
    if (v && v.key && isEnabled(v)) out[v.key] = v.value == null ? '' : String(v.value);
  }
  return out;
}

/** Generate snippets for a request using the injected language registry. */
function buildSnippets(request, options, deps, warnings) {
  const ids = options.snippetLanguages || [];
  const registry = (deps && deps.snippetLanguages) || [];
  const out = [];
  for (const id of ids) {
    const lang = registry.find(l => l.id === id);
    if (!lang) {
      const msg = `Unknown snippet language "${id}".`;
      if (warnings && !warnings.includes(msg)) warnings.push(msg);
      continue;
    }
    try {
      const code = lang.generate(request);
      if (typeof code === 'string' && code) out.push({ id: lang.id, label: lang.label, code });
    } catch (err) {
      const msg = `Snippet generation failed for "${request.name}" (${id}): ${err && err.message}`;
      if (warnings) warnings.push(msg);
    }
  }
  return out;
}

module.exports = { buildDocModel, buildSnippets, createResolver, splitUrl, descText };
