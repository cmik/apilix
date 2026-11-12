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

test('percent-encoded sensitive query key is redacted in url and examples', () => {
  const col = { info: { name: 'T' }, item: [{ name: 'q', request: { method: 'GET', url: 'http://h/x?api%2Dkey=PCT-SECRET&ok=1' } }] };
  for (const format of ['html', 'markdown', 'openapi']) {
    const out = generateDocs(col, { format }).content;
    assert.ok(!out.includes('PCT-SECRET'), `${format} leaked encoded-key secret`);
  }
});

// Run fn, fail with a diagnostic message naming the input when it is too slow.
function within(label, budgetMs, fn) {
  const t0 = process.hrtime.bigint();
  const result = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < budgetMs, `${label}: took ${ms.toFixed(0)} ms (budget ${budgetMs} ms)`);
  return result;
}

const descDoc = description => generateDocs({ info: { name: 'T', description }, item: [] }, { format: 'html' }).content;

test('redaction and rendering stay fast on adversarial input (per-input budgets)', () => {
  const big = 500000;
  const inputs = [
    ['redactUrlsInText a*50k', () => r.redactUrlsInText('a'.repeat(50000), false)],
    ['redactUrlsInText "a-" 500KB', () => r.redactUrlsInText('a-'.repeat(big / 2), false)],
    ['redactUrlsInText "a://" 500KB', () => r.redactUrlsInText('a://'.repeat(big / 4), false)],
    ['redactUrlsInText "Bearer " 500KB', () => r.redactUrlsInText('Bearer '.repeat(big / 7), false)],
    ['redactUrlsInText "Bearer"+spaces', () => r.redactUrlsInText(`Bearer${' '.repeat(big)}`, false)],
    ['xml "<->"+spaces', () => r.redactBodyText(`<->${' '.repeat(20000)}`, false)],
    ['xml "<-><![CDATA[" x3000', () => r.redactBodyText('<-><![CDATA['.repeat(3000), false)],
    ['xml "<password><![CDATA[" x25000', () => r.redactBodyText('<password><![CDATA['.repeat(25000), false)],
    ['xml "<password>" x50000', () => r.redactBodyText('<password>'.repeat(50000), false)],
    ['xml "<password><!--" x50000', () => r.redactBodyText('<password><!--x-->'.repeat(30000), false)],
    ['xml "<a " x100000', () => r.redactBodyText('<a "'.repeat(100000), false)],
    ['xml "<a x=\'" x100000', () => r.redactBodyText('<a x=\''.repeat(80000), false)],
    ['xml "<?" x200000', () => r.redactBodyText('<?'.repeat(200000), false)],
    ['xml attrs 400KB', () => r.redactBodyText(`<a ${'x="1" '.repeat(50000)}>`, false)],
    ['json-like array spaces', () => r.redactBodyText(`{"tokens":[${' '.repeat(100000)}1]`, false)],
    ['json-like array spaces 500KB', () => r.redactBodyText(`{"tokens":[${' '.repeat(big)}1]`, false)],
    ['json-like array "1," x', () => r.redactBodyText(`{"tokens":[${'1,'.repeat(big / 2)}1]`, false)],
    ['json-like array ", " x', () => r.redactBodyText(`{"tokens":[${', '.repeat(big / 2)}1]`, false)],
    ['json-like array commas+spaces', () => r.redactBodyText(`{"tokens":[${' ,'.repeat(big / 2)}1]`, false)],
    ['json-like nested "[" x', () => r.redactBodyText(`{"tokens":${'['.repeat(big)}1`, false)],
    ['json-like nested "[ " x', () => r.redactBodyText(`{"tokens":${'[ '.repeat(big / 2)}1`, false)],
    ['json-like nested "[1," x', () => r.redactBodyText(`{"tokens":${'[1,'.repeat(big / 3)}`, false)],
    ['json-like "\"tokens\":[" x (no close)', () => r.redactBodyText(`{${'"tokens":['.repeat(big / 10)}`, false)],
    ['json-like \"a\":\" x (unterminated)', () => r.redactBodyText(`{${'"a":"'.repeat(big / 6)}`, false)],
    ['json-like escaped quotes', () => r.redactBodyText(`{"a":"${'\\"'.repeat(big / 2)}`, false)],
    ['json-like key spaces', () => r.redactBodyText(`{"password"${' '.repeat(big)}:`, false)],
    ['json-like value spaces', () => r.redactBodyText(`{"password":${' '.repeat(big)}"x`, false)],
    ['json-like "{{" x', () => r.redactBodyText(`{"password":${'{{'.repeat(big / 2)}`, false)],
    ['json-like "{{a" x', () => r.redactBodyText(`{"password":${'{{a '.repeat(big / 4)}`, false)],
    ['json-like bare tokens', () => r.redactBodyText(`{"password":${'a '.repeat(100000)}`, false)],
    ['json-like many sensitive keys', () => r.redactBodyText(`{${'"token":1,'.repeat(20000)}`, false)],
    ['openapi "{{"+spaces', () => generateDocs({ info: { name: 'T' }, item: [{ name: 'r', request: { method: 'GET', url: `http://h/{{${' '.repeat(40000)}x` } }] }, { format: 'openapi' })],
    ['openapi "{{ x" x', () => generateDocs({ info: { name: 'T' }, item: [{ name: 'r', request: { method: 'GET', url: `http://h/${'{{ x '.repeat(40000)}` } }] }, { format: 'openapi' })],
    ['html "<A0..." +list', () => descDoc(`<A${'0'.repeat(50000)}\n* ${' '.repeat(50000)}x\n#${' '.repeat(50000)}x`)],
    ['html "<a " x20000', () => descDoc('<a '.repeat(20000))],
    ['html "<a " x130000', () => descDoc('<a '.repeat(130000))],
    ['html \'<a href="\' x40000', () => descDoc('<a href="'.repeat(40000))],
    ['html "<b "+400KB', () => descDoc(`<b ${'x'.repeat(400000)}`)],
    ['html "[" x80000', () => descDoc('['.repeat(80000))],
    ['html "![" x40000', () => descDoc('!['.repeat(40000))],
    ['html "![a](" x16000', () => descDoc('![a]('.repeat(16000))],
    ['html "[a](" x20000', () => descDoc('[a]('.repeat(20000))],
    ['html "[a](u" x20000', () => descDoc('[a](u'.repeat(20000))],
  ];
  for (const [label, fn] of inputs) { const t0 = Date.now(); within(label, 1500, fn); if (process.env.PERF_LOG) console.log(label, Date.now() - t0); }
});

