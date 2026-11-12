'use strict';

const http = require('node:http');

const BODY_TOKEN = 'respSecret_QwErTy123456';

/** Local fake API used by the run tests. Counts hits per path. */
function startFakeApi() {
  const hits = {};
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits[url.pathname] = (hits[url.pathname] || 0) + 1;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (url.pathname === '/ping') {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=cookieSecretValue123; Path=/' });
        res.end(JSON.stringify({ ok: true, access_token: BODY_TOKEN, note: 'hello' }));
      } else if (url.pathname === '/echo') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-reflected': String(req.headers['x-env-secret'] || '') });
        res.end(JSON.stringify({ seen: String(req.headers.authorization || ''), envSecret: String(req.headers['x-env-secret'] || ''), query: url.search, body, free: `plain text with ${req.headers['x-env-secret'] || ''} inside` }));
      } else if (url.pathname === '/redirect') {
        res.writeHead(302, { location: `http://localhost:${server.address().port}/landed` });
        res.end();
      } else if (url.pathname === '/slow') {
        const t = setTimeout(() => { res.writeHead(200); res.end('late'); }, 10000);
        req.on('close', () => clearTimeout(t));
      } else if (url.pathname === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('B'.repeat(200000));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ path: url.pathname, method: req.method }));
      }
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        base: `http://127.0.0.1:${server.address().port}`,
        hits,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
      });
    });
  });
}

module.exports = { startFakeApi, BODY_TOKEN };
