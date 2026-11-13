'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { safeMessage } = require('../src/common');

test('safeMessage hides the workspace root and every other absolute path, and bounds the length', () => {
  const root = '/Users/someone/projects/api-workspace';
  const m = safeMessage(`ENOENT: open '${root}/sub/c.json' then /etc/passwd and C:\\Users\\x\\y.json and /var/log/deep/file.txt`, [root]);
  assert.ok(!m.includes('someone'), m);
  assert.ok(!m.includes('/etc/passwd'), m);
  assert.ok(!m.includes('/var/log'), m);
  assert.ok(!m.includes('Users\\x'), m);
  assert.ok(m.includes('<workspace>'), m);
  assert.ok(safeMessage('x'.repeat(2000)).length <= 503);
  assert.equal(safeMessage(undefined), 'Error');
});

test('an error leaking a path through a tool call is masked end to end', async () => {
  const { startServer } = require('./client');
  const { makeTmp, writeJson } = require('./fixtures');
  const dir = makeTmp();
  writeJson(dir, 'c.json', { info: { name: 'X' }, item: [] });
  const s = startServer(['--workspace', dir]);
  try {
    await s.initialize();
    // an engine-level failure message containing the absolute workspace path goes through the same masking
    const r = await s.call('export_docs', { collection: 'c.json', format: 'markdown', folder: `${dir}/nope/deeper` });
    assert.equal(r.isError, true);
    assert.ok(!r.text.includes(dir), r.text);
  } finally { await s.close(); }
});
