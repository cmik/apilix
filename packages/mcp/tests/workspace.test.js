'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspaces, WorkspaceError, parseRelativePath } = require('../src/workspace');
const { collectionFixture, environmentFixture, makeTmp, writeJson } = require('./fixtures');

const IS_WIN = process.platform === 'win32';

async function setup() {
  const dir = makeTmp();
  writeJson(dir, 'demo.postman_collection.json', collectionFixture());
  writeJson(dir, 'envs/local.json', environmentFixture('http://127.0.0.1:1'));
  writeJson(dir, 'package.json', { name: 'x', version: '1.0.0' });
  writeJson(dir, 'notes.json', { hello: 'world' });
  writeJson(dir, 'apilix-ws.json', { collections: [collectionFixture({ info: { name: 'In workspace', schema: 'x' } })], environments: [{ name: 'WsEnv', values: [] }] });
  const ws = await createWorkspaces({ roots: [dir], maxFileBytes: 1024 * 1024 });
  return { dir, ws };
}

test('index classifies collections, environments and Apilix workspace files by content', async () => {
  const { ws } = await setup();
  const idx = await ws.index();
  const cols = idx.collections.map((c) => c.id).sort();
  assert.deepEqual(cols, ['apilix-ws.json#0', 'demo.postman_collection.json']);
  assert.deepEqual(idx.environments.map((e) => e.id).sort(), ['apilix-ws.json#0', 'envs/local.json']);
  const c = await ws.loadCollection('apilix-ws.json#0');
  assert.equal(c.value.info.name, 'In workspace');
  const e = await ws.loadEnvironment('envs/local.json');
  assert.equal(e.value.name, 'Local');
});

test('loading a file of the wrong kind or a missing sub-entry fails', async () => {
  const { ws } = await setup();
  await assert.rejects(ws.loadCollection('envs/local.json'), /No collection found/);
  await assert.rejects(ws.loadCollection('apilix-ws.json#7'), /No collection found/);
  await assert.rejects(ws.loadCollection('nope.json'), /not found/i);
});

test('path validation rejects traversal, absolute, NUL, UNC, drive, ADS, backslash, device names', () => {
  const bad = [
    '../x.json', 'a/../../x.json', '/etc/passwd.json', '//server/share/x.json', '\\\\server\\share\\x.json',
    'C:\\x.json', 'C:x.json', 'a.json:stream', 'a\0.json', 'a\\b.json', 'dir/./x.json', 'dir//x.json', 'CON.json', 'a/NUL.json',
    'x.json.', 'x.json ', 'file.txt', '', 'a/b/c/d/e/f/g/h/i.json', 'x'.repeat(600) + '.json', 'a?.json', 'a\n.json',
  ];
  for (const p of bad) {
    assert.throws(() => parseRelativePath(p), WorkspaceError, `should reject ${JSON.stringify(p).slice(0, 40)}`);
  }
  assert.deepEqual(parseRelativePath('a/b.json'), ['a', 'b.json']);
});

test('traversal and absolute ids never read outside the workspace', async () => {
  const { dir, ws } = await setup();
  const outside = makeTmp('apilix-outside-');
  writeJson(outside, 'secret.json', collectionFixture({ info: { name: 'OUTSIDE', schema: 'x' } }));
  const attempts = [
    `../${path.basename(outside)}/secret.json`,
    path.join(outside, 'secret.json'),
    `${dir}/../${path.basename(outside)}/secret.json`,
    'envs/../../secret.json',
    `file://${path.join(outside, 'secret.json')}`,
    'secret.json\0.json',
  ];
  for (const a of attempts) {
    await assert.rejects(ws.loadCollection(a), WorkspaceError, a);
  }
});

test('a symlink pointing outside the workspace is refused (file and directory), and not listed', { skip: IS_WIN }, async () => {
  const { dir, ws } = await setup();
  const outside = makeTmp('apilix-outside-');
  writeJson(outside, 'secret.json', collectionFixture({ info: { name: 'OUTSIDE', schema: 'x' } }));
  fs.symlinkSync(path.join(outside, 'secret.json'), path.join(dir, 'link.json'));
  fs.symlinkSync(outside, path.join(dir, 'linkdir'));
  await assert.rejects(ws.loadCollection('link.json'), /escapes/i);
  await assert.rejects(ws.loadCollection('linkdir/secret.json'), /escapes/i);
  const idx = await ws.index();
  assert.ok(!idx.collections.some((c) => c.name === 'OUTSIDE'));
});

test('a symlink that stays inside the workspace is resolved but must remain inside', { skip: IS_WIN }, async () => {
  const { dir, ws } = await setup();
  fs.symlinkSync(path.join(dir, 'demo.postman_collection.json'), path.join(dir, 'alias.json'));
  const c = await ws.loadCollection('alias.json');
  assert.equal(c.value.info.name, 'Demo API');
});

test('files over the size limit are refused', async () => {
  const dir = makeTmp();
  writeJson(dir, 'big.json', JSON.stringify({ info: { name: 'b' }, item: [], pad: 'x'.repeat(5000) }));
  const ws = await createWorkspaces({ roots: [dir], maxFileBytes: 1000 });
  await assert.rejects(ws.loadCollection('big.json'), /larger than/);
  const idx = await ws.index();
  assert.equal(idx.collections.length, 0);
  assert.equal(idx.skippedLarge, 1);
});