test('redactUrlsInText: a leading junk char before a scheme does not hide userinfo when another URL is present', () => {
  for (const junk of ['-', '9', '+', '.', 'x']) {
    const out = r.redactUrlsInText(`https://ok.example/x ${junk}https://u:SEKRET@h/x`, false);
    assert.ok(!out.includes('SEKRET'), `${junk}https leaked: ${out}`);
  }
  const q = r.redactUrlsInText('https://ok.example/a +https://h/p?token=SEKRET', false);
  assert.ok(!q.includes('SEKRET'), q);
  assert.equal(r.redactUrlsInText('https://ok.example/a?x=1 and https://other.example/b', false), 'https://ok.example/a?x=1 and https://other.example/b');
  assert.equal(r.redactUrlsInText('(https://h/x?token=S)', false), '(https://h/x?token=<redacted>)');
  assert.equal(r.redactUrlsInText('https://h/a(b)?token=S)', false).endsWith(')'), true);
});

test('protocol-relative URLs with userinfo are redacted', () => {
  assert.ok(!r.redactUrlUserinfo('//u:SEKRET@h/x', false).includes('SEKRET'));
  assert.ok(!r.redactUrlsInText('//u:SEKRET@h/x', false).includes('SEKRET'));
  assert.ok(!r.redactUrlsInText('see https://ok/a and //u:SEKRET@h/x', false).includes('SEKRET'));
  assert.equal(r.redactUrlsInText('https://cdn.example/a//b', false), 'https://cdn.example/a//b');
  const col = { info: { name: 'T' }, item: [{ name: 'r', request: { method: 'GET', url: '//u:SEKRET@h/x', header: [{ key: 'Location', value: '//u:SEKRET@h/y' }] } }] };
  assertAbsent(col, ['SEKRET']);
});

test('literal Bearer/Basic credentials in free text are redacted, variables are kept', () => {
  assert.ok(!r.redactUrlsInText('Bearer SEKRET https://h', false).includes('SEKRET'));
  assert.ok(!r.redactUrlsInText('basic SEKRET', false).includes('SEKRET'));
  assert.equal(r.redactUrlsInText('Bearer {{tok}}', false), 'Bearer {{tok}}');
  const col = { info: { name: 'T' }, item: [{ name: 'r', request: { method: 'GET', url: 'http://h/x', header: [{ key: 'X-Note', value: 'sent Bearer SEKRET1 then Basic SEKRET2' }], response: [{ name: 'ok', code: 200, header: [{ key: 'X-Echo', value: 'Bearer SEKRET3' }], body: '' }] } }] };
  assertAbsent(col, ['SEKRET1', 'SEKRET2', 'SEKRET3']);
});

