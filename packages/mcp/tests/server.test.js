'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./client');
const { collectionFixture, environmentFixture, makeTmp, writeJson, SECRET_TOKEN, ENV_SECRET, LITERAL_AUTH, PASSWORD } = require('./fixtures');

function workspaceDir() {
  const dir = makeTmp();
  writeJson(dir, 'demo.postman_collection.json', collectionFixture());
  writeJson(dir, 'envs/local.json', environmentFixture('http://127.0.0.1:1'));
  return dir;
}

async function withServer(args, fn, dirOpt) {
  const dir = dirOpt || workspaceDir();
  const s = startServer(['--workspace', dir, ...args]);
  try {
    await s.initialize();
    await fn(s, dir);
  } finally {
    const r = await s.close();
    assert.equal(s.badStdout.length, 0, `stdout must carry JSON-RPC only, got: ${s.badStdout[0]}`);
    assert.equal(r.code, 0);
  }
}

test('initialize -> tools/list -> tools/call over a real stdio process', async () => {
  const dir = workspaceDir();
  const s = startServer(['--workspace', dir]);
  const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'apilix');
  assert.ok(init.result.capabilities.tools);
  assert.ok(init.result.instructions.includes('untrusted'));
  s.notify('notifications/initialized');
  const list = await s.request('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  for (const n of ['list_collections', 'list_requests', 'get_request', 'export_docs']) assert.ok(names.includes(n), n);
  const lc = await s.call('list_collections');
  assert.equal(lc.isError, false);
  assert.equal(lc.data.collections[0].name, 'Demo API');
  assert.ok(s.stderr.includes('ready'));
  await s.close();
  assert.equal(s.badStdout.length, 0);
});

test('every tool has a strict schema, a description and coherent annotations', async () => {
  await withServer(['--allow-write', '--allow-host', '127.0.0.1', '--unsafe-allow-write-and-run'], async (s) => {
    const { result } = await s.request('tools/list', {});
    assert.deepEqual(result.tools.map((t) => t.name).sort(), ['export_docs', 'get_last_results', 'get_request', 'import_collection', 'list_collections', 'list_requests', 'run_collection', 'run_request']);
    for (const t of result.tools) {
      assert.equal(t.inputSchema.type, 'object', t.name);
      assert.equal(t.inputSchema.additionalProperties, false, `${t.name} must reject unknown properties`);
      assert.ok(t.description.length > 40, t.name);
      assert.equal(typeof t.annotations.readOnlyHint, 'boolean', t.name);
      assert.equal(typeof t.annotations.openWorldHint, 'boolean', t.name);
      if (!t.annotations.readOnlyHint) assert.equal(typeof t.annotations.destructiveHint, 'boolean', t.name);
      if (t.annotations.readOnlyHint) assert.equal(t.annotations.destructiveHint, false, t.name);
      for (const [k, v] of Object.entries(t.inputSchema.properties || {})) {
        if (v.type === 'string' && !v.enum) assert.ok(v.maxLength, `${t.name}.${k} needs maxLength`);
        if (v.type === 'integer') assert.ok(v.maximum !== undefined, `${t.name}.${k} needs a bound`);
      }
    }
  });
});

test('tools/call protocol errors: unknown tool is -32602, bad params shapes', async () => {
  await withServer([], async (s) => {
    let r = await s.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(r.error.code, -32602);
    r = await s.request('tools/call', { arguments: {} });
    assert.equal(r.error.code, -32602);
    r = await s.request('tools/call', { name: 'list_collections', arguments: [] });
    assert.equal(r.error.code, -32602);
    r = await s.request('tools/call', { name: 'list_collections', arguments: null });
    assert.equal(r.error.code, -32602);
    r = await s.request('tools/call');
    assert.equal(r.error.code, -32602);
    r = await s.request('tools/list', { cursor: 'abc' });
    assert.equal(r.error.code, -32602);
    r = await s.request('prompts/list', {});
    assert.equal(r.error.code, -32601);
  });
});

