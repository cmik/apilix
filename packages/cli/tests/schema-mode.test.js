'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { runCli, usage } = require('../src/index');

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(r => server.close(r)); }
}

async function withDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apilix-cli-schema-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function makeIo(cwd) {
  const out = []; const err = [];
  return { cwd, stdout: { write: c => out.push(String(c)) }, stderr: { write: c => err.push(String(c)) }, out: () => out.join(''), err: () => err.join('') };
}

async function writeCollection(dir, base) {
  const collection = {
    info: { name: 'Schema CLI', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ id: 'r1', name: 'Pet', request: { method: 'GET', url: { raw: `${base}/pet` }, apilix: { schemaLinks: [{ schemaId: 's1', match: '2xx' }] } } }],
    apilix: { schemas: [{ id: 's1', name: 'Pet', version: 1, schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } }] },
  };
  await fs.writeFile(path.join(dir, 'c.json'), JSON.stringify(collection));
}

const bad = (_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"name":1}'); };

test('usage documents --schema-mode', () => {
  assert.match(usage(), /--schema-mode <off\|warn\|strict>/);
});

test('invalid --schema-mode exits 2', async () => {
  await withDir(async dir => {
    const io = makeIo(dir);
    assert.equal(await runCli(['run', 'c.json', '--schema-mode', 'bogus'], io), 2);
    assert.match(io.err(), /schema-mode/);
  });
});

test('default (warn) exits 0 on a violation and reports it; off exits 0; strict exits 1', async () => {
  await withServer(bad, async base => {
    await withDir(async dir => {
      await writeCollection(dir, base);
      let io = makeIo(dir);
      assert.equal(await runCli(['run', 'c.json', '--no-color'], io), 0);
      assert.match(io.err(), /1 schema warning/);

      io = makeIo(dir);
      assert.equal(await runCli(['run', 'c.json', '--schema-mode', 'off', '--no-color'], io), 0);
      assert.doesNotMatch(io.err(), /schema warning/);

      io = makeIo(dir);
      assert.equal(await runCli(['run', 'c.json', '--schema-mode', 'strict', '--no-color', '--reporter', 'json'], io), 1);
      const report = JSON.parse(io.out());
      assert.equal(report.config.schemaMode, 'strict');
      assert.equal(report.iterations[0].results[0].testResults[0].synthetic, true);
    });
  });
});

test('strict exits 0 when the response matches', async () => {
  await withServer((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"name":"x"}'); }, async base => {
    await withDir(async dir => {
      await writeCollection(dir, base);
      assert.equal(await runCli(['run', 'c.json', '--schema-mode', 'strict', '--no-color'], makeIo(dir)), 0);
    });
  });
});

test('usage documents --schema-timeout; invalid values exit 2', async () => {
  assert.match(usage(), /--schema-timeout <ms>/);
  await withDir(async dir => {
    let io = makeIo(dir);
    assert.equal(await runCli(['run', 'c.json', '--schema-timeout', 'soon'], io), 2);
    assert.match(io.err(), /schema timeout/i);
    io = makeIo(dir);
    io.env = { APILIX_SCHEMA_TIMEOUT_MS: 'x1' };
    assert.equal(await runCli(['run', 'c.json'], io), 2);
  });
});

test('--schema-timeout / APILIX_SCHEMA_TIMEOUT_MS bound validation: strict fails, warn warns', async () => {
  const guard = require('@apilix/core/schema-guard');
  const evil = JSON.stringify(`${'a'.repeat(45)}!`);
  await withServer((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(evil); }, async base => {
    await withDir(async dir => {
      const collection = {
        info: { name: 'Slow', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [{ id: 'r1', name: 'Pet', request: { method: 'GET', url: { raw: `${base}/pet` }, apilix: { schemaLinks: [{ schemaId: 's1', match: '2xx' }] } } }],
        apilix: { schemas: [{ id: 's1', name: 'Slow', version: 1, schema: { type: 'string', pattern: '^(a+)+$' } }] },
      };
      await fs.writeFile(path.join(dir, 'c.json'), JSON.stringify(collection));
      try {
        let io = makeIo(dir);
        assert.equal(await runCli(['run', 'c.json', '--schema-mode', 'strict', '--schema-timeout', '200', '--no-color'], io), 1);
        assert.equal(guard.getSchemaValidationTimeoutMs(), 200);
        io = makeIo(dir);
        io.env = { APILIX_SCHEMA_TIMEOUT_MS: '300' };
        assert.equal(await runCli(['run', 'c.json', '--no-color'], io), 0);
        assert.match(io.err(), /1 schema warning/);
        assert.equal(guard.getSchemaValidationTimeoutMs(), 300);
      } finally { guard.setSchemaValidationTimeoutMs(undefined); guard._shutdown(); }
    });
  });
});

test('usage describes the run-level ceiling and the 100-10000 timeout range; out-of-range timeouts exit 2', async () => {
  assert.match(usage(), /ceiling/);
  assert.match(usage(), /100-10000/);
  await withDir(async dir => {
    for (const v of ['50', '10001', '60000']) {
      const io = makeIo(dir);
      assert.equal(await runCli(['run', 'c.json', '--schema-timeout', v], io), 2, v);
      assert.match(io.err(), /between 100 and 10000/);
    }
  });
});

test('static-check mode prints a single "time limit not enforced" warning per process', async () => {
  const prev = process.env.APILIX_SCHEMA_NO_WORKER;
  process.env.APILIX_SCHEMA_NO_WORKER = '1';
  try {
    await withServer((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"name":"x"}'); }, async base => {
      await withDir(async dir => {
        await writeCollection(dir, base);
        const first = makeIo(dir);
        assert.equal(await runCli(['run', 'c.json', '--no-color'], first), 0);
        assert.match(first.err(), /time limit is not enforced/);
        const second = makeIo(dir);
        assert.equal(await runCli(['run', 'c.json', '--no-color'], second), 0);
        assert.doesNotMatch(second.err(), /time limit is not enforced/);
      });
    });
  } finally {
    if (prev === undefined) delete process.env.APILIX_SCHEMA_NO_WORKER; else process.env.APILIX_SCHEMA_NO_WORKER = prev;
  }
});