test('XML redaction: CDATA, mixed content, comments, namespaces and attributes', () => {
  const cases = [
    '<password><![CDATA[SEKRET]]></password>',
    '<password>a<![CDATA[SEKRET]]></password>',
    '<password>SEKRET<![CDATA[b]]>c</password>',
    '<password><!-- c -->SEKRET</password>',
    '<password>SEKRET<!-- c --></password>',
    '<password>SE<!-- c -->KRET</password>',
    '<ns:Token xmlns:ns="u">SEKRET</ns:Token>',
    '<a secret="SEKRET"/>',
    '<a x="1" apiKey=\'SEKRET\'>t</a>',
    '<root><user>u</user><password>\n  SEKRET\n</password></root>',
  ];
  for (const c of cases) {
    const out = r.redactBodyText(c, false);
    assert.ok(!out.includes('SEKRET'), `leaked in ${JSON.stringify(c)} -> ${out}`);
    assert.ok(out.includes('<redacted>'), `no placeholder in ${JSON.stringify(c)} -> ${out}`);
  }
  assert.equal(r.redactBodyText('<a><b>keep</b><password>{{pw}}</password></a>', false), '<a><b>keep</b><password>{{pw}}</password></a>');
  assert.equal(r.redactBodyText('<user>bob</user>', false), '<user>bob</user>');
  assert.ok(r.redactBodyText('<root><user>bob</user></root>', false).includes('bob'));
  const col = req('http://h/x', { body: { mode: 'raw', raw: '<r><password>a<![CDATA[SEKRET]]></password></r>', options: { raw: { language: 'xml' } } } });
  assertAbsent(col, ['SEKRET']);
});

test('{{ var }} templating in OpenAPI keeps its meaning after the regex hardening', () => {
  const tpl = (url) => JSON.parse(generateDocs({ info: { name: 'T' }, item: [{ name: 'r', request: { method: 'GET', url } }] }, { format: 'openapi', openapiFormat: 'json' }).content);
  const spec = tpl('http://h/{{ a b }}/{{a}}/{{ x }}');
  const key = Object.keys(spec.paths)[0];
  assert.equal(key, '/{a_b}/{a}/{x}');
});

test('malformed percent-encoded sensitive keys are redacted everywhere', () => {
  for (const k of ['api%2Dkey%E0', '%74oken%ZZ', 'pass%word%', 'a%E0pi%2Dkey', 'api+key%ZZ']) {
    const col = { info: { name: 'T' }, item: [
      { name: 'q', request: { method: 'POST', url: `http://h/x?${k}=SEKRET&ok=1`, header: [{ key: k, value: 'SEKRET' }], body: { mode: 'urlencoded', urlencoded: [{ key: k, value: 'SEKRET' }] } } },
      { name: 'b', request: { method: 'POST', url: 'http://h/y', body: { mode: 'raw', raw: `${k}=SEKRET&a=1`, options: { raw: { language: 'text' } } } } },
      { name: 'f', request: { method: 'POST', url: 'http://h/z', body: { mode: 'formdata', formdata: [{ key: k, value: 'SEKRET' }] } } },
    ] };
    assertAbsent(col, ['SEKRET']);
  }
  assert.equal(r.isSensitiveKey('%74oken%ZZ'), true);
  assert.equal(r.isSensitiveKey('api%2Dkey%E0'), true);
  assert.equal(r.isSensitiveKey('%2574oken'), false, 'double encoding is decoded once only');
  assert.equal(r.isSensitiveKey('name'), false);
});

