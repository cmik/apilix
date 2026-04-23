'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { runCli, parseArgs } = require('./cli-runner');

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

test('runCli outputs JSON report to stdout and exits 0 on success', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withTempDir(async (dir) => {
      const collectionPath = path.join(dir, 'collection.json');
      const environmentPath = path.join(dir, 'environment.json');
      await copyFixture('collection-success.json', collectionPath);
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
      assert.equal(report.collectionName, 'CLI Fixture Collection');
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
      await copyFixture('collection-fail.json', collectionPath);
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
      await copyFixture('collection-success.json', collectionPath);
      await fs.writeFile(environmentPath, JSON.stringify(makeEnvironment(baseUrl)));
      await copyFixture('data.csv', csvPath);

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
      await copyFixture('collection-success.json', collectionPath);
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
      await copyFixture('collection-success.json', collectionPath);
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

// parseArgs

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

test('parseArgs supports legacy --collection flag without positional path', () => {
  const args = parseArgs(['run', '--collection', 'col.json']);
  assert.equal(args.collectionPath, 'col.json');
  assert.equal(args.usedLegacyCollectionFlag, true);
});

test('parseArgs prioritizes positional collection path over --collection', () => {
  const args = parseArgs(['run', 'primary.json', '--collection', 'legacy.json']);
  assert.equal(args.collectionPath, 'primary.json');
  assert.equal(args.usedLegacyCollectionFlag, false);
});

test('runCli accepts environment files provided as plain object maps', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withTempDir(async (dir) => {
      const collectionPath = path.join(dir, 'collection.json');
      const environmentPath = path.join(dir, 'environment.json');
      await copyFixture('collection-success.json', collectionPath);
      await fs.writeFile(environmentPath, JSON.stringify({ baseUrl }));

      const io = makeIo(dir);
      const exitCode = await runCli([
        'run',
        'collection.json',
        '-e', 'environment.json',
        '--reporter', 'json',
      ], io);

      assert.equal(exitCode, 0);
      const report = JSON.parse(io.readStdout());
      assert.equal(report.summary.errors, 0);
    });
  });
});

test('runCli returns usage error for invalid globals file shape', async () => {
  await withTempDir(async (dir) => {
    const collectionPath = path.join(dir, 'collection.json');
    const globalsPath = path.join(dir, 'globals.json');
    await copyFixture('collection-success.json', collectionPath);
    await fs.writeFile(globalsPath, JSON.stringify(['bad-shape']));

    const io = makeIo(dir);
    const exitCode = await runCli([
      'run',
      'collection.json',
      '--globals', 'globals.json',
    ], io);

    assert.equal(exitCode, 2);
    assert.match(io.readStderr(), /globals file must be an object map/i);
  });
});

// runCli timeout

test('runCli exits 1 with request error when --timeout 1 fires against a slow server', async () => {
  await withServer(async (req, res) => {
    await new Promise(r => setTimeout(r, 300));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withTempDir(async (dir) => {
      const collectionPath = path.join(dir, 'collection.json');
      const environmentPath = path.join(dir, 'environment.json');
      await copyFixture('collection-timeout.json', collectionPath);
      await fs.writeFile(environmentPath, JSON.stringify(makeEnvironment(baseUrl)));

      const io = makeIo(dir);
      const exitCode = await runCli([
        'run',
        'collection.json',
        '-e', 'environment.json',
        '--reporter', 'json',
        '--timeout', '1',
      ], io);

      assert.equal(exitCode, 1);
      const report = JSON.parse(io.readStdout());
      assert.equal(report.summary.errors, 1);
    });
  });
});

// parseArgs — proxy / bail flags

test('parseArgs captures --http-proxy and --https-proxy flags', () => {
  const args = parseArgs(['run', 'col.json', '--http-proxy', 'http://p:3128', '--https-proxy', 'http://ps:3128']);
  assert.equal(args.httpProxy, 'http://p:3128');
  assert.equal(args.httpsProxy, 'http://ps:3128');
});

