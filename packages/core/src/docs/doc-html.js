'use strict';

/**
 * Static, self-contained HTML documentation renderer.
 * - Every dynamic string passes through esc().
 * - No scripts, no external stylesheets/fonts; images from descriptions may load (img-src only). A restrictive CSP is embedded.
 * - Deterministic output (no timestamps / random ids).
 * - Theme toggle is CSS-only (hidden checkbox), so no JavaScript is needed.
 */

const { buildSnippets } = require('./doc-model');

const AUTH_LABELS = {
  bearer: 'Bearer token', basic: 'Basic auth', apikey: 'API key', oauth2: 'OAuth 2.0',
  digest: 'Digest', oauth1: 'OAuth 1.0', hawk: 'Hawk', awsv4: 'AWS Signature', ntlm: 'NTLM',
};
const FIELD_LABELS = {
  token: 'Token', username: 'Username', password: 'Password', value: 'Value',
  clientId: 'Client ID', clientSecret: 'Client secret', accessToken: 'Access token',
};
const KNOWN_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** The single escaping helper used for all text and attribute values. */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Allowlist HTML sanitizer ────────────────────────────────────────────────
// Descriptions may contain a small subset of HTML. Everything else is escaped.
// Attributes are dropped except a validated href on <a> and numeric
// colspan/rowspan on cells. Closing tags are only emitted when they match an
// open tag, and unclosed tags are closed at the end, so markup can't leak out
// of its container.

const INLINE_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'code', 'kbd', 'mark', 'small', 'sub', 'sup', 'a', 'br', 'img']);
const BLOCK_TAGS = new Set(['p', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'details', 'summary', 'div']);
const VOID_TAGS = new Set(['br', 'hr', 'img']);
const SAFE_IMG_SRC_RE = /^(https?:\/\/|data:image\/(png|jpe?g|gif|webp);base64,)/i;
const TAG_NAME_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)/y;
const MAX_TAG_LEN = 65536;

/**
 * Linear-time tag scanner (replaces a backtracking regex). Returns
 * `{ index, 0: fullMatch, 1: '/'|'', 2: name, 3: rawAttrs }` or null.
 * A '<' that does not start a well-formed tag (no closing '>' within
 * MAX_TAG_LEN, or a stray '<' / unterminated quote) is treated as text.
 */
function nextTag(raw, from) {
  let i = raw.indexOf('<', from);
  while (i !== -1) {
    TAG_NAME_RE.lastIndex = i;
    const nm = TAG_NAME_RE.exec(raw);
    if (nm) {
      const limit = Math.min(raw.length, i + MAX_TAG_LEN);
      let j = i + nm[0].length;
      let ok = false;
      while (j < limit) {
        const c = raw[j];
        if (c === '>') { ok = true; break; }
        if (c === '<') break;
        if (c === '"' || c === "'") {
          const close = raw.indexOf(c, j + 1);
          if (close === -1 || close >= limit) break;
          j = close + 1;
          continue;
        }
        j++;
      }
      if (ok) {
        const m = [raw.slice(i, j + 1), nm[1], nm[2], raw.slice(i + nm[0].length, j)];
        m.index = i;
        return m;
      }
    }
    i = raw.indexOf('<', i + 1);
  }
  return null;
}

