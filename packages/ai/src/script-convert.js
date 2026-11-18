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

// A regular expression literal longer than this is read as a division: an unclosed `/[` run would otherwise be rescanned from every `/`.
const MAX_REGEX_LITERAL = 2000;
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
        while (j < n && j - i < MAX_REGEX_LITERAL && code[j] !== '\n' && (code[j] !== '/' || inClass)) { if (code[j] === '\\') j++; else if (code[j] === '[') inClass = true; else if (code[j] === ']') inClass = false; j++; }
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

const IDENT_RE = /[A-Za-z_$][\w$]*/g;
const LEGACY_GLOBALS = ['responseBody', 'responseCode', 'responseHeaders', 'responseTime', 'tests', 'postman'];

/**
 * Names the script declares itself (variables, functions, classes, parameters, destructured names, catch bindings).
 * `all` is every such name; `local` is the subset declared where it does not cover the whole script (a parameter, a
 * catch binding, a loop variable, or a declaration inside a block): a reference elsewhere may still be the Postman global.
 */
function declaredNames(mask) {
  const all = new Set();
  const local = new Set();
  const depth = new Int32Array(mask.length + 1);
  for (let i = 0; i < mask.length; i++) depth[i + 1] = depth[i] + (mask[i] === '{' ? 1 : mask[i] === '}' ? -1 : 0);
  const add = (text, isLocal, at) => { for (const m of text.matchAll(IDENT_RE)) { all.add(m[0]); if (isLocal || depth[at] > 0) local.add(m[0]); } };
  const inLoopHead = (at) => /\bfor\s*(?:await\s*)?\(\s*$/.test(mask.slice(Math.max(0, at - 24), at));
  for (const m of mask.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) add(m[1], inLoopHead(m.index), m.index);
  for (const m of mask.matchAll(/\b(?:const|let|var)\s*[[{]([^\]}]*)[\]}]/g)) add(m[1], inLoopHead(m.index), m.index);
  for (const m of mask.matchAll(/\bfunction\s*[\w$]*\s*\(([^()]*)\)/g)) add(m[1], true, m.index);
  for (const m of mask.matchAll(/\(([^()]*)\)\s*=>/g)) add(m[1], true, m.index);
  for (const m of mask.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1], true, m.index);
  for (const m of mask.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1], true, m.index);
  return { all, local };
}

const prevSig = (mask, i) => { let k = i - 1; while (k >= 0 && /\s/.test(mask[k])) k--; return k >= 0 ? mask[k] : ''; };
const nextSig = (mask, i) => { let k = i; while (k < mask.length && /\s/.test(mask[k])) k++; return k < mask.length ? mask[k] : ''; };

/**
 * Where an identifier sits: 'key' (`{ pm: 1 }`, never a reference), 'shorthand' (`{ pm }`, `{ a, responseBody }`: rewriting
 * it would break the code, so it is left alone and reported, even when it is really an array element) or '' (a reference).
 */
function positionOf(mask, start, end) {
  const before = prevSig(mask, start);
  const after = nextSig(mask, end);
  if (before !== '{' && before !== ',') return '';
  if (after === ':') return 'key';
  return after === ',' || after === '}' ? 'shorthand' : '';
}

const lineNo = (text, index) => text.slice(0, index).split('\n').length;