test('an unrepresentable per-request auth does not inherit the root auth in OpenAPI', () => {
  const col = {
    info: { name: 'T' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{t}}' }] },
    item: [
      { name: 'rt', request: { method: 'GET', url: 'http://h/a', auth: { type: 'oauth2', oauth2: { grantType: 'refresh_token', clientId: 'c', clientSecret: 'CSSECRET', refreshToken: 'RTSECRET', tokenUrl: 'https://a/t' } } } },
      { name: 'inherit', request: { method: 'GET', url: 'http://h/b' } },
    ],
  };
  for (const openapiFormat of ['json', 'yaml']) {
    const res = generateDocs(col, { format: 'openapi', openapiFormat });
    assert.ok(!res.content.includes('RTSECRET'), 'refresh token leaked');
    assert.ok(!res.content.includes('CSSECRET'), 'client secret leaked');
    assert.ok(res.warnings.some(w => /rt/.test(w) && /security/.test(w)), `missing warning: ${res.warnings}`);
  }
  const spec = JSON.parse(generateDocs(col, { format: 'openapi', openapiFormat: 'json' }).content);
  assert.deepEqual(spec.paths['/a'].get.security, []);
  assert.equal(spec.paths['/b'].get.security, undefined);
  assert.ok(Array.isArray(spec.security) && spec.security.length === 1);
});

test('markdown links/images still render and a long data: image in HTML is kept', () => {
  const html = descDoc(`[link](https://e.com/x) ![pic](https://e.com/p.png)\n\n<img src="data:image/png;base64,${'A'.repeat(10000)}" alt="x">`);
  assert.ok(html.includes('<a href="https://e.com/x"'));
  assert.ok(html.includes('<img src="https://e.com/p.png"'));
  assert.ok(html.includes('<img src="data:image/png;base64,AAAA'), 'long data: image must be rendered');
  const long = descDoc(`<a href="https://e.com/${'p'.repeat(20000)}">go</a>`);
  assert.ok(long.includes(`href="https://e.com/${'p'.repeat(20000)}"`), 'long href must be rendered');
  assert.ok(!descDoc(`<a href="javascript:alert(1)" ${'x '.repeat(20000)}>z</a>`).includes('javascript:'));
});

test('markdown: backslash before backtick cannot break out of escaping', () => {
  const col = { info: { name: 'A\\`<b>' }, item: [] };
  const md = generateDocs(col, { format: 'markdown' }).content;
  assert.ok(md.includes('A\\\\\\`&lt;b&gt;'), md.split('\n')[0]);
});

test('redactJsonLike (invalid JSON): everything under a sensitive key is redacted, variables kept', () => {
  const cases = [
    ['{"tokens":[ 1 , 2 ,  true,\n"SEKRET",[ 3,[ 4 ]],{"n":"SEKRET2"}] bad', ['SEKRET', 'SEKRET2']],
    ['{"password":{"a":"SEKRET","b":[1,{"c":"SEKRET2"}]} bad', ['SEKRET', 'SEKRET2']],
    ['{"a": {"secret": "SEKRET"} bad', ['SEKRET']],
    ['{"password":"SEKRET unterminated', ['SEKRET']],
    ['{"token": SEKRET, "x":1 bad', ['SEKRET']],
    ['{"tokens":[,,SEKRET,  ,"SEKRET2"] bad', ['SEKRET', 'SEKRET2']],
  ];
  for (const [text, secrets] of cases) {
    const out = r.redactBodyText(text, false);
    for (const s of secrets) assert.ok(!out.includes(s), `${s} leaked: ${JSON.stringify(text)} -> ${out}`);
    assert.ok(out.includes('<redacted>'), out);
  }
  assert.equal(r.redactBodyText('{"tokens":[{{a}}, "{{b}}", "", null] bad', false), '{"tokens":[{{a}}, "{{b}}", "", null] bad');
  assert.equal(r.redactBodyText('{"user":"bob","n":[1,2] bad', false), '{"user":"bob","n":[1,2] bad');
});

test('redactJsonLike: adversarial whitespace/comma/bracket variants stay linear and leak nothing', () => {
  const big = 200000;
  const inputs = {
    spaces: `{"tokens":[${' '.repeat(big)}SEKRET]`,
    commas: `{"tokens":[${',  '.repeat(big / 3)}SEKRET]`,
    nested: `{"tokens":${'[ '.repeat(big / 2)}SEKRET`,
    repeated: `{${'"tokens":[1,'.repeat(big / 14)}SEKRET`,
  };
  for (const [label, text] of Object.entries(inputs)) {
    const out = within(`json-like ${label}`, 750, () => r.redactBodyText(text, false));
    assert.ok(!out.includes('SEKRET'), `${label} leaked the secret`);
  }
});

