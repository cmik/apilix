'use strict';

const axios = require('axios');
const http = require('http');
const https = require('https');
const FormData = require('form-data');
const { runScript } = require('./sandbox');

const httpClient = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  maxRedirects: 10,
  timeout: 30000,
  validateStatus: null, // never throw based on status code
});

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
  let url = `${protocol}://${host}/${path}`;
  if (query) url += `?${query}`;
  return resolveVariables(url, vars);
}

// ─── Auth handling ───────────────────────────────────────────────────────────

function applyAuth(auth, headers, vars) {
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
      if (location !== 'query') {
        headers[resolveVariables(keyName, vars)] = resolveVariables(keyValue, vars);
      }
      break;
    }
    case 'digest':
    case 'oauth1':
    case 'oauth2':
    default:
      // Not implemented in this version
      break;
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

function makeTimingAndCertContext() {
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

  const httpsTimingAgent = new https.Agent({ rejectUnauthorized: false });
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
  const {
    environment = {},
    collectionVariables = {},
    globals = {},
    dataRow = {},
    collVars = [],
    cookies = {},
  } = context;

  let vars = buildVariables(environment, collectionVariables, globals, dataRow, collVars);

  // Run pre-request script
  let scriptLogs = [];
  const preScript = (item.event || []).find(e => e.listen === 'prerequest');
  if (preScript) {
    const code = Array.isArray(preScript.script.exec)
      ? preScript.script.exec.join('\n')
      : (preScript.script.exec || '');
    if (code.trim()) {
      const result = await runScript(code, null, vars);
      vars = { ...vars, ...result.updatedVariables };
      scriptLogs = [...scriptLogs, ...result.consoleLogs];
    }
  }

  const req = item.request;
  const method = (req.method || 'GET').toUpperCase();
  const url = resolveUrl(req.url, vars);
  const headers = {};

  (req.header || []).forEach(h => {
    if (!h.disabled) {
      headers[resolveVariables(h.key, vars)] = resolveVariables(h.value, vars);
    }
  });

  applyAuth(req.auth, headers, vars);

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
  const _tc = makeTimingAndCertContext();
  const startTime = Date.now();

  try {
    // ─── Redirect chain handling ───────────────────────────────────────────
    const MAX_REDIRECTS = 10;
    const redirectChain = [];
    let curMethod = method;
    let curUrl = url;
    let curData = data;
    let curHeaders = { ...headers };
    let axiosResponse;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const _isHopHttps = curUrl.toLowerCase().startsWith('https://');
      // Only instrument the timing agent on the first hop
      const agentOpts = hop === 0
        ? (_isHopHttps ? { httpsAgent: _tc.httpsTimingAgent } : { httpAgent: _tc.httpTimingAgent })
        : (_isHopHttps ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) } : {});
      const hopStart = Date.now();
      axiosResponse = await httpClient.request({
        method: curMethod, url: curUrl, headers: curHeaders, data: curData,
        maxRedirects: 0,
        ...agentOpts,
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
        const result = await runScript(code, responseData, vars);
        testResults = result.tests;
        updatedVars = result.updatedVariables;
        scriptLogs = [...scriptLogs, ...result.consoleLogs];
        vars = { ...vars, ...updatedVars };
      }
    }

    // Split updated vars back into environment and collection variables
    const updatedEnv = { ...environment };
    const updatedCollVars = { ...collectionVariables };
    Object.entries(updatedVars).forEach(([k, v]) => {
      if (k in environment) updatedEnv[k] = v;
      else updatedCollVars[k] = v;
    });
    // Any new keys go into collectionVariables
    Object.entries(updatedVars).forEach(([k, v]) => {
      if (!(k in environment)) updatedCollVars[k] = v;
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
      updatedEnvironment: updatedEnv,
      updatedCollectionVariables: updatedCollVars,
      updatedCookies,
      networkTimings,
      tlsCertChain: _tc.certHolder.chain,
      redirectChain,
      error: null,
    };
  } catch (err) {
    return {
      status: 0,
      statusText: 'Request Failed',
      responseTime: Date.now() - startTime,
      resolvedUrl: url,
      requestHeaders: headers,
      requestBody: requestBodyStr,
      headers: {},
      body: err.message,
      size: 0,
      testResults: [],
      updatedEnvironment: environment,
      updatedCollectionVariables: collectionVariables,
      updatedCookies: cookies,
      networkTimings: { dns: 0, tcp: 0, tls: 0, server: 0, total: Date.now() - startTime },
      tlsCertChain: null,
      redirectChain: [],
      error: err.message,
    };
  }
}

// ─── Flatten collection items ────────────────────────────────────────────────

function flattenItems(items, result) {
  if (!result) result = [];
  for (const item of (items || [])) {
    if (item.item) {
      flattenItems(item.item, result);
    } else if (item.request) {
      result.push(item);
    }
  }
  return result;
}

module.exports = { executeRequest, flattenItems };
