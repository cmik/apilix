'use strict';

const axios = require('axios');
const http = require('http');
const https = require('https');
const FormData = require('form-data');
const vm = require('vm');
const JSON5 = require('json5');
const { MongoClient, ObjectId } = require('mongodb');
const { runScript } = require('./script-runtime');
const { refreshOAuth2Token } = require('./oauth');
const { makeHttpsAgent } = require('./tls-utils');

const MAX_RESULT_BYTES = 10 * 1024 * 1024;
const MAX_RUNTIME_MS = 1800 * 1000;
const DEFAULT_MONGO_LIMIT = 50;

function parseJsonObject(text, fallback = {}) {
  if (!text || !String(text).trim()) return fallback;
  try {
    const parsed = JSON5.parse(String(text));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonArray(text, fallback = []) {
  if (!text || !String(text).trim()) return fallback;
  try {
    const parsed = JSON5.parse(String(text));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function applyMongoAuthOptions(uri, auth) {
  if (!auth || !auth.mode) return uri;
  try {
    const parsed = new URL(uri);
    // The URL setter already percent-encodes userinfo characters — do NOT pre-encode
    // with encodeURIComponent or the result will be double-encoded in the final URI.
    if (auth.username) parsed.username = auth.username;
    if (auth.password) parsed.password = auth.password;
    if (auth.authSource) parsed.searchParams.set('authSource', auth.authSource);
    if (auth.mode === 'x509') parsed.searchParams.set('authMechanism', 'MONGODB-X509');
    if (auth.mode === 'ldap-plain') parsed.searchParams.set('authMechanism', 'PLAIN');
    if (auth.mode === 'oidc') parsed.searchParams.set('authMechanism', 'MONGODB-OIDC');
    return parsed.toString();
  } catch {
    return uri;
  }
}

function extractMongoConnection(config, vars, context) {
  const resolvedDatabase = resolveVariables(config.database || '', vars);
  // Resolve {{variable}} tokens in auth credentials before injecting into the URI.
  const resolvedAuth = config.auth ? {
    ...config.auth,
    username: resolveVariables(config.auth.username || '', vars) || undefined,
    password: resolveVariables(config.auth.password || '', vars) || undefined,
    authSource: resolveVariables(config.auth.authSource || '', vars) || undefined,
  } : config.auth;

  if (!config.connection || !config.connection.mode) {
    throw new Error('MongoDB request is missing a connection reference');
  }
  if (config.connection.mode === 'direct') {
    const uri = resolveVariables(config.connection.uri || '', vars);
    if (!uri) throw new Error('MongoDB direct connection URI is empty');
    return { uri: applyMongoAuthOptions(uri, resolvedAuth), database: resolvedDatabase };
  }

  const registry = (context && context.mongoConnections) || {};
  const found = registry[config.connection.connectionId];
  if (!found || !found.uri) {
    throw new Error(`MongoDB named connection "${config.connection.connectionId}" not found`);
  }
  const uri = resolveVariables(found.uri, vars);
  const db = resolvedDatabase || resolveVariables(found.database || '', vars);
  if (!db) throw new Error('MongoDB database is required');
  return { uri: applyMongoAuthOptions(uri, resolvedAuth), database: db };
}

function buildMongoDbApi(db, session) {
  return {
    collection(name) {
      const coll = db.collection(name);
      return {
        find: (filter = {}, options = {}) => coll.find(filter, { ...options, session }),
        aggregate: (pipeline = [], options = {}) => coll.aggregate(pipeline, { ...options, session }),
        insertOne: (doc, options = {}) => coll.insertOne(doc, { ...options, session }),
        insertMany: (docs, options = {}) => coll.insertMany(docs, { ...options, session }),
        updateOne: (filter, update, options = {}) => coll.updateOne(filter, update, { ...options, session }),
        updateMany: (filter, update, options = {}) => coll.updateMany(filter, update, { ...options, session }),
        deleteOne: (filter, options = {}) => coll.deleteOne(filter, { ...options, session }),
        deleteMany: (filter, options = {}) => coll.deleteMany(filter, { ...options, session }),
        countDocuments: (filter = {}, options = {}) => coll.countDocuments(filter, { ...options, session }),
        distinct: (field, filter = {}, options = {}) => coll.distinct(field, filter, { ...options, session }),
      };
    },
    ObjectId,
  };
}

async function executeMongoOperation(mongoCfg, vars, context) {
  const opStart = Date.now();
  const { uri, database } = extractMongoConnection(mongoCfg, vars, context);
  const maxTimeMS = Math.max(1, Math.min(MAX_RUNTIME_MS, parseInt(mongoCfg.maxTimeMS, 10) || MAX_RUNTIME_MS));
  // Declared outside execPromise so the timeout handler can force-close it
  // if the race resolves before the operation completes.
  let client;

  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`Mongo request timed out after ${maxTimeMS}ms`)), maxTimeMS);
  });

  const execPromise = (async () => {
    client = new MongoClient(uri, {
      maxPoolSize: 20,
      minPoolSize: 0,
      maxIdleTimeMS: 30000,
      serverSelectionTimeoutMS: Math.min(5000, maxTimeMS),
      connectTimeoutMS: Math.min(10000, maxTimeMS),
      socketTimeoutMS: Math.min(MAX_RUNTIME_MS, maxTimeMS),
    });
    await client.connect();
    const db = client.db(database);
    const collectionName = resolveVariables(mongoCfg.collection || '', vars);
    const operation = mongoCfg.operation || 'find';
    const useTransaction = mongoCfg.useTransaction === true;
    const session = useTransaction ? client.startSession() : null;

    const runInSession = async (fn) => {
      if (!session) return fn();
      let output;
      await session.withTransaction(async () => {
        output = await fn();
      });
      return output;
    };

    try {
      const payload = await runInSession(async () => {
        if (operation === 'script') {
          const sandbox = {
            db: buildMongoDbApi(db, session),
            BSON: { ObjectId },
            ObjectId,
            result: null,
            console: { log() {}, warn() {}, error() {}, info() {} },
            // ECMAScript built-ins — not present in a blank vm.runInNewContext context by default
            Date,
            Math,
            JSON,
            Array,
            Object,
            Number,
            String,
            Boolean,
            RegExp,
            Error,
            Buffer,
            parseInt,
            parseFloat,
            isNaN,
            isFinite,
          };
          const script = new vm.Script(String(mongoCfg.script || ''), { filename: 'apilix-mongo-script.js' });
          // Limit synchronous CPU time to 30 s regardless of maxTimeMS to avoid
          // blocking the event loop. Async/wall-clock timeout is handled by timeoutPromise.
          const vmSyncTimeout = Math.min(30000, maxTimeMS);
          let ret = script.runInNewContext(sandbox, { timeout: vmSyncTimeout });
          // The script may return a Promise (e.g. async function or .then chain).
          // vm.runInNewContext itself is synchronous but the returned Promise can
          // be awaited in this outer async context.
          if (ret && typeof ret.then === 'function') ret = await ret;
          return ret === undefined ? sandbox.result : ret;
        }

        if (!collectionName) throw new Error('MongoDB collection is required for this operation');
        const collection = db.collection(collectionName);
        const limit = Math.max(1, Math.min(5000, parseInt(mongoCfg.limit, 10) || DEFAULT_MONGO_LIMIT));
        if (operation === 'find') {
          const filter = parseJsonObject(resolveVariables(mongoCfg.filter || '{}', vars), {});
          const projection = parseJsonObject(resolveVariables(mongoCfg.projection || '{}', vars), undefined);
          const sort = parseJsonObject(resolveVariables(mongoCfg.sort || '{}', vars), undefined);
          const skip = Math.max(0, parseInt(mongoCfg.skip, 10) || 0);
          const cursor = collection.find(filter, { projection, sort, skip, limit, maxTimeMS, session: session || undefined });
          return await cursor.toArray();
        }
        if (operation === 'aggregate') {
          const pipeline = parseJsonArray(resolveVariables(mongoCfg.pipeline || '[]', vars), []);
          const cursor = collection.aggregate(pipeline, { maxTimeMS, session: session || undefined });
          return await cursor.limit(limit).toArray();
        }
        if (operation === 'insert') {
          const docs = parseJsonArray(resolveVariables(mongoCfg.documents || '[]', vars), []);
          if (docs.length === 0) throw new Error('Mongo insert requires at least one document');
          return docs.length === 1
            ? await collection.insertOne(docs[0], { session: session || undefined })
            : await collection.insertMany(docs, { session: session || undefined });
        }
        if (operation === 'update') {
          const filter = parseJsonObject(resolveVariables(mongoCfg.filter || '{}', vars), {});
          const update = parseJsonObject(resolveVariables(mongoCfg.update || '{}', vars), {});
          if (!update || Object.keys(update).length === 0) throw new Error('Mongo update requires an update document');
          return mongoCfg.updateMode === 'many'
            ? await collection.updateMany(filter, update, { session: session || undefined })
            : await collection.updateOne(filter, update, { session: session || undefined });
        }
        if (operation === 'delete') {
          const filter = parseJsonObject(resolveVariables(mongoCfg.filter || '{}', vars), {});
          return mongoCfg.deleteMode === 'many'
            ? await collection.deleteMany(filter, { session: session || undefined })
            : await collection.deleteOne(filter, { session: session || undefined });
        }
        if (operation === 'count') {
          const filter = parseJsonObject(resolveVariables(mongoCfg.filter || '{}', vars), {});
          return { count: await collection.countDocuments(filter, { maxTimeMS, session: session || undefined }) };
        }
        if (operation === 'distinct') {
          const filter = parseJsonObject(resolveVariables(mongoCfg.filter || '{}', vars), {});
          const field = resolveVariables(mongoCfg.distinctField || '', vars);
          if (!field) throw new Error('Mongo distinct requires distinctField');
          return await collection.distinct(field, filter, { maxTimeMS, session: session || undefined });
        }
        throw new Error(`Unsupported MongoDB operation "${operation}"`);
      });

      const prettyBody = JSON.stringify(payload, null, 2);
      const bodyBytes = Buffer.byteLength(prettyBody, 'utf8');
      const truncated = bodyBytes > MAX_RESULT_BYTES;
      const body = truncated
        ? prettyBody.slice(0, MAX_RESULT_BYTES) + '\n/* truncated: exceeded 10MB limit */'
        : prettyBody;

      return {
        protocol: 'mongodb',
        status: truncated ? 2400 : 2200,
        statusText: truncated ? 'MONGO_PARTIAL' : 'MONGO_SUCCESS',
        mongoStatus: truncated ? 'partial' : 'success',
        mongoOperation: operation,
        responseTime: Date.now() - opStart,
        body,
        jsonData: payload,
        size: Buffer.byteLength(body, 'utf8'),
      };
    } finally {
      if (session) await session.endSession();
      await client.close();
    }
  })();

  try {
    return await Promise.race([execPromise, timeoutPromise]);
  } catch (err) {
    // If the timeout won the race the execPromise may still be running and
    // holding the client open. Force-close it to release the socket immediately.
    if (client) await client.close().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

const httpClient = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  maxRedirects: 10,
  timeout: 30000,
  validateStatus: () => true, // never throw based on status code
});

