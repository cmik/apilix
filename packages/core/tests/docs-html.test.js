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

// ─── renderImages option ─────────────────────────────────────────────────────

const IMG_DESC = [
  'MD ![logo](https://img.test/a.png) and ![](http://img.test/b.png)',
  'HTML <img src="https://img.test/c.png" alt="cee" width="10" onerror="x()"> and <img src="https://img.test/d.png">',
  'DATA ![dd](data:image/png;base64,AAAA) <img src="data:image/gif;base64,BBBB" alt="gg">',
  'BAD <img src="javascript:alert(1)"> ![j](javascript:alert(1))',
].join('\n\n');
const imgCol = () => {
  const col = makeCollection();
  col.info.description = IMG_DESC;
  col.item[0].item[0].request.description = IMG_DESC;
  return col;
};

test('renderImages default and true: images rendered, CSP allows http(s) and data', () => {
  for (const opts of [{}, { renderImages: true }]) {
    const out = html(opts, imgCol());
    assert.match(out, /<img src="https:\/\/img\.test\/a\.png" alt="logo">/);
    assert.match(out, /<img src="https:\/\/img\.test\/c\.png" alt="cee" width="10">/);
    assert.match(out, /<img src="data:image\/png;base64,AAAA" alt="dd">/);
    assert.match(out, /img-src data: https: http:/);
  }
});

test('renderImages false: no <img>, no src=, links instead, restrictive CSP', () => {
  const out = html({ renderImages: false }, imgCol());
  assert.ok(!/<img\b/i.test(out), 'no <img> tag');
  assert.ok(!/<[^>]*\ssrc=/i.test(out), "no src attribute on any real tag");
  assert.match(out, /img-src 'none'/);
  assert.ok(!/img-src[^;]*(https|http|data):/.test(out));
  assert.match(out, /<a href="https:\/\/img\.test\/a\.png" rel="noopener noreferrer nofollow">logo<\/a>/);
  assert.match(out, /<a href="http:\/\/img\.test\/b\.png" rel="noopener noreferrer nofollow">http:\/\/img\.test\/b\.png<\/a>/);
  assert.match(out, /<a href="https:\/\/img\.test\/c\.png" rel="noopener noreferrer nofollow">cee<\/a>/);
  assert.match(out, /<a href="https:\/\/img\.test\/d\.png" rel="noopener noreferrer nofollow">https:\/\/img\.test\/d\.png<\/a>/);
  // data: images are not valid link targets: degrade to alt text, never an href/src
  assert.ok(!/data:image/.test(out), 'data URI is dropped');
  assert.match(out, /DATA dd gg/);
  assert.ok(!/onerror/.test(out));
});

test('security is identical with renderImages on and off', () => {
  for (const renderImages of [true, false]) {
    const out = html({ renderImages }, imgCol());
    assert.ok(!/href="javascript:/i.test(out) && !/src="javascript:/i.test(out));
    assert.ok(!/<img src="javascript/i.test(out));
    assert.ok(!/\sonerror=/i.test(out));
    assert.ok(!/<script/i.test(out));
    assert.match(out, /&lt;img src=&quot;javascript:alert\(1\)&quot;&gt;/);
  }
});

test('renderMarkdownSafe takes renderImages explicitly; images inside tables/lists/headings follow it', () => {
  const md = '# T ![h](https://i.test/h.png)\n\n- item ![l](https://i.test/l.png)\n\n<table><tr><td><img src="https://i.test/t.png" alt="tt"></td></tr></table>';
  assert.equal((renderMarkdownSafe(md).match(/<img /g) || []).length, 3);
  const off = renderMarkdownSafe(md, false);
  assert.ok(!/<img/.test(off));
  assert.equal((off.match(/<a href="https:\/\/i\.test\//g) || []).length, 3);
});

test('renderImages false also applies to parameter descriptions', () => {
  const col = makeCollection();
  col.item[0].item[0].request.header = [{ key: 'H', value: 'v', description: '![x](https://i.test/p.png)' }];
  assert.match(html({}, col), /<img src="https:\/\/i\.test\/p\.png"/);
  const off = html({ renderImages: false }, col);
  assert.ok(!/<img/.test(off));
  assert.match(off, /<a href="https:\/\/i\.test\/p\.png"/);
});
