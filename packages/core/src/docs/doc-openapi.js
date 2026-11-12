'use strict';

/**
 * Convert a documentation model into an OpenAPI 3.0.3 (default) or 3.1.0 object.
 * Returns { spec, warnings }. Pure and deterministic.
 */

const { REDACTED } = require('./doc-redact');

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const IGNORED_HEADER_PARAMS = new Set(['content-type', 'accept', 'authorization']);

function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9_.-]/g, '_') || '_';
}

/** {{var}} -> {var}; returns the template and the variable names found. */
function templateVars(str, found) {
  return String(str).replace(/\{\{\s*([^{}\s](?:[^{}]*?[^{}\s])?)\s*\}\}/g, (m, name) => {
    const n = safeName(name);
    if (found) found.add(n);
    return `{${n}}`;
  });
}

function toPathTemplate(path) {
  const names = [];
  const converted = path.split('/').map(seg => {
    const m = seg.match(/^:([A-Za-z_][\w-]*)$/);
    if (m) { names.push({ name: m[1], fromVar: false }); return `{${m[1]}}`; }
    return seg.replace(/\{\{\s*([^{}\s](?:[^{}]*?[^{}\s])?)\s*\}\}/g, (mm, v) => {
      const n = safeName(v);
      names.push({ name: n, fromVar: true });
      return `{${n}}`;
    });
  }).join('/');
  return { template: converted.startsWith('/') ? converted : `/${converted}`, names };
}

function camelCase(text) {
  const words = String(text).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return '';
  return words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('');
}

function inferSchema(value, v31) {
  if (value === null) return v31 ? { type: 'null' } : { nullable: true };
  if (Array.isArray(value)) return { type: 'array', items: value.length ? inferSchema(value[0], v31) : {} };
  switch (typeof value) {
    case 'string': return { type: 'string' };
    case 'boolean': return { type: 'boolean' };
    case 'number': return { type: Number.isInteger(value) ? 'integer' : 'number' };
    case 'object': {
      const properties = {};
      for (const [k, v] of Object.entries(value)) properties[k] = inferSchema(v, v31);
      return { type: 'object', properties };
    }
    default: return {};
  }
}

