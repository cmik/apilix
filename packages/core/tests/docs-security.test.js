'use strict';

/**
 * Regression tests for credential leaks (includeCredentials=false). Every test
 * asserts the secret literal is ABSENT from html, markdown, openapi json/yaml
 * and generated snippets, not merely that a placeholder is present.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateDocs } = require('../src/docs');
const r = require('../src/docs/doc-redact');

// Snippet generator that dumps the whole request model, so any leaked value shows up.
const snippetLanguages = [{ id: 'dump', label: 'Dump', generate: req => JSON.stringify(req) }];

function everyOutput(collection, extra = {}) {
  const base = Object.assign({ snippetLanguages: ['dump'] }, extra);
  const outs = [];
  for (const [format, more] of [['html', {}], ['markdown', {}], ['openapi', { openapiFormat: 'json' }], ['openapi', { openapiFormat: 'yaml' }]]) {
    outs.push({ label: `${format}${more.openapiFormat ? `/${more.openapiFormat}` : ''}`, content: generateDocs(collection, Object.assign({ format }, base, more), { snippetLanguages }).content });
  }
  return outs;
}

function assertAbsent(collection, secrets, extra) {
  for (const { label, content } of everyOutput(collection, extra)) {
    for (const s of secrets) assert.ok(!content.includes(s), `${s} leaked in ${label}`);
  }
}

const req = (url, extra = {}) => ({ info: { name: 'T' }, item: [{ name: 'r', request: Object.assign({ method: 'POST', url }, extra) }] });
const rawBody = raw => ({ body: { mode: 'raw', raw, options: { raw: { language: 'json' } } } });

test('JSON body with unquoted {{var}} is still redacted and keeps the var', () => {
  const col = req('http://h/x', rawBody('{"password":"JSONPW","id":{{id}},"name":"{{n}}"}'));
  assertAbsent(col, ['JSONPW']);
  const md = generateDocs(col, { format: 'markdown' }).content;
  assert.match(md, /\{\{id\}\}/);
  assert.match(md, /\{\{n\}\}/);
});

test('unparsable JSON falls back to regex redaction', () => {
  const col = req('http://h/x', rawBody('{"password":"FALLBACKPW", "x": {{a}}{{b}} oops, "tokens":["ARR1","ARR2"], "pin": 123456, "api_key": {{k}}}'));
  assertAbsent(col, ['FALLBACKPW', 'ARR1', 'ARR2', '123456']);
  assert.match(generateDocs(col, { format: 'markdown' }).content, /\{\{k\}\}/);
  assert.equal(r.redactBodyText('not json {"password":"X1"}', false).includes('X1'), false);
});

test('graphql variables with templated JSON are redacted', () => {
  const col = req('http://h/gql', { body: { mode: 'graphql', graphql: { query: 'query {a}', variables: '{"password":"GQLPW","id":{{id}}}' } } });
  assertAbsent(col, ['GQLPW']);
});

test('arrays and nested objects under a sensitive key are redacted', () => {
  const col = req('http://h/x', rawBody('{"tokens":["ARRTOK1","ARRTOK2"],"auth":{"inner":"NESTEDVAL","list":[1,"LISTVAL"]},"user":{"pass":"PASSVAL"},"ok":"visible"}'));
  assertAbsent(col, ['ARRTOK1', 'ARRTOK2', 'NESTEDVAL', 'LISTVAL', 'PASSVAL']);
  assert.match(generateDocs(col, { format: 'markdown' }).content, /visible/);
});

test('example response and originalRequest bodies are redacted too', () => {
  const col = req('http://h/x');
  col.item[0].response = [
    { name: 'ok', code: 200, body: '{"password":"EXPW","id":{{id}}}', originalRequest: { method: 'POST', url: 'http://h/x', body: { mode: 'raw', raw: '{"secret":"EXSECRET","id":{{id}}}' } } },
    { name: 'form', code: 400, body: 'password=FORMPW&x=1&session_id=SESS1' },
    { name: 'xml', code: 500, body: '<Envelope><Header><wsse:Password Type="x">SOAPPW</wsse:Password></Header><Body><password>XMLPW</password><user>bob</user><n apiKey="ATTRKEY"/><q token="ATTRTOK">z</q></Body></Envelope>' },
  ];
  assertAbsent(col, ['EXPW', 'EXSECRET', 'FORMPW', 'SESS1', 'SOAPPW', 'XMLPW', 'ATTRKEY', 'ATTRTOK']);
  const md = generateDocs(col, { format: 'markdown' }).content;
  assert.match(md, /x=1/);
  assert.match(md, /<user>bob<\/user>/);
});

test('urlencoded and XML request bodies in raw mode are redacted', () => {
  assertAbsent(req('http://h/x', { body: { mode: 'raw', raw: 'client_secret=RAWFORMSECRET&grant_type=x' } }), ['RAWFORMSECRET']);
  assertAbsent(req('http://h/x', { body: { mode: 'raw', raw: '<a><password><![CDATA[CDATAPW]]></password></a>' } }), ['CDATAPW']);
});

test('URL userinfo containing "/" or "@" is fully removed', () => {
  const cases = [
    ['https://user:pa/ss@host/p', ['pa/ss', 'user:']],
    ['https://user:p@ss@host2/p/:id', ['p@ss', 'user:p']],
    ['user:SCHEMELESSPW@host3/p', ['SCHEMELESSPW']],
    ['https://tok3n@host4/p', ['tok3n']],
  ];
  for (const [url, secrets] of cases) assertAbsent(req(url), secrets);
  assert.equal(r.redactUrlUserinfo('https://user:pa/ss@host/p', false), `https://${r.REDACTED}@host/p`);
  assert.equal(r.redactUrlUserinfo('https://user:p@ss@host2', false), `https://${r.REDACTED}@host2`);
  // host/path with '@' later and variable-only userinfo are left alone
  assert.equal(r.redactUrlUserinfo('https://host/users/@me', false), 'https://host/users/@me');
  assert.equal(r.redactUrlUserinfo('https://{{u}}:{{p}}@host', false), 'https://{{u}}:{{p}}@host');
  assert.equal(r.redactUrlUserinfo('mailto:a@b.c', false), 'mailto:a@b.c');
});

test('secretVariableKeys values never appear in the variables table', () => {
  const col = { info: { name: 'T' }, variable: [{ key: 'foo', value: 'SECRETVARVALUE' }, { key: 'plain', value: 'PLAINVAL' }], item: [{ name: 'r', request: { method: 'GET', url: 'http://h/{{foo}}/{{plain}}' } }] };
  for (const mode of ['keep', 'resolve']) assertAbsent(col, ['SECRETVARVALUE'], { secretVariableKeys: ['foo'], variableMode: mode, variables: { foo: 'SECRETVARVALUE' } });
  assert.match(generateDocs(col, { format: 'markdown', secretVariableKeys: ['foo'] }).content, /PLAINVAL/);
});

test('bare pass/pw and nested secret-like keys are sensitive', () => {
  for (const n of ['pass', 'pw', 'passwd', 'pwd', 'user_pass', 'userPass', 'secret_key', 'api_secret', 'apiSecret', 'private_key', 'privateKey', 'credential', 'credentials', 'client_secret', 'X-Api-Key']) {
    assert.equal(r.isSensitiveName(n), true, n);
  }
  assertAbsent(req('http://h/x?pw=QUERYPW&pass=QPASS', rawBody('{"user":{"pass":"NPASS"},"private_key":"PK1","credentials":{"a":"CRED1"}}')), ['QUERYPW', 'QPASS', 'NPASS', 'PK1', 'CRED1']);
});

test('false positives stay visible: passenger, bypass, compass, authors', () => {
  for (const n of ['passenger', 'bypass', 'compass', 'authors', 'monkey', 'keyboard', 'page']) {
    assert.equal(r.isSensitiveName(n), false, n);
  }
  const col = req('http://h/x?passenger=PQ1&bypass=PQ2&compass=PQ3', rawBody('{"passenger":"PB1","bypass":"PB2","compass":"PB3","authors":["PB4"]}'));
  const md = generateDocs(col, { format: 'markdown' }).content;
  for (const v of ['PQ1', 'PQ2', 'PQ3', 'PB1', 'PB2', 'PB3', 'PB4']) assert.ok(md.includes(v), `${v} should be visible`);
});

test('OAuth2 URLs have sensitive query params and userinfo scrubbed everywhere', () => {
  const col = req('http://h/x', { auth: { type: 'oauth2', oauth2: { grantType: 'authorization_code', tokenUrl: 'https://u:TUPW@t.example/token?client_secret=OAUTHURLSECRET&x=1', authorizationUrl: 'https://a.example/auth?access_token=AUTHTOK#access_token=FRAGTOK', clientSecret: 'CS1' } } });
  assertAbsent(col, ['OAUTHURLSECRET', 'TUPW', 'AUTHTOK', 'FRAGTOK', 'CS1']);
  assert.match(generateDocs(col, { format: 'openapi' }).content, /x=1/);
  const oauth1 = { info: { name: 'T' }, auth: col.item[0].request.auth, item: [{ name: 'r', request: { method: 'GET', url: 'http://h/y' } }] };
  assertAbsent(oauth1, ['OAUTHURLSECRET', 'TUPW', 'AUTHTOK', 'FRAGTOK']);
});

test('example headers and originalRequest URLs are scrubbed', () => {
  const col = req('http://h/x');
  col.item[0].response = [{
    name: 'ok', code: 302,
    header: [{ key: 'Location', value: 'https://x/cb?token=LOCTOK&state=s1' }, { key: 'Link', value: '<https://x/n?api_key=LINKKEY>; rel="next", <https://y:LPW@x/z>; rel="last"' }, { key: 'Content-Location', value: '/cb?session=CLOC' }],
    originalRequest: { method: 'GET', url: { raw: 'https://u:ORIGPW@h/path?access_token=ORIGTOK&a=b' }, header: [] },
  }];
  assertAbsent(col, ['LOCTOK', 'LINKKEY', 'LPW', 'CLOC', 'ORIGPW', 'ORIGTOK']);
  assert.match(generateDocs(col, { format: 'markdown' }).content, /state=s1/);
});

test('request headers with URLs (Referer) are scrubbed', () => {
  assertAbsent(req('http://h/x', { header: [{ key: 'Referer', value: 'https://x/?token=REFTOK' }] }), ['REFTOK']);
});

test('--include-credentials still keeps literals', () => {
  const col = req('https://u:pa/ss@host/p?token=KEEPME', rawBody('{"password":"KEEPPW"}'));
  const md = generateDocs(col, { format: 'markdown', includeCredentials: true }).content;
  for (const v of ['pa/ss', 'KEEPME', 'KEEPPW']) assert.ok(md.includes(v), v);
});

test('html: emphasis cannot alter href values', () => {
  const col = { info: { name: 'T', description: 'See [x](https://a.com/*b*c) and [**bold** y](https://a.com/p_*q*) and [z](#"onx)' }, item: [] };
  const html = generateDocs(col, { format: 'html' }).content;
  assert.ok(html.includes('href="https://a.com/*b*c"'), 'href kept verbatim');
  assert.ok(html.includes('href="https://a.com/p_*q*"'));
  assert.ok(!/href="[^"]*<(em|strong)>/.test(html), 'no tags inside href');
  assert.ok(html.includes('<strong>bold</strong> y</a>'), 'label emphasis still works');
  assert.ok(!html.includes('<a href="#"onx'), 'no attribute breakout');
});

test('markdown: raw HTML in names/descriptions is escaped and headings stay single-line', () => {
  const col = {
    info: { name: 'T<script>alert(1)</script>', description: 'Desc <img src=x onerror=alert(1)> & `<keep>`\n```\n<code>&\n```' },
    item: [{ name: 'Evil\n# injected <b>x</b>', description: 'folder <i>d</i>', item: [{ name: 'a\nb <u>', request: { method: 'GET', url: 'http://h/x', description: '<script>y</script>' } }] }],
  };
  const md = generateDocs(col, { format: 'markdown' }).content;
  assert.ok(!md.includes('<script>'), 'no raw script');
  assert.ok(!md.includes('<img'), 'no raw img');
  assert.ok(!md.includes('<b>x</b>') && !md.includes('<i>d</i>') && !md.includes('<u>'));
  assert.ok(md.includes('&lt;script&gt;'));
  assert.ok(md.includes('`<keep>`'), 'code spans untouched');
  assert.ok(md.includes('<code>&\n'), 'fenced content untouched');
  assert.ok(!/^# injected/m.test(md), 'newline in name cannot start a new heading');
  assert.ok(/^## Evil # injected &lt;b&gt;x&lt;\/b&gt;$/m.test(md));
});