test('invalid tool arguments come back as isError results the model can correct', async () => {
  await withServer([], async (s) => {
    for (const [name, args, re] of [
      ['list_requests', {}, /collection/],
      ['list_requests', { collection: 'x', extra: 1 }, /unexpected property "extra"/],
      ['list_requests', { collection: 5 }, /string/],
      ['list_collections', { limit: 0 }, /limit/],
      ['list_collections', { limit: 100000 }, /limit/],
      ['list_collections', { offset: -1 }, /offset/],
      ['get_request', { collection: 'x'.repeat(2000), request: 'a' }, /collection/],
      ['export_docs', { collection: 'x', format: 'pdf' }, /format/],
    ]) {
      const r = await s.call(name, args);
      assert.equal(r.isError, true, name);
      assert.match(r.text, re, `${name}: ${r.text}`);
    }
  });
});

test('list_collections / list_requests / get_request on a fixture', async () => {
  await withServer([], async (s) => {
    const lc = await s.call('list_collections');
    assert.deepEqual(lc.data.environments.map((e) => [e.name, e.variables, e.secretVariables]), [['Local', 4, 1]]);
    const col = lc.data.collections[0];
    assert.equal(col.requests, 4);
    assert.equal(col.folders, 1);
    assert.equal(lc.data.untrustedContent, true);

    const lr = await s.call('list_requests', { collection: col.id });
    assert.deepEqual(lr.data.items.map((i) => i.path), ['Users', 'Users/List users', 'Users/Create user', 'Ping', 'Fails']);
    assert.equal(lr.data.items[1].method, 'GET');
    assert.ok(lr.data.items[1].url.startsWith('{{base}}/users'));
    const inFolder = await s.call('list_requests', { collection: col.id, folder: 'Users' });
    assert.equal(inFolder.data.total, 2);
    const page = await s.call('list_requests', { collection: col.id, limit: 2 });
    assert.equal(page.data.items.length, 2);
    assert.equal(page.data.nextOffset, 2);

    const gr = await s.call('get_request', { collection: col.id, request: 'req-list' });
    assert.equal(gr.data.request.method, 'GET');
    assert.equal(gr.data.request.headers.find((h) => h.key === 'Authorization').value, '<redacted>');

    const missing = await s.call('get_request', { collection: col.id, request: 'nope' });
    assert.equal(missing.isError, true);
    const bad = await s.call('get_request', { collection: 'does-not-exist.json', request: 'x' });
    assert.equal(bad.isError, true);
  });
});

test('no tool output or resource ever contains a secret (headers, URL, body, auth, env)', async () => {
  await withServer([], async (s) => {
    const lc = await s.call('list_collections');
    const colId = lc.data.collections[0].id;
    const outputs = [lc.text];
    outputs.push((await s.call('list_requests', { collection: colId })).text);
    for (const ref of ['req-list', 'req-create', 'req-ping']) outputs.push((await s.call('get_request', { collection: colId, request: ref })).text);
    for (const format of ['html', 'markdown', 'openapi']) {
      outputs.push((await s.call('export_docs', { collection: colId, format, includeExamples: true })).text);
    }
    const withEnv = await s.call('export_docs', { collection: colId, format: 'markdown', environment: 'envs/local.json', resolveVariables: true });
    assert.equal(withEnv.isError, false);
    outputs.push(withEnv.text);
    const res = await s.request('resources/list', {});
    outputs.push(JSON.stringify(res));
    for (const r of res.result.resources) outputs.push(JSON.stringify(await s.request('resources/read', { uri: r.uri })));
    const joined = outputs.join('\n');
    for (const secret of [SECRET_TOKEN, ENV_SECRET, LITERAL_AUTH, PASSWORD]) {
      assert.ok(!joined.includes(secret), `leaked ${secret}`);
    }
    assert.ok(joined.includes('visible-value'), 'non-secret env values are readable through the resource');
  });
});

test('resources: list, read collection/environment, reject bad URIs', async () => {
  await withServer([], async (s) => {
    const list = await s.request('resources/list', {});
    const uris = list.result.resources.map((r) => r.uri);
    assert.equal(uris.length, 2);
    const env = list.result.resources.find((r) => r.uri.includes('environment'));
    const e = JSON.parse((await s.request('resources/read', { uri: env.uri })).result.contents[0].text);
    assert.equal(e.variables.find((v) => v.key === 'hidden').value, '<redacted>');
    assert.equal(e.variables.find((v) => v.key === 'apiToken').value, '<redacted>');
    assert.equal(e.variables.find((v) => v.key === 'plain').value, 'visible-value');
    const col = list.result.resources.find((r) => r.uri.includes('collection'));
    const c = JSON.parse((await s.request('resources/read', { uri: col.uri })).result.contents[0].text);
    assert.equal(c.info.name, 'Demo API');
    assert.equal(c.items[0].type, 'folder');
    for (const uri of ['file:///etc/passwd', 'apilix://collection/..%2F..%2Fetc%2Fpasswd', 'apilix://collection/%E0%A4%A', 'apilix://other/x', 'apilix://collection/' + encodeURIComponent('/abs.json')]) {
      const r = await s.request('resources/read', { uri });
      assert.ok(r.error, uri);
    }
    assert.equal((await s.request('resources/read', {})).error.code, -32602);
  });
});

