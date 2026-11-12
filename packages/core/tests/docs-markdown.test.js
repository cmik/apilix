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
