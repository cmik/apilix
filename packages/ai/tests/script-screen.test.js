'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { screenScript } = require('../src/script-screen');
const { dryRunScript } = require('../src/dry-run');

const ok = (code) => assert.deepEqual(screenScript(code), { ok: true }, code);
const refused = (code) => assert.equal(screenScript(code).ok, false, `should refuse: ${code}`);

test('ordinary apx assertions pass the screen', () => {
  ok(`apx.test("Status is 200", () => {\n  apx.expect(apx.response.code).to.equal(200);\n});`);
  ok(`apx.test("items", () => {\n  const json = apx.response.json();\n  apx.expect(json.items).to.be.an('array');\n  apx.expect(json.items[0].id).to.match(/^[0-9a-f-]{36}$/i);\n  apx.expect(json.items[json.items.length - 1]).to.be.an('object');\n  apx.expect(['a', 'b']).to.include(json.status);\n  const total = json.items.reduce((s, i) => s + i.price, 0);\n  apx.expect(json.total).to.equal(total);\n  apx.expect(Object.keys(json)).to.include('items');\n  const [first] = json.items;\n  apx.expect(Array.isArray(json.items)).to.equal(true);\n  apx.expect(\`n=\${json.items.length}\`).to.be.a('string');\n});`);
  ok(`apx.environment.set("id", apx.response.json().id);`);
});

test('sandbox escapes through constructors are refused', () => {
  refused(`apx.test('x', () => { apx.test.constructor('return process')(); });`);
  refused(`apx.test('x', () => { Object['constructor']('return process')(); });`);
  refused(`apx.test('x', () => { const k = 'con' + 'structor'; Object[k]('return process')(); });`);
  refused(`const k = ['con','structor'].join(''); apx.test[k]('return process')();`);
  refused(`apx.test('x', () => { Object[\`con\${'structor'}\`]; });`);
  refused(`const {['con'+'structor']: F} = apx.test;`);
  refused(`const {constructor: F} = apx.test;`);
  refused(`apx.test('x', () => { (() => {}).constructor('return process')(); });`);
  refused(`apx.test('x', () => { Object['\\x63onstructor']; });`);
  refused(`apx.test('x', () => { this.process; });`);
  refused(`apx.test('x', () => { globalThis.process; });`);
  refused(`apx.test('x', () => { eval('1'); });`);
  refused(`apx.test('x', () => { new Function('return 1')(); });`);
  refused(`apx.test('x', () => { Error.prepareStackTrace = () => 1; });`);
  refused(`apx.test('x', () => { x.__proto__.polluted = 1; });`);
  refused(`apx.test('x', () => { import('fs'); });`);
});

test('built-ins cannot be aliased or modified', () => {
  refused(`const O = Object; O.keys = () => 1;`);
  refused(`Object.keys = () => [];`);
  refused(`JSON.parse = () => 1;`);
  refused(`Math.random += 1;`);
  refused(`const { parse } = JSON;`);
  refused(`Object.assign(Object, { a: 1 });`);
  refused(`Object.defineProperty(Object, 'a', { value: 1 });`);
});

test('network and flow-control APIs are refused', () => {
  refused(`apx.sendRequest('http://example.com');`);
  refused(`apx.execution.setNextRequest('x');`);
  refused(`fetch('http://example.com');`);
});

test('unterminated or oversized input is refused, never thrown', () => {
  refused(`apx.test('x`);
  refused('`abc');
  refused('/* never closed');
  refused('x'.repeat(13000));
  refused(null);
});

test('dry-run: a passing test runs on the response, a failing one is reported', async () => {
  const response = { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'a', items: [1, 2] }), responseTime: 10 };
  const pass = await dryRunScript(`apx.test('ok', () => { apx.expect(apx.response.json().items).to.have.lengthOf(2); });`, { response, expects: 'test' });
  assert.equal(pass.ok, true, pass.reason);
  const bad = await dryRunScript(`apx.test('ko', () => { apx.expect(apx.response.json().items).to.have.lengthOf(3); });`, { response, expects: 'test' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /ko/);
  const none = await dryRunScript(`const a = 1;`, { response, expects: 'test' });
  assert.equal(none.ok, false);
  const syntax = await dryRunScript(`apx.test('x', () => {`, { response });
  assert.equal(syntax.ok, false);
  assert.match(syntax.reason, /syntax/);
});

test('dry-run: captures must save a real value', async () => {
  const response = { status: 200, headers: {}, body: JSON.stringify({ id: 'abc' }) };
  assert.equal((await dryRunScript(`apx.environment.set('id', apx.response.json().id);`, { response, expects: 'capture' })).ok, true);
  assert.equal((await dryRunScript(`apx.environment.set('id', apx.response.json().missing);`, { response, expects: 'capture' })).ok, false);
});

test('dry-run: loops and hung promises do not hang the server', async () => {
  const started = Date.now();
  const r1 = await dryRunScript(`while (true) {}`, { response: { status: 200, body: '' } });
  const r2 = await dryRunScript(`await new Promise(() => {});`, { response: { status: 200, body: '' } });
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, false);
  assert.ok(Date.now() - started < 10000);
});

test('dry-run: a refused script is not executed', async () => {
  globalThis.__DRY_RUN_CANARY__ = 0;
  const r = await dryRunScript(`apx.test('x', () => { Object['constructor']('return 1')(); });`, { response: { status: 200, body: '' } });
  assert.equal(r.ok, false);
  assert.equal(globalThis.__DRY_RUN_CANARY__, 0);
});

test('lenient mode tolerates a stand-in mismatch but not a broken script', async () => {
  const response = { status: 200, headers: {}, body: '{}' };
  const mismatch = await dryRunScript(`apx.test('s', () => { apx.expect(apx.response.code).to.equal(201); apx.expect(apx.response.json().data.id).to.be.a('string'); });`, { response, mode: 'lenient' });
  assert.equal(mismatch.ok, true, mismatch.reason);
  const unknown = await dryRunScript(`apx.test('s', () => { apx.response.jsno(); });`, { response, mode: 'lenient' });
  assert.equal(unknown.ok, false);
  const undefinedVar = await dryRunScript(`apx.test('s', () => { expect(1).to.equal(1); });`, { response, mode: 'lenient' });
  assert.equal(undefinedVar.ok, false);
  const syntax = await dryRunScript(`apx.test('s', () => {`, { response, mode: 'lenient' });
  assert.equal(syntax.ok, false);
});