/**
 * Ping a MongoDB server to verify connectivity.
 * Used by the /api/mongo/connections/:id/test endpoint — lives here so that
 * the server package does not need to declare mongodb as a direct dependency.
 *
 * @param {string} uri - MongoDB connection URI
 * @param {string} [database='admin'] - Database to ping
 * @returns {Promise<{ ok: boolean, latencyMs?: number, error?: string }>}
 */
async function executeMongoTest(uri, database = 'admin') {
  try {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 5000,
    });
    const start = Date.now();
    try {
      await client.connect();
      await client.db(database).command({ ping: 1 });
      return { ok: true, latencyMs: Date.now() - start };
    } finally {
      try { await client.close(); } catch (_) {}
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * List databases or collections via a short-lived MongoClient.
 * @param {string} uri - MongoDB connection URI
 * @param {'databases'|'collections'} operation - What to list
 * @param {string} [database] - Required when operation='collections'
 * @returns {Promise<{ databases?: string[], collections?: string[], error?: string }>}
 */
async function executeMongoIntrospect(uri, operation, database) {
  // Validate early so we never open a network connection unnecessarily
  if (operation === 'collections' && !database) {
    return { error: 'database is required for collections listing' };
  }
  try {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 5000,
    });
    try {
      await client.connect();
      if (operation === 'databases') {
        const result = await client.db().admin().listDatabases();
        return { databases: result.databases.map(d => d.name) };
      } else {
        const result = await client.db(database).listCollections().toArray();
        return { collections: result.map(c => c.name).sort() };
      }
    } finally {
      try { await client.close(); } catch (_) {}
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Runtime config (updated by POST /api/settings) ─────────────────────────────────────────────────

const executorConfig = {
  requestTimeout: 30000,
  followRedirects: true,
  sslVerification: false,
  proxyEnabled: false,
  httpProxy: '',
  httpsProxy: '',
  noProxy: '',
  /** PEM-encoded CA certificate(s) to add to the trust store. Only honoured when sslVerification is true. */
  customCAs: '',
  /** Per-host client certificates for mutual TLS (mTLS). */
  clientCertificates: [],
};

function setExecutorConfig(cfg) {
  Object.assign(executorConfig, cfg);
}

/**
 * Returns true if `pattern` matches `hostname`.
 * Supports exact match and leading wildcard (*.example.com).
 */
function matchesHost(pattern, hostname) {
  if (!pattern || !hostname) return false;
  if (pattern === '*') return true;
  const p = pattern.toLowerCase();
  const h = hostname.toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1));
  return p === h;
}

