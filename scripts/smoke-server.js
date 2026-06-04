'use strict';
// Minimal HTTP server used by CI smoke tests.
// Usage: node scripts/smoke-server.js <port>
const http = require('http');
const port = parseInt(process.argv[2], 10);
if (!port) { process.stderr.write('Usage: smoke-server.js <port>\n'); process.exit(2); }
http.createServer(function (req, res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}).listen(port, '127.0.0.1');
