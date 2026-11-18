'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { maskScriptLiterals } = require('../src/script-mask');
const { scriptAssist, describeScriptAssist } = require('../src/script-assist');

const fake = (answer, calls = []) => ({ calls, complete: async (req) => { calls.push(req); return { data: answer, usage: { inputTokens: 1, outputTokens: 1 }, model: 'm', latencyMs: 1 }; } });

test('maskScriptLiterals: strings, numbers, templates, regexes and comments go; structure stays (table)', () => {
  const cases = [
    ["apx.expect(apx.response.json().name).to.equal('Alice Martin');", 'apx.expect(apx.response.json().name).to.equal("<string>");'],
    ['apx.expect(apx.response.code).to.equal(201);', 'apx.expect(apx.response.code).to.equal(<number>);'],
    ['const id = "u-98765"; const n = 3.14;', 'const id = "<string>"; const n = <number>;'],
    ['x = `hello ${user.name} bye`;', 'x = `<string>${user.name}<string>`;'],
    ['if (/alice@corp\\.com/.test(s)) {}', 'if (/<regex>/.test(s)) {}'],
    ['a = b / c / d;', 'a = b / c / d;'],
    ['f(1); // secret note 42\ng(2); /* more 7 */ h()', 'f(<number>); \ng(<number>);   h()'],
    ["apx.test('it\\'s \"ok\"', () => {});", 'apx.test("<string>", () => {});'],
    ['const o = { id: 42, tags: ["a", "b"] };', 'const o = { id: <number>, tags: ["<string>", "<string>"] };'],
    ['a1 = b2 + c_3;', 'a1 = b2 + c_3;'],
  ];
  for (const [input, expected] of cases) assert.equal(maskScriptLiterals(input), expected, input);
});

test('maskScriptLiterals tolerates garbage and is linear on hostile input', () => {
  for (const v of [undefined, null, 5, '']) assert.equal(maskScriptLiterals(v), '');
  const t = Date.now();
  maskScriptLiterals(`'${'\\n'.repeat(20000)}`);
  maskScriptLiterals('`${'.repeat(5000));
  maskScriptLiterals('/'.repeat(20000));
  assert.ok(Date.now() - t < 1500);
});

const SCRIPT = "apx.test('user is Alice', () => { apx.expect(apx.response.json().email).to.equal('alice@corp.com'); apx.expect(apx.response.json().balance).to.equal(1234.5); }); // customer 98765";

test('shape-only: no literal of the script reaches the provider or the preview; normal mode still sends it', async () => {
  for (const mode of ['explain', 'fix', 'generate', 'convert']) {
    // convert needs something apx lacks, otherwise it is fully deterministic and no model is called
    const script = mode === 'convert' ? `${SCRIPT.replaceAll('apx.', 'pm.')}\nconst c = pm.cookies.get("sid");` : SCRIPT;
    const input = { mode, kind: 'test', script, error: 'boom', instruction: 'add a check' };
    const shape = fake({ explanation: 'ok', script: 'apx.test("x", () => {});' });
    await scriptAssist({ provider: shape, ...input, sendResponseBodies: false });
    const full = fake({ explanation: 'ok', script: 'apx.test("x", () => {});' });
    await scriptAssist({ provider: full, ...input, sendResponseBodies: true });
    assert.equal(shape.calls.length, 1, mode);
    const sent = JSON.stringify(shape.calls[0]);
    for (const leaked of ['Alice', 'alice@corp.com', '1234', '98765']) assert.ok(!sent.includes(leaked), `${mode}: leaked ${leaked}`);
    const shown = describeScriptAssist({ ...input, sendResponseBodies: false }).sections.map(s => s.text).join('\n');
    for (const leaked of ['Alice', 'alice@corp.com', '1234', '98765']) assert.ok(!shown.includes(leaked), `${mode} preview: leaked ${leaked}`);
    assert.match(JSON.stringify(full.calls[0]), /alice@corp\.com/, `${mode}: normal mode keeps the literals`);
    assert.match(describeScriptAssist({ ...input, sendResponseBodies: true }).sections.map(s => s.text).join('\n'), /alice@corp\.com/);
  }
});

test('shape-only: the preview is exactly the data block of the payload', async () => {
  const input = { mode: 'fix', script: SCRIPT, error: "expected 'Alice' to equal 'Bob'", variableNames: ['token'] };
  const provider = fake({ explanation: 'ok', script: 'apx.test("x", () => {});' });
  await scriptAssist({ provider, ...input, sendResponseBodies: false });
  const block = describeScriptAssist({ ...input, sendResponseBodies: false }).sections.find(s => /as sent/.test(s.label)).text;
  assert.ok(provider.calls[0].messages[0].content.includes(block));
});

test('shape-only: a proposal built from the masked copy is flagged and never counts as validated when placeholders remain', async () => {
  const withPlaceholder = fake({ explanation: 'Fixed.', script: 'apx.test("x", () => { apx.expect(apx.response.json().a).to.equal("<string>"); });' });
  const r = await scriptAssist({ provider: withPlaceholder, mode: 'fix', script: SCRIPT, error: 'boom', sendResponseBodies: false });
  assert.equal(r.maskedInput, true);
  assert.equal(r.validation.validated, false);
  assert.ok(r.warnings.some(w => /placeholders/.test(w)));
  assert.ok(r.warnings.some(w => /only saw your script/.test(w)));
  const clean = fake({ explanation: 'Fixed.', script: 'apx.test("x", () => { apx.expect(1).to.equal(1); });' });
  const r2 = await scriptAssist({ provider: clean, mode: 'fix', script: SCRIPT, error: 'boom', sendResponseBodies: false });
  assert.equal(r2.maskedInput, true);
  assert.ok(r2.warnings.some(w => /only saw your script/.test(w)));
  const normal = await scriptAssist({ provider: fake({ explanation: 'Fixed.', script: 'apx.test("x", () => { apx.expect(1).to.equal(1); });' }), mode: 'fix', script: SCRIPT, error: 'boom' });
  assert.equal(normal.maskedInput, false);
  assert.equal(normal.validation.validated, true);
  const noLiterals = await scriptAssist({ provider: fake({ explanation: 'x', script: 'apx.test("x", () => {});' }), mode: 'fix', script: 'apx.test(x, () => {});', error: 'boom', sendResponseBodies: false });
  assert.equal(noLiterals.maskedInput, false);
});

test('shape-only convert: a refused model rewrite falls back to the real converted script, never the masked copy', async () => {
  const evil = fake({ explanation: 'x', script: "require('fs');" });
  const r = await scriptAssist({ provider: evil, mode: 'convert', script: "pm.test('Alice', () => { pm.cookies.get('sid'); });", sendResponseBodies: false });
  assert.match(r.script, /Alice/);
  assert.ok(!/<string>/.test(r.script));
});

test('the regex-literal scan is bounded: an unclosed /[ run is not rescanned from every slash', () => {
  const hostile = '=/['.repeat(20000);
  const t = Date.now();
  maskScriptLiterals(hostile);
  assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
  assert.equal(maskScriptLiterals('x = /ab+c/g.test(s);'), 'x = /<regex>/.test(s);');
});