test('redactJsonLike: Unicode whitespace between key, colon and value cannot hide a secret', () => {
  const spaces = [' ', ' ', '\u000b', ' ', ' ', '﻿', '　', ' '];
  for (const ws of spaces) {
    const label = `U+${ws.charCodeAt(0).toString(16)}`;
    for (const text of [
      `{"token"${ws}:"SEKRET"}`,
      `{"token":${ws}"SEKRET"}`,
      `{"token"${ws}:${ws}"SEKRET"${ws},"b":"keep"}`,
      `{"token":${ws}SEKRET${ws}}`,
      `{"token":${ws}["SEKRET"${ws},${ws}"SEKRET"]${ws}`,
      `{"token":${ws}SEKRET,"b":"keep"`,
    ]) {
      const out = r.redactBodyText(text, false);
      assert.ok(!out.includes('SEKRET'), `${label} leaked: ${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
      assert.ok(out.includes('<redacted>'), `${label}: ${JSON.stringify(out)}`);
    }
  }
  // a non-secret sibling after a Unicode space is untouched
  assert.ok(r.redactBodyText('{"token": "SEKRET","b": "keep"', false).includes('"b": "keep"'));
});

test('redactJsonLike: comments between key, colon and value cannot hide a secret', () => {
  const cases = [
    '{"token":/*c*/"SEKRET","b":"keep"}',
    '{"token":/* a */["SEKRET"]}',
    '{"token": // c\n "SEKRET"}',
    '{"token"/*c*/:"SEKRET"}',
    '{"token"// c\n:"SEKRET"}',
    '{"token"/*a*/:/*b*/ /*c*/ ["SEKRET", /*d*/ "SEKRET"] bad',
    '{"token":/*c*/ SEKRET, "b":"keep"}',
    '{"token":/*c*/{"a":"SEKRET"} bad',
    '{"token":/* unterminated "SEKRET"',
    '{"a":1, // note\n "token":/*c*/"SEKRET"}',
  ];
  for (const text of cases) {
    const out = r.redactBodyText(text, false);
    assert.ok(!out.includes('SEKRET'), `leaked: ${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
  }
  const keep = r.redactBodyText('{"token":/*c*/"SEKRET","b":"keep"}', false);
  assert.ok(keep.includes('"b":"keep"'), keep);
});

test('redactJsonLike: an orphan or missing quote cannot shift the string parity and hide a key', () => {
  const cases = [
    '{user":"bob","password":"SEKRET"}',
    '{"note":"it"s","password":"SEKRET","token":"T0K"}',
    '{"name":"a,"password":"SEKRET","x":1}',
    '{"name":"a\\","password":"SEKRET"}',
    '{"a":"unterminated, "password":"SEKRET"}',
    '{"a":1,"b":"x"y","token":"T0K"}',
    '{"user":"bob,"password":"SEKRET"}',
    '{"a":""","password":"SEKRET"}',
  ];
  for (const text of cases) {
    const out = r.redactBodyText(text, false);
    for (const s of ['SEKRET', 'T0K']) assert.ok(!out.includes(s), `${s} leaked: ${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
  }
  assert.ok(!r.redactBodyText("{'password':'SEKRET'}", false).includes('SEKRET'));
  assert.ok(!r.redactBodyText('{password:"SEKRET"}', false).includes('SEKRET'));
});

test('redactJsonLike: percent-encoded sensitive keys are recognised in invalid JSON too', () => {
  for (const text of ['{"tok%65n":"SEKRET"', '{"tok%65n":"SEKRET",}', '{"a":1,"%70assword":["SEKRET"] bad', '{"api%2Dkey":SEKRET,}']) {
    const out = r.redactBodyText(text, false);
    assert.ok(!out.includes('SEKRET'), `leaked: ${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
  }
  // valid JSON path agrees
  assert.ok(!r.redactBodyText('{"tok%65n":"SEKRET"}', false).includes('SEKRET'));
});

test('redactJsonLike: quote-heavy adversarial input stays linear', () => {
  const n = 150000;
  const inputs = {
    'quotes only': '"'.repeat(n),
    'key quotes': `{"password":${'"'.repeat(n)}`,
    'orphan keys': `{${'a":"b",'.repeat(n / 8)}"password":"SEKRET"`,
    'sensitive keys': `{${'"token"'.repeat(n / 8)}:`,
    'sensitive pairs': `{${'a"token":1,'.repeat(n / 12)}`,
    'comments': `{"a"${'/*'.repeat(n / 2)}`,
    'comments closed': `{${'"a"/*'.repeat(n / 6)}*/}`,
    'line comments': `{"token":${'//\n'.repeat(n / 3)}"SEKRET"`,
  };
  for (const [label, text] of Object.entries(inputs)) {
    const out = within(`json-like ${label}`, 1500, () => r.redactBodyText(text, false));
    assert.ok(!out.includes('SEKRET'), `${label} leaked`);
  }
});

test('markdown and HTML: a very long <img> attribute is linear (no quadratic regex)', () => {
  const big = 200000;
  const inputs = {
    'a x200000': '<img ' + 'a'.repeat(big) + '>',
    'a- x100000': '<img ' + 'a-'.repeat(big / 2) + '>',
    'a  x100000': '<img ' + 'a '.repeat(big / 2) + '>',
    'a= x100000': '<img ' + 'a='.repeat(big / 2) + '>',
    'a=" x66666': '<img ' + 'a="'.repeat(big / 3) + '>',
    "a=' x66666": "<img " + "a='".repeat(big / 3) + '>',
    'many tags': '<img a '.repeat(big / 7),
    'src then junk': '<img src="https://h/x.png" ' + 'b-'.repeat(big / 2) + '>',
  };
  for (const [label, description] of Object.entries(inputs)) {
    const doc = { info: { name: 'T', description }, item: [] };
    within(`markdown ${label}`, 1500, () => generateDocs(doc, { format: 'markdown' }));
    for (const renderImages of [true, false]) {
      within(`html(${renderImages}) ${label}`, 1500, () => generateDocs(doc, { format: 'html', renderImages }));
    }
  }
  const ok = generateDocs({ info: { name: 'T', description: '<img src="https://h/x.png" ' + 'b-'.repeat(1000) + ' alt="ok">' }, item: [] }, { format: 'markdown' }).content;
  assert.match(ok, /!\[ok\]\(https:\/\/h\/x\.png\)/);
});

test('renderImages=false: images inside links never produce nested anchors', () => {
  const descs = [
    '[![build](https://img.shields.io/b.svg)](https://ci.example/run)',
    '<a href="https://ci.example/run"><img src="https://img.shields.io/b.svg" alt="build"></a>',
    '<a href="https://ci.example/run">![build](https://img.shields.io/b.svg)</a>',
    '[![](https://img.shields.io/b.svg)](https://ci.example/run)',
  ];
  for (const description of descs) {
    for (const renderImages of [true, false]) {
      const out = generateDocs({ info: { name: 'T', description }, item: [] }, { format: 'html', renderImages }).content;
      const main = out.split('<main>')[1].split('</main>')[0];
      assert.ok(!/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/.test(main), `nested <a> (renderImages=${renderImages}): ${description} -> ${main}`);
      assert.equal((main.match(/<a /g) || []).length, 1, `exactly one link (renderImages=${renderImages}): ${main}`);
      assert.match(main, /<a href="https:\/\/ci\.example\/run" rel="noopener noreferrer nofollow">/, 'outer link target kept');
      if (renderImages) assert.match(main, /<img src="https:\/\/img\.shields\.io\/b\.svg"/);
      else assert.ok(!/<img\b/.test(main));
    }
  }
});

test('img alt attributes: entities are not double-escaped and code placeholders do not leak', () => {
  const desc = '<img src="https://h/a.png" alt="a&quot;b&amp;c"> <img src="https://h/b.png" alt="`tick`">';
  const on = generateDocs({ info: { name: 'T', description: desc }, item: [] }, { format: 'html' }).content;
  assert.match(on, /<img src="https:\/\/h\/a\.png" alt="a&quot;b&amp;c">/);
  assert.ok(!/&amp;quot;|&amp;amp;/.test(on), 'no double escaping');
  assert.ok(!/alt="[^"]*[\u0000-\u0002]/.test(on) && !/alt=" 0 "/.test(on), 'no placeholder in alt');
  assert.match(on, /<img src="https:\/\/h\/b\.png" alt="tick">/);
  const off = generateDocs({ info: { name: 'T', description: desc }, item: [] }, { format: 'html', renderImages: false }).content;
  assert.ok(!/&amp;quot;|&amp;amp;/.test(off));
  assert.ok(!/[\u0000-\u0002]/.test(off.split('<main>')[1]));
  const md = generateDocs({ info: { name: 'T', description: desc }, item: [] }, { format: 'markdown' }).content;
  assert.match(md, /!\[a"b&amp;c\]\(https:\/\/h\/a\.png\)/);
});