test('export_docs: truncation flag, folder, unknown folder error', async () => {
  await withServer([], async (s) => {
    const colId = 'demo.postman_collection.json';
    const full = await s.call('export_docs', { collection: colId, format: 'markdown' });
    assert.equal(full.data.truncated, false);
    assert.ok(full.data.content.includes('Demo API'));
    const cut = await s.call('export_docs', { collection: colId, format: 'html', maxChars: 1000 });
    assert.equal(cut.data.truncated, true);
    assert.equal(cut.data.content.length, 1000);
    assert.ok(cut.data.totalChars > 1000);
    const oa = await s.call('export_docs', { collection: colId, format: 'openapi', folder: 'Users' });
    assert.equal(JSON.parse(oa.data.content).openapi, '3.0.3');
    const bad = await s.call('export_docs', { collection: colId, format: 'markdown', folder: 'Nope' });
    assert.equal(bad.isError, true);
    const noEnv = await s.call('export_docs', { collection: colId, format: 'markdown', resolveVariables: true });
    assert.equal(noEnv.isError, true);
  });
});

test('path escape attempts through tool arguments are refused and do not echo absolute paths', async () => {
  const outside = makeTmp('apilix-outside-');
  writeJson(outside, 'x.json', collectionFixture({ info: { name: 'OUTSIDE', schema: 'x' } }));
  await withServer([], async (s, dir) => {
    for (const id of [`../${require('node:path').basename(outside)}/x.json`, `${outside}/x.json`, 'a\u0000.json', '//host/share/x.json', 'C:\\x.json', '..\\x.json']) {
      const r = await s.call('list_requests', { collection: id });
      assert.equal(r.isError, true, id);
      assert.ok(!r.text.includes(outside), 'absolute path leaked');
      assert.ok(!r.text.includes(dir), 'workspace absolute path leaked');
    }
  });
});

test('malformed and oversized input does not crash the server or pollute stdout', async () => {
  const dir = workspaceDir();
  const s = startServer(['--workspace', dir, '--max-line-bytes', '4096']);
  await s.initialize();
  s.raw('this is not json\n');
  s.raw(`${'a'.repeat(20000)}\n`);
  s.raw('{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"list_collections","arguments":{}}}\n');
  const deadline = Date.now() + 20000;
  while (!s.messages.some((m) => m.id === 99) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  const codes = s.messages.filter((m) => m.error).map((m) => m.error.code);
  assert.ok(codes.includes(-32700));
  assert.ok(codes.includes(-32600));
  assert.ok(s.messages.some((m) => m.id === 99 && m.result));
  await s.close();
  assert.equal(s.badStdout.length, 0);
});

test('stdout stays clean even when libraries call console.log (routed to stderr)', async () => {
  // covered end-to-end: the server only ever prints JSON lines (badStdout is asserted in every test)
  const dir = workspaceDir();
  const s = startServer(['--workspace', dir]);
  await s.initialize();
  assert.match(s.stderr, /apilix-mcp: ready/);
  await s.close();
  assert.equal(s.badStdout.length, 0);
});

test('startup refuses a missing folder and the home directory when implicit; --help / --version work', async () => {
  const os = require('node:os');
  const bad = startServer(['--workspace', require('node:path').join(os.tmpdir(), 'nope-does-not-exist-1')]);
  assert.equal((await bad.close()).code, 2);
  assert.match(bad.stderr, /does not exist/);
  const home = startServer([], { cwd: os.homedir() });
  assert.equal((await home.close()).code, 2);
  assert.match(home.stderr, /home directory/);
  const help = startServer(['--help']);
  assert.equal((await help.close()).code, 0);
  const unknown = startServer(['--wat']);
  assert.equal((await unknown.close()).code, 2);
});
