'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseMcpArgs, helpText, runEnabled, runMode } = require('../src/args');

test('defaults: read-only, run NOT enabled, cwd as the (implicit) workspace, redaction on', () => {
  const o = parseMcpArgs([], '/work/dir');
  assert.deepEqual(o.workspaces, [path.resolve('/work/dir')]);
  assert.equal(o.workspaceExplicit, false);
  assert.equal(o.allowWrite, false);
  assert.equal(o.noRun, false);
  assert.equal(o.includeCredentials, false);
  assert.deepEqual(o.allowHosts, []);
  assert.equal(o.allowAnyHost, false);
  assert.equal(runEnabled(o), false);
  assert.equal(runMode(o), 'off');
});

test('run tools need --allow-host or --allow-any-host; --no-run wins; the two are exclusive', () => {
  assert.equal(runMode(parseMcpArgs(['--allow-host', 'a.com'])), 'restricted');
  assert.equal(runMode(parseMcpArgs(['--allow-any-host'])), 'any');
  assert.equal(runMode(parseMcpArgs(['--no-run'])), 'disabled');
  assert.equal(runEnabled(parseMcpArgs(['--allow-host', 'a.com'])), true);
  assert.throws(() => parseMcpArgs(['--allow-any-host', '--allow-host', 'a.com']), /mutually exclusive/);
  assert.throws(() => parseMcpArgs(['--allow-host', 'a.com', '--allow-any-host']), /mutually exclusive/);
  assert.throws(() => parseMcpArgs(['--no-run', '--allow-any-host']), /no effect/);
});

test('repeatable --workspace / --allow-host, relative paths resolved against cwd, = syntax', () => {
  const o = parseMcpArgs(['--workspace', 'a', '--workspace=../b', '--allow-host', 'API.example.com', '--allow-host=*.x.io:8443', '--allow-write', '--unsafe-allow-write-and-run'], '/w/c');
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
  for (const f of ['--workspace', '--allow-write', '--no-run', '--allow-host', '--allow-any-host', '--unsafe-allow-write-and-run', '--include-credentials', '--run-timeout', '--max-requests', '--ssl-verification']) {
    assert.ok(h.includes(f), f);
  }
});

test('--allow-write with the run tools is refused unless --unsafe-allow-write-and-run is given', () => {
  assert.throws(() => parseMcpArgs(['--allow-write', '--allow-host', 'a.com']), /arbitrary code execution/);
  assert.throws(() => parseMcpArgs(['--allow-write', '--allow-any-host']), /--unsafe-allow-write-and-run/);
  assert.equal(parseMcpArgs(['--allow-write', '--allow-host', 'a.com', '--unsafe-allow-write-and-run']).allowWrite, true);
  // still valid: write without run (no run flag, or --no-run)
  assert.equal(parseMcpArgs(['--allow-write']).allowWrite, true);
  assert.equal(parseMcpArgs(['--allow-write', '--no-run']).allowWrite, true);
  // the escape hatch alone enables nothing
  assert.equal(runEnabled(parseMcpArgs(['--unsafe-allow-write-and-run'])), false);
});
