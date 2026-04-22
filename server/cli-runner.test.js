'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { runCli, parseArgs } = require('./cli-runner');

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apilix-cli-'));
  try {
    await runTest(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeIo(cwd) {
  const stdout = [];
  const stderr = [];
  return {
    cwd,
    stdout: { write(chunk) { stdout.push(String(chunk)); } },
    stderr: { write(chunk) { stderr.push(String(chunk)); } },
    readStdout() { return stdout.join(''); },
    readStderr() { return stderr.join(''); },
  };
}

function makeCollection(url, testCode) {
  return {
    info: {
      name: 'CLI Collection',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      {
        id: 'req-1',
        name: 'Ping',
        request: {
          method: 'GET',
          url: { raw: url },
        },
        event: [
          {
            listen: 'test',
            script: {
              type: 'text/javascript',
              exec: testCode.split('\n'),
            },
          },
        ],
      },
    ],
  };
}

function makeEnvironment(baseUrl) {
  return {
    name: 'Local',
    values: [
      { key: 'baseUrl', value: baseUrl, enabled: true },
    ],
  };
}

test('runCli outputs JSON report to stdout and exits 0 on success', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withTempDir(async (dir) => {
      const collectionPath = path.join(dir, 'collection.json');
      const environmentPath = path.join(dir, 'environment.json');
      await fs.writeFile(collectionPath, JSON.stringify(makeCollection('{{baseUrl}}/ping', "apx.test('Status 200', () => { apx.expect(apx.response.code).to.equal(200); });")));
      await fs.writeFile(environmentPath, JSON.stringify(makeEnvironment(baseUrl)));

      const io = makeIo(dir);
      const exitCode = await runCli([
        'run',
        'collection.json',
        '-e', 'environment.json',
        '--reporter', 'json',
      ], io);

      assert.equal(exitCode, 0);
      assert.match(io.readStderr(), /Request Name/);
      const report = JSON.parse(io.readStdout());
      assert.equal(report.collectionName, 'CLI Collection');
      assert.equal(report.summary.requests, 1);
      assert.equal(report.summary.passed, 1);
      assert.equal(report.summary.failed, 0);
      assert.equal(report.summary.errors, 0);
    });
  });
});

test('runCli writes JUnit XML and exits 1 when an assertion fails', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withTempDir(async (dir) => {
      const collectionPath = path.join(dir, 'collection.json');
      const environmentPath = path.join(dir, 'environment.json');
      const reportPath = path.join(dir, 'report.xml');
      await fs.writeFile(collectionPath, JSON.stringify(makeCollection('{{baseUrl}}/ping', "apx.test('Status 201', () => { apx.expect(apx.response.code).to.equal(201); });")));
      await fs.writeFile(environmentPath, JSON.stringify(makeEnvironment(baseUrl)));

      const io = makeIo(dir);
      const exitCode = await runCli([
        'run',
        'collection.json',
        '-e', 'environment.json',
        '--reporter', 'junit',
        '--out', 'report.xml',
      ], io);

      assert.equal(exitCode, 1);
      const xml = await fs.readFile(reportPath, 'utf8');
      assert.match(xml, /<failure message=/);
      assert.match(xml, /Status 201/);
    });
  });
});

test('runCli supports CSV-driven iterations and both reporters', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withTempDir(async (dir) => {
      const collectionPath = path.join(dir, 'collection.json');
      const environmentPath = path.join(dir, 'environment.json');
      const csvPath = path.join(dir, 'data.csv');
      const outDir = path.join(dir, 'reports');
      await fs.writeFile(collectionPath, JSON.stringify(makeCollection('{{baseUrl}}/ping?name={{name}}', "apx.test('Status 200', () => { apx.expect(apx.response.code).to.equal(200); });")));
      await fs.writeFile(environmentPath, JSON.stringify(makeEnvironment(baseUrl)));
      await fs.writeFile(csvPath, 'name\nAlice\nBob\n');

      const io = makeIo(dir);
      const exitCode = await runCli([
        'run',
        'collection.json',
        '-e', 'environment.json',
        '--csv', 'data.csv',
        '--reporter', 'both',
        '--out-dir', 'reports',
      ], io);

      assert.equal(exitCode, 0);
      const json = JSON.parse(await fs.readFile(path.join(outDir, 'apilix-run.json'), 'utf8'));
      const xml = await fs.readFile(path.join(outDir, 'apilix-run.junit.xml'), 'utf8');
      assert.equal(json.iterations.length, 2);
      assert.deepEqual(json.iterations.map(iteration => iteration.dataRow.name), ['Alice', 'Bob']);
      assert.match(xml, /<testsuites/);
    });
  });
});

