'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { executeRequest, setExecutorConfig } = require('./executor');

async function withServer(handler, runTest) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/test`;

  try {
    await runTest(url);
  } finally {
    await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
}

function makeContext() {
  return {
    environment: {},
    collectionVariables: {},
    globals: {},
    dataRow: {},
    collVars: [],
    cookies: {},
    collectionItems: [],
    conditionalExecution: true,
    mockBase: null,
  };
}

test('executeRequest routes new environment mutations from test scripts into updatedEnvironment', async () => {
  setExecutorConfig({ followRedirects: false, requestTimeout: 3000, sslVerification: false });

  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (url) => {
    const item = {
      name: 'Env mutation request',
      request: { method: 'GET', url },
      event: [
        {
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: ["apx.environment.set('brandNewVar', 'hello');"],
          },
        },
      ],
    };

    const result = await executeRequest(item, makeContext());

    assert.equal(result.error, null);
    assert.equal(result.updatedEnvironment.brandNewVar, 'hello');
    assert.equal(result.updatedCollectionVariables.brandNewVar, undefined);
  });
});

test('executeRequest keeps collection and generic variable mutations out of environment scope', async () => {
  setExecutorConfig({ followRedirects: false, requestTimeout: 3000, sslVerification: false });

  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (url) => {
    const item = {
      name: 'Collection mutation request',
      request: { method: 'GET', url },
      event: [
        {
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: [
              "apx.collectionVariables.set('collectionOnly', 'c1');",
              "apx.variables.set('genericVar', 'g1');",
            ],
          },
        },
      ],
    };

    const result = await executeRequest(item, makeContext());

    assert.equal(result.error, null);
    assert.equal(result.updatedEnvironment.collectionOnly, undefined);
    assert.equal(result.updatedEnvironment.genericVar, undefined);
    assert.equal(result.updatedCollectionVariables.collectionOnly, 'c1');
    assert.equal(result.updatedCollectionVariables.genericVar, 'g1');
  });
});