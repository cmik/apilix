'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'cli');

async function withServer(handler, runTest) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const urlBase = `http://127.0.0.1:${address.port}`;
  try {
    await runTest(urlBase);
  } finally {
    await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
}

async function withTempDir(runTest) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apilix-cli-process-'));
  try {
    await runTest(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function runNodeCli(args, cwd) {
  const root = path.resolve(__dirname, '..');
  const entry = path.join(root, 'bin', 'apilix.js');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function makeEnvironment(baseUrl) {
  return {
    name: 'Local',
    values: [
      { key: 'baseUrl', value: baseUrl, enabled: true },
    ],
  };
}

async function copyFixture(fileName, targetPath) {
  const fixturePath = path.join(FIXTURE_DIR, fileName);
  const text = await fs.readFile(fixturePath, 'utf8');
  await fs.writeFile(targetPath, text);
}

test('process CLI prints help and exits 0', async () => {
  const result = await runNodeCli(['--help'], path.resolve(__dirname, '..'));
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /run \[collectionPath\]|run \[options\]/);
});

test('process CLI can run collection and emit JSON report', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withTempDir(async (dir) => {
      const collectionPath = path.join(dir, 'collection.json');
      const environmentPath = path.join(dir, 'environment.json');

      await copyFixture('collection-success.json', collectionPath);
      await fs.writeFile(environmentPath, JSON.stringify(makeEnvironment(baseUrl)));

      const result = await runNodeCli([
        'run',
        'collection.json',
        '-e', 'environment.json',
        '--reporter', 'json',
        '--no-color',
      ], dir);

      assert.equal(result.code, 0);
      assert.match(result.stderr, /Request Name/);
      assert.doesNotMatch(result.stderr, /\x1b\[[0-9;]*m/);

      const report = JSON.parse(result.stdout);
      assert.equal(report.collectionName, 'CLI Fixture Collection');
      assert.equal(report.summary.errors, 0);
      assert.equal(report.summary.failed, 0);
    });
  });
});
