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
  await assert.rejects(ws.loadCollection('link.json'), /File not found in workspace/);
  await assert.rejects(ws.loadCollection('linkdir/secret.json'), /File not found in workspace/);
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
  await assert.rejects(ws.loadCollection('big.json'), { message: 'File not found in workspace' }, 'same answer as a missing file');
  const idx = await ws.index();
  assert.equal(idx.collections.length, 0);
  assert.equal(idx.skippedLarge, 1);
});

test('invalid JSON and non-regular files are refused cleanly', async () => {
  const dir = makeTmp();
  writeJson(dir, 'broken.json', '{not json');
  fs.mkdirSync(path.join(dir, 'dir.json'));
  const ws = await createWorkspaces({ roots: [dir], maxFileBytes: 1000 });
  await assert.rejects(ws.loadCollection('broken.json'), { message: 'File not found in workspace' }, 'same answer as a missing file');
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
  await assert.rejects(ws.writeJsonAtomic(null, 'notes.json', text, { overwrite: true }), /exactly one Postman collection/);
  await assert.rejects(ws.writeJsonAtomic(null, 'package.json', text, { overwrite: true }), /exactly one Postman collection/);
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

test('read access has the same reach as the scan, and every refusal looks exactly like a missing file', { skip: IS_WIN }, async () => {
  const { dir, ws } = await setup();
  const col = collectionFixture({ info: { name: 'Hidden', schema: 'x' } });
  writeJson(dir, '.hidden/c.json', col);
  writeJson(dir, 'node_modules/pkg/c.json', col);
  writeJson(dir, 'a/b/c/d/e/f/deep.json', col);
  writeJson(dir, 'package.json', col);
  const outside = makeTmp('apilix-outside-');
  writeJson(outside, 'o.json', col);
  fs.symlinkSync(path.join(outside, 'o.json'), path.join(dir, 'ln.json'));
  fs.mkdirSync(path.join(dir, 'adir.json'));
  const messages = new Set();
  for (const id of ['missing.json', '.hidden/c.json', 'node_modules/pkg/c.json', 'a/b/c/d/e/f/deep.json', 'package.json', 'ln.json', 'adir.json']) {
    const e = await ws.loadCollection(id).then(() => null, (x) => x);
    assert.ok(e, `${id} must be refused`);
    messages.add(`${e.code}:${e.message}`);
  }
  assert.deepEqual([...messages], ['ENOTFOUND:File not found in workspace']);
  const idx = await ws.index();
  assert.ok(!idx.collections.some((c) => c.name === 'Hidden'), 'and none of them is listed either');
});

test('file names containing "#" are listed and loadable; "#<n>" still selects an entry of a multi-entity file', async () => {
  const { dir, ws } = await setup();
  writeJson(dir, 'a#b.json', collectionFixture({ info: { name: 'Hash', schema: 'x' } }));
  writeJson(dir, 'm#1.json', { collections: [collectionFixture({ info: { name: 'M0', schema: 'x' } }), collectionFixture({ info: { name: 'M1', schema: 'x' } })], environments: [] });
  const idx = await ws.index();
  const hash = idx.collections.find((c) => c.name === 'Hash');
  assert.equal(hash.id, 'a#b.json');
  assert.equal((await ws.loadCollection(hash.id)).value.info.name, 'Hash');
  const m1 = idx.collections.find((c) => c.name === 'M1');
  assert.equal(m1.id, 'm#1.json#1');
  assert.equal((await ws.loadCollection(m1.id)).value.info.name, 'M1');
});

test('overwrite is allowed only when the target holds exactly one collection', async () => {
  const { dir, ws } = await setup();
  const one = collectionFixture({ info: { name: 'One', schema: 'x' } });
  writeJson(dir, 'one.json', one);
  writeJson(dir, 'wrapped.json', { collection: one });
  writeJson(dir, 'multi1.json', { collections: [one], environments: [] });
  writeJson(dir, 'multi2.json', { collections: [one, one] });
  writeJson(dir, 'env.json', { name: 'E', values: [] });
  writeJson(dir, 'mixed.json', { collections: [one], environments: [{ name: 'E', values: [] }] });
  const text = JSON.stringify(collectionFixture({ info: { name: 'New', schema: 'x' } }));
  for (const f of ['multi1.json', 'multi2.json', 'env.json', 'mixed.json']) {
    const before = fs.readFileSync(path.join(dir, f), 'utf8');
    await assert.rejects(ws.writeJsonAtomic(null, f, text, { overwrite: true }), /exactly one Postman collection/, f);
    assert.equal(fs.readFileSync(path.join(dir, f), 'utf8'), before, `${f} untouched`);
  }
  for (const f of ['one.json', 'wrapped.json']) {
    const r = await ws.writeJsonAtomic(null, f, text, { overwrite: true });
    assert.equal(r.replaced, true, f);
  }
});

test('written files are 0600 (with and without hard links) and a failed fallback write leaves nothing behind', { skip: IS_WIN }, async () => {
  const fsp = require('node:fs/promises');
  const { dir, ws } = await setup();
  const text = JSON.stringify(collectionFixture({ info: { name: 'Perm', schema: 'x' } }));
  await ws.writeJsonAtomic(null, 'p1.json', text);
  assert.equal(fs.statSync(path.join(dir, 'p1.json')).mode & 0o777, 0o600, 'created via link');
  await ws.writeJsonAtomic(null, 'p1.json', text, { overwrite: true });
  assert.equal(fs.statSync(path.join(dir, 'p1.json')).mode & 0o777, 0o600, 'replaced via rename');

  const realLink = fsp.link;
  const realOpen = fsp.open;
  fsp.link = async () => { throw Object.assign(new Error('no hard links here'), { code: 'EPERM' }); };
  try {
    await ws.writeJsonAtomic(null, 'p2.json', text); // fallback: exclusive create
    assert.equal(fs.statSync(path.join(dir, 'p2.json')).mode & 0o777, 0o600, 'fallback create');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'p2.json'), 'utf8')).info.name, 'Perm');
    // an existing target is never touched by the fallback
    await assert.rejects(ws.writeJsonAtomic(null, 'p2.json', 'x'.repeat(10)), /already exists/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'p2.json'), 'utf8')).info.name, 'Perm');
    // a write failing halfway: the handle is closed and the partial target removed
    const target = path.join(dir, 'p3.json');
    let opened = null;
    fsp.open = async (p, ...rest) => { const h = await realOpen(p, ...rest); if (p === target) { opened = h; h.writeFile = async () => { throw new Error('disk full'); }; } return h; };
    await assert.rejects(ws.writeJsonAtomic(null, 'p3.json', text), /Unable to write/);
    assert.ok(opened, 'the fallback opened the target');
    assert.ok(!fs.existsSync(target), 'partial file removed');
  } finally { fsp.link = realLink; fsp.open = realOpen; }
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('the scan cache forgets files that disappeared', async () => {
  const { dir, ws } = await setup();
  const before = (await ws.index()).collections.length;
  const n = ws.cacheSize();
  writeJson(dir, 'temp.json', collectionFixture({ info: { name: 'Temp', schema: 'x' } }));
  assert.equal((await ws.index()).collections.length, before + 1);
  assert.equal(ws.cacheSize(), n + 1);
  fs.unlinkSync(path.join(dir, 'temp.json'));
  assert.equal((await ws.index()).collections.length, before);
  assert.equal(ws.cacheSize(), n);
});

