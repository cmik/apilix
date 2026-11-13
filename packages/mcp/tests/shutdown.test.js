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
const waitFor = async (cond, what, timeoutMs = 60000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
};

const get = (name, p) => ({ name, id: `id-${name}`, request: { method: 'GET', url: `{{base}}${p}` } });

async function slowSetup(t) {
  const api = await startFakeApi();
  t.after(() => api.close());
  const dir = makeTmp();
  writeJson(dir, 'c.postman_collection.json', { info: { name: 'S' }, item: [{ name: 'F', id: 'f', item: [get('Slow', '/slow'), get('After', '/after-slow')] }] });
  writeJson(dir, 'env.json', { name: 'E', values: [{ key: 'base', value: api.base, enabled: true }] });
  const s = startServer(['--workspace', dir, '--allow-host', '127.0.0.1']);
  t.after(() => { if (!s.child.killed && s.child.exitCode === null) s.child.kill('SIGKILL'); });
  await s.initialize();
  const id = s.start('tools/call', { name: 'run_collection', arguments: { collection: 'c.postman_collection.json', environment: 'env.json', timeoutMs: 30000 } }).id;
  await waitFor(() => api.hits['/slow'] === 1, 'the slow request to reach the server');
  return { api, s, id, dir };
}

test('EOF on stdin during a slow run: the run is aborted, the process exits promptly, no further request is sent', async (t) => {
  const { api, s } = await slowSetup(t);
  const t0 = Date.now();
  const exit = await Promise.race([s.close(), sleep(8000).then(() => ({ code: 'still running' }))]);
  assert.equal(exit.code, 0, `exit=${JSON.stringify(exit)}`);
  assert.ok(Date.now() - t0 < 6000, `exited in ${Date.now() - t0} ms (the slow endpoint takes 10 s)`);
  assert.equal(api.hits['/after-slow'] || 0, 0, 'no request after the abort');
  assert.equal(s.badStdout.length, 0);
});

test('SIGTERM during a slow run: runs are aborted, clean exit 0, nothing more is sent', { skip: process.platform === 'win32' }, async (t) => {
  const { api, s } = await slowSetup(t);
  const t0 = Date.now();
  s.child.kill('SIGTERM');
  const exit = await Promise.race([s.exited, sleep(8000).then(() => ({ code: 'still running' }))]);
  assert.equal(exit.code, 0, `exit=${JSON.stringify(exit)} stderr=${s.stderr}`);
  assert.ok(Date.now() - t0 < 6000);
  assert.match(s.stderr, /received SIGTERM/);
  assert.equal(api.hits['/after-slow'] || 0, 0);
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

test('console.log/info/debug/dir/table/warn/error/trace never reach stdout; known secrets are scrubbed on stderr', async (t) => {
  const dir = makeTmp();
  writeJson(dir, 'c.json', { info: { name: 'X' }, item: [] });
  writeJson(dir, 'env.json', { name: 'E', values: [{ key: 'hidden', value: ENV_SECRET, enabled: true, secret: true }] });
  const script = `
    const { runMcp } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'main'))});
    const done = runMcp(['--workspace', ${JSON.stringify(dir)}]);
    process.on('SIGUSR2', () => {
      console.log('L-log', ${JSON.stringify(ENV_SECRET)});
      console.info('L-info'); console.debug('L-debug'); console.dir({ k: 'L-dir' }); console.table([{ a: 'L-table' }]);
      console.warn('L-warn'); console.error('L-error'); console.trace('L-trace');
      process.stderr.write('LOGS-DONE\\n');
    });
    done.then((c) => process.exit(c));
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((r) => child.on('exit', r));
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await waitFor(() => out.includes('"id":1'), 'the initialize response');
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_collections', arguments: {} } });
  await waitFor(() => out.includes('"id":2'), 'the list_collections response (the secret is registered by then)');
  child.kill('SIGUSR2');
  await waitFor(() => err.includes('LOGS-DONE'), 'the console calls');
  child.stdin.end();
  await exited;
  for (const line of out.split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line), `non-JSON on stdout: ${line}`);
  for (const tag of ['L-log', 'L-info', 'L-debug', 'L-dir', 'L-table', 'L-warn', 'L-error', 'L-trace']) {
    assert.ok(!out.includes(tag), `${tag} leaked to stdout`);
    assert.ok(err.includes(tag), `${tag} missing from stderr`);
  }
  assert.ok(!err.includes(ENV_SECRET), 'a known secret is scrubbed from redirected console output');
});

/** Spawn the server in a child whose fs.open() returns a handle that never finishes writing a .tmp file (a write "in progress", deterministically). */
function spawnStalledWriter(dir, extraArgs = []) {
  const script = `
    const fsp = require('node:fs/promises');
    const realOpen = fsp.open;
    fsp.open = async (...a) => {
      const fh = await realOpen(...a);
      if (!String(a[0]).endsWith('.tmp')) return fh;
      return new Proxy(fh, { get(t, k) { if (k === 'writeFile') return async () => { process.stderr.write('WRITE-STALLED\\n'); await new Promise(() => {}); }; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
    };
    require(${JSON.stringify(path.join(__dirname, '..', 'src', 'main'))}).runMcp(JSON.parse(process.env.MCP_ARGS)).then((c) => process.exit(c));
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MCP_ARGS: JSON.stringify(['--workspace', dir, '--allow-write', ...extraArgs]) } });
  const state = { err: '', out: '', exit: null };
  child.stderr.on('data', (d) => { state.err += d; });
  child.stdout.on('data', (d) => { state.out += d; });
  const exited = new Promise((r) => child.on('exit', (code, signal) => { state.exit = { code, signal }; r(state.exit); }));
  const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'import_collection', arguments: { file: 'w.json', collection: { info: { name: 'W' }, item: [] } } } });
  return { child, state, exited };
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  test(`${sig} while a write is IN PROGRESS: exits promptly and no .apilix-mcp-*.tmp is left`, { skip: process.platform === 'win32' }, async (t) => {
    const dir = makeTmp();
    const w = spawnStalledWriter(dir);
    t.after(() => { if (!w.state.exit) w.child.kill('SIGKILL'); });
    await waitFor(() => w.state.err.includes('WRITE-STALLED'), 'the stalled write');
    assert.ok(fs.readdirSync(dir).some((f) => /^\.apilix-mcp-.*\.tmp$/.test(f)), 'a temp file exists while the write is in progress');
    w.child.kill(sig);
    const exit = await Promise.race([w.exited, sleep(15000).then(() => ({ code: 'still running' }))]);
    assert.equal(exit.code, 0, `exit=${JSON.stringify(exit)} stderr=${w.state.err}`);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  });
}
