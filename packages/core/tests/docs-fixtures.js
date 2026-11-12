'use strict';

/** Shared fixture for docs export tests. Contains deliberate secrets and XSS payloads. */
function makeCollection() {
  return {
    info: {
      name: 'Demo <API>',
      description: '# Intro\n**bold** [bad](javascript:alert(1)) [ok](https://example.com/x?a=1&b=2) <script>alert(1)</script>',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: 'SECRET-COLLECTION-TOKEN' }] },
    variable: [
      { key: 'baseUrl', value: 'https://api.example.com' },
      { key: 'apiToken', value: 'SECRET-VAR-VALUE' },
    ],
    item: [
      {
        name: 'Users',
        description: 'User endpoints',
        item: [
          {
            id: 'req-get',
            name: 'Get user',
            request: {
              method: 'GET',
              url: { raw: '{{baseUrl}}/users/:id?token=SECRET-QUERY&page=1', variable: [{ key: 'id', value: '42', description: 'User id' }] },
              header: [
                { key: 'Authorization', value: 'Bearer SECRET-HEADER' },
                { key: 'X-Trace', value: 'trace-1' },
                { key: 'X-Disabled', value: 'nope', disabled: true },
              ],
              description: 'Fetch <img src=x onerror=alert(1)> a user',
              auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Key' }, { key: 'value', value: 'SECRET-APIKEY' }, { key: 'in', value: 'header' }] },
            },
            response: [
              {
                name: 'Found',
                code: 200,
                status: 'OK',
                header: [{ key: 'Content-Type', value: 'application/json' }, { key: 'Set-Cookie', value: 'sid=SECRET-COOKIE' }],
                body: '{"id":42,"name":"Ann","password":"SECRET-RESP-PW"}',
                _postman_previewlanguage: 'json',
              },
              { name: 'Missing', code: 404, status: 'Not Found', header: [], body: '{"error":"nope"}' },
            ],
          },
          {
            id: 'req-create',
            name: 'Create user',
            request: {
              method: 'POST',
              url: '{{baseUrl}}/users',
              header: [{ key: 'Content-Type', value: 'application/json' }],
              body: { mode: 'raw', raw: '{"name":"Ann","api_key":"SECRET-BODY-KEY","token":"{{apiToken}}"}', options: { raw: { language: 'json' } } },
            },
          },
        ],
      },
      {
        name: 'Public',
        request: { method: 'GET', url: 'https://other.example.org/health', auth: { type: 'noauth' } },
      },
      { name: 'Mongo thing', request: { requestType: 'mongodb', method: 'MONGO', url: 'x' } },
    ],
  };
}

const SECRETS = [
  'SECRET-COLLECTION-TOKEN', 'SECRET-QUERY', 'SECRET-HEADER', 'SECRET-APIKEY',
  'SECRET-COOKIE', 'SECRET-RESP-PW', 'SECRET-BODY-KEY', 'SECRET-VAR-VALUE',
];

module.exports = { makeCollection, SECRETS };
