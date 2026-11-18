'use strict';

/**
 * Value-masking of a script for shape-only mode: string literals, template text, regular expressions and
 * numbers are replaced by placeholders and comments are dropped; identifiers, calls, operators and structure
 * stay. The result is CONTEXT for the model, not a script: it does not parse (`<number>` is not JavaScript)
 * and must never be offered back as the user's script. Single linear pass, no regex backtracking.
 */

const REGEX_PRECEDING_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'instanceof']);
const STRING = '"<string>"';
const NUMBER = '<number>';
const REGEX = '/<regex>/';

function maskScriptLiterals(code) {
  const src = typeof code === 'string' ? code : '';
  const n = src.length;
  let out = '';
  let i = 0;
  let lastSig = '';
  let lastWord = '';
  const stack = []; // brace depth inside each template `${`

  // Template text from `from` (just after the backtick or the closing `}` of an interpolation).
  const templateText = (from) => {
    let j = from;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') { out += '<string>`'; return j + 1; }
      if (src[j] === '$' && src[j + 1] === '{') { out += '<string>${'; stack.push(0); return j + 2; }
      j++;
    }
    out += '<string>`';
    return n;
  };

  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { out += c; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e === -1 ? n : e; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; out += ' '; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      out += STRING; i = j + 1; lastSig = c; lastWord = ''; continue;
    }
    if (c === '`') { out += '`'; i = templateText(i + 1); lastSig = '`'; lastWord = ''; continue; }
    if (stack.length && c === '{') { stack[stack.length - 1]++; out += c; i++; lastSig = c; continue; }
    if (stack.length && c === '}') {
      if (stack[stack.length - 1] === 0) { stack.pop(); out += '}'; i = templateText(i + 1); lastSig = '`'; continue; }
      stack[stack.length - 1]--; out += c; i++; lastSig = c; continue;
    }
    if (c === '/') {
      const regexOk = lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig) || REGEX_PRECEDING_WORDS.has(lastWord);
      if (regexOk) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== '\n' && (src[j] !== '/' || inClass)) { if (src[j] === '\\') j++; else if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false; j++; }
        if (src[j] === '/') { j++; while (j < n && /[a-z]/i.test(src[j])) j++; out += REGEX; i = j; lastSig = '/'; lastWord = ''; continue; }
      }
      out += c; i++; lastSig = c; lastWord = ''; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      lastWord = src.slice(i, j); lastSig = 'a'; out += lastWord; i = j; continue;
    }
    if (/[0-9]/.test(c)) { let j = i + 1; while (j < n && /[\w.]/.test(src[j])) j++; out += NUMBER; lastSig = '0'; lastWord = ''; i = j; continue; }
    out += c; lastSig = c; lastWord = ''; i++;
  }
  return out;
}

module.exports = { maskScriptLiterals };
