'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./client');
const { collectionFixture, makeTmp, writeJson } = require('./fixtures');

const IS_WIN = process.platform === 'win32';
const newCollection = (name = 'Imported') => ({
  info: { name, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [{ name: 'F', item: [{ name: 'R', request: { method: 'GET', url: 'http://example.test/x' } }] }],
});

async function withServer(args, fn) {
  const dir = makeTmp();
  writeJson(dir, 'existing.json', collectionFixture());
  writeJson(dir, 'notes.json', { not: 'a collection' });
  fs.mkdirSync(path.join(dir, 'sub'));
  const s = startServer(['--workspace', dir, ...args]);
  await s.initialize();
  try { await fn(s, dir); } finally {
    await s.close();
    assert.equal(s.badStdout.length, 0);
  }
}

test('read-only by default: import_collection is not listed and a direct call is refused; nothing is written', async () => {
  await withServer([], async (s, dir) => {
    const names = (await s.request('tools/list', {})).result.tools.map((t) => t.name);
    assert.ok(!names.includes('import_collection'));
    const r = await s.call('import_collection', { file: 'new.json', collection: newCollection() });
    assert.equal(r.isError, true);
    assert.match(r.text, /--allow-write/);
    assert.ok(!fs.existsSync(path.join(dir, 'new.json')));
    assert.deepEqual(fs.readdirSync(dir).sort(), ['existing.json', 'notes.json', 'sub']);
  });
});

test('--allow-write: creates a collection atomically; it can then be listed; no tmp files remain', async () => {
  await withServer(['--allow-write'], async (s, dir) => {
    const tool = (await s.request('tools/list', {})).result.tools.find((t) => t.name === 'import_collection');
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, true);
    assert.equal(tool.annotations.openWorldHint, false);
    const r = await s.call('import_collection', { file: 'sub/new.postman_collection.json', collection: newCollection() });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data.requests, 1);
    assert.equal(r.data.folders, 1);
    assert.equal(r.data.replaced, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'sub', 'new.postman_collection.json'), 'utf8')).info.name, 'Imported');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'sub')), ['new.postman_collection.json']);
    const lc = await s.call('list_collections');
    assert.ok(lc.data.collections.some((c) => c.name === 'Imported'));
    assert.match(s.stderr, /import_collection wrote sub\/new\.postman_collection\.json/);
  });
});

test('no overwrite without overwrite:true; overwrite only replaces a recognised collection', async () => {
  await withServer(['--allow-write'], async (s, dir) => {
    const before = fs.readFileSync(path.join(dir, 'existing.json'), 'utf8');
    const refused = await s.call('import_collection', { file: 'existing.json', collection: newCollection('Evil') });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /overwrite:true/);
    assert.equal(fs.readFileSync(path.join(dir, 'existing.json'), 'utf8'), before);

    const notCollection = await s.call('import_collection', { file: 'notes.json', collection: newCollection('Evil'), overwrite: true });
    assert.equal(notCollection.isError, true);
    assert.match(notCollection.text, /exactly one Postman collection/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8')), { not: 'a collection' });

    const ok = await s.call('import_collection', { file: 'existing.json', collection: newCollection('Replaced'), overwrite: true });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(ok.data.replaced, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'existing.json'), 'utf8')).info.name, 'Replaced');
  });
});

test('path escapes, hidden files, missing folders and non-json names are refused; nothing outside is written', async () => {
  const outside = makeTmp('apilix-outside-');
  await withServer(['--allow-write'], async (s, dir) => {
    for (const file of ['../escape.json', `${outside}/abs.json`, 'a\u0000b.json', '//srv/share/x.json', 'C:\\x.json', 'sub\\x.json', '.hidden.json', 'nope/dir/x.json', 'x.txt', 'sub/../../up.json']) {
      const r = await s.call('import_collection', { file, collection: newCollection() });
      assert.equal(r.isError, true, file);
      assert.ok(!r.text.includes(outside) && !r.text.includes(dir), 'no absolute path in errors');
    }
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.deepEqual(fs.readdirSync(path.dirname(dir)).filter((f) => f === 'escape.json' || f === 'up.json'), []);
  });
});

test('symlinks are never written through', { skip: IS_WIN }, async () => {
  const outside = makeTmp('apilix-outside-');
  writeJson(outside, 'victim.json', collectionFixture({ info: { name: 'VICTIM', schema: 'x' } }));
  await withServer(['--allow-write'], async (s, dir) => {
    fs.symlinkSync(path.join(outside, 'victim.json'), path.join(dir, 'evil.json'));
    fs.symlinkSync(outside, path.join(dir, 'outdir'));
    const a = await s.call('import_collection', { file: 'evil.json', collection: newCollection('PWN'), overwrite: true });
    assert.equal(a.isError, true);
    const b = await s.call('import_collection', { file: 'outdir/new.json', collection: newCollection('PWN') });
    assert.equal(b.isError, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(outside, 'victim.json'), 'utf8')).info.name, 'VICTIM');
    assert.ok(!fs.existsSync(path.join(outside, 'new.json')));
  });
});

