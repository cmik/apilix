'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateDocs } = require('../src/docs');
const { fence } = require('../src/docs/doc-markdown');
const { makeCollection, SECRETS } = require('./docs-fixtures');

const snippetLanguages = [{ id: 'curl', label: 'cURL', generate: r => `curl -X ${r.method} '${r.fullUrl}'` }];

test('markdown renders structure, tables, examples and snippets', () => {
  const r = generateDocs(makeCollection(), { format: 'markdown', snippetLanguages: ['curl'] }, { snippetLanguages });
  assert.equal(r.extension, 'md');
  assert.match(r.content, /^# Demo &lt;API&gt;/);
  assert.match(r.content, /## Users/);
  assert.match(r.content, /### Get user/);
  assert.match(r.content, /`GET \{\{baseUrl\}\}\/users\/:id\?token=<redacted>&page=1`/);
  assert.match(r.content, /\| Name \| Value \|/);
  assert.match(r.content, /\*\*Example: Found\*\* \(200 OK\)/);
  assert.match(r.content, /curl -X GET/);
});

test('markdown never leaks credentials', () => {
  const r = generateDocs(makeCollection(), { format: 'markdown' });
  for (const s of SECRETS) assert.ok(!r.content.includes(s), `${s} leaked`);
});

test('markdown is deterministic and escapes table pipes', () => {
  const col = makeCollection();
  col.item[0].item[0].request.header.push({ key: 'X-Pipe', value: 'a|b\nc' });
  const a = generateDocs(col, { format: 'markdown' }).content;
  assert.equal(a, generateDocs(col, { format: 'markdown' }).content);
  assert.match(a, /a\\\|b<br>c/);
});

test('fence is longer than any backtick run in the content', () => {
  assert.ok(fence('x ```` y', '').startsWith('`````\n'));
  assert.ok(fence('plain', 'json').startsWith('```json\n'));
});

test('unknown snippet language yields a warning', () => {
  const r = generateDocs(makeCollection(), { format: 'markdown', snippetLanguages: ['nope'] }, { snippetLanguages });
  assert.ok(r.warnings.some(w => /Unknown snippet language/.test(w)));
});

test('failing snippet generator is reported, not thrown', () => {
  const bad = [{ id: 'bad', label: 'Bad', generate: () => { throw new Error('boom'); } }];
  const r = generateDocs(makeCollection(), { format: 'markdown', snippetLanguages: ['bad'] }, { snippetLanguages: bad });
  assert.ok(r.warnings.some(w => /boom/.test(w)));
});

test('unsupported format throws', () => {
  assert.throws(() => generateDocs(makeCollection(), { format: 'pdf' }), /Unsupported docs format/);
});

test('markdown and OpenAPI exports keep images regardless of renderImages', () => {
  const col = makeCollection();
  const desc = 'A ![alt](https://img.test/a.png) B <img src="https://img.test/b.png" alt="bee" width="5" onerror="x()"> C ![d](data:image/png;base64,AAAA) <img src="javascript:alert(1)">';
  col.item[0].item[0].request.description = desc;
  for (const renderImages of [undefined, true, false]) {
    const md = generateDocs(col, { format: 'markdown', renderImages }).content;
    assert.match(md, /!\[alt\]\(https:\/\/img\.test\/a\.png\)/);
    assert.match(md, /!\[bee\]\(https:\/\/img\.test\/b\.png\)/, '<img> becomes a markdown image');
    assert.match(md, /!\[d\]\(data:image\/png;base64,AAAA\)/);
    assert.ok(!/<img/i.test(md) && !/onerror/.test(md.replace(/&lt;[^\n]*/g, '')));
    assert.match(md, /&lt;img src="javascript:alert\(1\)"&gt;/);
    for (const openapiFormat of ['json', 'yaml']) {
      const r = generateDocs(col, { format: 'openapi', openapiFormat, renderImages });
      const op = Object.values(r.spec.paths).flatMap(p => Object.values(p)).find(o => /img\.test\/a\.png/.test(o.description || ''));
      assert.ok(op, 'operation found');
      assert.match(op.description, /!\[alt\]\(https:\/\/img\.test\/a\.png\)/);
      assert.match(op.description, /<img src="https:\/\/img\.test\/b\.png" alt="bee"/);
      assert.match(op.description, /!\[d\]\(data:image\/png;base64,AAAA\)/);
      assert.match(r.content, /https:\/\/img\.test\/a\.png/);
      assert.match(r.content, /https:\/\/img\.test\/b\.png/);
    }
  }
});
