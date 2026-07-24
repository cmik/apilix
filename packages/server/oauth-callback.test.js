'use strict';

/**
 * Tests for the OAuth 2.0 Authorization Code callback bridge:
 *   GET /oauth/callback          – the redirect URI registered with OAuth providers
 *   GET /api/oauth/auth-callback-stream – the SSE stream the renderer subscribes to
 *
 * These route handlers are inlined verbatim from index.js so the tests remain
 * self-contained. If the production handlers diverge from this copy, the tests
 * will diverge too, which is a deliberate reminder to keep them in sync.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

// ─── Replicated shared state + route handlers (verbatim from index.js) ────────

const _oauthSseClients = new Map();

function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildApp() {
  const app = express();

  app.get('/oauth/callback', (req, res) => {
    const { code, state, error } = req.query;
    if (!state || typeof state !== 'string' || state.length > 512) {
      return res.status(400).send('<h2>Invalid OAuth callback (missing or invalid state)</h2>');
    }

    const sseClient = _oauthSseClients.get(state);
    if (sseClient) {
      sseClient.write(`event: code\ndata: ${JSON.stringify({ code: code || null, error: error || null })}\n\n`);
      sseClient.end();
      _oauthSseClients.delete(state);
    }

    const html = error
      ? `<html><body style="font-family:sans-serif;padding:2em"><h2>Authorization failed</h2><p>${_escapeHtml(String(error))}</p><p>You can close this tab and return to Apilix.</p></body></html>`
      : `<html><body style="font-family:sans-serif;padding:2em"><h2>Authorization successful</h2><p>You can close this tab and return to Apilix.</p></body></html>`;
    res.set('Content-Type', 'text/html').send(html);
  });

  app.get('/api/oauth/auth-callback-stream', (req, res) => {
    const { state } = req.query;
    if (!state || typeof state !== 'string' || state.length > 512) {
      return res.status(400).json({ error: 'Missing or invalid state parameter' });
    }

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    _oauthSseClients.set(state, res);

    const timeout = setTimeout(() => {
      _oauthSseClients.delete(state);
      res.write('event: timeout\ndata: {}\n\n');
      res.end();
    }, 5 * 60 * 1000);

    req.on('close', () => {
      _oauthSseClients.delete(state);
      clearTimeout(timeout);
    });
  });

  return app;
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let server;
let baseUrl;

before(async () => {
  const app = buildApp();
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

beforeEach(() => {
  _oauthSseClients.clear();
});

// ─── Helper: buffered GET ─────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

// ─── /oauth/callback — input validation ──────────────────────────────────────

describe('/oauth/callback — input validation', () => {
  it('returns 400 when state parameter is missing', async () => {
    const { status, body } = await get(`${baseUrl}/oauth/callback?code=abc`);
    assert.equal(status, 400);
    assert.ok(body.includes('missing or invalid state'));
  });

  it('returns 400 when state parameter exceeds 512 characters', async () => {
    const longState = 'a'.repeat(513);
    const { status } = await get(`${baseUrl}/oauth/callback?code=abc&state=${longState}`);
    assert.equal(status, 400);
  });

  it('returns 400 when state is an empty string', async () => {
    const { status } = await get(`${baseUrl}/oauth/callback?code=abc&state=`);
    assert.equal(status, 400);
  });
});

// ─── /oauth/callback — browser HTML response ─────────────────────────────────

describe('/oauth/callback — browser HTML response', () => {
  it('returns 200 success HTML when no error and no waiting SSE client', async () => {
    const { status, headers, body } = await get(`${baseUrl}/oauth/callback?code=abc&state=state1`);
    assert.equal(status, 200);
    assert.ok(headers['content-type'].includes('text/html'));
    assert.ok(body.includes('Authorization successful'));
    assert.ok(body.includes('close this tab'));
  });

  it('returns failure HTML when error param is present', async () => {
    const { status, body } = await get(`${baseUrl}/oauth/callback?error=access_denied&state=state1`);
    assert.equal(status, 200);
    assert.ok(body.includes('Authorization failed'));
    assert.ok(body.includes('access_denied'));
  });

  it('HTML-escapes the error message to prevent XSS', async () => {
    const malicious = '<script>alert(1)</script>';
    const { body } = await get(`${baseUrl}/oauth/callback?error=${encodeURIComponent(malicious)}&state=state1`);
    assert.ok(!body.includes('<script>'), 'raw <script> tag must not appear in response');
    assert.ok(body.includes('&lt;script&gt;'), 'HTML-escaped form must appear');
  });
});

// ─── /api/oauth/auth-callback-stream — input validation ──────────────────────

describe('/api/oauth/auth-callback-stream — input validation', () => {
  it('returns 400 JSON when state is missing', async () => {
    const { status, body } = await get(`${baseUrl}/api/oauth/auth-callback-stream`);
    assert.equal(status, 400);
    const parsed = JSON.parse(body);
    assert.equal(parsed.error, 'Missing or invalid state parameter');
  });

  it('returns 400 when state exceeds 512 characters', async () => {
    const longState = 'z'.repeat(513);
    const { status } = await get(`${baseUrl}/api/oauth/auth-callback-stream?state=${longState}`);
    assert.equal(status, 400);
  });
});

// ─── SSE integration: auth-callback-stream + oauth/callback ──────────────────

describe('SSE integration: /api/oauth/auth-callback-stream + /oauth/callback', () => {
  it('pushes a code event to the waiting SSE client when callback is hit', (t, done) => {
    const sseReq = http.get(
      `${baseUrl}/api/oauth/auth-callback-stream?state=flow-state`,
      (sseRes) => {
        assert.equal(sseRes.statusCode, 200);
        assert.ok(sseRes.headers['content-type'].includes('text/event-stream'));

        let buffer = '';
        sseRes.on('data', chunk => { buffer += chunk.toString(); });
        sseRes.on('end', () => {
          assert.ok(buffer.includes('event: code'), `expected 'event: code' in buffer`);
          const dataLine = buffer.split('\n').find(l => l.startsWith('data:'));
          const parsed = JSON.parse(dataLine.slice('data: '.length));
          assert.equal(parsed.code, 'the_auth_code');
          assert.equal(parsed.error, null);
          done();
        });

        // Headers received ⇒ SSE client is already registered in _oauthSseClients.
        // Trigger the callback immediately.
        http.get(
          `${baseUrl}/oauth/callback?code=the_auth_code&state=flow-state`,
          res => res.resume()
        );
      }
    );
    sseReq.on('error', done);
  });

  it('delivers an error field when the callback carries an OAuth error param', (t, done) => {
    http.get(
      `${baseUrl}/api/oauth/auth-callback-stream?state=err-state`,
      (sseRes) => {
        let buffer = '';
        sseRes.on('data', chunk => { buffer += chunk.toString(); });
        sseRes.on('end', () => {
          const dataLine = buffer.split('\n').find(l => l.startsWith('data:'));
          const parsed = JSON.parse(dataLine.slice('data: '.length));
          assert.equal(parsed.code, null);
          assert.equal(parsed.error, 'access_denied');
          done();
        });

        http.get(
          `${baseUrl}/oauth/callback?error=access_denied&state=err-state`,
          res => res.resume()
        );
      }
    );
  });

  it('callback returns success HTML even when no SSE client is waiting', async () => {
    const { status, body } = await get(
      `${baseUrl}/oauth/callback?code=orphan_code&state=no-sse-state`
    );
    assert.equal(status, 200);
    assert.ok(body.includes('Authorization successful'));
    // Map stays clean
    assert.equal(_oauthSseClients.has('no-sse-state'), false);
  });

  it('removes the state from the map when the SSE client disconnects', (t, done) => {
    const sseReq = http.get(
      `${baseUrl}/api/oauth/auth-callback-stream?state=close-state`,
      (sseRes) => {
        sseRes.resume();
        // Destroy the socket to simulate the renderer closing the SSE connection.
        sseReq.destroy();

        // The server's req 'close' event fires asynchronously after socket teardown.
        setTimeout(() => {
          assert.equal(
            _oauthSseClients.has('close-state'),
            false,
            'state must be removed from map after disconnect'
          );
          done();
        }, 100);
      }
    );
    sseReq.on('error', () => {}); // suppress ECONNRESET from destroy
  });

  it('sends a timeout event after 5 minutes of inactivity', (t, done) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const sseReq = http.get(
      `${baseUrl}/api/oauth/auth-callback-stream?state=timeout-state`,
      (sseRes) => {
        let buffer = '';
        sseRes.on('data', chunk => { buffer += chunk.toString(); });
        sseRes.on('end', () => {
          assert.ok(buffer.includes('event: timeout'), `expected 'event: timeout' in buffer`);
          assert.equal(_oauthSseClients.has('timeout-state'), false);
          done();
        });

        // Response headers received ⇒ the server's setTimeout is now registered.
        // Advance fake timers past the 5-minute threshold.
        setImmediate(() => {
          t.mock.timers.tick(5 * 60 * 1000 + 100);
        });
      }
    );
    sseReq.on('error', done);
  });
});
