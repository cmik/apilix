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

const { redactRequest, redactResponse, scrubTokenPatterns } = require('../src/redact');
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-xyz';

test('header with a neutral name carrying a Bearer JWT is masked', () => {
  const out = redactRequest({ method: 'GET', url: 'https://x.test/', header: [{ key: 'X-Custom', value: `Bearer ${JWT}` }, { key: 'X-Trace', value: 'abc' }] });
  const s = json(out);
  assert.ok(!s.includes('eyJhbGci'), s);
  assert.ok(s.includes('"abc"'));
});

test('JWT, ghp_, sk-, xox and AKIA tokens in free-text body values are masked', () => {
  const body = JSON.stringify({ note: `tok ghp_${'a'.repeat(36)} and ${JWT}`, other: 'sk-live-ABCDEFGH12345678', slack: 'xoxb-123456789012-abcdefABCDEF', aws: 'AKIAIOSFODNN7EXAMPLE', keep: 'hello' });
  const { value } = redactContext({ response: { status: 200, body } });
  const s = json(value);
  for (const leak of ['ghp_aaaa', 'eyJhbGci', 'sk-live-ABCD', 'xoxb-1234', 'AKIAIOSFODNN7']) assert.ok(!s.includes(leak), leak);
  assert.ok(s.includes('hello'));
});

test('URL with a sensitive query param inside a body value is masked', () => {
  const { value } = redactContext({ response: { status: 200, body: '{"next":"https://api.test/cb?code=CODE1234&page=2"}' } });
  assert.ok(!json(value).includes('CODE1234'));
  assert.ok(json(value).includes('page=2'));
});

test('scripts: literal secret under a neutral variable name and URL credentials are masked', () => {
  const src = [
    'const k = "sk-live-ABCDEFGH12345678";',
    'const u = "https://user:pw0rd@h.example.com/?token=TTTT7777&q=1";',
    'const ok = "https://h.example.com/items?page=2";',
  ].join('\n');
  const { value } = redactContext({ scripts: { test: src } });
  const out = value.scripts.test;
  for (const leak of ['sk-live-ABCD', 'pw0rd', 'TTTT7777']) assert.ok(!out.includes(leak), leak);
  assert.ok(out.includes('page=2'));
});

test('base64-encoded secret values are scrubbed', () => {
  const secret = 'envSecretValue99';
  const b64 = Buffer.from(secret).toString('base64');
  const { value } = redactContext({
    request: { method: 'GET', url: 'https://x.test/', header: [{ key: 'X-A', value: b64 }, { key: 'X-B', value: b64.replace(/=+$/, '') }] },
  }, { secretValues: [secret] });
  assert.ok(!json(value).includes(b64.replace(/=+$/, '')), json(value));
});

test('prose such as "Basic authentication" is not masked; {{var}} survives; redactSecrets:false keeps token shapes', () => {
  assert.equal(scrubTokenPatterns('Use Basic authentication here'), 'Use Basic authentication here');
  assert.equal(scrubTokenPatterns('Bearer {{token}}'), 'Bearer {{token}}');
  assert.ok(!scrubTokenPatterns('Basic dXNlcjpwYXNz1234').includes('dXNlcjpw'));
  const { value } = redactContext({ response: { status: 200, body: `{"note":"${JWT}"}` } }, { redactSecrets: false });
  assert.ok(json(value).includes('eyJhbGci'));
});

test('base64 padded, unpadded and url-safe forms of a secret are scrubbed', () => {
  for (const secret of ['abcd', 'abcde', 'abcdef', 'user:pa55w0rd?>~']) {
    const b64 = Buffer.from(secret, 'utf8').toString('base64');
    const forms = [b64, b64.replace(/=+$/, ''), b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')];
    for (const f of forms) {
      const out = scrubSecretValues('x ' + f + ' y', [secret]);
      assert.ok(!out.includes(f), 'form ' + f + ' of ' + secret + ' leaked: ' + out);
    }
  }
});