/**
 * Return a numeric specificity score for a pattern that is already known to
 * match a given hostname.  Higher score = higher precedence.
 *   exact match  → 2
 *   *.wildcard   → 1 + (suffix length / large constant)  so longer suffix wins
 *   bare *       → 0
 */
function matchSpecificity(pattern) {
  if (pattern === '*') return 0;
  if (pattern.startsWith('*.')) return 1 + pattern.length / 1e6;
  return 2;
}

/**
 * Build extra https.Agent options for a given URL.
 * Merges customCAs (CA trust) and any matching client certificate (mTLS).
 *
 * When multiple entries match the hostname, the most-specific pattern wins:
 *   exact host  >  *.wildcard (longer suffix first)  >  bare *
 * This makes selection deterministic regardless of list order.
 */
function buildAgentExtra(url) {
  const extra = {};
  if (executorConfig.customCAs) extra.ca = executorConfig.customCAs;
  const hostname = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  const match = (executorConfig.clientCertificates ?? [])
    .filter(c => c.enabled !== false && matchesHost(c.host, hostname))
    .sort((a, b) => matchSpecificity(b.host) - matchSpecificity(a.host))[0];
  if (match) {
    extra.cert = match.cert;
    extra.key  = match.key;
    if (match.passphrase) extra.passphrase = match.passphrase;
  }
  return extra;
}

function buildProxyOption(proxyUrl, targetUrl) {
  if (!proxyUrl) return undefined;
  try {
    const parsed = new URL(proxyUrl);
    // Check noProxy list
    if (executorConfig.noProxy) {
      try {
        const targetHost = new URL(targetUrl).hostname;
        const noProxyList = executorConfig.noProxy.split(',').map(h => h.trim()).filter(Boolean);
        if (noProxyList.some(h => targetHost === h || targetHost.endsWith('.' + h))) return undefined;
      } catch { /* ignore */ }
    }
    return {
      protocol: parsed.protocol.replace(':', ''),
      host: parsed.hostname,
      port: parseInt(parsed.port, 10) || (parsed.protocol === 'https:' ? 443 : 80),
      ...(parsed.username ? { auth: { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) } } : {}),
    };
  } catch { return undefined; }
}

// ─── Variable resolution ─────────────────────────────────────────────────────

const { resolveVariables } = require('./variable-resolver');

function buildVariables(environment, collectionVariables, globals, dataRow, collVars) {
  const collVarsObj = {};
  (collVars || []).forEach(v => {
    if (v.key && !v.disabled) collVarsObj[v.key] = v.value;
  });
  return {
    ...collVarsObj,
    ...globals,
    ...collectionVariables,
    ...environment,
    ...dataRow,
  };
}

/**
 * Resolve all header key/value pairs in a single batch pass.
 * Returns a plain object with resolved keys and values; disabled headers are omitted.
 */
function resolveHeaderPairs(headers, vars) {
  const resolved = {};
  (headers || []).forEach(h => {
    if (!h.disabled) {
      resolved[resolveVariables(h.key, vars)] = resolveVariables(h.value, vars);
    }
  });
  return resolved;
}

/**
 * Resolve all key/value param pairs (urlencoded params) in a single batch pass.
 * Disabled entries are filtered out.
 */
