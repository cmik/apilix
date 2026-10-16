'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { executeRequest } = require('../src/request-engine');

async function withResponseServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

function makeItem(url) {
  return {
    request: { method: 'GET', url: { raw: url }, header: [] },
    event: [],
  };
}

test('executeRequest preserves binary response bytes and decoded body text', async () => {
  const originalBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x80, 0x41]);

  await withResponseServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip' });
    res.end(originalBytes);
  }, async baseUrl => {
    const response = await executeRequest(makeItem(baseUrl), {});

    assert.equal(response.bodyBase64, originalBytes.toString('base64'));
    assert.deepEqual(Buffer.from(response.bodyBase64, 'base64'), originalBytes);
    assert.equal(response.size, originalBytes.length);
  });
});

test('executeRequest keeps text responses as text without binary payload', async () => {
  await withResponseServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"ok":true}');
  }, async baseUrl => {
    const response = await executeRequest(makeItem(baseUrl), {});

    assert.equal(response.body, '{\n  "ok": true\n}');
    assert.equal(response.bodyBase64, undefined);
  });
});

test('executeRequest retains file bytes when Content-Disposition marks a download', async () => {
  const originalBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]);

  await withResponseServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-disposition': 'attachment; filename="archive.zip"',
    });
    res.end(originalBytes);
  }, async baseUrl => {
    const response = await executeRequest(makeItem(baseUrl), {});

    assert.deepEqual(Buffer.from(response.bodyBase64, 'base64'), originalBytes);
  });
});