function tryJson(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

function mimeFromLanguage(lang) {
  switch (lang) {
    case 'json': return 'application/json';
    case 'xml': return 'application/xml';
    case 'html': return 'text/html';
    case 'javascript': return 'application/javascript';
    default: return 'text/plain';
  }
}

function headerValue(headers, name) {
  const h = (headers || []).find(e => e.key.toLowerCase() === name);
  return h ? h.value : '';
}

function mediaFromText(text, mime, v31, isRequestExample) {
  const media = {};
  if (/json/i.test(mime)) {
    const parsed = tryJson(text);
    if (parsed.ok) {
      media.schema = inferSchema(parsed.value, v31);
      return { media, example: parsed.value };
    }
  }
  media.schema = { type: 'string' };
  return { media, example: text };
}

function buildRequestBody(req, v31, markAi) {
  const body = req.body;
  if (!body) return null;
  const ctHeader = headerValue(req.headers, 'content-type').split(';')[0].trim();
  const fieldsSchema = (fields, fileAware) => {
    const properties = {};
    for (const f of fields) {
      properties[f.key] = fileAware && f.type === 'file'
        ? { type: 'string', format: 'binary' }
        : { type: 'string' };
      if (f.description) properties[f.key].description = f.description;
      if (f.description && f.descriptionSource === 'ai' && markAi) properties[f.key]['x-generated-by'] = 'ai';
    }
    return { type: 'object', properties };
  };
  const fieldsExample = fields => {
    const ex = {};
    for (const f of fields) if (f.type !== 'file' && f.value !== REDACTED) ex[f.key] = f.value;
    return ex;
  };
  switch (body.mode) {
    case 'raw': {
      const mime = ctHeader || mimeFromLanguage(body.language);
      const { media, example } = mediaFromText(body.raw || '', mime, v31);
      if (example !== '' && example !== undefined) media.example = example;
      return { content: { [mime]: media } };
    }
    case 'urlencoded':
      return { content: { 'application/x-www-form-urlencoded': { schema: fieldsSchema(body.fields || [], false), example: fieldsExample(body.fields || []) } } };
    case 'formdata':
      return { content: { 'multipart/form-data': { schema: fieldsSchema(body.fields || [], true), example: fieldsExample(body.fields || []) } } };
    case 'file':
      return { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
    case 'graphql': {
      const example = { query: body.graphql.query };
      const vars = body.graphql.variables ? tryJson(body.graphql.variables) : { ok: false };
      if (vars.ok) example.variables = vars.value;
      return {
        content: {
          'application/json': {
            schema: { type: 'object', properties: { query: { type: 'string' }, variables: { type: 'object' } }, required: ['query'] },
            example,
          },
        },
      };
    }
    default:
      return null;
  }
}

function buildResponses(req, v31) {
  const responses = {};
  for (const ex of req.examples) {
    const code = ex.code || parseInt(ex.status, 10);
    const key = Number.isFinite(code) && code >= 100 && code < 600 ? String(code) : 'default';
    const entry = responses[key] || (responses[key] = { description: ex.status ? String(ex.status).replace(/^\d+\s*/, '') || ex.name : ex.name });
    if (ex.body === undefined || ex.body === '') continue;
    const mime = headerValue(ex.headers, 'content-type').split(';')[0].trim() || mimeFromLanguage(ex.language);
    const { media, example } = mediaFromText(ex.body, mime, v31);
    entry.content = entry.content || {};
    const slot = entry.content[mime] || (entry.content[mime] = { schema: media.schema, examples: {} });
    let name = safeName(ex.name);
    let i = 2;
    while (slot.examples[name]) name = `${safeName(ex.name)}_${i++}`;
    slot.examples[name] = { summary: ex.name, value: example };
  }
  if (!Object.keys(responses).length) responses.default = { description: 'Default response' };
  return responses;
}

function buildOpenApi(model, options = {}, extraWarnings = []) {
  const v31 = options.openapiVersion === '3.1.0';
  const markAi = options.markAiContent !== false;
  const warnings = extraWarnings.slice();
  const schemes = {};
  const schemeKeys = new Map();
  const servers = [];
  const serverIndex = new Map();
  const varDefaults = {};
  for (const v of model.variables) if (v.value !== REDACTED) varDefaults[safeName(v.key)] = v.value;

  function registerServer(base) {
    if (!base) return null;
    if (serverIndex.has(base)) return serverIndex.get(base);
    const found = new Set();
    const url = templateVars(base.replace(/^([a-z][a-z0-9+.-]*:\/\/)<redacted>@/i, '$1'), found);
    const server = { url };
    if (found.size) {
      server.variables = {};
      for (const n of [...found].sort()) server.variables[n] = { default: varDefaults[n] || '' };
    }
    serverIndex.set(base, server);
    servers.push(server);
    return server;
  }

  function schemeFor(auth) {
    if (!auth) return null;
    let def; let prefix;
    switch (auth.type) {
      case 'bearer': def = { type: 'http', scheme: 'bearer' }; prefix = 'bearerAuth'; break;
      case 'basic': def = { type: 'http', scheme: 'basic' }; prefix = 'basicAuth'; break;
      case 'digest': def = { type: 'http', scheme: 'digest' }; prefix = 'digestAuth'; break;
      case 'apikey': def = { type: 'apiKey', in: auth.in || 'header', name: auth.name || 'X-API-Key' }; prefix = 'apiKeyAuth'; break;
      case 'oauth2': {
        const o = auth.oauth2 || {};
        if (o.grantType === 'refresh_token') {
          warnings.push('OAuth2 grant type "refresh_token" cannot be expressed as an OpenAPI flow; omitted.');
          return null;
        }
        const scopes = {};
        for (const s of o.scopes || []) scopes[s] = '';
        const tokenUrl = o.tokenUrl ? templateVars(o.tokenUrl) : '';
        const authorizationUrl = o.authorizationUrl ? templateVars(o.authorizationUrl) : '';
        const flows = o.grantType === 'client_credentials'
          ? { clientCredentials: { tokenUrl, scopes } }
          : { authorizationCode: { authorizationUrl, tokenUrl, scopes } };
        def = { type: 'oauth2', flows };
        prefix = 'oauth2Auth';
        break;
      }
      case 'noauth': return null;
      default:
        warnings.push(`Unsupported auth type "${auth.type}" cannot be expressed in OpenAPI; omitted.`);
        return null;
    }
    const sig = JSON.stringify(def);
    if (schemeKeys.has(sig)) return schemeKeys.get(sig);
    let name = prefix; let i = 2;
    while (schemes[name]) name = `${prefix}${i++}`;
    schemes[name] = def;
    const ref = { name, scopes: auth.type === 'oauth2' && auth.oauth2 && auth.oauth2.scopes ? auth.oauth2.scopes.slice() : [] };
    schemeKeys.set(sig, ref);
    return ref;
  }

  const rootScheme = model.auth ? schemeFor(model.auth) : null;
  const rootHasAuth = !!rootScheme;

  const paths = {};
  const usedIds = new Set();
  const tagDescriptions = new Map();
  (function collectTags(nodes, trail) {
    for (const n of nodes) {
      if (n.type !== 'folder') continue;
      const t = trail.concat(n.name);
      if (n.description) tagDescriptions.set(t.join(' / '), n.description);
      collectTags(n.children || [], t);
    }
  })(model.tree, []);
  const tagOrder = [];

  for (const req of model.requests) {
    const method = req.method.toLowerCase();
    if (!HTTP_METHODS.has(method)) {
      warnings.push(`Skipped "${req.name}": method ${req.method} is not supported by OpenAPI.`);
      continue;
    }
    const { template, names } = toPathTemplate(req.path);
    const server = registerServer(req.baseUrl);
    const pathItem = paths[template] || (paths[template] = {});
    if (pathItem[method]) {
      warnings.push(`Skipped "${req.name}": duplicate operation ${req.method} ${template}.`);
      continue;
    }

    let opId = camelCase(req.name) || camelCase(`${method} ${template}`) || method;
    if (!/^[A-Za-z]/.test(opId)) opId = `op${opId}`;
    let uniqueId = opId; let n = 2;
    while (usedIds.has(uniqueId)) uniqueId = `${opId}${n++}`;
    usedIds.add(uniqueId);

    const op = { summary: req.name, operationId: uniqueId };
    if (req.description) op.description = req.description;
    if (req.description && req.descriptionSource === 'ai' && markAi) op['x-generated-by'] = 'ai';
    if (req.folderPath.length) {
      const tag = req.folderPath.join(' / ');
      op.tags = [tag];
      if (!tagOrder.includes(tag)) tagOrder.push(tag);
    }

    const params = [];
    const seen = new Set();
    for (const { name } of names) {
      if (seen.has(`path:${name}`)) continue;
      seen.add(`path:${name}`);
      const def = req.pathVariables.find(p => safeName(p.key) === name);
      const p = { name, in: 'path', required: true, schema: { type: 'string' } };
      if (def && def.description) p.description = def.description;
      if (def && def.description && def.descriptionSource === 'ai' && markAi) p['x-generated-by'] = 'ai';
      if (def && def.value && def.value !== REDACTED) p.example = def.value;
      params.push(p);
    }
    for (const q of req.query) {
      if (seen.has(`query:${q.key}`)) continue;
      seen.add(`query:${q.key}`);
      const p = { name: q.key, in: 'query', required: false, schema: { type: 'string' } };
      if (q.description) p.description = q.description;
      if (q.description && q.descriptionSource === 'ai' && markAi) p['x-generated-by'] = 'ai';
      if (q.value && q.value !== REDACTED) p.example = q.value;
      params.push(p);
    }
    for (const h of req.headers) {
      const lower = h.key.toLowerCase();
      if (IGNORED_HEADER_PARAMS.has(lower) || seen.has(`header:${lower}`)) continue;
      seen.add(`header:${lower}`);
      const p = { name: h.key, in: 'header', required: false, schema: { type: 'string' } };
      if (h.description) p.description = h.description;
      if (h.description && h.descriptionSource === 'ai' && markAi) p['x-generated-by'] = 'ai';
      if (h.value && h.value !== REDACTED) p.example = h.value;
      params.push(p);
    }
    if (params.length) op.parameters = params;

    const body = buildRequestBody(req, v31, markAi);
    if (body) op.requestBody = body;
    op.responses = buildResponses(req, v31);

    if (req.auth) {
      if (req.auth.type === 'noauth') {
        if (rootHasAuth && req.auth.source !== 'collection') op.security = [];
      } else if (req.auth.source !== 'collection') {
        const ref = schemeFor(req.auth);
        if (ref) {
          op.security = [{ [ref.name]: ref.scopes }];
        } else if (rootHasAuth) {
          // The request's own auth is not representable: do not silently inherit the root scheme.
          op.security = [];
          warnings.push(`Request "${req.name}" uses auth (${req.auth.type}) that cannot be expressed in OpenAPI; security set to [] so it does not inherit the collection auth.`);
        }
      }
    }
    if (server && servers.length > 1) op.servers = [server];
    pathItem[method] = op;
  }

  // Operations registered before a second server appeared need an explicit server.
  if (servers.length > 1) {
    for (const req of model.requests) {
      const { template } = toPathTemplate(req.path);
      const op = paths[template] && paths[template][req.method.toLowerCase()];
      if (op && op.summary === req.name && !op.servers && serverIndex.get(req.baseUrl)) op.servers = [serverIndex.get(req.baseUrl)];
    }
  }

  const spec = {
    openapi: v31 ? '3.1.0' : '3.0.3',
    info: { title: model.title, version: '1.0.0' },
  };
  if (model.description) spec.info.description = model.description;
  if (servers.length) spec.servers = servers;
  if (tagOrder.length) spec.tags = tagOrder.map(name => (tagDescriptions.has(name) ? { name, description: tagDescriptions.get(name) } : { name }));
  if (rootScheme) spec.security = [{ [rootScheme.name]: rootScheme.scopes }];
  spec.paths = paths;
  if (Object.keys(schemes).length) spec.components = { securitySchemes: schemes };
  return { spec, warnings };
}

module.exports = { buildOpenApi, toPathTemplate };
