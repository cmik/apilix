'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Writable } = require('node:stream');

const { runCli, usage } = require('../src/index');

const BIN = path.join(__dirname, '..', '..', '..', 'bin', 'apilix.js');

function sink() {
  let text = '';
  const stream = new Writable({ write(chunk, enc, cb) { text += chunk.toString(); cb(); } });
  return { stream, get text() { return text; } };
}

test('usage mentions the mcp command', () => {
  assert.match(usage(), /apilix mcp/);
});

test('apilix mcp --help prints the MCP help and exits 0', async () => {
  const out = sink();
  const err = sink();
  const code = await runCli(['mcp', '--help'], { stdout: out.stream, stderr: err.stream });
  assert.equal(code, 0);
  assert.match(out.text, /Usage: apilix mcp/);
  assert.match(out.text, /--allow-write/);
  assert.match(out.text, /--no-run/);
  assert.match(out.text, /--allow-host/);
});

test('apilix mcp with an unknown flag exits 2 and does not start the server', async () => {
  const out = sink();
  const err = sink();
  const code = await runCli(['mcp', '--nope'], { stdout: out.stream, stderr: err.stream });
  assert.equal(code, 2);
  assert.match(err.text, /Unknown option/);
  assert.equal(out.text, '');
});

test('a CLI build without @apilix/mcp reports a clear message and exit code 2', async () => {
  const out = sink();
  const err = sink();
  const code = await runCli(['mcp'], { stdout: out.stream, stderr: err.stream, loadMcp: () => { throw Object.assign(new Error("Cannot find module '@apilix/mcp'\nRequire stack:\n- /x/cli.js"), { code: 'MODULE_NOT_FOUND' }); } });
  assert.equal(code, 2);
  assert.match(err.text, /MCP support is not available in this build of the CLI/);
});

test('any other failure while loading @apilix/mcp is NOT masked as "not available"', async () => {
  const out = sink();
  const err = sink();
  // a dependency of @apilix/mcp is missing: the message mentions the package only in the require stack
  const missingDep = () => { throw Object.assign(new Error("Cannot find module 'ajv'\nRequire stack:\n- /x/node_modules/@apilix/mcp/src/server.js"), { code: 'MODULE_NOT_FOUND' }); };
  await assert.rejects(runCli(['mcp'], { stdout: out.stream, stderr: err.stream, loadMcp: missingDep }), /Cannot find module 'ajv'/);
  await assert.rejects(runCli(['mcp'], { stdout: out.stream, stderr: err.stream, loadMcp: () => { throw new SyntaxError('Unexpected token'); } }), /Unexpected token/);
  assert.doesNotMatch(err.text, /not available in this build/);
});

test('apilix mcp usage errors for the execution flags exit 2', async () => {
  for (const args of [['--allow-any-host', '--allow-host', 'a.com'], ['--allow-write', '--allow-any-host'], ['--allow-write', '--allow-host', 'a.com']]) {
    const out = sink();
    const err = sink();
    const code = await runCli(['mcp', ...args], { stdout: out.stream, stderr: err.stream });
    assert.equal(code, 2, args.join(' '));
    assert.match(err.text, /mutually exclusive|arbitrary code execution/);
  }
  const out = sink();
  await runCli(['mcp', '--help'], { stdout: out.stream, stderr: sink().stream });
  assert.match(out.text, /--allow-any-host/);
  assert.match(out.text, /--unsafe-allow-write-and-run/);
});

test('bin/apilix.js mcp speaks MCP over stdio (initialize, tools/list, tools/call) and exits 0 on EOF', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'apilix-cli-mcp-'));
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ info: { name: 'CLI MCP' }, item: [{ name: 'R', request: { method: 'GET', url: 'http://x.test/' } }] }));
  const child = spawn(process.execPath, [BIN, 'mcp', '--workspace', dir, '--no-run'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const msgs = [];
  let stderr = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { msgs.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
  const waitFor = async (id) => { const end = Date.now() + 30000; while (Date.now() < end) { const m = msgs.find((x) => x.id === id); if (m) return m; await new Promise((r) => setTimeout(r, 25)); } throw new Error(`timeout ${id}\n${stderr}`); };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal((await waitFor(1)).result.serverInfo.name, 'apilix');
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = (await waitFor(2)).result.tools.map((t) => t.name);
  assert.ok(names.includes('list_collections'));
  assert.ok(!names.includes('run_request'), '--no-run is honoured through the CLI');
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_collections', arguments: {} } });
  const call = await waitFor(3);
  assert.equal(JSON.parse(call.result.content[0].text).collections[0].name, 'CLI MCP');
  child.stdin.end();
  assert.equal(await exited, 0);
});
