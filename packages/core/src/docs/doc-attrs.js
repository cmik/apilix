'use strict';

/**
 * Linear-time HTML attribute scanner shared by the Markdown and HTML renderers
 * (no backtracking regular expressions over untrusted text).
 */

const isNameStart = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === ':';
const isNameChar = c => isNameStart(c) || (c >= '0' && c <= '9') || c === '-' || c === '.';
const isSpace = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

/**
 * Parse `name`, `name=value`, `name="value"` and `name='value'` attributes.
 * Returns [{ name (lower-cased), value ('' when none) }]. An unterminated
 * quote leaves the attribute without a value.
 */
function parseAttrs(raw) {
  const text = String(raw == null ? '' : raw);
  const n = text.length;
  const out = [];
  const noClose = { '"': false, "'": false };
  let i = 0;
  while (i < n) {
    if (!isNameStart(text[i])) { i++; continue; }
    const s = i;
    while (i < n && isNameChar(text[i])) i++;
    const name = text.slice(s, i).toLowerCase();
    let p = i;
    while (p < n && isSpace(text[p])) p++;
    if (text[p] !== '=') { out.push({ name, value: '' }); continue; }
    p++;
    while (p < n && isSpace(text[p])) p++;
    const q = text[p];
    if (q === '"' || q === "'") {
      const e = noClose[q] ? -1 : text.indexOf(q, p + 1);
      if (e < 0) { noClose[q] = true; out.push({ name, value: '' }); continue; }
      out.push({ name, value: text.slice(p + 1, e) });
      i = e + 1;
    } else {
      let e = p;
      while (e < n && !isSpace(text[e]) && text[e] !== '"' && text[e] !== "'" && text[e] !== '>') e++;
      if (e === p) { out.push({ name, value: '' }); continue; }
      out.push({ name, value: text.slice(p, e) });
      i = e;
    }
  }
  return out;
}

/** Decode the few entities that matter in an attribute value (escaped again on output). */
function decodeAttrEntities(v) {
  return String(v).replace(/&(quot|amp|lt|gt|apos|#39|#34);/gi, (m, e) => {
    switch (e.toLowerCase()) {
      case 'quot': case '#34': return '"';
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      default: return "'";
    }
  });
}

module.exports = { parseAttrs, decodeAttrEntities };