test('parseArgs captures --proxy-bypass host list', () => {
  const args = parseArgs(['run', 'col.json', '--proxy-bypass', 'localhost,127.0.0.1']);
  assert.equal(args.proxyBypass, 'localhost,127.0.0.1');
});

test('parseArgs defaults proxy fields to empty strings', () => {
  const args = parseArgs(['run', 'col.json']);
  assert.equal(args.httpProxy, '');
  assert.equal(args.httpsProxy, '');
  assert.equal(args.proxyBypass, '');
});

test('parseArgs supports --bail flag', () => {
  const argsWithBail = parseArgs(['run', 'col.json', '--bail']);
  assert.equal(argsWithBail.bail, true);

  const argsWithoutBail = parseArgs(['run', 'col.json']);
  assert.equal(argsWithoutBail.bail, false);
});

// --bail integration

test('runCli --bail stops after first test assertion failure and exits 1', async () => {
  let requestCount = 0;
  await withServer((req, res) => {
    requestCount++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withTempDir(async (dir) => {
      const collectionPath = path.join(dir, 'collection.json');
      // Two-request collection: first has a failing assertion, second would succeed
      await fs.writeFile(collectionPath, JSON.stringify({
        info: {
          name: 'Bail Test Collection',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        item: [
          {
            id: 'req-1',
            name: 'Failing Request',
            request: { method: 'GET', url: { raw: `${baseUrl}/first` } },
            event: [{
              listen: 'test',
              script: {
                type: 'text/javascript',
                exec: ["apx.test('must fail', () => { apx.expect(apx.response.code).to.equal(999); });"],
              },
            }],
          },
          {
            id: 'req-2',
            name: 'Should Not Run',
            request: { method: 'GET', url: { raw: `${baseUrl}/second` } },
          },
        ],
      }));

      const io = makeIo(dir);
      const exitCode = await runCli([
        'run',
        'collection.json',
        '--reporter', 'json',
        '--bail',
      ], io);

      assert.equal(exitCode, 1);
      const report = JSON.parse(io.readStdout());
      // Only one request should have been executed before bail
      assert.equal(report.summary.requests, 1);
      assert.equal(report.summary.failed, 1);
      // Server should have been hit exactly once
      assert.equal(requestCount, 1);
    });
  });
});

test('runCli --bail stops after first request error and exits 1', async () => {
  let requestCount = 0;
  await withServer((req, res) => {
    requestCount++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withTempDir(async (dir) => {
      const collectionPath = path.join(dir, 'collection.json');
      // First request points to a port nothing is listening on (will error)
      await fs.writeFile(collectionPath, JSON.stringify({
        info: {
          name: 'Bail Error Collection',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        item: [
          {
            id: 'req-1',
            name: 'Erroring Request',
            request: { method: 'GET', url: { raw: 'http://127.0.0.1:19999/fail' } },
          },
          {
            id: 'req-2',
            name: 'Should Not Run',
            request: { method: 'GET', url: { raw: `${baseUrl}/second` } },
          },
        ],
      }));

      const io = makeIo(dir);
      const exitCode = await runCli([
        'run',
        'collection.json',
        '--reporter', 'json',
        '--bail',
      ], io);

      assert.equal(exitCode, 1);
      const report = JSON.parse(io.readStdout());
      assert.equal(report.summary.requests, 1);
      assert.equal(report.summary.errors, 1);
      // The live server should not have been hit at all
      assert.equal(requestCount, 0);
    });
  });
});

// apx.execution.setNextRequest()

test('runCli apx.execution.setNextRequest() jumps to named request and skips intermediate', async () => {
  const visited = [];
  await withServer((req, res) => {
    visited.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withTempDir(async (dir) => {
      const collectionPath = path.join(dir, 'collection.json');
      await fs.writeFile(collectionPath, JSON.stringify({
        info: {
          name: 'setNextRequest Jump Collection',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        item: [
          {
            id: 'req-1',
            name: 'First',
            request: { method: 'GET', url: { raw: `${baseUrl}/first` } },
            event: [{
              listen: 'test',
              script: {
                type: 'text/javascript',
                exec: ["apx.execution.setNextRequest('Third');"],
              },
            }],
          },
          {
            id: 'req-2',
            name: 'Second',
            request: { method: 'GET', url: { raw: `${baseUrl}/second` } },
          },
          {
            id: 'req-3',
            name: 'Third',
            request: { method: 'GET', url: { raw: `${baseUrl}/third` } },
          },
        ],
      }));

      const io = makeIo(dir);
      const exitCode = await runCli([
        'run',
        'collection.json',
        '--reporter', 'json',
      ], io);

      assert.equal(exitCode, 0);
      const report = JSON.parse(io.readStdout());
      // Only First and Third should have been executed — Second is skipped
      assert.equal(report.summary.requests, 2);
      assert.equal(report.summary.errors, 0);
      assert.ok(visited.includes('/first'), 'expected /first to be hit');
      assert.ok(visited.includes('/third'), 'expected /third to be hit');
      assert.ok(!visited.includes('/second'), 'expected /second to be skipped');
    });
  });
});

test('runCli apx.execution.setNextRequest(null) stops the run after the current request', async () => {
  let requestCount = 0;
  await withServer((req, res) => {
    requestCount++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withTempDir(async (dir) => {
      const collectionPath = path.join(dir, 'collection.json');
      await fs.writeFile(collectionPath, JSON.stringify({
        info: {
          name: 'setNextRequest Stop Collection',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        item: [
          {
            id: 'req-1',
            name: 'First',
            request: { method: 'GET', url: { raw: `${baseUrl}/first` } },
            event: [{
              listen: 'test',
              script: {
                type: 'text/javascript',
                exec: ['apx.execution.setNextRequest(null);'],
              },
            }],
          },
          {
            id: 'req-2',
            name: 'Should Not Run',
            request: { method: 'GET', url: { raw: `${baseUrl}/second` } },
          },
        ],
      }));

      const io = makeIo(dir);
      const exitCode = await runCli([
        'run',
        'collection.json',
        '--reporter', 'json',
      ], io);

      assert.equal(exitCode, 0);
      const report = JSON.parse(io.readStdout());
      // Run stopped after First — Second never executed
      assert.equal(report.summary.requests, 1);
      assert.equal(report.summary.errors, 0);
      assert.equal(requestCount, 1);
    });
  });
});

// apx.execution.skipRequest()

test('runCli apx.execution.skipRequest() skips the HTTP call but still records the request', async () => {
  let requestCount = 0;
  await withServer((req, res) => {
    requestCount++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    await withTempDir(async (dir) => {
      const collectionPath = path.join(dir, 'collection.json');
      await fs.writeFile(collectionPath, JSON.stringify({
        info: {
          name: 'skipRequest Collection',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        item: [
          {
            id: 'req-1',
            name: 'Skipped Request',
            request: { method: 'GET', url: { raw: `${baseUrl}/skipped` } },
            event: [{
              listen: 'prerequest',
              script: {
                type: 'text/javascript',
                exec: ['apx.execution.skipRequest();'],
              },
            }],
          },
          {
            id: 'req-2',
            name: 'Normal Request',
            request: { method: 'GET', url: { raw: `${baseUrl}/normal` } },
          },
        ],
      }));

      const io = makeIo(dir);
      const exitCode = await runCli([
        'run',
        'collection.json',
        '--reporter', 'json',
      ], io);

      assert.equal(exitCode, 0);
      const report = JSON.parse(io.readStdout());
      // Both requests counted, no errors
      assert.equal(report.summary.requests, 2);
      assert.equal(report.summary.errors, 0);
      // The skipped request never reached the server; Normal Request did
      assert.equal(requestCount, 1);
      // The first result should be marked skipped with status 0
      const results = report.iterations[0].results;
      assert.equal(results[0].name, 'Skipped Request');
      assert.equal(results[0].skipped, true);
      assert.equal(results[0].status, 0);
      assert.equal(results[1].name, 'Normal Request');
      assert.equal(results[1].skipped, false);
    });
  });
});