test('collection validation: shape, schema version, depth, size', async () => {
  await withServer(['--allow-write', '--max-file-size', '2048'], async (s) => {
    const cases = [
      [{}, /info\.name/],
      [{ info: { name: 'x' } }, /"item" must be an array/],
      [{ info: { name: 'x', schema: 'https://example.com/other' }, item: [] }, /v2\.0\/v2\.1/],
      [{ info: { name: 'x' }, item: [{ name: 'a' }] }, /neither/],
      [{ info: { name: 'x' }, item: [{ request: {} }] }, /name/],
      [{ info: { name: 'x' }, item: ['str'] }, /object/],
      [{ info: { name: 'x' }, item: [], variable: 'no' }, /variable/],
      [{ info: { name: 'x' }, item: [{ name: 'big', request: { method: 'GET', url: 'x'.repeat(5000) } }] }, /larger than/],
    ];
    for (const [collection, re] of cases) {
      const r = await s.call('import_collection', { file: 'v.json', collection });
      assert.equal(r.isError, true, JSON.stringify(collection).slice(0, 60));
      assert.match(r.text, re);
    }
    let deep = { name: 'leaf', request: { method: 'GET', url: 'x' } };
    for (let i = 0; i < 25; i++) deep = { name: `f${i}`, item: [deep] };
    const d = await s.call('import_collection', { file: 'deep.json', collection: { info: { name: 'x' }, item: [deep] } });
    assert.equal(d.isError, true);
    const wrongType = await s.call('import_collection', { file: 'v.json', collection: 'string' });
    assert.equal(wrongType.isError, true);
    const extra = await s.call('import_collection', { file: 'v.json', collection: newCollection(), nope: 1 });
    assert.match(extra.text, /unexpected property/);
  });
});

test('several workspaces: the target workspace must be named', async () => {
  const a = makeTmp('apilix-a-');
  const b = makeTmp('apilix-b-');
  const s = startServer(['--workspace', a, '--workspace', b, '--allow-write']);
  await s.initialize();
  const lc = await s.call('list_collections');
  assert.equal(lc.data.workspaces.length, 2);
  const noWs = await s.call('import_collection', { file: 'x.json', collection: newCollection() });
  assert.equal(noWs.isError, true);
  assert.match(noWs.text, /Specify which workspace/);
  const ok = await s.call('import_collection', { file: 'x.json', collection: newCollection(), workspace: lc.data.workspaces[1] });
  assert.equal(ok.isError, false, ok.text);
  assert.ok(fs.existsSync(path.join(b, 'x.json')));
  assert.ok(!fs.existsSync(path.join(a, 'x.json')));
  await s.close();
});

test('write + run: the server refuses to start (exit 2) without --unsafe-allow-write-and-run; with it, it warns at every start', async () => {
  for (const runFlag of [['--allow-host', '127.0.0.1'], ['--allow-any-host']]) {
    const refused = startServer(['--workspace', makeTmp(), '--allow-write', ...runFlag]);
    assert.equal((await refused.close()).code, 2);
    assert.match(refused.stderr, /arbitrary code execution/);
    assert.match(refused.stderr, /--unsafe-allow-write-and-run/);
  }
  const ok = startServer(['--workspace', makeTmp(), '--allow-write', '--allow-host', '127.0.0.1', '--unsafe-allow-write-and-run']);
  await ok.initialize();
  const names = (await ok.request('tools/list', {})).result.tools.map((t) => t.name);
  assert.ok(names.includes('import_collection') && names.includes('run_request'));
  assert.match(ok.stderr, /WARNING: --unsafe-allow-write-and-run/);
  await ok.close();
  // write without run stays valid, with or without --no-run
  for (const extra of [[], ['--no-run']]) {
    const w = startServer(['--workspace', makeTmp(), '--allow-write', ...extra]);
    await w.initialize();
    assert.ok(!w.stderr.includes('WARNING: --unsafe'));
    assert.equal((await w.close()).code, 0);
  }
});

test('tool descriptions state that write + run is code execution and that workspace collections run their scripts', async () => {
  const s = startServer(['--workspace', makeTmp(), '--allow-write', '--allow-host', '127.0.0.1', '--unsafe-allow-write-and-run']);
  await s.initialize();
  const tools = (await s.request('tools/list', {})).result.tools;
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  assert.match(byName.import_collection, /arbitrary code execution/);
  assert.match(byName.run_request, /even one the operator never reviewed/);
  assert.match(byName.run_collection, /executes its scripts/);
  await s.close();
});

test('overwrite:true is refused for an environment or a multi-collection file, without writing', async () => {
  await withServer(['--allow-write'], async (s, dir) => {
    writeJson(dir, 'env.json', { name: 'E', values: [{ key: 'a', value: 'b' }] });
    writeJson(dir, 'bundle.json', { collections: [collectionFixture(), collectionFixture()] });
    for (const f of ['env.json', 'bundle.json']) {
      const before = fs.readFileSync(path.join(dir, f), 'utf8');
      const r = await s.call('import_collection', { file: f, collection: newCollection('Evil'), overwrite: true });
      assert.equal(r.isError, true, f);
      assert.match(r.text, /exactly one Postman collection/);
      assert.equal(fs.readFileSync(path.join(dir, f), 'utf8'), before, `${f} untouched`);
    }
    const tool = (await s.request('tools/list', {})).result.tools.find((t) => t.name === 'import_collection');
    assert.match(tool.description, /EXACTLY ONE collection/);
  });
});
