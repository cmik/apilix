'use strict';

const http = require('node:http');

/**
 * Start a fake provider. `handler(req, body, res)` may answer; every request is
 * recorded in `calls`. Returns { url, calls, close }.
 */
async function startFake(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      const call = { method: req.method, url: req.url, headers: req.headers, body, aborted: false };
      calls.push(call);
      req.on('aborted', () => { call.aborted = true; });
      res.on('close', () => { if (!res.writableEnded) call.aborted = true; });
      handler(call, res, calls.length);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
  };
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

module.exports = { startFake, json };
