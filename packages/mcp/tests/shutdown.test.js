'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startServer } = require('./client');
const { startFakeApi } = require('./fake-server');
const { makeTmp, writeJson, ENV_SECRET } = require('./fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (name, p) => ({ name, id: `id-${name}`, request: { method: 'GET', url: `{{base}}${p}` } });

async function slowSetup() {
  const api = await startFakeApi();
  const dir = makeTmp();
  writeJson(dir, 'c.postman_collection.json', { info: { name: 'S' }, item: [{ name: 'F', id: 'f', item: [get('Slow', '/slow'), get('After', '/after-slow')] }] });
  writeJson(dir, 'env.json', { name: 'E', values: [{ key: 'base', value: api.base, enabled: true }] });
  const s = startServer(['--workspace', dir, '--allow-host', '127.0.0.1']);
  await s.initialize();
  const id = s.start('tools/call', { name: 'run_collection', arguments: { collection: 'c.postman_collection.json', environment: 'env.json', timeoutMs: 30000 } }).id;
  await sleep(700);
  assert.equal(api.hits['/slow'], 1, 'the slow request is in flight');
  return { api, s, id, dir };
}

test('EOF on stdin during a slow run: the run is aborted, the process exits promptly, no further request is sent', async () => {
  const { api, s } = await slowSetup();
  const t0 = Date.now();
  const exit = await Promise.race([s.close(), sleep(8000).then(() => ({ code: 'still running' }))]);
  assert.equal(exit.code, 0, `exit=${JSON.stringify(exit)}`);
  assert.ok(Date.now() - t0 < 6000, `exited in ${Date.now() - t0} ms (the slow endpoint takes 10 s)`);
  assert.equal(api.hits['/after-slow'] || 0, 0, 'no request after the abort');
  assert.equal(s.badStdout.length, 0);
  await api.close();
});

test('SIGTERM during a slow run: runs are aborted, clean exit 0, nothing more is sent', { skip: process.platform === 'win32' }, async () => {
  const { api, s } = await slowSetup();
  const t0 = Date.now();
  s.child.kill('SIGTERM');
  const exit = await Promise.race([s.exited, sleep(8000).then(() => ({ code: 'still running' }))]);
  assert.equal(exit.code, 0, `exit=${JSON.stringify(exit)} stderr=${s.stderr}`);
  assert.ok(Date.now() - t0 < 6000);
  assert.match(s.stderr, /received SIGTERM/);
  assert.equal(api.hits['/after-slow'] || 0, 0);
  await api.close();
});

test('a closed stdout (EPIPE) ends the process cleanly instead of crashing', { skip: process.platform === 'win32' }, async () => {
  const dir = makeTmp();
  writeJson(dir, 'c.json', { info: { name: 'X' }, item: [] });
  const s = startServer(['--workspace', dir]);
  await s.initialize();
  s.child.stdout.destroy();
  s.raw(`${JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/list' })}\n`);
  await sleep(100);
  s.raw(`${JSON.stringify({ jsonrpc: '2.0', id: 78, method: 'tools/list' })}\n`);
  const exit = await Promise.race([s.exited, sleep(8000).then(() => ({ code: 'still running' }))]);
  if (exit.code === 'still running') s.child.kill('SIGKILL');
  assert.equal(exit.code, 0, `exit=${JSON.stringify(exit)} stderr=${s.stderr}`);
  assert.ok(!/Unhandled|throw er|at .*\.js:\d+/.test(s.stderr), s.stderr);
});

test('SIGTERM after a write exits 0 and leaves no .apilix-mcp-*.tmp file behind', { skip: process.platform === 'win32' }, async () => {
  const dir = makeTmp();
  const s = startServer(['--workspace', dir, '--allow-write']);
  await s.initialize();
  const big = { info: { name: 'Big' }, item: [{ name: 'a', request: { method: 'GET', url: 'http://x.test/' } }] };
  const r = await s.call('import_collection', { file: 'big.json', collection: big });
  assert.equal(r.isError, false, r.text);
  s.child.kill('SIGTERM');
  const exit = await s.exited;
  assert.equal(exit.code, 0);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('console.log/info/debug/dir/table/warn/error/trace never reach stdout; known secrets are scrubbed on stderr', async () => {
  const dir = makeTmp();
  writeJson(dir, 'c.json', { info: { name: 'X' }, item: [] });
  writeJson(dir, 'env.json', { name: 'E', values: [{ key: 'hidden', value: ENV_SECRET, enabled: true, secret: true }] });
  const script = `
    const { PassThrough } = require('node:stream');
    const { runMcp } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'main'))});
    const stdin = new PassThrough();
    const done = runMcp(['--workspace', ${JSON.stringify(dir)}], { stdin });
    const send = (o) => stdin.write(JSON.stringify(o) + '\\n');
    setTimeout(() => send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }), 200);
    setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_collections', arguments: {} } }), 400);
    setTimeout(() => {
      console.log('L-log', ${JSON.stringify(ENV_SECRET)});
      console.info('L-info'); console.debug('L-debug'); console.dir({ k: 'L-dir' }); console.table([{ a: 'L-table' }]);
      console.warn('L-warn'); console.error('L-error'); console.trace('L-trace');
      stdin.end();
    }, 900);
    done.then((c) => process.exit(c));
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  await new Promise((r) => child.on('exit', r));
  for (const line of out.split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line), `non-JSON on stdout: ${line}`);
  for (const tag of ['L-log', 'L-info', 'L-debug', 'L-dir', 'L-table', 'L-warn', 'L-error', 'L-trace']) {
    assert.ok(!out.includes(tag), `${tag} leaked to stdout`);
    assert.ok(err.includes(tag), `${tag} missing from stderr`);
  }
  assert.ok(!err.includes(ENV_SECRET), 'a known secret is scrubbed from redirected console output');
});