/** `tests["name"] = expr;` on ONE line (a trailing comment is kept). null when the line is not that, or not safely convertible. */
function convertTestsLine(line, maskLine, nextLine) {
  if (!/^\s*tests\s*\[/.test(maskLine)) return null;
  // The statement goes on at the start of the next line (`tests["a"] = x\n  && y;`, `foo\n(1)`): not one complete line.
  if (nextLine && /^[.(\[+\-*/%&|^?:,<>=`]/.test(nextLine)) return null;
  const codeEnd = maskLine.trimEnd().length;
  const code = line.slice(0, codeEnd);
  const tail = line.slice(codeEnd);
  const head = /^(\s*)tests\s*\[\s*(?:"([^"\\]*)"|'([^'\\]*)')\s*\]\s*=\s*/.exec(code);
  if (!head) return null;
  const rawBody = code.slice(head[0].length).trimEnd();
  let bodyMask = maskLine.slice(head[0].length, codeEnd).trimEnd();
  if (bodyMask.endsWith(';')) bodyMask = bodyMask.slice(0, -1).trimEnd();
  const body = rawBody.slice(0, bodyMask.length);
  // A comment between the expression and its `;` moves behind the statement.
  const moved = rawBody.slice(bodyMask.length).replace(/;\s*$/, '').trim();
  // One complete expression only (checked on the masked text, so comments and strings do not count): no `;` left,
  // balanced brackets, not ending on an operator (it would continue on the next line).
  if (!bodyMask || bodyMask.includes(';') || /[=+\-*/%&|^?:,<>!(\[{]$/.test(bodyMask)) return null;
  let depth = 0;
  for (const c of bodyMask) {
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (depth < 0) return null;
  }
  if (depth !== 0) return null;
  const name = head[2] !== undefined ? head[2] : head[3];
  return `${head[1]}apx.test(${JSON.stringify(name)}, function () { apx.expect(${body}).to.be.ok; });${moved ? ` ${moved}` : ''}${tail}`;
}

/**
 * @param {string} code
 * @returns {{ script: string, changed: boolean, renamed: number, legacy: number,
 *   remaining: Array<{ path: string, line: number, reason: string }> }}
 */
function convertPmToApx(code) {
  const src = typeof code === 'string' ? code : '';
  const { all: declared, local: declaredLocal } = declaredNames(maskNonCode(src));
  if (declared.has('pm') || declared.has('apx')) {
    return { script: src, changed: false, renamed: 0, legacy: 0, remaining: [{ path: 'pm', line: 1, reason: 'the script declares its own pm or apx variable: nothing was rewritten' }] };
  }
  const own = new Set(LEGACY_GLOBALS.filter(g => declared.has(g)));
  let text = src;
  let legacy = 0;
  let renamed = 0;
  let mask = maskNonCode(text);

  /** Rewrite `re` matches in code, except those that are keys / shorthand properties. */
  const rewrite = (re, fn) => {
    const r = replaceInCode(text, mask, re, (m) => {
      if (positionOf(mask, m.index, m.index + m[0].length)) return m[0];
      return fn(m);
    });
    text = r.text;
    mask = maskNonCode(text);
  };

  // 1. legacy postman.* / responseBody / responseCode.code / tests["name"] = expr;
  if (!own.has('postman')) {
    rewrite(/(?<![\w$.])postman\s*\.\s*([A-Za-z]+)(?=\s*\()/g, (m) => {
      if (!LEGACY_CALLS[m[1]]) return m[0];
      legacy++;
      return LEGACY_CALLS[m[1]];
    });
  }
  if (!own.has('responseCode')) rewrite(/(?<![\w$.])responseCode\s*\.\s*code(?![\w$])/g, () => { legacy++; return 'apx.response.code'; });
  if (!own.has('responseBody')) rewrite(/(?<![\w$.])responseBody(?![\w$])/g, () => { legacy++; return 'apx.response.text()'; });
  if (!own.has('tests')) {
    const lines = text.split('\n');
    const maskLines = mask.split('\n');
    for (let li = 0; li < lines.length; li++) {
      let k = li + 1;
      while (k < lines.length && (lines[k].trim() === '' || lines[k].trim().startsWith('//'))) k++;
      const converted = convertTestsLine(lines[li], maskLines[li], k < lines.length ? lines[k].trim() : '');
      if (converted !== null) { lines[li] = converted; legacy++; }
    }
    text = lines.join('\n');
    mask = maskNonCode(text);
  }

  // 2. pm -> apx (identifier in code, not a property name, an object key or a shorthand property)
  rewrite(/(?<![\w$.])pm(?![\w$])/g, () => { renamed++; return 'apx'; });

  // 3. what apx does not have, and what could not be converted safely
  mask = maskNonCode(text);
  const remaining = findUnsupported(text, mask);
  const note = (p, index, why) => { if (!remaining.some(x => x.path === p)) remaining.push({ path: p, line: lineNo(text, index), reason: why }); };
  // A legacy global the script also declares inside a function, block or parameter list: the references were NOT rewritten
  // (one of them may be the global), so every one is reported and the script is never called fully converted.
  const shadowedRefs = {
    responseBody: /(?<![\w$.])responseBody(?![\w$])/g,
    responseCode: /(?<![\w$.])responseCode\s*\.\s*code(?![\w$])/g,
    responseHeaders: /(?<![\w$.])responseHeaders(?![\w$])/g,
    responseTime: /(?<![\w$.])responseTime(?![\w$])/g,
    tests: /(?<![\w$.])tests\s*\[/g,
    postman: /(?<![\w$.])postman\s*\.\s*[A-Za-z]+\s*\(/g,
  };
  for (const g of own) {
    if (!declaredLocal.has(g)) continue;
    for (const m of mask.matchAll(shadowedRefs[g])) {
      if (positionOf(mask, m.index, m.index + m[0].length) === 'key') continue;
      const line = lineNo(text, m.index);
      if (!remaining.some(x => x.path === g && x.line === line)) remaining.push({ path: g, line, reason: `shadowed locally: "${g}" is also declared in a function, block or parameter list, so this reference was not converted` });
    }
  }
  if (!own.has('tests')) {
    for (const m of mask.matchAll(/(?<![\w$.])tests\s*\[/g)) note('tests[...]', m.index, 'legacy tests[...] assignment that could not be converted automatically (not a single complete statement on one line)');
  }
  if (!own.has('postman')) {
    for (const m of mask.matchAll(/(?<![\w$.])postman\s*\.\s*([A-Za-z]+)/g)) note(`postman.${m[1]}`, m.index, 'legacy Postman API with no apx equivalent');
  }
  for (const g of ['responseBody', 'responseCode', 'responseHeaders', 'responseTime']) {
    if (own.has(g)) continue;
    for (const m of mask.matchAll(new RegExp(String.raw`(?<![\w$.])${g}(?![\w$])`, 'g'))) {
      if (positionOf(mask, m.index, m.index + g.length) === 'key') continue;
      note(g, m.index, 'legacy Postman global that could not be converted automatically');
    }
  }
  for (const m of mask.matchAll(/(?<![\w$.])pm(?![\w$])/g)) {
    if (positionOf(mask, m.index, m.index + 2) !== 'key') note('pm', m.index, 'a shorthand property could not be renamed safely');
  }
  return { script: text, changed: text !== src, renamed, legacy, remaining };
}

module.exports = { convertPmToApx, maskNonCode };