test('invalid JSON and non-regular files are refused cleanly', async () => {
  const dir = makeTmp();
  writeJson(dir, 'broken.json', '{not json');
  fs.mkdirSync(path.join(dir, 'dir.json'));
  const ws = await createWorkspaces({ roots: [dir], maxFileBytes: 1000 });
  await assert.rejects(ws.loadCollection('broken.json'), /not valid JSON/);
  await assert.rejects(ws.loadCollection('dir.json'), WorkspaceError);
  assert.deepEqual((await ws.index()).collections, []);
});

test('refuses the filesystem root, a missing folder and (when implicit) the home directory', async () => {
  await assert.rejects(createWorkspaces({ roots: [path.parse(process.cwd()).root], maxFileBytes: 10 }), /filesystem root/);
  await assert.rejects(createWorkspaces({ roots: [path.join(os.tmpdir(), 'does-not-exist-xyz')], maxFileBytes: 10 }), /does not exist/);
  await assert.rejects(createWorkspaces({ roots: [os.homedir()], maxFileBytes: 10, explicit: false }), /home directory/);
  const ws = await createWorkspaces({ roots: [os.homedir()], maxFileBytes: 10, explicit: true });
  assert.ok(ws.warnings.length === 1);
});

test('several workspaces: ids are prefixed with the workspace label and cannot be mixed up', async () => {
  const a = makeTmp('apilix-a-');
  const b = makeTmp('apilix-b-');
  writeJson(a, 'one.json', collectionFixture({ info: { name: 'A', schema: 'x' } }));
  writeJson(b, 'two.json', collectionFixture({ info: { name: 'B', schema: 'x' } }));
  const ws = await createWorkspaces({ roots: [a, b], maxFileBytes: 1e6 });
  assert.ok(ws.multi);
  const idx = await ws.index();
  assert.equal(idx.collections.length, 2);
  const idA = idx.collections.find((c) => c.name === 'A').id;
  assert.match(idA, /^apilix-a-[^:]*:one\.json$/);
  assert.equal((await ws.loadCollection(idA)).value.info.name, 'A');
  await assert.rejects(ws.loadCollection('one.json'), /ids must look like/);
  await assert.rejects(ws.loadCollection('nope:one.json'), /Unknown workspace/);
  // a label cannot be used to reach the other workspace's files
  await assert.rejects(ws.loadCollection(`${idA.split(':')[0]}:../${path.basename(b)}/two.json`), WorkspaceError);
});

test('writeJsonAtomic: creates, refuses to overwrite without the flag, overwrites only recognised files', async () => {
  const { dir, ws } = await setup();
  const text = JSON.stringify(collectionFixture({ info: { name: 'New', schema: 'x' } }));
  const r = await ws.writeJsonAtomic(null, 'new.json', text);
  assert.equal(r.file, 'new.json');
  assert.equal(r.replaced, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'new.json'), 'utf8')).info.name, 'New');
  await assert.rejects(ws.writeJsonAtomic(null, 'new.json', text), /already exists/);
  const r2 = await ws.writeJsonAtomic(null, 'new.json', text.replace('New', 'Newer'), { overwrite: true });
  assert.equal(r2.replaced, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'new.json'), 'utf8')).info.name, 'Newer');
  // not a recognised collection: even overwrite:true is refused
  await assert.rejects(ws.writeJsonAtomic(null, 'notes.json', text, { overwrite: true }), /not a recognised/);
  await assert.rejects(ws.writeJsonAtomic(null, 'package.json', text, { overwrite: true }), /not a recognised/);
  // no tmp leftovers
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('writeJsonAtomic: rejects escapes, hidden names, missing folders, oversize', async () => {
  const { ws } = await setup();
  const text = '{"info":{"name":"x"},"item":[]}';
  for (const p of ['../x.json', '/abs/x.json', 'a\0.json', '.hidden.json', 'sub/.x.json', 'C:\\x.json', 'x.txt']) {
    await assert.rejects(ws.writeJsonAtomic(null, p, text), WorkspaceError, p);
  }
  await assert.rejects(ws.writeJsonAtomic(null, 'missing-dir/x.json', text), /does not exist/);
  const small = await createWorkspaces({ roots: [makeTmp()], maxFileBytes: 10 });
  await assert.rejects(small.writeJsonAtomic(null, 'x.json', text), /larger than/);
});

test('writeJsonAtomic never writes through symlinks', { skip: IS_WIN }, async () => {
  const { dir, ws } = await setup();
  const outside = makeTmp('apilix-outside-');
  writeJson(outside, 'victim.json', collectionFixture({ info: { name: 'VICTIM', schema: 'x' } }));
  fs.symlinkSync(path.join(outside, 'victim.json'), path.join(dir, 'evil.json'));
  fs.symlinkSync(outside, path.join(dir, 'outdir'));
  const text = '{"info":{"name":"pwn"},"item":[]}';
  await assert.rejects(ws.writeJsonAtomic(null, 'evil.json', text, { overwrite: true }), /symbolic link/);
  await assert.rejects(ws.writeJsonAtomic(null, 'outdir/new.json', text), /escapes/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outside, 'victim.json'), 'utf8')).info.name, 'VICTIM');
  assert.ok(!fs.existsSync(path.join(outside, 'new.json')));
});

test('multi-workspace write requires an explicit workspace label', async () => {
  const a = makeTmp('apilix-a-');
  const b = makeTmp('apilix-b-');
  const ws = await createWorkspaces({ roots: [a, b], maxFileBytes: 1e6 });
  await assert.rejects(ws.writeJsonAtomic(null, 'x.json', '{}'), /Specify which workspace/);
  const r = await ws.writeJsonAtomic(ws.labels[1], 'x.json', '{"info":{"name":"x"},"item":[]}');
  assert.ok(fs.existsSync(path.join(b, 'x.json')));
  assert.ok(r.file.includes(':'));
});
