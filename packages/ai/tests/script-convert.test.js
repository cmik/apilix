'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { convertPmToApx, maskNonCode } = require('../src/script-convert');

const conv = (code) => convertPmToApx(code);

test('pm -> apx rename and legacy rewrites (table)', () => {
  const cases = [
    ['plain test', "pm.test('ok', () => { pm.expect(pm.response.code).to.equal(200); });", "apx.test('ok', () => { apx.expect(apx.response.code).to.equal(200); });"],
    ['environment', "pm.environment.set('t', pm.response.json().token);", "apx.environment.set('t', apx.response.json().token);"],
    ['variables and collectionVariables', "pm.variables.get('a'); pm.collectionVariables.set('b', 1);", "apx.variables.get('a'); apx.collectionVariables.set('b', 1);"],
    ['headers', "pm.response.headers.get('Content-Type')", "apx.response.headers.get('Content-Type')"],
    ['status assertion', 'pm.response.to.have.status(201);', 'apx.response.to.have.status(201);'],
    ['spacing around the dot', 'pm . environment . get("x")', 'apx . environment . get("x")'],
    ['legacy setEnvironmentVariable', "postman.setEnvironmentVariable('a', 'b');", "apx.environment.set('a', 'b');"],
    ['legacy getEnvironmentVariable', "var x = postman.getEnvironmentVariable('a');", "var x = apx.environment.get('a');"],
    ['legacy clearEnvironmentVariable', "postman.clearEnvironmentVariable('a');", "apx.environment.unset('a');"],
    ['legacy globals', "postman.setGlobalVariable('g', 1); postman.getGlobalVariable('g'); postman.clearGlobalVariable('g');", "apx.globals.set('g', 1); apx.globals.get('g'); apx.globals.unset('g');"],
    ['legacy responseBody', 'var j = JSON.parse(responseBody);', 'var j = JSON.parse(apx.response.text());'],
    ['legacy responseCode', 'if (responseCode.code === 200) {}', 'if (apx.response.code === 200) {}'],
    ['legacy tests[]', 'tests["Status is 200"] = responseCode.code === 200;', 'apx.test("Status is 200", function () { apx.expect(apx.response.code === 200).to.be.ok; });'],
    ["legacy tests[''] single quotes, CRLF kept", "tests['x'] = a > 1;\r\n", "apx.test(\"x\", function () { apx.expect(a > 1).to.be.ok; });\r\n"],
    ['pm inside an interpolation is code', 'const s = `v=${pm.response.code}`;', 'const s = `v=${apx.response.code}`;'],
  ];
  for (const [name, input, expected] of cases) {
    const r = conv(input);
    assert.equal(r.script, expected, name);
    assert.deepEqual(r.remaining, [], `${name}: nothing should remain`);
    assert.equal(r.changed, true, name);
  }
});

test('strings, comments, regular expressions and property names are left alone', () => {
  const input = [
    "const a = 'pm.environment.get(x)';",
    '// pm.test("commented")',
    '/* pm.expect */',
    'const re = /pm\\.x/;',
    'const t = `pm.y ${1}`;',
    'const o = { pm: 1 }; o.pm; other.pm.x;',
  ].join('\n');
  const r = conv(input);
  assert.equal(r.script, input);
  assert.equal(r.changed, false);
  assert.equal(r.renamed, 0);
});

test('legacy rewrites are counted apart from the pm rename', () => {
  const r = conv("postman.setEnvironmentVariable('a', 1);\ntests['t'] = responseCode.code === 200;\npm.test('x', () => {});");
  assert.equal(r.legacy, 3);
  assert.equal(r.renamed, 1);
  assert.equal(conv("postman.unknownThing('a');").script, "postman.unknownThing('a');");
});

