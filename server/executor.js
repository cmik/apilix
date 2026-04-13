'use strict';

const axios = require('axios');
const http = require('http');
const https = require('https');
const FormData = require('form-data');
const { runScript } = require('./sandbox');
const { refreshOAuth2Token } = require('./oauth');
const { makeHttpsAgent } = require('./tlsUtils');

const httpClient = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  maxRedirects: 10,
  timeout: 30000,
  validateStatus: () => true, // never throw based on status code
});

// ─── Runtime config (updated by POST /api/settings) ─────────────────────────────────────────────────

const executorConfig = {
  requestTimeout: 30000,
  followRedirects: true,
  sslVerification: false,
  proxyEnabled: false,
  httpProxy: '',
  httpsProxy: '',
  noProxy: '',
};

function setExecutorConfig(cfg) {
  Object.assign(executorConfig, cfg);
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

function resolveVariables(str, vars) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const trimmed = key.trim();
    return vars[trimmed] !== undefined ? vars[trimmed] : match;
  });
}

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

function resolveUrl(urlObj, vars) {
  if (typeof urlObj === 'string') {
    return resolveVariables(urlObj, vars);
  }
  if (urlObj && urlObj.raw) {
    return resolveVariables(urlObj.raw, vars);
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
  return resolveVariables(url, vars);
}

// ─── Auth handling ───────────────────────────────────────────────────────────

async function applyAuth(auth, headers, vars) {
  if (!auth || auth.type === 'noauth') return;

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
      if (location === 'query') {
        // Query-param API keys are appended by the caller after URL resolution;
        // we store them as a sentinel so resolveUrl can pick them up if needed.
        // For now: best-effort append to the Authorization header is intentionally
        // skipped since the URL is not available here. Callers relying on query-param
        // API keys should embed the key directly in the URL via an environment variable.
      } else {
        headers[resolveVariables(keyName, vars)] = resolveVariables(keyValue, vars);
      }
      break;
    }
    case 'oauth2': {
      await handleOAuth2(auth, headers, vars);
      break;
    }
    case 'digest':
    case 'oauth1':
    default:
      // Not implemented in this version
      break;
  }
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

function buildBody(body, headers, vars) {
  if (!body || body.mode === 'none') return undefined;

  switch (body.mode) {
    case 'raw': {
      const data = resolveVariables(body.raw || '', vars);
      if (!headers['Content-Type'] && !headers['content-type']) {
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
      (body.urlencoded || []).forEach(p => {
        if (!p.disabled) {
          params.append(resolveVariables(p.key, vars), resolveVariables(p.value, vars));
        }
      });
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      return params.toString();
    }
    case 'formdata': {
      const form = new FormData();
      (body.formdata || []).forEach(p => {
        if (!p.disabled && p.type !== 'file') {
          form.append(resolveVariables(p.key, vars), resolveVariables(p.value, vars));
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

function makeTimingAndCertContext(rejectUnauthorized = false) {
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

  const httpsTimingAgent = makeHttpsAgent(rejectUnauthorized);
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
        context: { environment, collectionVariables, globals, dataRow, collVars, cookies, mockBase },
      };
      const result = await runScript(code, null, vars, scriptDeps);
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
  const method = (req.method || 'GET').toUpperCase();
  let url = resolveUrl(req.url, vars);

  // Rewrite to mock server base AFTER variable resolution so that URLs like
  // {{baseUrl}}/path resolve to https://real.host/path first, then become
  // http://localhost:PORT/path — not http://localhost:PORT/https://real.host/path.
  if (mockBase) {
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

  (req.header || []).forEach(h => {
    if (!h.disabled) {
      headers[resolveVariables(h.key, vars)] = resolveVariables(h.value, vars);
    }
  });

  await applyAuth(req.auth, headers, vars);

  // Inject cookies from cookie jar
  const cookieHeader = getCookiesForRequest(cookies, url);
  if (cookieHeader) headers['Cookie'] = cookieHeader;

  const data = buildBody(req.body, headers, vars);

  // Capture request body as a loggable string
  let requestBodyStr = undefined;
  if (typeof data === 'string') {
    requestBodyStr = data;
  } else if (data && typeof data.toString === 'function' && !(data instanceof FormData)) {
    try { requestBodyStr = data.toString(); } catch (_) {}
  }

  // Per-request agent with timing and TLS capture
  const _tc = makeTimingAndCertContext(executorConfig.sslVerification === true);
  const startTime = Date.now();
  let testChildRequests = [];
  let nextRequestSignal = undefined; // set by pm.execution.setNextRequest()
  let nextRequestByIdSignal = undefined; // set by pm.execution.setNextRequestById()

  try {
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
        ? makeHttpsAgent(rejectUnauthorized)
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
          context: { environment, collectionVariables, globals, dataRow, collVars, cookies, mockBase },
        };
        const result = await runScript(code, responseData, vars, scriptDeps);
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
      error: null,
    };
  } catch (err) {
    const errorResponseTime = Date.now() - startTime;
    return {
      status: 0,
      statusText: 'Request Failed',
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

module.exports = { executeRequest, flattenItems, setExecutorConfig };
