'use strict';

/**
 * Tests for OAuth 2.0 token URL variable resolution
 * Validates that token URLs with {{variable}} placeholders are resolved before validation
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

// Mock @apilix/core exports
const { resolveVariables } = require('@apilix/core');

// Helper to validate URL scheme
function validateTokenUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/**
 * Resolve variables in a token URL and validate the resolved result.
 * This mirrors the server implementation.
 */
function resolveAndValidateTokenUrl(tokenUrl, vars = {}) {
  if (!tokenUrl || typeof tokenUrl !== 'string') {
    throw new Error('tokenUrl must be a non-empty string');
  }
  
  const resolvedUrl = resolveVariables(tokenUrl, vars);
  
  if (!validateTokenUrl(resolvedUrl)) {
    throw new Error('Invalid or disallowed tokenUrl');
  }
  
  return resolvedUrl;
}

// ─── Helper: set up minimal test server ──────────────────────────────────────

function createTestApp() {
  const app = express();
  app.use(express.json());

  app.post('/api/oauth/exchange-code', (req, res) => {
    const { oauth2Config, environment } = req.body;
    if (!oauth2Config || !oauth2Config.tokenUrl) {
      return res.status(400).json({ error: 'Missing oauth2Config or tokenUrl' });
    }

    const vars = environment || {};
    
    let resolvedTokenUrl;
    try {
      resolvedTokenUrl = resolveAndValidateTokenUrl(oauth2Config.tokenUrl, vars);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    res.json({ success: true, resolvedTokenUrl });
  });

  app.post('/api/oauth/refresh', (req, res) => {
    const { oauth2Config, environment } = req.body;
    if (!oauth2Config || !oauth2Config.tokenUrl) {
      return res.status(400).json({ error: 'Missing oauth2Config or tokenUrl' });
    }

    const vars = environment || {};
    
    let resolvedTokenUrl;
    try {
      resolvedTokenUrl = resolveAndValidateTokenUrl(oauth2Config.tokenUrl, vars);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    res.json({ success: true, resolvedTokenUrl });
  });

  return app;
}

// ─── Helper: make HTTP request ────────────────────────────────────────────────

function makeRequest(url, method, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            body: JSON.parse(data),
          });
        } catch {
          resolve({
            status: res.statusCode,
            body: data,
          });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let server;
let baseUrl;

before(async () => {
  const app = createTestApp();
  server = http.createServer(app);
  await new Promise((resolve, reject) =>
    server.listen(0, '127.0.0.1', err => (err ? reject(err) : resolve()))
  );
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close(err => (err ? reject(err) : resolve()))
  );
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OAuth token URL variable resolution', () => {
  it('resolves {{host}} in tokenUrl and validates the result', async () => {
    const { status, body } = await makeRequest(`${baseUrl}/api/oauth/exchange-code`, 'POST', {
      oauth2Config: {
        tokenUrl: 'https://{{host}}/oauth/token',
        clientId: 'test-client',
      },
      environment: { host: 'api.example.com' },
    });

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.resolvedTokenUrl, 'https://api.example.com/oauth/token');
  });

  it('resolves multiple variables in tokenUrl', async () => {
    const { status, body } = await makeRequest(`${baseUrl}/api/oauth/exchange-code`, 'POST', {
      oauth2Config: {
        tokenUrl: 'https://{{host}}/oauth/token?tenant={{tenant}}',
        clientId: 'test-client',
      },
      environment: { host: 'api.example.com', tenant: 'acme' },
    });

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.resolvedTokenUrl, 'https://api.example.com/oauth/token?tenant=acme');
  });

  it('works with refresh endpoint too', async () => {
    const { status, body } = await makeRequest(`${baseUrl}/api/oauth/refresh`, 'POST', {
      oauth2Config: {
        tokenUrl: 'https://{{tokenHost}}/oauth/token',
        clientId: 'test-client',
      },
      environment: { tokenHost: 'auth.example.com' },
    });

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.resolvedTokenUrl, 'https://auth.example.com/oauth/token');
  });

  it('rejects resolved URL with invalid scheme', async () => {
    const { status, body } = await makeRequest(`${baseUrl}/api/oauth/exchange-code`, 'POST', {
      oauth2Config: {
        tokenUrl: '{{badScheme}}://api.example.com/token',
        clientId: 'test-client',
      },
      environment: { badScheme: 'ftp' },
    });

    assert.equal(status, 400);
    assert.match(body.error, /Invalid or disallowed tokenUrl/);
  });

  it('rejects when resolved URL is empty after variable substitution', async () => {
    const { status, body } = await makeRequest(`${baseUrl}/api/oauth/exchange-code`, 'POST', {
      oauth2Config: {
        tokenUrl: '{{missingVar}}/oauth/token',
        clientId: 'test-client',
      },
      environment: {},
    });

    assert.equal(status, 400);
    assert.match(body.error, /Invalid or disallowed tokenUrl/);
  });

  it('accepts literal https URL when no variables present', async () => {
    const { status, body } = await makeRequest(`${baseUrl}/api/oauth/exchange-code`, 'POST', {
      oauth2Config: {
        tokenUrl: 'https://api.example.com/oauth/token',
        clientId: 'test-client',
      },
      environment: {},
    });

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.resolvedTokenUrl, 'https://api.example.com/oauth/token');
  });

  it('accepts literal http URL for localhost', async () => {
    const { status, body } = await makeRequest(`${baseUrl}/api/oauth/exchange-code`, 'POST', {
      oauth2Config: {
        tokenUrl: 'http://localhost:3001/oauth/token',
        clientId: 'test-client',
      },
      environment: {},
    });

    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.resolvedTokenUrl, 'http://localhost:3001/oauth/token');
  });
});