function resolveParamPairs(params, vars) {
  return (params || []).filter(p => !p.disabled).map(p => ({
    key: resolveVariables(p.key, vars),
    value: resolveVariables(p.value, vars),
  }));
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyPathVariables(url, variables, vars) {
  let resolved = url;
  (variables || []).forEach(variable => {
    if (!variable || variable.disabled) return;
    const key = resolveVariables(variable.key || '', vars);
    if (!key) return;
    const value = encodeURIComponent(resolveVariables(variable.value || '', vars));
    resolved = resolved.replace(new RegExp(`:${escapeRegExp(key)}(?=/|$|\\?|#)`, 'g'), value);
  });
  return resolved;
}

function resolveUrl(urlObj, vars) {
  if (typeof urlObj === 'string') {
    return resolveVariables(urlObj, vars);
  }
  if (urlObj && urlObj.raw) {
    // Keep ordering consistent with Postman-like semantics:
    // resolve {{vars}} first, then apply :path variables from url.variable.
    const resolvedRaw = resolveVariables(urlObj.raw, vars);
    return applyPathVariables(resolvedRaw, urlObj.variable, vars);
  }
  // Reconstruct from parts if raw is absent
  const protocol = (urlObj.protocol || 'https').replace('://', '');
  const host = (Array.isArray(urlObj.host) ? urlObj.host.join('.') : urlObj.host) || '';
  const path = (Array.isArray(urlObj.path) ? urlObj.path.join('/') : urlObj.path) || '';
  const query = (urlObj.query || [])
    .filter(q => !q.disabled)
    .map(q => `${encodeURIComponent(resolveVariables(q.key, vars))}=${encodeURIComponent(resolveVariables(q.value, vars))}`)
    .join('&');
  let url = `${protocol}://${host}/${path.replace(/^\//, '')}`;
  if (query) url += `?${query}`;
  const resolvedUrl = resolveVariables(url, vars);
  return applyPathVariables(resolvedUrl, urlObj.variable, vars);
}

// ─── Auth handling ───────────────────────────────────────────────────────────

async function applyAuth(auth, headers, vars, currentUrl, authWarnings = []) {
  if (!auth || auth.type === 'noauth') return currentUrl;

  switch (auth.type) {
    case 'bearer': {
      const token = (auth.bearer || []).find(b => b.key === 'token');
      if (token) headers['Authorization'] = `Bearer ${resolveVariables(token.value, vars)}`;
      break;
    }
    case 'basic': {
      const user = (auth.basic || []).find(b => b.key === 'username')?.value || '';
      const pass = (auth.basic || []).find(b => b.key === 'password')?.value || '';
      const encoded = Buffer.from(`${resolveVariables(user, vars)}:${resolveVariables(pass, vars)}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
      break;
    }
    case 'apikey': {
      const keyName = (auth.apikey || []).find(b => b.key === 'key')?.value || 'X-API-Key';
      const keyValue = (auth.apikey || []).find(b => b.key === 'value')?.value || '';
      const location = (auth.apikey || []).find(b => b.key === 'in')?.value || 'header';
      const resolvedKey = resolveVariables(keyName, vars);
      const resolvedValue = resolveVariables(keyValue, vars);

      if (location === 'query') {
        if (!currentUrl) break;
        const parsed = new URL(currentUrl);
        parsed.searchParams.set(resolvedKey, resolvedValue);
        currentUrl = parsed.toString();
      } else {
        headers[resolvedKey] = resolvedValue;
      }
      break;
    }
    case 'oauth2': {
      await handleOAuth2(auth, headers, vars);
      break;
    }
    case 'digest': {
      authWarnings.push('Unsupported auth type "digest". Request sent without authentication header.');
      break;
    }
    case 'oauth1': {
      authWarnings.push('Unsupported auth type "oauth1". Request sent without authentication header.');
      break;
    }
    default:
      if (auth && auth.type) {
        authWarnings.push(`Unsupported auth type "${auth.type}". Request sent without authentication header.`);
      }
      break;
  }

  return currentUrl;
}

/**
 * Handle OAuth 2.0 authentication
 * Check if token is valid; if expired or missing, refresh it
 */
async function handleOAuth2(auth, headers, vars) {
  if (!auth.oauth2) return;

  const oauth2 = auth.oauth2;
  const now = Date.now();

  let token = oauth2.accessToken;
  const tokenExpiredOrMissing = !token || (oauth2.expiresAt && oauth2.expiresAt <= now + 60000);

  if (tokenExpiredOrMissing) {
    // Determine whether we can auto-refresh:
    //   • client_credentials — always fetch a new token
    //   • any grant type that already has a refresh_token — use refresh_token grant
    //   • authorization_code with no refresh_token — cannot auto-refresh; user must authorize first
    const hasRefreshToken = !!oauth2.refreshToken;
    const isClientCredentials = oauth2.grantType === 'client_credentials';

    if (isClientCredentials || hasRefreshToken) {
      try {
        // When a refresh token is available, always use the refresh_token grant
        const configForRefresh = hasRefreshToken
          ? { ...oauth2, grantType: 'refresh_token' }
          : oauth2;
        const refreshResult = await refreshOAuth2Token(configForRefresh, vars);
        token = refreshResult.accessToken;
      } catch (error) {
        // Surface the real cause (e.g. ECONNREFUSED, token endpoint 4xx) as a
        // visible request error rather than silently dropping the auth header.
        const cause = error.message.replace(/^OAuth 2\.0 token refresh failed:\s*/i, '');
        throw new Error(`OAuth token refresh failed: ${cause}`);
      }
    } else {
      // authorization_code flow — user has not authorized yet; skip the auth header
      // so the request proceeds and the target API returns a natural 401
      console.warn('OAuth 2.0: No access token available for authorization_code flow. User needs to authorize first.');
    }
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
}

// ─── Body handling ───────────────────────────────────────────────────────────

function buildBody(body, headers, vars, skipWarnings = []) {
  if (!body || body.mode === 'none') return undefined;

  switch (body.mode) {
    case 'raw': {
      const data = resolveVariables(body.raw || '', vars);
      if (body.soap) {
        // SOAP request — set protocol-correct headers regardless of user-supplied CT
        const { action, version } = body.soap;
        if (version === '1.2') {
          headers['Content-Type'] = `application/soap+xml; charset=utf-8${action ? `; action="${action}"` : ''}`;
        } else {
          // SOAP 1.1
          headers['Content-Type'] = 'text/xml; charset=utf-8';
          if (action) headers['SOAPAction'] = `"${action}"`;
        }
      } else if (!headers['Content-Type'] && !headers['content-type']) {
        const lang = body.options?.raw?.language;
        if (lang === 'json') headers['Content-Type'] = 'application/json';
        else if (lang === 'xml') headers['Content-Type'] = 'application/xml';
        else if (lang === 'html') headers['Content-Type'] = 'text/html';
        else headers['Content-Type'] = 'text/plain';
      }
      return data;
    }
    case 'urlencoded': {
      const params = new URLSearchParams();
      resolveParamPairs(body.urlencoded, vars).forEach(({ key, value }) => {
        params.append(key, value);
      });
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      return params.toString();
    }
    case 'formdata': {
      const form = new FormData();
      (body.formdata || []).forEach(p => {
        if (p.disabled) return;
        const key = resolveVariables(p.key, vars);
        if (p.type === 'file') {
          skipWarnings.push(`Skipped file field "${key}" in formdata — file attachments are not supported in CLI mode`);
        } else {
          form.append(key, resolveVariables(p.value, vars));
        }
      });
      Object.assign(headers, form.getHeaders());
      return form;
    }
    case 'file': {
      if (!body.raw) return undefined;
      const buffer = Buffer.from(body.raw, 'base64');
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/octet-stream';
      }
      return buffer;
    }
    case 'graphql': {
      const payload = { query: body.graphql?.query || '' };
      if (body.graphql?.variables) {
        try { payload.variables = JSON.parse(body.graphql.variables); } catch (_) {}
      }
      headers['Content-Type'] = 'application/json';
      return JSON.stringify(payload);
    }
    default:
      return undefined;
  }
}

// ─── Cookie helpers ──────────────────────────────────────────────────────────

function extractHostname(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function getCookiesForRequest(cookieJar, url) {
  if (!cookieJar) return '';
  const hostname = extractHostname(url);
  if (!hostname) return '';
  const pairs = [];
  Object.entries(cookieJar).forEach(([domain, cookies]) => {
    const d = domain.replace(/^\./, '');
    if (hostname === d || hostname.endsWith('.' + d)) {
      (cookies || []).forEach(c => {
        if (c.enabled !== false) pairs.push(`${c.name}=${c.value}`);
      });
    }
  });
  return pairs.join('; ');
}

function parseSetCookieHeaders(setCookieArray, hostname) {
  const parsed = [];
  (setCookieArray || []).forEach(header => {
    const parts = header.split(';').map(p => p.trim());
    const [nameValue, ...attrs] = parts;
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx === -1) return;
    const name = nameValue.slice(0, eqIdx).trim();
    const value = nameValue.slice(eqIdx + 1).trim();
    let domain = hostname;
    let path = '/';
    let expires = null;
    let httpOnly = false;
    let secure = false;
    let sameSite = 'Lax';
    attrs.forEach(attr => {
      const lower = attr.toLowerCase();
      if (lower.startsWith('domain=')) domain = attr.slice(7).replace(/^\./, '');
      else if (lower.startsWith('path=')) path = attr.slice(5);
      else if (lower.startsWith('expires=')) expires = attr.slice(8);
      else if (lower === 'httponly') httpOnly = true;
      else if (lower === 'secure') secure = true;
      else if (lower.startsWith('samesite=')) sameSite = attr.slice(9);
    });
    parsed.push({ name, value, domain, path, expires, httpOnly, secure, sameSite, enabled: true });
  });
  return parsed;
}

// ─── TLS cert & network timing ──────────────────────────────────────────────

function serializeCert(cert) {
  function entries(obj) {
    if (!obj || typeof obj !== 'object') return {};
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)])
    );
  }
  return {
    subject: cert.subject ? entries(cert.subject) : null,
    issuer: cert.issuer ? entries(cert.issuer) : null,
    validFrom: cert.valid_from || null,
    validTo: cert.valid_to || null,
    fingerprint: cert.fingerprint || null,
    fingerprint256: cert.fingerprint256 || null,
    serialNumber: cert.serialNumber || null,
    subjectAltNames: cert.subjectaltname || null,
    bits: cert.bits || null,
  };
}

function serializeCertChain(cert) {
  const chain = [];
  const seen = new Set();
  let cur = cert;
  while (cur && cur.subject) {
    const fp = cur.fingerprint;
    if (fp && seen.has(fp)) break;
    if (fp) seen.add(fp);
    chain.push(serializeCert(cur));
    cur = cur.issuerCertificate;
  }
  return chain;
}

function makeTimingAndCertContext(rejectUnauthorized = false, url = '') {
  const timings = { dns: 0, tcp: 0, tls: 0 };
  const certHolder = { chain: null };
  let captured = false;

  function instrument(socket, isSecure) {
    if (captured) return;
    captured = true;
    const t0 = Date.now();
    let dnsEnd = t0;
    let connectEnd = null;
    socket.once('lookup', () => { dnsEnd = Date.now(); timings.dns = dnsEnd - t0; });
    socket.once('connect', () => { connectEnd = Date.now(); timings.tcp = connectEnd - dnsEnd; });
    if (isSecure) {
      socket.once('secureConnect', () => {
        const secureEnd = Date.now();
        timings.tls = secureEnd - (connectEnd ?? dnsEnd);
        try {
          const raw = socket.getPeerCertificate(true);
          if (raw && raw.subject) certHolder.chain = serializeCertChain(raw);
        } catch (_) {}
      });
    }
  }

  const httpsTimingAgent = makeHttpsAgent(rejectUnauthorized, buildAgentExtra(url || ''));
  const _origHttps = httpsTimingAgent.createConnection.bind(httpsTimingAgent);
  httpsTimingAgent.createConnection = function (opts, cb) {
    const sock = _origHttps(opts, cb);
    instrument(sock, true);
    return sock;
  };

  const httpTimingAgent = new http.Agent({});
  const _origHttp = httpTimingAgent.createConnection.bind(httpTimingAgent);
  httpTimingAgent.createConnection = function (opts, cb) {
    const sock = _origHttp(opts, cb);
    instrument(sock, false);
    return sock;
  };

  return { timings, certHolder, httpsTimingAgent, httpTimingAgent };
}

// ─── Main executor ───────────────────────────────────────────────────────────

async function executeRequest(item, context) {
  let environment = context.environment ?? {};
  let collectionVariables = context.collectionVariables ?? {};
  let globals = context.globals ?? {};
  const {
    dataRow = {},
    collVars = [],
    cookies = {},
    collectionItems = [],
    conditionalExecution = true,
    mockBase = null,
    iteration = 1,
    requestId = item.id || '',
    vmContext = null,
  } = context;
  let vars = buildVariables(environment, collectionVariables, globals, dataRow, collVars);
  // Keep original key sets for scope routing — used when splitting script mutations
  // back into their respective scopes. Must be captured before any script runs.
  const originalEnvKeys = new Set(Object.keys(environment));

  function applyScopedMutations(updatedVariables = {}, updatedEnvMutations = {}, updatedCollVarMutations = {}, updatedGlobalMutations = {}) {
    const nextEnvironment = { ...environment, ...updatedEnvMutations };
    const nextCollectionVariables = { ...collectionVariables, ...updatedCollVarMutations };
    const trackedKeys = new Set([
      ...Object.keys(updatedEnvMutations),
      ...Object.keys(updatedCollVarMutations),
      ...Object.keys(updatedGlobalMutations),
    ]);

    Object.entries(updatedVariables).forEach(([key, value]) => {
      if (trackedKeys.has(key)) return;
      if (originalEnvKeys.has(key)) nextEnvironment[key] = value;
      else nextCollectionVariables[key] = value;
    });

    environment = nextEnvironment;
    collectionVariables = nextCollectionVariables;
  }

  // Run pre-request script
  let scriptLogs = [];
  let preChildRequests = [];
  const preScript = (item.event || []).find(e => e.listen === 'prerequest');
  let preSkipRequest = false;
  if (preScript) {
    const code = Array.isArray(preScript.script.exec)
      ? preScript.script.exec.join('\n')
      : (preScript.script.exec || '');
    if (code.trim()) {
      const scriptDeps = {
        collectionItems,
        executeRequestFn: executeRequest,
        context: { environment, collectionVariables, globals, dataRow, collVars, cookies, mockBase, mongoConnections: context.mongoConnections || {} },
        requestId,
        iteration,
      };
      const result = await runScript(code, null, vars, scriptDeps, vmContext);
      const preUpdatedVars = result.updatedVariables;
      const preEnvMutations = result.updatedEnvMutations || {};
      const preCollVarMutations = result.updatedCollVarMutations || {};
      const preUpdatedGlobals = result.updatedGlobalMutations || {};
      // Propagate pre-request mutations back into their respective scopes so the
      // test script context (and any child requests it fires) sees the updated values.
      applyScopedMutations(preUpdatedVars, preEnvMutations, preCollVarMutations, preUpdatedGlobals);
      globals = { ...globals, ...preUpdatedGlobals };
      vars = { ...vars, ...preUpdatedVars, ...preUpdatedGlobals };
      scriptLogs = [...scriptLogs, ...result.consoleLogs];
      preChildRequests = result.childRequests || [];
      preSkipRequest = conditionalExecution && result.skipRequest === true;

      if (preSkipRequest) {
        return {
          status: 0,
          statusText: 'Skipped',
          responseTime: 0,
          resolvedUrl: '',
          requestHeaders: {},
          requestBody: undefined,
          headers: {},
          body: '',
          size: 0,
          testResults: [],
          scriptLogs,
          preChildRequests,
          testChildRequests: [],
          updatedEnvironment: environment,
          updatedCollectionVariables: collectionVariables,
          updatedGlobals: globals,
          updatedCookies: cookies,
          skipped: true,
          nextRequest: undefined,
          nextRequestById: undefined,
          error: null,
        };
      }
    }
  }

  const req = item.request;
  const isMongo = req?.requestType === 'mongodb' || !!req?.mongodb;
  const method = (req.method || 'GET').toUpperCase();
  let url = isMongo
    ? `mongodb://${resolveVariables(req.mongodb?.database || '', vars)}/${resolveVariables(req.mongodb?.collection || '', vars)}`
    : resolveUrl(req.url, vars);

  // Rewrite to mock server base AFTER variable resolution so that URLs like
  // {{baseUrl}}/path resolve to https://real.host/path first, then become
  // http://localhost:PORT/path — not http://localhost:PORT/https://real.host/path.
  if (mockBase && !isMongo) {
    try {
      const parsed = new URL(url);
      url = mockBase.replace(/\/$/, '') + parsed.pathname + parsed.search + parsed.hash;
    } catch {
      // URL couldn't be parsed even after resolution (edge case) — strip origin best-effort
      const stripped = url.replace(/^(?:https?:)?\/\/[^/?#]*/i, '');
      const pathPart = stripped !== url ? (stripped || '/') : (url.startsWith('/') ? url : '/' + url);
      url = mockBase.replace(/\/$/, '') + pathPart;
    }
  }

  const headers = {};

  if (!isMongo) {
    Object.assign(headers, resolveHeaderPairs(req.header, vars));
  }

  const authWarnings = [];
  if (!isMongo) {
    url = await applyAuth(req.auth, headers, vars, url, authWarnings);
  }

  // Inject cookies from cookie jar
  if (!isMongo) {
    const cookieHeader = getCookiesForRequest(cookies, url);
    if (cookieHeader) headers['Cookie'] = cookieHeader;
  }

  const buildWarnings = [];
  const data = isMongo ? undefined : buildBody(req.body, headers, vars, buildWarnings);
  const allWarnings = [...authWarnings, ...buildWarnings];

  // Capture request body as a loggable string
  let requestBodyStr = undefined;
  if (typeof data === 'string') {
    requestBodyStr = data;
  } else if (data && typeof data.toString === 'function' && !(data instanceof FormData)) {
    try { requestBodyStr = data.toString(); } catch (_) {}
  }

  // Per-request agent with timing and TLS capture
  const _tc = makeTimingAndCertContext(executorConfig.sslVerification === true, url);
  const startTime = Date.now();
  let testChildRequests = [];
  let nextRequestSignal = undefined; // set by pm.execution.setNextRequest()
  let nextRequestByIdSignal = undefined; // set by pm.execution.setNextRequestById()

  try {
    if (isMongo) {
      const mongoResponse = await executeMongoOperation(req.mongodb || {}, vars, context);

      const testScript = (item.event || []).find(e => e.listen === 'test');
      let testResults = [];
      let updatedVars = {};
      let testEnvMutations = {};
      let testCollVarMutations = {};
      let testUpdatedGlobals = {};

      if (testScript) {
        const code = Array.isArray(testScript.script.exec)
          ? testScript.script.exec.join('\n')
          : (testScript.script.exec || '');
        if (code.trim()) {
          const scriptDeps = {
            collectionItems,
            executeRequestFn: executeRequest,
            context: { environment, collectionVariables, globals, dataRow, collVars, cookies, mockBase, mongoConnections: context.mongoConnections || {} },
            requestId,
            iteration,
          };
          const result = await runScript(code, {
            code: mongoResponse.status,
            status: mongoResponse.statusText,
            responseTime: mongoResponse.responseTime,
            headers: {},
            body: mongoResponse.body,
            jsonData: mongoResponse.jsonData,
          }, vars, scriptDeps, vmContext);
          testResults = result.tests;
          updatedVars = result.updatedVariables;
          testEnvMutations = result.updatedEnvMutations || {};
          testCollVarMutations = result.updatedCollVarMutations || {};
          testUpdatedGlobals = result.updatedGlobalMutations || {};
          globals = { ...globals, ...testUpdatedGlobals };
          scriptLogs = [...scriptLogs, ...result.consoleLogs];
          testChildRequests = result.childRequests || [];
          if (result.nextRequest !== undefined) nextRequestSignal = result.nextRequest;
          if (result.nextRequestById !== undefined) nextRequestByIdSignal = result.nextRequestById;
          vars = { ...vars, ...updatedVars, ...testUpdatedGlobals };
        }
      }

      const updatedEnv = { ...environment, ...testEnvMutations };
      const updatedCollVars = { ...collectionVariables, ...testCollVarMutations };
      const trackedKeys = new Set([
        ...Object.keys(testEnvMutations),
        ...Object.keys(testCollVarMutations),
        ...Object.keys(testUpdatedGlobals),
      ]);
      Object.entries(updatedVars).forEach(([k, v]) => {
        if (trackedKeys.has(k)) return;
        if (originalEnvKeys.has(k)) updatedEnv[k] = v;
        else updatedCollVars[k] = v;
      });

      return {
        protocol: 'mongodb',
        mongoStatus: mongoResponse.mongoStatus,
        mongoOperation: mongoResponse.mongoOperation,
        status: mongoResponse.status,
        statusText: mongoResponse.statusText,
        responseTime: mongoResponse.responseTime,
        resolvedUrl: url,
        requestHeaders: {},
        requestBody: req.mongodb?.operation === 'script' ? (req.mongodb?.script || '') : JSON.stringify(req.mongodb || {}),
        headers: {},
        body: mongoResponse.body,
        size: mongoResponse.size,
        testResults,
        scriptLogs,
        preChildRequests,
        testChildRequests,
        updatedEnvironment: updatedEnv,
        updatedCollectionVariables: updatedCollVars,
        updatedGlobals: globals,
        updatedCookies: cookies,
        networkTimings: null,
        tlsCertChain: null,
        redirectChain: [],
        nextRequest: nextRequestSignal,
        nextRequestById: nextRequestByIdSignal,
        warnings: allWarnings,
        error: null,
      };
    }

    // ─── Redirect chain handling ───────────────────────────────────────────
    const MAX_REDIRECTS = executorConfig.followRedirects ? 10 : 0;
    const rejectUnauthorized = executorConfig.sslVerification === true;
    const redirectChain = [];
    let curMethod = method;
    let curUrl = url;
    let curData = data;
    let curHeaders = { ...headers };
    let axiosResponse;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const _isHopHttps = curUrl.toLowerCase().startsWith('https://');
      // Per-hop HTTPS agent — only build when used (non-initial HTTPS hops).
      const hopHttpsAgent = (hop > 0 && _isHopHttps)
        ? makeHttpsAgent(rejectUnauthorized, buildAgentExtra(curUrl))
        : undefined;
      // Only instrument the timing agent on the first hop (timing agent reuses same TLS setting)
      const agentOpts = hop === 0
        ? (_isHopHttps ? { httpsAgent: _tc.httpsTimingAgent } : { httpAgent: _tc.httpTimingAgent })
        : (_isHopHttps ? { httpsAgent: hopHttpsAgent } : {});
      // Proxy option — always set `proxy` key so axios never falls back to env vars (HTTP_PROXY etc.)
      const proxyOpt = (() => {
        if (!executorConfig.proxyEnabled) return { proxy: false };
        const pUrl = _isHopHttps ? (executorConfig.httpsProxy || executorConfig.httpProxy) : executorConfig.httpProxy;
        const p = buildProxyOption(pUrl, curUrl);
        return p ? { proxy: p } : { proxy: false };
      })();
      const hopStart = Date.now();
      axiosResponse = await httpClient.request({
        method: curMethod, url: curUrl, headers: curHeaders, data: curData,
        maxRedirects: 0,
        timeout: executorConfig.requestTimeout ?? 30000,
        ...agentOpts,
        ...proxyOpt,
      });
      const hopTime = Date.now() - hopStart;

      const status = axiosResponse.status;
      if (status >= 300 && status < 400 && axiosResponse.headers.location) {
        const hopHeaders = {};
        Object.entries(axiosResponse.headers || {}).forEach(([k, v]) => { hopHeaders[k] = String(v); });
        redirectChain.push({
          url: curUrl,
          status,
          statusText: axiosResponse.statusText || '',
          headers: hopHeaders,
          responseTime: hopTime,
        });
        // Resolve possibly-relative Location
        let nextUrl = axiosResponse.headers.location;
        try { nextUrl = new URL(nextUrl, curUrl).href; } catch (_) {}
        // 303 always switches to GET; 301/302 switch to GET for non-HEAD/GET
        if ([301, 302, 303].includes(status) && curMethod !== 'GET' && curMethod !== 'HEAD') {
          curMethod = 'GET';
          curData = undefined;
          delete curHeaders['Content-Type'];
          delete curHeaders['content-type'];
        }
        curUrl = nextUrl;
      } else {
        break;
      }
    }
    // ──────────────────────────────────────────────────────────────────────

    const responseTime = Date.now() - startTime;
    const _isHttps = curUrl.toLowerCase().startsWith('https://');
    const networkTimings = {
      dns: _tc.timings.dns,
      tcp: _tc.timings.tcp,
      tls: _isHttps ? _tc.timings.tls : 0,
      server: Math.max(0, responseTime - _tc.timings.dns - _tc.timings.tcp - (_isHttps ? _tc.timings.tls : 0)),
      total: responseTime,
    };

    const bodyString = typeof axiosResponse.data === 'string'
      ? axiosResponse.data
      : JSON.stringify(axiosResponse.data, null, 2);

    // Run test script
    const testScript = (item.event || []).find(e => e.listen === 'test');
    let testResults = [];
    let updatedVars = {};
    let testEnvMutations = {};
    let testCollVarMutations = {};
    let testUpdatedGlobals = {};

    if (testScript) {
      const code = Array.isArray(testScript.script.exec)
        ? testScript.script.exec.join('\n')
        : (testScript.script.exec || '');
      if (code.trim()) {
        const responseData = {
          code: axiosResponse.status,
          status: axiosResponse.statusText,
          responseTime,
          headers: axiosResponse.headers,
          body: bodyString,
          jsonData: axiosResponse.data,
        };
        const scriptDeps = {
          collectionItems,
          executeRequestFn: executeRequest,
          context: { environment, collectionVariables, globals, dataRow, collVars, cookies, mockBase, mongoConnections: context.mongoConnections || {} },
          requestId,
          iteration,
        };
        const result = await runScript(code, responseData, vars, scriptDeps, vmContext);
        testResults = result.tests;
        updatedVars = result.updatedVariables;
        testEnvMutations = result.updatedEnvMutations || {};
        testCollVarMutations = result.updatedCollVarMutations || {};
        testUpdatedGlobals = result.updatedGlobalMutations || {};
        globals = { ...globals, ...testUpdatedGlobals };
        scriptLogs = [...scriptLogs, ...result.consoleLogs];
        testChildRequests = result.childRequests || [];
        if (result.nextRequest !== undefined) nextRequestSignal = result.nextRequest;
        if (result.nextRequestById !== undefined) nextRequestByIdSignal = result.nextRequestById;
        vars = { ...vars, ...updatedVars, ...testUpdatedGlobals };
      }
    }

    // Split updated vars back into environment and collection variables.
    // Keys already tracked in updatedGlobalMutations are excluded — globals are
    // returned separately via the `globals` variable, not via env/collVars.
    // Explicit env/collection writes are replayed from their dedicated buckets,
    // while generic apx.variables writes still fall back to original scope.
    const updatedEnv = { ...environment, ...testEnvMutations };
    const updatedCollVars = { ...collectionVariables, ...testCollVarMutations };
    const trackedKeys = new Set([
      ...Object.keys(testEnvMutations),
      ...Object.keys(testCollVarMutations),
      ...Object.keys(testUpdatedGlobals),
    ]);
    Object.entries(updatedVars).forEach(([k, v]) => {
      if (trackedKeys.has(k)) return;
      if (originalEnvKeys.has(k)) updatedEnv[k] = v;
      else updatedCollVars[k] = v;
    });

    const responseHeaders = {};
    Object.entries(axiosResponse.headers || {}).forEach(([k, v]) => {
      responseHeaders[k] = String(v);
    });

    // Parse Set-Cookie headers and merge into cookie jar
    const updatedCookies = Object.assign({}, cookies);
    const setCookieRaw = axiosResponse.headers['set-cookie'];
    if (setCookieRaw) {
      const hostname = extractHostname(url);
      const newCookies = parseSetCookieHeaders(
        Array.isArray(setCookieRaw) ? setCookieRaw : [setCookieRaw],
        hostname,
      );
      newCookies.forEach(cookie => {
        const domain = cookie.domain;
        const existing = updatedCookies[domain] ? [...updatedCookies[domain]] : [];
        const idx = existing.findIndex(c => c.name === cookie.name);
        if (idx >= 0) existing[idx] = cookie;
        else existing.push(cookie);
        updatedCookies[domain] = existing;
      });
    }

    return {
      status: axiosResponse.status,
      statusText: axiosResponse.statusText,
      responseTime,
      resolvedUrl: curUrl,
      requestHeaders: headers,
      requestBody: requestBodyStr,
      headers: responseHeaders,
      body: bodyString,
      size: bodyString.length,
      testResults,
      scriptLogs,
      preChildRequests,
      testChildRequests,
      updatedEnvironment: updatedEnv,
      updatedCollectionVariables: updatedCollVars,
      updatedGlobals: globals,
      updatedCookies,
      networkTimings,
      tlsCertChain: _tc.certHolder.chain,
      redirectChain,
      nextRequest: nextRequestSignal,
      nextRequestById: nextRequestByIdSignal,
      warnings: allWarnings,
      error: null,
    };
  } catch (err) {
    const errorResponseTime = Date.now() - startTime;
    return {
      protocol: isMongo ? 'mongodb' : 'http',
      mongoStatus: isMongo ? 'error' : undefined,
      mongoOperation: isMongo ? (req.mongodb?.operation || 'find') : undefined,
      status: 0,
      statusText: isMongo ? 'MONGO_ERROR' : 'Request Failed',
      responseTime: errorResponseTime,
      resolvedUrl: url,
      requestHeaders: headers,
      requestBody: requestBodyStr,
      headers: {},
      body: err.message,
      size: 0,
      testResults: [],
      scriptLogs,
      preChildRequests,
      testChildRequests,
      updatedEnvironment: environment,
      updatedCollectionVariables: collectionVariables,
      updatedGlobals: globals,
      updatedCookies: cookies,
      networkTimings: { dns: 0, tcp: 0, tls: 0, server: 0, total: errorResponseTime },
      tlsCertChain: null,
      redirectChain: [],
      warnings: allWarnings,
      error: err.message,
    };
  }
}

// ─── Flatten collection items ────────────────────────────────────────────────

function flattenItems(items) {
  const result = [];
  for (const item of (items || [])) {
    if (item.item) {
      result.push(...flattenItems(item.item));
    } else if (item.request) {
      result.push(item);
    }
  }
  return result;
}

/**
 * Extract the trimmed script code for a given listen type from an event array.
 * Returns null when absent or empty.
 */
function extractEventScript(events, listen) {
  const ev = (events || []).find(e => e.listen === listen);
  if (!ev) return null;
  const code = Array.isArray(ev.script.exec) ? ev.script.exec.join('\n') : (ev.script.exec || '');
  return code.trim() || null;
}

/**
 * Merge accumulated ancestor scripts into a leaf request item's events.
 * Ancestor scripts run in outermost-first order (collection → folders → request).
 */
function mergeAncestorScripts(item, accPrereqs, accTests) {
  if (accPrereqs.length === 0 && accTests.length === 0) return item;

  const ownPrereq = extractEventScript(item.event, 'prerequest');
  const ownTest = extractEventScript(item.event, 'test');
  const prereqParts = ownPrereq ? [...accPrereqs, ownPrereq] : accPrereqs;
  const testParts = ownTest ? [...accTests, ownTest] : accTests;

  // Keep any other event types untouched; replace prerequest/test with merged versions
  const otherEvents = (item.event || []).filter(e => e.listen !== 'prerequest' && e.listen !== 'test');
  const newEvents = [...otherEvents];
  if (prereqParts.length > 0) {
    newEvents.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: prereqParts.join('\n\n').split('\n') } });
  }
  if (testParts.length > 0) {
    newEvents.push({ listen: 'test', script: { type: 'text/javascript', exec: testParts.join('\n\n').split('\n') } });
  }
  return { ...item, event: newEvents };
}

/**
 * Like flattenItems but bakes collection-level and folder-level pre-request/test
 * scripts into each leaf item so the executor runs them in order:
 *   collection → folders (outer→inner) → request
 */
function flattenItemsWithScripts(items, collectionEvents) {
  const colPrereq = extractEventScript(collectionEvents, 'prerequest');
  const colTest = extractEventScript(collectionEvents, 'test');

  function walk(nodes, accPrereqs, accTests) {
    const result = [];
    for (const item of (nodes || [])) {
      if (item.item) {
        const folderPrereq = extractEventScript(item.event, 'prerequest');
        const folderTest = extractEventScript(item.event, 'test');
        const nextPrereqs = folderPrereq ? [...accPrereqs, folderPrereq] : accPrereqs;
        const nextTests = folderTest ? [...accTests, folderTest] : accTests;
        result.push(...walk(item.item, nextPrereqs, nextTests));
      } else if (item.request) {
        result.push(mergeAncestorScripts(item, accPrereqs, accTests));
      }
    }
    return result;
  }

  return walk(items, colPrereq ? [colPrereq] : [], colTest ? [colTest] : []);
}

module.exports = { executeRequest, flattenItems, flattenItemsWithScripts, setExecutorConfig, resolveVariables, buildBody, buildProxyOption, applyAuth, resolveHeaderPairs, resolveParamPairs, executeMongoTest, executeMongoIntrospect };