test('code inside a template interpolation is converted, the template text around it is not', () => {
  const r = conv("const s = `a ${ fn(() => { return 1; }, pm.response.code) } pm.text ${pm.info.iteration}`; pm.test('z', () => {});");
  assert.equal(r.script, "const s = `a ${ fn(() => { return 1; }, apx.response.code) } pm.text ${apx.info.iteration}`; apx.test('z', () => {});");
});

test('a script that already uses apx is unchanged', () => {
  const input = "apx.test('x', () => { apx.expect(apx.response.code).to.equal(200); });";
  const r = conv(input);
  assert.equal(r.script, input);
  assert.equal(r.changed, false);
  assert.deepEqual(r.remaining, []);
});

test('members apx does not have are reported, never guessed, with their line', () => {
  const r = conv(["pm.test('a', () => {});", "const c = pm.cookies.get('sid');", "pm.request.headers.add({ key: 'a', value: 'b' });", "pm.info.requestName;", "pm.expect(1).to.have.jsonSchema({});", "pm.response.to.have.jsonSchema({});", "pm.visualizer.set('x');"].join('\n'));
  const byPath = Object.fromEntries(r.remaining.map(x => [x.path, x.line]));
  assert.deepEqual(byPath, {
    'apx.cookies': 2,
    'apx.request.headers.add': 3,
    'apx.info.requestName': 4,
    'apx.expect(...).jsonSchema': 5,
    'apx.response.to.have.jsonSchema': 6,
    'apx.visualizer': 7,
  });
  assert.ok(r.script.includes('apx.cookies.get'), 'the member is renamed, the report says it is missing');
});

test('supported members, including assertion chains and call arguments, are not reported', () => {
  const r = conv("pm.expect(pm.response.json().items).to.be.an('array').that.is.not.empty;\npm.expect(a).to.have.lengthOf(3).and.to.be.above(1);\npm.expect({a:1}).to.deep.equal({a:1});\npm.test.skip('later');\npm.response.size;\npm.info.iteration;");
  assert.deepEqual(r.remaining, []);
});

test('a script that declares its own pm or apx is not touched', () => {
  const input = 'const pm = { x: 1 }; pm.x;';
  const r = conv(input);
  assert.equal(r.script, input);
  assert.equal(r.changed, false);
  assert.equal(r.remaining.length, 1);
  assert.match(r.remaining[0].reason, /declares its own/);
});

test('non-string input and an empty script are safe', () => {
  for (const v of [undefined, null, 5, '']) assert.deepEqual(conv(v), { script: '', changed: false, renamed: 0, legacy: 0, remaining: [] });
});

test('the converted script compiles and its tests run in the real script runtime', async () => {
  const { runScript } = require('@apilix/core/script-runtime');
  const r = conv("pm.test('code', () => { pm.expect(pm.response.code).to.equal(200); });\ntests['legacy'] = responseCode.code === 200;\npostman.setEnvironmentVariable('k', 'v');");
  assert.deepEqual(r.remaining, []);
  const res = await runScript(r.script, { code: 200, status: 'OK', responseTime: 1, headers: {}, body: '{}', jsonData: {} }, {});
  assert.deepEqual(res.tests.map(t => [t.name, t.passed]), [['code', true], ['legacy', true]]);
  assert.equal(res.updatedEnvMutations.k, 'v');
});

test('maskNonCode keeps length and newlines and blanks strings, comments, regexes and template text', () => {
  const src = "a('x'); // c\nb(`t${pm}u`); /re/.test(q); d / 2 / e";
  const m = maskNonCode(src);
  assert.equal(m.length, src.length);
  assert.equal(m.split('\n').length, 2);
  assert.ok(!m.includes("'x'") && !m.includes('// c') && !m.includes('/re/') && !m.includes('t$') && m.includes('pm') && m.includes('d / 2 / e'));
});

test('hostile input does not hang the converter (linear scan)', () => {
  const t = Date.now();
  conv('pm.'.repeat(20000) + '`${'.repeat(2000) + "'".repeat(5000));
  assert.ok(Date.now() - t < 2000);
});
