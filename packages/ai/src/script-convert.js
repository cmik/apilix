'use strict';

/**
 * Deterministic Postman -> apx conversion. No model involved, no network, no execution: plain text
 * rewriting driven by the REAL apx surface (apx-surface.js).
 *
 *  - `pm` is an alias of `apx` in the runtime, so `pm.x` becomes `apx.x` (identifiers in code only: strings,
 *    comments, regular expressions and property names such as `foo.pm` are left alone);
 *  - the legacy Postman globals with a one-to-one equivalent are rewritten (postman.setEnvironmentVariable,
 *    responseBody, responseCode.code, tests["name"] = expr;);
 *  - what the apx API does not have (pm.cookies, pm.request.headers.get, an unknown assertion...) is NOT
 *    guessed: it is returned in `remaining`, and only that goes to the model (when the user asks).
 *
 * The output is text for the user to review. It is never run here; any script that reaches the user passes
 * the same screen / dry-run gate as a model-written one (script-assist.js).
 */

const { getApxSurface } = require('./apx-surface');

const REGEX_PRECEDING_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'instanceof']);

/**
 * Copy of `code` where every comment, string, template text and regular expression is blanked to spaces
 * (newlines kept), so a regular expression over the mask never matches inside them and indexes line up.
 */
function maskNonCode(code) {
  const n = code.length;
  const out = code.split('');
  const blank = (from, to) => { for (let k = from; k < to && k < n; k++) if (code[k] !== '\n' && code[k] !== '\r') out[k] = ' '; };
  const stack = []; // template nesting: brace depth inside each `${`
  let i = 0;
  let lastSig = ''; // last significant code char
  let lastWord = '';
  const scanTemplate = (from) => {
    // from points just after the opening backtick (or just after the `}` closing an interpolation)
    let j = from;
    while (j < n) {
      if (code[j] === '\\') { j += 2; continue; }
      if (code[j] === '`') { blank(from, j + 1); return { end: j + 1, interpolation: false }; }
      if (code[j] === '$' && code[j + 1] === '{') { blank(from, j + 2); return { end: j + 2, interpolation: true }; }
      j++;
    }
    blank(from, n);
    return { end: n, interpolation: false };
  };
  while (i < n) {
    const c = code[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && code[i + 1] === '/') { const e = code.indexOf('\n', i); const end = e === -1 ? n : e; blank(i, end); i = end; continue; }
    if (c === '/' && code[i + 1] === '*') { const e = code.indexOf('*/', i + 2); const end = e === -1 ? n : e + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== '\n') { if (code[j] === '\\') j++; j++; }
      blank(i, j + 1); i = j + 1; lastSig = c; lastWord = ''; continue;
    }
    if (c === '`') {
      const r = scanTemplate(i + 1);
      blank(i, i + 1);
      i = r.end;
      if (r.interpolation) stack.push(0);
      lastSig = '`'; lastWord = '';
      continue;
    }
    if (stack.length && c === '{') { stack[stack.length - 1]++; i++; lastSig = c; continue; }
    if (stack.length && c === '}') {
      if (stack[stack.length - 1] === 0) {
        stack.pop();
        const r = scanTemplate(i + 1);
        blank(i, i + 1);
        i = r.end;
        if (r.interpolation) stack.push(0);
        lastSig = '`'; continue;
      }
      stack[stack.length - 1]--; i++; lastSig = c; continue;
    }
    if (c === '/') {
      const regexOk = lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig) || REGEX_PRECEDING_WORDS.has(lastWord);
      if (regexOk) {
        let j = i + 1;
        let inClass = false;
        while (j < n && code[j] !== '\n' && (code[j] !== '/' || inClass)) { if (code[j] === '\\') j++; else if (code[j] === '[') inClass = true; else if (code[j] === ']') inClass = false; j++; }
        if (code[j] === '/') { j++; while (j < n && /[a-z]/i.test(code[j])) j++; blank(i, j); i = j; lastSig = '/'; lastWord = ''; continue; }
      }
      i++; lastSig = c; lastWord = ''; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(code[j])) j++;
      lastWord = code.slice(i, j); lastSig = 'a'; i = j; continue;
    }
    if (/[0-9]/.test(c)) { let j = i + 1; while (j < n && /[\w.]/.test(code[j])) j++; lastSig = '0'; lastWord = ''; i = j; continue; }
    lastSig = c; lastWord = ''; i++;
  }
  return out.join('');
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Replace `re` matches in `mask` with `fn(match)` text, applied to the original at the same positions. */
function replaceInCode(code, mask, re, fn) {
  let out = '';
  let last = 0;
  let count = 0;
  for (const m of mask.matchAll(re)) {
    out += code.slice(last, m.index) + fn(m);
    last = m.index + m[0].length;
    count++;
  }
  return { text: out + code.slice(last), count };
}

const LEGACY_CALLS = {
  setEnvironmentVariable: 'apx.environment.set',
  getEnvironmentVariable: 'apx.environment.get',
  clearEnvironmentVariable: 'apx.environment.unset',
  setGlobalVariable: 'apx.globals.set',
  getGlobalVariable: 'apx.globals.get',
  clearGlobalVariable: 'apx.globals.unset',
  setNextRequest: 'apx.execution.setNextRequest',
};

