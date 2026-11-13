'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SECRET_TOKEN = 'tok_SuperSecretValue_9f8e7d6c';
const ENV_SECRET = 'envSecret_Zx81QpLm20';
const LITERAL_AUTH = 'literalBearer_AbC123xyz789';
const PASSWORD = 'pa55w0rd_Hunter2xyz';

/** Postman collection whose base URL comes from {{base}}. */
function collectionFixture(extra = {}) {
  return {
    info: { name: 'Demo API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', description: 'Demo collection' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: LITERAL_AUTH, type: 'string' }] },
    variable: [{ key: 'colVar', value: 'cv' }],
    item: [
      {
        name: 'Users',
        id: 'folder-users',
        item: [
          {
            name: 'List users', id: 'req-list',
            request: {
              method: 'GET',
              url: { raw: `{{base}}/users?page=1&api_key=${PASSWORD}`, host: ['{{base}}'], path: ['users'], query: [{ key: 'page', value: '1' }, { key: 'api_key', value: PASSWORD }] },
              header: [{ key: 'Authorization', value: `Bearer ${SECRET_TOKEN}` }, { key: 'X-Trace', value: 'abc' }],
            },
            event: [{ listen: 'test', script: { exec: ['apx.test("status is 200", function () { apx.expect(apx.response.code).to.equal(200); });'] } }],
          },
          {
            name: 'Create user', id: 'req-create',
            request: {
              method: 'POST', url: '{{base}}/users',
              header: [{ key: 'Content-Type', value: 'application/json' }],
              body: { mode: 'raw', raw: `{"name":"x","password":"${PASSWORD}"}` },
            },
          },
        ],
      },
      { name: 'Ping', id: 'req-ping', request: { method: 'GET', url: '{{base}}/ping' } },
      { name: 'Fails', id: 'req-fails', request: { method: 'GET', url: '{{base}}/ping' }, event: [{ listen: 'test', script: { exec: ['apx.test("expects 201", function () { apx.expect(apx.response.code).to.equal(201); });'] } }] },
    ],
    ...extra,
  };
}

function environmentFixture(base) {
  return {
    name: 'Local',
    values: [
      { key: 'base', value: base, enabled: true },
      { key: 'apiToken', value: SECRET_TOKEN, enabled: true },
      { key: 'hidden', value: ENV_SECRET, enabled: true, secret: true },
      { key: 'plain', value: 'visible-value', enabled: true },
    ],
  };
}

function makeTmp(prefix = 'apilix-mcp-') {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function writeJson(dir, rel, obj) {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return abs;
}

module.exports = { SECRET_TOKEN, ENV_SECRET, LITERAL_AUTH, PASSWORD, collectionFixture, environmentFixture, makeTmp, writeJson };
