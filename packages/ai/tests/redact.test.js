'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactContext, redactScript, scrubSecretValues, REDACTED } = require('../src/redact');

const SECRET = 'sup3r-s3cret-value';

function json(x) { return JSON.stringify(x); }

test('secrets in URL userinfo, query, body, cookie and headers are masked', () => {
  const { value, redactions } = redactContext({
    request: {
      method: 'POST',
      url: 'https://user:hunter2pw@api.example.com/v1/x?api_key=AKIA123456&page=2',
      header: [
        { key: 'Authorization', value: 'Bearer eyJhbGciOi.abc.def' },
        { key: 'Cookie', value: 'sid=abcdef123456' },
        { key: 'Content-Type', value: 'application/json' },
      ],
      body: { mode: 'raw', raw: '{"user":{"password":"p4ssw0rd!","name":"bob","nested":{"client_secret":"zzz999"}}}' },
    },
  });
  const s = json(value);
  for (const leak of ['hunter2pw', 'AKIA123456', 'eyJhbGciOi', 'sid=abcdef123456', 'p4ssw0rd!', 'zzz999']) {
    assert.ok(!s.includes(leak), `leaked ${leak}`);
  }
  assert.ok(s.includes('page=2'));
  assert.ok(s.includes('bob'));
  assert.ok(s.includes('application/json'));
  assert.ok(redactions >= 5);
});

test('{{variable}} references survive', () => {
  const { value } = redactContext({
    request: {
      method: 'GET',
      url: '{{baseUrl}}/x?token={{token}}',
      header: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
    },
  });
  const s = json(value);
  assert.ok(s.includes('{{baseUrl}}'));
  assert.ok(s.includes('Bearer {{token}}'));
  assert.ok(s.includes('"value":"{{token}}"'));
});

test('auth block literals are masked whatever the key name', () => {
  const { value } = redactContext({
    request: { method: 'GET', url: 'x', auth: { type: 'bearer', bearer: [{ key: 'value', value: 'lit-token-123456' }] } },
  });
  assert.ok(!json(value).includes('lit-token-123456'));
});

test('known secret values are scrubbed from every text, even with redactSecrets:false', () => {
  const { value } = redactContext(
    {
      request: { method: 'GET', url: `https://x.test/?note=${SECRET}`, header: [{ key: 'X-Note', value: `hello ${SECRET}` }] },
      response: { status: 200, body: `{"echo":"${SECRET}"}` },
      scripts: { test: `console.log("${SECRET}")` },
      text: `free ${SECRET}`,
    },
    { secretValues: [SECRET], redactSecrets: false },
  );
  assert.ok(!json(value).includes(SECRET));
});

test('redactSecrets:false keeps by-name literals but still scrubs secret values', () => {
  const { value } = redactContext(
    { request: { method: 'GET', url: 'x', header: [{ key: 'Authorization', value: 'Bearer abc.def.ghi' }, { key: 'X-Other', value: SECRET }] } },
    { secretValues: [SECRET], redactSecrets: false },
  );
  const s = json(value);
  assert.ok(s.includes('Bearer abc.def.ghi'));
  assert.ok(!s.includes(SECRET));
});

test('short secret values (<4 chars) are not scrubbed, long ones are, longest first', () => {
  assert.equal(scrubSecretValues('ab abc', ['ab']), 'ab abc');
  assert.equal(scrubSecretValues('xx secret-long yy secret', ['secret', 'secret-long']), `xx ${REDACTED} yy ${REDACTED}`);
});

test('URL-encoded form of a secret is scrubbed', () => {
  const out = scrubSecretValues('q=a%20b%26c!', ['a b&c!']);
  assert.ok(!out.includes('a%20b'));
});

test('redactScript masks apx.*.set literals for sensitive names only', () => {
  const src = [
    "apx.environment.set('token', 'abc123xyz');",
    'apx.globals.set("api_key", "KEY-999999");',
    "apx.environment.set('userId', 'u-1');",
    "apx.environment.set('token', apx.response.json().token);",
    "apx.environment.set('token', '{{other}}');",
  ].join('\n');
  const out = redactScript(src);
  assert.ok(!out.includes('abc123xyz'));
  assert.ok(!out.includes('KEY-999999'));
  assert.ok(out.includes("'userId', 'u-1'"));
  assert.ok(out.includes('apx.response.json().token'));
  assert.ok(out.includes("'{{other}}'"));
});

test('redactScript masks hard-coded Authorization headers, auth schemes and sensitive assignments', () => {
  const src = [
    "const h = { 'Authorization': 'Bearer abcdef123456', 'Accept': 'json' };",
    'const password = "hunter2hunter2";',
    "const cfg = { client_secret: 'zzz-secret-1' };",
    "const label = 'Bearer ' + token;",
  ].join('\n');
  const out = redactScript(src);
  for (const leak of ['abcdef123456', 'hunter2hunter2', 'zzz-secret-1']) assert.ok(!out.includes(leak), leak);
  assert.ok(out.includes("'Accept': 'json'"));
  assert.ok(out.includes("'Bearer ' + token"));
});

test('secret in cookie header and environment-like nested JSON is masked in responses', () => {
  const { value } = redactContext({
    response: { status: 200, headers: { 'Set-Cookie': 'session=abc123def', 'Content-Type': 'application/json' }, body: '{"access_token":"tok-987654","items":[{"id":1}]}' },
  });
  const s = json(value);
  assert.ok(!s.includes('abc123def'));
  assert.ok(!s.includes('tok-987654'));
  assert.match(s, /\\"id\\": 1/);
});