test('an in-root symlink cannot reach a hidden or skipped folder (exclusions apply to the resolved path)', { skip: IS_WIN }, async () => {
  const dir = makeTmp();
  writeJson(dir, '.private/secret.postman_collection.json', collectionFixture());
  writeJson(dir, 'node_modules/pkg/c.json', collectionFixture());
  fs.symlinkSync(path.join(dir, '.private'), path.join(dir, 'visible-link'));
  fs.symlinkSync(path.join(dir, 'node_modules'), path.join(dir, 'nm-link'));
  const ws = await createWorkspaces({ roots: [dir], maxFileBytes: 1024 * 1024 });
  await assert.rejects(ws.loadCollection('visible-link/secret.postman_collection.json'), /not found/i);
  await assert.rejects(ws.loadCollection('nm-link/pkg/c.json'), /not found/i);
});

test('an in-root symlink to a normal folder still resolves', { skip: IS_WIN }, async () => {
  const dir = makeTmp();
  writeJson(dir, 'real/a.postman_collection.json', collectionFixture());
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'alias'));
  const ws = await createWorkspaces({ roots: [dir], maxFileBytes: 1024 * 1024 });
  const c = await ws.loadCollection('alias/a.postman_collection.json');
  assert.ok(c.value.info);
});

test('index reports scanTruncated when the file cap is reached', async () => {
  const dir = makeTmp();
  for (let i = 0; i < 1005; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.json`), '{}');
  const ws = await createWorkspaces({ roots: [dir], maxFileBytes: 1024 * 1024 });
  assert.equal((await ws.index()).scanTruncated, true);
  const small = makeTmp();
  writeJson(small, 'a.json', collectionFixture());
  const ws2 = await createWorkspaces({ roots: [small], maxFileBytes: 1024 * 1024 });
  assert.equal((await ws2.index()).scanTruncated, false);
});
