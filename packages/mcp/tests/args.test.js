'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseMcpArgs, helpText } = require('../src/args');

test('defaults: read-only, run enabled, cwd as the (implicit) workspace, redaction on', () => {
  const o = parseMcpArgs([], '/work/dir');
  assert.deepEqual(o.workspaces, [path.resolve('/work/dir')]);
  assert.equal(o.workspaceExplicit, false);
  assert.equal(o.allowWrite, false);
  assert.equal(o.noRun, false);
  assert.equal(o.includeCredentials, false);
  assert.deepEqual(o.allowHosts, []);
});

test('repeatable --workspace / --allow-host, relative paths resolved against cwd, = syntax', () => {
  const o = parseMcpArgs(['--workspace', 'a', '--workspace=../b', '--allow-host', 'API.example.com', '--allow-host=*.x.io:8443', '--allow-write'], '/w/c');
  assert.deepEqual(o.workspaces, [path.resolve('/w/c/a'), path.resolve('/w/b')]);
  assert.equal(o.workspaceExplicit, true);
  assert.deepEqual(o.allowHosts, ['api.example.com', '*.x.io:8443']);
  assert.equal(o.allowWrite, true);
});

test('invalid input is rejected', () => {
  assert.throws(() => parseMcpArgs(['--bogus']), /Unknown option/);
  assert.throws(() => parseMcpArgs(['--workspace']), /requires a value/);
  assert.throws(() => parseMcpArgs(['--workspace', '--allow-write']), /requires a value/);
  assert.throws(() => parseMcpArgs(['--allow-host', '*']), /invalid pattern/);
  assert.throws(() => parseMcpArgs(['--allow-host', 'a/b']), /invalid pattern/);
  assert.throws(() => parseMcpArgs(['--run-timeout', '0']), /between/);
  assert.throws(() => parseMcpArgs(['--run-timeout', 'abc']), /integer/);
  assert.throws(() => parseMcpArgs(['--no-run', '--allow-host', 'a.com']), /no effect/);
});

test('help mentions every flag', () => {
  const h = helpText();
  for (const f of ['--workspace', '--allow-write', '--no-run', '--allow-host', '--include-credentials', '--run-timeout', '--max-requests', '--ssl-verification']) {
    assert.ok(h.includes(f), f);
  }
});