function safeAttrs(tag, rawAttrs) {
  let out = '';
  const attrRe = /([a-zA-Z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = attrRe.exec(rawAttrs)) !== null) {
    const name = m[1].toLowerCase();
    const val = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '';
    if (tag === 'a' && name === 'href') {
      const url = val.replace(/[\u0000- ]+/g, '');
      if (/^(https?:\/\/|mailto:|#)/i.test(url)) out += ` href="${esc(url)}" rel="noopener noreferrer nofollow"`;
    } else if (tag === 'img' && name === 'src') {
      const url = val.replace(/[\u0000-\u0020]+/g, '');
      if (SAFE_IMG_SRC_RE.test(url)) out += ` src="${esc(url)}"`;
    } else if (tag === 'img' && (name === 'alt' || name === 'title')) {
      out += ` ${name}="${esc(val)}"`;
    } else if (tag === 'img' && (name === 'width' || name === 'height') && /^\d{1,4}$/.test(val)) {
      out += ` ${name}="${val}"`;
    } else if ((tag === 'td' || tag === 'th') && (name === 'colspan' || name === 'rowspan') && /^\d{1,2}$/.test(val)) {
      out += ` ${name}="${val}"`;
    }
  }
  return out;
}

/**
 * Sanitize an HTML fragment. `allowed` is the set of tag names to keep.
 * `textFn` renders the text between tags (defaults to esc).
 */
function sanitizeHtml(src, allowed, textFn) {
  const render = textFn || esc;
  const stack = [];
  let out = '';
  let last = 0;
  let m;
  const raw = String(src == null ? '' : src);
  let pos = 0;
  while ((m = nextTag(raw, pos)) !== null) {
    pos = m.index + m[0].length;
    out += render(raw.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (!allowed.has(tag)) { out += esc(m[0]); continue; }
    if (VOID_TAGS.has(tag)) {
      if (!closing) {
        const attrs = safeAttrs(tag, m[3]);
        if (tag !== 'img' || / src="/.test(attrs)) out += `<${tag}${attrs}>`;
        else out += esc(m[0]);
      }
      continue;
    }
    if (closing) {
      const idx = stack.lastIndexOf(tag);
      if (idx === -1) continue;
      while (stack.length > idx) out += `</${stack.pop()}>`;
    } else {
      stack.push(tag);
      out += `<${tag}${safeAttrs(tag, m[3])}>`;
    }
  }
  out += render(raw.slice(last));
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

const ALL_TAGS = new Set([...INLINE_TAGS, ...BLOCK_TAGS]);
const BLOCK_START_RE = /^\s*<\/?(p|ul|ol|li|table|thead|tbody|tfoot|tr|th|td|caption|blockquote|pre|h[1-6]|hr|details|summary|div)\b/i;

// ─── Minimal safe markdown renderer ──────────────────────────────────────────

function renderInline(text) {
  const codes = [];
  const links = [];
  const tags = [];
  // Code spans are pulled out of the raw text first (their content is shown
  // literally), then allowed inline tags are sanitized and stashed behind
  // placeholders so the markdown rules below cannot touch them. Everything else
  // is escaped by sanitizeHtml.
  const raw = String(text == null ? '' : text).replace(/[\u0000-\u0002]/g, '');
  const withCodes = raw.replace(/`([^`]+)`/g, (m, c) => { codes.push(esc(c)); return `\u0000${codes.length - 1}\u0000`; });
  let s = sanitizeHtml(withCodes, INLINE_TAGS)
    .replace(/<\/?(?:b|strong|i|em|u|s|del|ins|code|kbd|mark|small|sub|sup|a|br|img)\b[^>]*>/gi, m => { tags.push(m); return `\u0002${tags.length - 1}\u0002`; });
  // Markdown images: ![alt](url) -> <img>, only for safe sources.
  s = s.replace(/!\[([^\[\]]{0,500})\]\(([^()\s]{1,2000})\)/g, (m, alt, url) => {
    const rawUrl = url.replace(/\u0000(\d+)\u0000/g, (mm, i) => `\`${codes[Number(i)]}\``);
    if (!SAFE_IMG_SRC_RE.test(rawUrl)) return m;
    tags.push(`<img src="${rawUrl}" alt="${alt}">`);
    return `\u0002${tags.length - 1}\u0002`;
  });
  // Links are stashed behind placeholders so the emphasis rules below can never
  // rewrite an href value (e.g. https://a.com/*b*c).
  s = s.replace(/\[([^\[\]]{1,500})\]\(([^()\s]{1,2000})\)/g, (m, label, url) => {
    const rawUrl = url.replace(/\u0000(\d+)\u0000/g, (mm, i) => `\`${codes[Number(i)]}\``);
    if (!/^(https?:\/\/|mailto:|#)/i.test(rawUrl)) return label;
    links.push({ label, url: rawUrl });
    return `\u0001${links.length - 1}\u0001`;
  });
  const emphasis = t => t
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
  s = emphasis(s);
  s = s.replace(/\u0001(\d+)\u0001/g, (m, i) => {
    const l = links[Number(i)];
    return `<a href="${l.url}" rel="noopener noreferrer nofollow">${emphasis(l.label)}</a>`;
  });
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[Number(i)]}</code>`);
  s = s.replace(/\u0002(\d+)\u0002/g, (m, i) => tags[Number(i)]);
  return s;
}

/** Render a small, safe subset of Markdown (headings, lists, fences, inline). */
function renderMarkdownSafe(src) {
  const lines = String(src == null ? '' : src).replace(/\u0000/g, '').split(/\r?\n/);
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${renderInline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${renderInline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceM = line.match(/^\s*(`{3,})/);
    if (fenceM) {
      flushPara(); flushList();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fenceM[1])) buf.push(lines[i++]);
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (BLOCK_START_RE.test(line)) {
      flushPara(); flushList();
      const buf = [line];
      const text = () => buf.join('\n');
      const inPre = () => (text().match(/<pre\b/gi) || []).length > (text().match(/<\/pre>/gi) || []).length;
      while (i + 1 < lines.length && (lines[i + 1].trim() !== '' || inPre())) buf.push(lines[++i]);
      out.push(sanitizeHtml(text(), ALL_TAGS));
      continue;
    }
    const head = line.match(/^(#{1,6})\s/);
    if (head) {
      flushPara(); flushList();
      const lvl = Math.min(6, head[1].length + 3);
      out.push(`<h${lvl}>${renderInline(line.slice(head[0].length).trimStart())}</h${lvl}>`);
      continue;
    }
    const li = line.match(/^\s*([-*+]|\d+\.)\s/);
    if (li) {
      flushPara();
      const tag = /\d/.test(li[1]) ? 'ol' : 'ul';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(line.slice(li[0].length).trimStart());
      continue;
    }
    if (line.trim() === '') { flushPara(); flushList(); continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join('\n');
}

// ─── Layout ──────────────────────────────────────────────────────────────────

const DARK_VARS = '--bg:#020617;--panel:#0f172a;--elev:#1e293b;--border:#334155;--text:#e2e8f0;--muted:#94a3b8;--accent:#f97316;--accent-fg:#fff;--code:#0b1220;';
const LIGHT_VARS = '--bg:#ffffff;--panel:#f8fafc;--elev:#f1f5f9;--border:#cbd5e1;--text:#0f172a;--muted:#475569;--accent:#ea580c;--accent-fg:#fff;--code:#f1f5f9;';

function themeCss(theme) {
  if (theme === 'light') return `.app{${LIGHT_VARS}}#tt:checked~.app{${DARK_VARS}}`;
  if (theme === 'auto') {
    return `.app{${LIGHT_VARS}}@media (prefers-color-scheme:dark){.app{${DARK_VARS}}#tt:checked~.app{${LIGHT_VARS}}}@media (prefers-color-scheme:light){#tt:checked~.app{${DARK_VARS}}}`;
  }
  return `.app{${DARK_VARS}}#tt:checked~.app{${LIGHT_VARS}}`;
}

const BASE_CSS = `
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
#tt{position:fixed;top:0;left:0;width:1px;height:1px;opacity:0}
.app{display:flex;min-height:100vh;background:var(--bg);color:var(--text)}
nav.side{width:280px;flex:0 0 280px;background:var(--panel);border-right:1px solid var(--border);padding:16px;position:sticky;top:0;height:100vh;overflow:auto}
nav.side h1{font-size:15px;margin:0 0 12px}
nav.side ul{list-style:none;margin:0;padding-left:12px}
nav.side>ul{padding-left:0}
nav.side a{color:var(--muted);text-decoration:none;display:block;padding:2px 0;font-size:13px}
nav.side a:hover{color:var(--accent)}
nav.side .folder{color:var(--text);font-weight:600;font-size:13px;margin-top:6px}
main{flex:1;min-width:0;padding:24px 32px;max-width:980px}
.toggle{float:right;cursor:pointer;border:1px solid var(--border);background:var(--elev);color:var(--text);border-radius:4px;padding:4px 10px;font-size:12px;user-select:none}
#tt:focus-visible~.app .toggle{outline:2px solid var(--accent)}
main h1{font-size:26px;margin:0 0 8px}
main h2.folder-h{font-size:20px;border-bottom:1px solid var(--border);padding-bottom:6px;margin-top:36px}
section.req{background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:16px;margin:16px 0}
section.req h3{margin:0 0 8px;font-size:17px}
.endpoint{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:8px}
.badge{display:inline-block;min-width:56px;text-align:center;padding:1px 8px;border-radius:3px;font-size:12px;font-weight:700;color:#fff;background:#64748b}
.m-get{background:#16a34a}.m-post{background:#ea580c}.m-put{background:#2563eb}.m-patch{background:#7c3aed}.m-delete{background:#dc2626}.m-head,.m-options{background:#0d9488}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
code{background:var(--code);padding:1px 4px;border-radius:3px;word-break:break-all}
pre{background:var(--code);border:1px solid var(--border);border-radius:4px;padding:10px;overflow:auto;margin:6px 0}
pre code{background:none;padding:0;word-break:normal}
h4{margin:14px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--accent)}
table{border-collapse:collapse;width:100%;margin:4px 0;font-size:13px}
th,td{border:1px solid var(--border);padding:4px 8px;text-align:left;vertical-align:top;word-break:break-word}
th{background:var(--elev)}
details{margin:6px 0}summary{cursor:pointer;color:var(--muted)}
a{color:var(--accent)}
.muted{color:var(--muted)}
@media (max-width:760px){.app{flex-direction:column}nav.side{position:static;width:auto;height:auto;flex:none}main{padding:16px}}
`;

function kvTable(list) {
  if (!list || !list.length) return '';
  const hasDesc = list.some(e => e.description);
  const head = `<tr><th>Name</th><th>Value</th>${hasDesc ? '<th>Description</th>' : ''}</tr>`;
  const rows = list.map(e => `<tr><td><code>${esc(e.key)}</code></td><td>${esc(e.value)}${e.type === 'file' ? ' <span class="muted">(file)</span>' : ''}</td>${hasDesc ? `<td>${renderInline(e.description || '')}</td>` : ''}</tr>`);
  return `<table>${head}${rows.join('')}</table>`;
}

function authHtml(auth) {
  if (!auth || auth.type === 'noauth') return '';
  let h = `<h4>Authentication</h4><p>${esc(AUTH_LABELS[auth.type] || auth.type)}${auth.source !== 'request' ? ` <span class="muted">(inherited from ${esc(auth.source)})</span>` : ''}</p>`;
  if (auth.type === 'apikey') h += `<p>Sent in ${esc(auth.in)}: <code>${esc(auth.name)}</code></p>`;
  if (auth.oauth2) {
    const o = auth.oauth2;
    h += `<p>Grant type: <code>${esc(o.grantType)}</code>`;
    if (o.authorizationUrl) h += `<br>Authorization URL: <code>${esc(o.authorizationUrl)}</code>`;
    if (o.tokenUrl) h += `<br>Token URL: <code>${esc(o.tokenUrl)}</code>`;
    if (o.scopes && o.scopes.length) h += `<br>Scopes: ${o.scopes.map(s => `<code>${esc(s)}</code>`).join(' ')}`;
    h += '</p>';
  }
  if (auth.fields && auth.fields.length) {
    h += `<table><tr><th>Field</th><th>Value</th></tr>${auth.fields.map(f => `<tr><td>${esc(FIELD_LABELS[f.key] || f.key)}</td><td><code>${esc(f.value)}</code></td></tr>`).join('')}</table>`;
  }
  return h;
}

function bodyHtml(body) {
  if (!body) return '';
  let h = '<h4>Body</h4>';
  if (body.mode === 'raw') h += `<p class="muted">raw (${esc(body.language || 'text')})</p><pre><code>${esc(body.raw || '')}</code></pre>`;
  else if (body.mode === 'urlencoded' || body.mode === 'formdata') h += `<p class="muted">${esc(body.mode)}</p>${kvTable(body.fields) || '<p class="muted">No fields</p>'}`;
  else if (body.mode === 'graphql') {
    h += `<p class="muted">GraphQL</p><pre><code>${esc(body.graphql.query)}</code></pre>`;
    if (body.graphql.variables) h += `<h4>Variables</h4><pre><code>${esc(body.graphql.variables)}</code></pre>`;
  } else if (body.mode === 'file') h += '<p class="muted">binary file</p>';
  return h;
}

function examplesHtml(examples) {
  return examples.map(ex => {
    let h = `<h4>Example: ${esc(ex.name)}${ex.code || ex.status ? ` <span class="muted">(${esc([ex.code, ex.status].filter(Boolean).join(' '))})</span>` : ''}</h4>`;
    if (ex.originalRequest && (ex.originalRequest.method || ex.originalRequest.url)) {
      h += `<p class="muted">Request: <code>${esc([ex.originalRequest.method, ex.originalRequest.url].filter(Boolean).join(' '))}</code></p>`;
    }
    h += kvTable(ex.headers);
    if (ex.body) h += `<pre><code>${esc(ex.body)}</code></pre>`;
    return h;
  }).join('');
}

function renderHtml(model, options, deps) {
  const warnings = [];
  const theme = ['dark', 'light', 'auto'].includes(options.theme) ? options.theme : 'dark';
  let n = 0;
  const anchors = new Map();
  for (const r of model.requests) anchors.set(r, `r${++n}`);

  function navHtml(nodes) {
    if (!nodes.length) return '';
    return `<ul>${nodes.map(node => {
      if (node.type === 'folder') return `<li><div class="folder">${esc(node.name)}</div>${navHtml(node.children || [])}</li>`;
      return `<li><a href="#${anchors.get(node.request)}">${esc(node.name)}</a></li>`;
    }).join('')}</ul>`;
  }

  function requestHtml(req) {
    const m = req.method.toLowerCase();
    const cls = KNOWN_METHODS.has(m) ? `m-${m}` : '';
    let h = `<section class="req" id="${anchors.get(req)}"><h3>${esc(req.name)}</h3>`;
    h += `<div class="endpoint"><span class="badge ${cls}">${esc(req.method)}</span><code>${esc(req.fullUrl)}</code></div>`;
    if (req.description) h += `<div class="desc">${renderMarkdownSafe(req.description)}</div>`;
    h += authHtml(req.auth);
    if (req.pathVariables.length) h += `<h4>Path variables</h4>${kvTable(req.pathVariables)}`;
    if (req.query.length) h += `<h4>Query parameters</h4>${kvTable(req.query)}`;
    if (req.headers.length) h += `<h4>Headers</h4>${kvTable(req.headers)}`;
    h += bodyHtml(req.body);
    h += examplesHtml(req.examples);
    for (const s of buildSnippets(req, options, deps, warnings)) {
      h += `<details><summary>${esc(s.label)}</summary><pre><code>${esc(s.code)}</code></pre></details>`;
    }
    return `${h}</section>`;
  }

  function bodyNodes(nodes, depth) {
    return nodes.map(node => {
      if (node.type === 'folder') {
        const tag = `h${Math.min(6, depth + 1)}`;
        return `<${tag} class="folder-h">${esc(node.name)}</${tag}>${node.description ? `<div class="desc">${renderMarkdownSafe(node.description)}</div>` : ''}${bodyNodes(node.children || [], depth + 1)}`;
      }
      return requestHtml(node.request);
    }).join('\n');
  }

  const content = bodyNodes(model.tree, 2);
  const varsHtml = model.variables.length ? `<h2 class="folder-h">Variables</h2>${kvTable(model.variables)}` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Apilix">
<title>${esc(model.title)}</title>
<style>${BASE_CSS}${themeCss(theme)}</style>
</head>
<body>
<input type="checkbox" id="tt" aria-label="Toggle light/dark theme">
<div class="app">
<nav class="side"><h1>${esc(model.title)}</h1>${navHtml(model.tree)}</nav>
<main>
<label for="tt" class="toggle">Light / Dark</label>
<h1>${esc(model.title)}</h1>
${model.description ? `<div class="desc">${renderMarkdownSafe(model.description)}</div>` : ''}
${authHtml(model.auth)}
${varsHtml}
${content}
</main>
</div>
</body>
</html>
`;
  return { content: html, warnings };
}

module.exports = { renderHtml, esc, renderMarkdownSafe, sanitizeHtml };
