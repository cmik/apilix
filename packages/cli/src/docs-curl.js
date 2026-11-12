'use strict';

/**
 * Minimal cURL snippet generator for `apilix docs`.
 * Consumes the redacted DocRequestModel from @apilix/core/docs, so it can
 * never print credentials that the model has already removed.
 */

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function authValue(req, key) {
  const field = req.auth && req.auth.fields && req.auth.fields.find(f => f.key === key);
  return field ? field.value : '';
}

function generateCurl(req) {
  const parts = [`curl -X ${req.method}`];
  let url = req.fullUrl;
  const auth = req.auth;

  if (auth && auth.type === 'bearer') {
    parts.push(`  -H ${shellQuote(`Authorization: Bearer ${authValue(req, 'token')}`)}`);
  } else if (auth && auth.type === 'basic') {
    parts.push(`  -u ${shellQuote(`${authValue(req, 'username')}:${authValue(req, 'password')}`)}`);
  } else if (auth && auth.type === 'apikey') {
    if (auth.in === 'query') {
      url += `${url.includes('?') ? '&' : '?'}${auth.name}=${authValue(req, 'value')}`;
    } else {
      parts.push(`  -H ${shellQuote(`${auth.name}: ${authValue(req, 'value')}`)}`);
    }
  }

  for (const h of req.headers) {
    if (h.key) parts.push(`  -H ${shellQuote(`${h.key}: ${h.value}`)}`);
  }

  const body = req.body;
  if (body) {
    if (body.mode === 'raw' && body.raw) {
      parts.push(`  --data-raw ${shellQuote(body.raw)}`);
    } else if (body.mode === 'urlencoded') {
      for (const f of body.fields || []) if (f.key) parts.push(`  --data-urlencode ${shellQuote(`${f.key}=${f.value}`)}`);
    } else if (body.mode === 'formdata') {
      for (const f of body.fields || []) if (f.key) parts.push(`  -F ${shellQuote(`${f.key}=${f.type === 'file' ? '@file' : f.value}`)}`);
    } else if (body.mode === 'graphql') {
      const payload = { query: body.graphql.query };
      if (body.graphql.variables) {
        try { payload.variables = JSON.parse(body.graphql.variables); } catch { /* keep query only */ }
      }
      parts.push(`  -H ${shellQuote('Content-Type: application/json')}`, `  --data-raw ${shellQuote(JSON.stringify(payload))}`);
    }
  }

  parts.push(`  ${shellQuote(url)}`);
  return parts.join(' \\\n');
}

const CLI_SNIPPET_LANGUAGES = [{ id: 'curl', label: 'cURL', generate: generateCurl }];

module.exports = { generateCurl, CLI_SNIPPET_LANGUAGES };