test('runCli returns usage error for missing collection flag', async () => {
  await withTempDir(async (dir) => {
    const io = makeIo(dir);
    const exitCode = await runCli(['run'], io);
    assert.equal(exitCode, 2);
    assert.match(io.readStderr(), /collection path is required/i);
  });
});

test('runCli defaults to table reporter and writes summary to stderr', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withTempDir(async (dir) => {
      const collectionPath = path.join(dir, 'collection.json');
      const environmentPath = path.join(dir, 'environment.json');
      await fs.writeFile(collectionPath, JSON.stringify(makeCollection('{{baseUrl}}/ping', "apx.test('Status 200', () => { apx.expect(apx.response.code).to.equal(200); });")));
      await fs.writeFile(environmentPath, JSON.stringify(makeEnvironment(baseUrl)));

      const io = makeIo(dir);
      const exitCode = await runCli([
        'run',
        'collection.json',
        '-e', 'environment.json',
      ], io);

      assert.equal(exitCode, 0);
      assert.equal(io.readStdout(), '');
      assert.match(io.readStderr(), /Request Name/);
    });
  });
});

test('runCli supports legacy --collection flag and --no-color strips ANSI codes', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withTempDir(async (dir) => {
      const collectionPath = path.join(dir, 'collection.json');
      const environmentPath = path.join(dir, 'environment.json');
      await fs.writeFile(collectionPath, JSON.stringify(makeCollection('{{baseUrl}}/ping', "apx.test('Status 200', () => { apx.expect(apx.response.code).to.equal(200); });")));
      await fs.writeFile(environmentPath, JSON.stringify(makeEnvironment(baseUrl)));

      const io = makeIo(dir);
      const exitCode = await runCli([
        'run',
        '--collection', 'collection.json',
        '-e', 'environment.json',
        '--no-color',
      ], io);

      assert.equal(exitCode, 0);
      assert.match(io.readStderr(), /Request Name/);
      assert.doesNotMatch(io.readStderr(), /\x1b\[[0-9;]*m/);
    });
  });
});

// ─── parseArgs — timeout=0 fix ────────────────────────────────────────────────

test('parseArgs preserves --timeout 0 as string "0" (not coerced to default)', () => {
  const args = parseArgs(['run', 'col.json', '--timeout', '0']);
  assert.equal(args.timeout, '0');
});

test('parseArgs preserves --timeout with a positive value', () => {
  const args = parseArgs(['run', 'col.json', '--timeout', '5000']);
  assert.equal(args.timeout, '5000');
});

test('parseArgs supports -e short flag for environment file', () => {
  const args = parseArgs(['run', 'col.json', '-e', 'env.json']);
  assert.equal(args.environmentPath, 'env.json');
});

// ─── runCli — --timeout respected (slow server) ───────────────────────────────

test('runCli exits 1 with request error when --timeout 1 fires against a slow server', async () => {
  await withServer(async (req, res) => {
    // Delay response 300ms — well beyond the 1ms timeout
    await new Promise(r => setTimeout(r, 300));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withTempDir(async (dir) => {
      const collectionPath = path.join(dir, 'collection.json');
      await fs.writeFile(
        collectionPath,
        JSON.stringify({
          info: {
            name: 'Timeout Collection',
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
          },
          item: [
            {
              id: 'req-t',
              name: 'Slow Request',
              request: { method: 'GET', url: { raw: `${baseUrl}/slow` } },
            },
          ],
        }),
      );

      const io = makeIo(dir);
      const exitCode = await runCli([
        'run',
        'collection.json',
        '--reporter', 'json',
        '--timeout', '1',
      ], io);

      // The request should time out → at least one error → exit 1
      assert.equal(exitCode, 1);
      const report = JSON.parse(io.readStdout());
      assert.equal(report.summary.errors, 1);
    });
  });
});