/** Index of the `)` matching the `(` at `open` in the mask, or -1. */
function closeParen(mask, open) {
  let d = 0;
  for (let k = open; k < mask.length; k++) {
    if (mask[k] === '(') d++;
    else if (mask[k] === ')') { d--; if (d === 0) return k; }
  }
  return -1;
}

/** Report apx.* member paths that do not exist. */
function findUnsupported(code, mask) {
  const { tree, expect } = getApxSurface();
  const found = new Map();
  const note = (p, index, why) => { if (!found.has(p)) found.set(p, { path: p, line: lineOf(code, index), reason: why }); };

  // apx.a.b.c chains
  for (const m of mask.matchAll(/(?<![\w$.])apx((?:\s*\.\s*[A-Za-z_$][\w$]*)*)/g)) {
    const segs = m[1].split('.').map(s => s.trim()).filter(Boolean);
    if (!segs.length) continue;
    let node = tree;
    const walked = ['apx'];
    for (const seg of segs) {
      if (node.kind === 'value') break; // a property of a value (apx.response.code.toString)
      if (node.children && Object.prototype.hasOwnProperty.call(node.children, seg)) { node = node.children[seg]; walked.push(seg); continue; }
      if (node.kind === 'fn') break; // a property of a function result
      note([...walked, seg].join('.'), m.index, 'not available in apx');
      break;
    }
  }
  // apx["x"] computed access
  for (const m of mask.matchAll(/(?<![\w$.])apx\s*\[/g)) note('apx[...]', m.index, 'computed access to apx cannot be converted');

  // apx.expect(...).to.be.<member>(...) chains
  const known = new Set([...(expect.deep ? ['deep'] : []), ...expect.props, ...expect.methods.map(x => x.name), ...(expect.deep || [])]);
  for (const m of mask.matchAll(/(?<![\w$.])apx\s*\.\s*(?:soft)?[eE]xpect\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    let k = closeParen(mask, open);
    if (k === -1) continue;
    k++;
    for (;;) {
      const next = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(mask.slice(k));
      if (!next) break;
      const name = next[1];
      if (!known.has(name)) { note(`apx.expect(...).${name}`, k, 'assertion not available in apx'); break; }
      k += next[0].length;
      const call = /^\s*\(/.exec(mask.slice(k));
      if (call) { const close = closeParen(mask, k + call[0].length - 1); if (close === -1) break; k = close + 1; }
    }
  }
  return [...found.values()];
}

/**
 * @param {string} code
 * @returns {{ script: string, changed: boolean, renamed: number, legacy: number,
 *   remaining: Array<{ path: string, line: number, reason: string }> }}
 */
function convertPmToApx(code) {
  const src = typeof code === 'string' ? code : '';
  if (/\b(?:const|let|var|function)\s+(?:pm|apx)\b/.test(maskNonCode(src))) {
    return { script: src, changed: false, renamed: 0, legacy: 0, remaining: [{ path: 'pm', line: 1, reason: 'the script declares its own pm or apx variable: nothing was rewritten' }] };
  }
  let text = src;
  let legacy = 0;
  let renamed = 0;

  // 1. legacy postman.* / responseBody / responseCode.code / tests["name"] = expr;
  let mask = maskNonCode(text);
  let r = replaceInCode(text, mask, /(?<![\w$.])postman\s*\.\s*([A-Za-z]+)(?=\s*\()/g, (m) => {
    if (!LEGACY_CALLS[m[1]]) return m[0];
    legacy++;
    return LEGACY_CALLS[m[1]];
  });
  text = r.text;
  mask = maskNonCode(text);
  r = replaceInCode(text, mask, /(?<![\w$.])responseCode\s*\.\s*code(?![\w$])/g, () => 'apx.response.code');
  legacy += r.count; text = r.text; mask = maskNonCode(text);
  r = replaceInCode(text, mask, /(?<![\w$.])responseBody(?![\w$])/g, () => 'apx.response.text()');
  legacy += r.count; text = r.text; mask = maskNonCode(text);
  const lines = text.split('\n');
  const maskLines = mask.split('\n');
  for (let li = 0; li < lines.length; li++) {
    if (!/^\s*tests\s*\[/.test(maskLines[li])) continue;
    const m = /^(\s*)tests\s*\[\s*(?:"([^"\\]*)"|'([^'\\]*)')\s*\]\s*=\s*([^;]+?)[ \t]*;?[ \t]*(\r?)$/.exec(lines[li]);
    if (!m) continue;
    const name = m[2] !== undefined ? m[2] : m[3];
    lines[li] = `${m[1]}apx.test(${JSON.stringify(name)}, function () { apx.expect(${m[4]}).to.be.ok; });${m[5]}`;
    legacy++;
  }
  text = lines.join('\n');

  // 2. pm -> apx (identifier in code, not a property name or an object key)
  mask = maskNonCode(text);
  r = replaceInCode(text, mask, /(?<![\w$.])pm(?![\w$])(?!\s*:)/g, () => 'apx');
  renamed = r.count;
  text = r.text;

  // 3. what apx does not have
  const remaining = findUnsupported(text, maskNonCode(text));
  return { script: text, changed: text !== src, renamed, legacy, remaining };
}

module.exports = { convertPmToApx, maskNonCode };
