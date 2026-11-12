'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateDocs } = require('../src/docs');
const { esc, renderMarkdownSafe } = require('../src/docs/doc-html');
const { makeCollection, SECRETS } = require('./docs-fixtures');

const html = (opts, col = makeCollection()) => generateDocs(col, Object.assign({ format: 'html' }, opts)).content;

test('esc escapes all dangerous characters', () => {
  assert.equal(esc(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
});

test('XSS payloads in names, descriptions, urls, bodies and examples are neutralised', () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(1)>"\'';
  const col = makeCollection();
  col.info.name = evil;
  col.item[0].name = evil;
  col.item[0].item[0].name = evil;
  col.item[0].item[0].request.url = { raw: `https://x.test/${evil}?q=${evil}` };
  col.item[0].item[0].request.header.push({ key: evil, value: evil });
  col.item[0].item[0].response[0].body = evil;
  col.item[0].item[0].response[0].name = evil;
  const out = html({}, col);
  assert.ok(!/<script/i.test(out), 'no script element');
  assert.ok(!/<img/i.test(out), 'no img element');
  assert.ok(!/\sonerror=/i.test(out.replace(/&lt;[^>]*&gt;/g, '')) || !/<[^>]*\sonerror=/i.test(out));
  assert.ok(out.includes('&lt;script&gt;'));
});

test('markdown descriptions: unsafe links dropped, raw html escaped', () => {
  const out = html({});
  assert.ok(!/href="javascript:/i.test(out));
  assert.ok(out.includes('<a href="https://example.com/x?a=1&amp;b=2"'));
  assert.ok(out.includes('<strong>bold</strong>'));
  assert.ok(!out.includes('<script>alert(1)</script>'));
});

test('renderMarkdownSafe handles lists, fences and escapes inside code', () => {
  const out = renderMarkdownSafe('- a\n- **b**\n\n```\n<x>\n```\n\n1. one');
  assert.equal(out, '<ul><li>a</li><li><strong>b</strong></li></ul>\n<pre><code>&lt;x&gt;</code></pre>\n<ol><li>one</li></ol>');
  assert.ok(!renderMarkdownSafe('[x](data:text/html,<b>)').includes('<a '));
});

test('no external resources, scripts or forms; CSP present', () => {
  const out = html({ snippetLanguages: [] });
  assert.match(out, /Content-Security-Policy/);
  assert.match(out, /default-src 'none'/);
  assert.ok(!/<script/i.test(out));
  assert.ok(!/<link\b/i.test(out));
  assert.ok(!/<img\b/i.test(out));
  assert.ok(!/<iframe\b/i.test(out));
  assert.ok(!/@import/i.test(out));
  assert.ok(!/url\(\s*['"]?https?:/i.test(out));
  assert.ok(!/<[^>]*\ssrc\s*=/i.test(out));
});

test('html is deterministic and has no timestamps', () => {
  assert.equal(html({}), html({}));
  assert.ok(!/\b20\d\d-\d\d-\d\dT/.test(html({})));
});

test('html never leaks credentials by default', () => {
  const out = html({});
  for (const s of SECRETS) assert.ok(!out.includes(s), `${s} leaked`);
});

test('theme options and toggle', () => {
  assert.match(html({ theme: 'dark' }), /id="tt"/);
  assert.match(html({ theme: 'light' }), /\.app\{--bg:#ffffff/);
  assert.match(html({ theme: 'auto' }), /prefers-color-scheme:dark/);
  assert.match(html({}), /\.app\{--bg:#020617/);
});

test('snippets and examples render', () => {
  const out = generateDocs(makeCollection(), { format: 'html', snippetLanguages: ['curl'] }, {
    snippetLanguages: [{ id: 'curl', label: 'cURL', generate: r => `curl '${r.fullUrl}'` }],
  }).content;
  assert.match(out, /<summary>cURL<\/summary>/);
  assert.match(out, /Example: Found/);
  assert.match(out, /id="r1"/);
});

// ─── Allowlisted HTML in descriptions ────────────────────────────────────────

test('description: allowlisted HTML tags are rendered', () => {
  const { renderMarkdownSafe } = require('../src/docs/doc-html');
  const html = renderMarkdownSafe('Use <b>bold</b>, <i>it</i> and<br>breaks\n\n<ul>\n<li>one</li>\n<li><code>two</code></li>\n</ul>');
  assert.ok(html.includes('<b>bold</b>'));
  assert.ok(html.includes('<br>'));
  assert.ok(html.includes('<ul>') && html.includes('<li>one</li>'));
});

test('description: dangerous HTML is neutralized', () => {
  const { renderMarkdownSafe } = require('../src/docs/doc-html');
  const html = renderMarkdownSafe([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)" onclick="x()">x</a>',
    '<div onmouseover="x()" style="a:b">d</div><style>body{}</style>',
  ].join('\n\n'));
  assert.ok(!/<script/i.test(html));
  assert.ok(!/<img/i.test(html));
  assert.ok(!/<style/i.test(html));
  assert.ok(!/javascript:/i.test(html));
  assert.ok(!/<[^>]*\son\w+=/i.test(html)); // no real tag carries an event handler
  assert.ok(!/<[^>]*\sstyle=/i.test(html));
});

test('description: stray closing tags cannot escape and unclosed tags are closed', () => {
  const { renderMarkdownSafe } = require('../src/docs/doc-html');
  const html = renderMarkdownSafe('</div></section> text <b>open');
  assert.ok(!html.includes('</div>') && !html.includes('</section>'));
  assert.ok(html.endsWith('</b>') || html.includes('</b>'));
});

test('description: code spans keep tags literal; href attribute cannot be broken out of', () => {
  const { renderMarkdownSafe } = require('../src/docs/doc-html');
  assert.ok(renderMarkdownSafe('`<b>x</b>`').includes('&lt;b&gt;x&lt;/b&gt;'));
  const html = renderMarkdownSafe(`<a href='https://x.com" onmouseover="y'>q</a>`);
  assert.ok(!/\sonmouseover=/.test(html));
});

test('description: <img> and markdown images render for safe sources only', () => {
  const { renderMarkdownSafe } = require('../src/docs/doc-html');
  const a = renderMarkdownSafe('<img src="https://x.test/a.png" alt="A" width="40" onerror="x()" style="y">');
  assert.ok(a.includes('<img src="https://x.test/a.png" alt="A" width="40">'));
  assert.ok(!/onerror=|style=/.test(a));
  const b = renderMarkdownSafe('![logo](https://x.test/l.png)');
  assert.ok(b.includes('<img src="https://x.test/l.png" alt="logo">'));
  const c = renderMarkdownSafe('<img src="data:image/png;base64,AAAA">');
  assert.ok(c.includes('<img src="data:image/png;base64,AAAA">'));
  for (const bad of ['<img src="javascript:alert(1)">', '<img src="data:text/html;base64,AAAA">', '<img src=x>', '![x](javascript:alert(1))', '<img src="file:///etc/passwd">']) {
    const out = renderMarkdownSafe(bad);
    assert.ok(!/<img\b/i.test(out), `img survived: ${bad}`);
    assert.ok(!/<[^>]*javascript:/i.test(out));
  }
  const brk = renderMarkdownSafe('![a" onerror="x](https://x.test/a.png)');
  assert.ok(brk.includes('alt="a&quot; onerror=&quot;x"'));
  assert.ok(!/"\s+onerror=/.test(brk)); // quote is escaped, so no attribute breakout
});
