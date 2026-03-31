'use strict';

const axios = require('axios');
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

// ─── Main executor ───────────────────────────────────────────────────────────

async function executeRequest(item, context) {
  const {
    environment = {},
    collectionVariables = {},
    globals = {},
    dataRow = {},
    collVars = [],
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

  const data = buildBody(req.body, headers, vars);

  // Capture request body as a loggable string
  let requestBodyStr = undefined;
  if (typeof data === 'string') {
    requestBodyStr = data;
  } else if (data && typeof data.toString === 'function' && !(data instanceof FormData)) {
    try { requestBodyStr = data.toString(); } catch (_) {}
  }

  const startTime = Date.now();

  try {
    const axiosResponse = await httpClient.request({ method, url, headers, data });
    const responseTime = Date.now() - startTime;

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

    return {
      status: axiosResponse.status,
      statusText: axiosResponse.statusText,
      responseTime,
      resolvedUrl: url,
      requestHeaders: headers,
      requestBody: requestBodyStr,
      headers: responseHeaders,
      body: bodyString,
      size: bodyString.length,
      testResults,
      scriptLogs,
      updatedEnvironment: updatedEnv,
      updatedCollectionVariables: updatedCollVars,
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
