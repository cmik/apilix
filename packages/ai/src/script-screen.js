'use strict';

/**
 * Static screen applied to model-written scripts BEFORE they are dry-run.
 *
 * It is a defence-in-depth filter, NOT a security boundary: the boundary is the dedicated child process
 * (dry-run.js / dry-run-worker.js). A hand-written tokenizer cannot be proven equivalent to V8's parser, so
 * this screen is deliberately conservative: whenever it cannot tell what the engine would do (a `/` after
 * `)`, `}`, `++` or `--` may be a division or a regex, an interpolation with quotes or comments, a number
 * glued to an identifier, a non-ASCII character in code...) it REFUSES the script. A false positive costs one
 * suggestion; a refused script is never executed anywhere (not even in the child) and is never offered to
 * the user (see nl-generate.js).
 */

// Identifiers refused anywhere (including after a dot).
const DENIED_IDENTIFIERS = new Set([
  'constructor', '__proto__', 'prototype', 'this', 'eval', 'Function', 'AsyncFunction', 'GeneratorFunction',
  'process', 'require', 'module', 'exports', 'global', 'globalThis', 'window', 'self', 'import', 'with',
  'arguments', 'caller', 'callee', 'Reflect', 'Proxy', 'Symbol', 'WebAssembly', 'SharedArrayBuffer', 'Atomics',
  'getPrototypeOf', 'setPrototypeOf', 'defineProperty', 'defineProperties', 'assign', 'freeze', 'seal',
  'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'getOwnPropertyNames', 'getOwnPropertySymbols',
  'entries', 'fromEntries', 'hasOwn', 'call', 'apply', 'bind', 'class', 'extends', 'super', 'export',
  'while', 'do',
  'preventExtensions', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
  'prepareStackTrace', 'captureStackTrace', 'stackTraceLimit', 'stack', 'delete', 'fetch', 'XMLHttpRequest',
  'sendRequest', 'executeRequest', 'setNextRequest', 'setNextRequestById', 'skipRequest', 'setTimeout',
  'setInterval', 'queueMicrotask', 'setImmediate', 'crypto', 'Buffer', 'TextDecoder', 'TextEncoder',
]);
const DENIED_IN_STRINGS = ['constructor', '__proto__', 'prototype', '__define', '__lookup'];
// Built-ins shared with the host: may be called through (`Object.keys(x)`) but not aliased or mutated.
const BUILTINS = new Set(['Object', 'Array', 'JSON', 'Math', 'String', 'Number', 'Boolean', 'Date', 'RegExp', 'Error', 'Promise', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'btoa', 'atob', 'escape', 'unescape']);
const NON_VALUE_KEYWORDS = new Set(['return', 'typeof', 'in', 'of', 'case', 'yield', 'await', 'new', 'void', 'else', 'do', 'throw', 'instanceof', 'const', 'let', 'var']);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '||=', '&&=', '??=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '++', '--']);
const MAX_SCRIPT_CHARS = 12000;

class ScreenError extends Error {}

const LINE_TERMINATORS = new Set(['\n', '\r', ' ', ' ']);
// Every character V8 treats as white space or a line terminator (ECMAScript WhiteSpace + LineTerminator).
const WHITESPACE = new Set(['\t', '\v', '\f', ' ', ' ', '﻿', ' ', ' ', ' ', ' ', ' ', ' ',
  ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　', '\n', '\r', ' ', ' ']);
// Escapes allowed inside strings/templates. No \x, \u, octal or line continuation: they can spell or split a denied word.
const SAFE_ESCAPES = new Set(['n', 'r', 't', 'b', 'f', 'v', '0', "'", '"', '\\', '/', '`', '$', ' ']);
const NUMBER_RE = /0[xX][0-9a-fA-F_]+n?|0[oO][0-7_]+n?|0[bB][01_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?/y;
const OPERATORS = ['>>>=', '**=', '||=', '&&=', '??=', '<<=', '>>=', '>>>', '...', '===', '!==', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '++', '--', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.'];
// Characters an interpolation may contain: nothing that could open a string, comment, regex, block or escape.
const SIMPLE_INTERPOLATION_RE = /^[A-Za-z0-9_$.\s+\-*%()[\],?:<>=!&|]*$/;

/** Tokenise just enough JavaScript to screen it. Throws ScreenError on anything it cannot follow with certainty. */
function tokenize(src, depth = 0) {
  if (depth > 3) throw new ScreenError('template literals are nested too deeply');
  const tokens = [];
  const n = src.length;
  let i = 0;
  const prevSig = () => tokens[tokens.length - 1];
  /** @returns {boolean} whether a `/` here starts a regex; throws when it cannot be decided. */
  const regexAllowed = () => {
    const p = prevSig();
    if (!p) return true;
    if (p.t === 'num' || p.t === 'str' || p.t === 'tpl' || p.t === 'tplx' || p.t === 'regex') return false;
    if (p.t === 'id') return NON_VALUE_KEYWORDS.has(p.v);
    if (p.t === 'p') {
      if (p.v === ']') return false;
      // `)` (if (x) /re/ vs (a) / b), `}` (block vs object literal), `++`/`--` (postfix vs prefix) are ambiguous.
      if (p.v === ')' || p.v === '}' || p.v === '++' || p.v === '--') throw new ScreenError('a "/" after ")", "}", "++" or "--" is ambiguous (division or regular expression)');
      return true;
    }
    return true;
  };
  const checkEscape = (ch) => {
    if (ch === undefined || !SAFE_ESCAPES.has(ch)) throw new ScreenError('escape sequences other than \\n \\t \\\\ \\\' \\" are not allowed in a validated script');
  };
  while (i < n) {
    const c = src[i];
    if (WHITESPACE.has(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && !LINE_TERMINATORS.has(src[i])) i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new ScreenError('unterminated comment');
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let v = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\n' || src[j] === '\r') throw new ScreenError('unterminated string');
        if (src[j] === '\\') { checkEscape(src[j + 1]); v += `\\${src[j + 1]}`; j += 2; } else { v += src[j]; j++; }
      }
      if (j >= n) throw new ScreenError('unterminated string');
      tokens.push({ t: 'str', v });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let v = '';
      let closed = false;
      while (j < n) {
        if (src[j] === '\\') { checkEscape(src[j + 1]); v += `\\${src[j + 1]}`; j += 2; continue; }
        if (src[j] === '`') { closed = true; break; }
        if (src[j] === '$' && src[j + 1] === '{') {
          const end = src.indexOf('}', j + 2);
          if (end === -1) throw new ScreenError('unterminated template expression');
          const expr = src.slice(j + 2, end);
          if (!SIMPLE_INTERPOLATION_RE.test(expr)) throw new ScreenError('template interpolations may only contain simple expressions (no quotes, comments, braces or escapes)');
          for (const tok of tokenize(expr, depth + 1)) tokens.push(tok);
          // Interpolation can build strings: keep a marker so computed access after it is refused.
          tokens.push({ t: 'tplx' });
          j = end + 1;
          continue;
        }
        v += src[j];
        j++;
      }
      if (!closed) throw new ScreenError('unterminated template literal');
      tokens.push({ t: 'tpl', v });
      i = j + 1;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && (src[j] !== '/' || inClass)) {
        if (LINE_TERMINATORS.has(src[j])) throw new ScreenError('unterminated regular expression');
        if (src[j] === '\\') { j++; if (j >= n || LINE_TERMINATORS.has(src[j])) throw new ScreenError('unterminated regular expression'); }
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j++;
      }
      if (j >= n) throw new ScreenError('unterminated regular expression');
      j++;
      const flagsStart = j;
      while (j < n && /[A-Za-z]/.test(src[j])) j++;
      if (src.slice(flagsStart, j).includes('v')) throw new ScreenError('regular expressions with the "v" flag are not allowed');
      tokens.push({ t: 'regex', v: src.slice(i + 1, flagsStart - 1) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(src);
      if (!m) throw new ScreenError('malformed number');
      const j = i + m[0].length;
      if (j < n && /[A-Za-z0-9_$\\]/.test(src[j])) throw new ScreenError('a number glued to an identifier is not allowed');
      tokens.push({ t: 'num', v: m[0] });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      tokens.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '\\') throw new ScreenError('unicode escapes in identifiers are not allowed');
    if (c.charCodeAt(0) > 126 || c.charCodeAt(0) < 32) throw new ScreenError('non-ASCII or control characters are not allowed outside text');
    const four = src.slice(i, i + 4);
    const op = OPERATORS.find(o => four.startsWith(o));
    if (op) { tokens.push({ t: 'p', v: op }); i += op.length; continue; }
    tokens.push({ t: 'p', v: c });
    i++;
  }
  return tokens;
}

function matchingBracket(tokens, open) {
  let d = 0;
  for (let k = open; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t !== 'p') continue;
    if (t.v === '[') d++;
    else if (t.v === ']') { d--; if (d === 0) return k; }
  }
  return -1;
}

/** Index content that cannot build a property name: a number, a plain string, or `<path>.length - N`. */
function isSafeIndex(inner) {
  if (inner.length === 1 && inner[0].t === 'num') return true;
  if (inner.length === 1 && inner[0].t === 'str') return true;
  // path.to.length - 1  /  path.length
  const idPath = (toks) => toks.length >= 3 && toks.length % 2 === 1
    && toks.every((t, k) => (k % 2 === 0 ? t.t === 'id' : t.t === 'p' && t.v === '.'));
  if (inner.length >= 3 && inner[inner.length - 1].t === 'num'
    && inner[inner.length - 2].t === 'p' && (inner[inner.length - 2].v === '-')) {
    const path = inner.slice(0, -2);
    return idPath(path) && path[path.length - 1].v === 'length';
  }
  return idPath(inner) && inner[inner.length - 1].v === 'length';
}

/**
 * `for` is only accepted when it visibly ends: `for (const x of <expr>)`, `for (const k in <expr>)` or a counter
 * loop `for (let i = <num>; i < <num | path.length>; i++)`. `for await`, empty conditions and anything else is refused.
 * (`while` and `do` are refused as identifiers.)
 */
function checkFor(tokens, k) {
  const open = tokens[k + 1];
  if (!open || open.t !== 'p' || open.v !== '(') return '"for" must be followed by "(" (for await is not allowed)';
  let d = 0;
  let close = -1;
  for (let m = k + 1; m < tokens.length; m++) {
    const t = tokens[m];
    if (t.t !== 'p') continue;
    if (t.v === '(') d++;
    else if (t.v === ')') { d--; if (d === 0) { close = m; break; } }
  }
  if (close === -1) return 'unbalanced parentheses in a "for" loop';
  const head = tokens.slice(k + 2, close);
  const isId = (t, v) => t && t.t === 'id' && (v === undefined || t.v === v);
  const isP = (t, v) => t && t.t === 'p' && t.v === v;
  // for (const x of expr) / for (const k in expr) / for (const [a, b] of expr)
  if (head.length >= 4 && ['const', 'let', 'var'].includes(head[0].v) && head[0].t === 'id') {
    const ofIn = head.findIndex((t, idx) => idx > 1 && t.t === 'id' && (t.v === 'of' || t.v === 'in'));
    const semi = head.some(t => isP(t, ';'));
    if (ofIn !== -1 && !semi) return null;
  }
  // for (let i = 0; i < limit; i++)
  const semis = head.map((t, idx) => (isP(t, ';') ? idx : -1)).filter(idx => idx !== -1);
  if (semis.length === 2) {
    const init = head.slice(0, semis[0]);
    const cond = head.slice(semis[0] + 1, semis[1]);
    const step = head.slice(semis[1] + 1);
    const counter = init[1];
    const initOk = init.length === 4 && ['const', 'let', 'var'].includes(init[0].v) && isId(init[1]) && isP(init[2], '=') && init[3].t === 'num';
    const limitOk = (toks) => (toks.length === 1 && toks[0].t === 'num')
      || (toks.length >= 3 && toks.length % 2 === 1 && toks.every((t, idx) => (idx % 2 === 0 ? t.t === 'id' : isP(t, '.'))) && toks[toks.length - 1].v === 'length');
    const condOk = cond.length >= 3 && isId(cond[0], counter && counter.v) && (isP(cond[1], '<') || isP(cond[1], '<=')) && limitOk(cond.slice(2));
    const stepOk = step.length === 2 && ((isId(step[0], counter && counter.v) && isP(step[1], '++')) || (isP(step[0], '++') && isId(step[1], counter && counter.v)));
    if (initOk && condOk && stepOk) return null;
  }
  return 'only "for (const x of list)", "for (const k in object)" and "for (let i = 0; i < list.length; i++)" loops are allowed in a validated script';
}

/**
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function screenScript(code) {
  if (typeof code !== 'string') return { ok: false, reason: 'script is not text' };
  if (code.length > MAX_SCRIPT_CHARS) return { ok: false, reason: `script is longer than ${MAX_SCRIPT_CHARS} characters` };
  let tokens;
  try { tokens = tokenize(code); } catch (e) {
    if (e instanceof ScreenError) return { ok: false, reason: e.message };
    throw e;
  }
  const hasLoop = tokens.some(t => t.t === 'id' && t.v === 'for');
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    if (t.t === 'id') {
      if (t.v === 'for') {
        const bad = checkFor(tokens, k);
        if (bad) return { ok: false, reason: bad };
      }
      if (t.v === 'await' && hasLoop) return { ok: false, reason: '"await" next to a loop is not allowed in a validated script' };
      if ((t.v === 'get' || t.v === 'set') && next && (next.t === 'id' || next.t === 'str' || next.t === 'num' || (next.t === 'p' && next.v === '['))
        && prev && prev.t === 'p' && (prev.v === '{' || prev.v === ',')) {
        return { ok: false, reason: 'getters and setters are not allowed in a validated script' };
      }
      if (t.v === 'new' && next && next.t === 'p' && next.v === '.') return { ok: false, reason: '"new.target" is not allowed in a validated script' };
      if (DENIED_IDENTIFIERS.has(t.v)) return { ok: false, reason: `"${t.v}" is not allowed in a validated script` };
      if (BUILTINS.has(t.v) && !(prev && prev.t === 'p' && prev.v === '.')) {
        const follow = next && next.t === 'p' ? next.v : null;
        const afterInstanceof = prev && prev.t === 'id' && prev.v === 'instanceof';
        if (!afterInstanceof && follow !== '.' && follow !== '(' && follow !== ')' && follow !== '?.') {
          return { ok: false, reason: `built-in "${t.v}" cannot be aliased` };
        }
        // Object.keys = ..., JSON.parse += ...
        let m = k + 1;
        while (tokens[m] && tokens[m].t === 'p' && (tokens[m].v === '.') && tokens[m + 1] && tokens[m + 1].t === 'id') m += 2;
        if (m > k + 1 && tokens[m] && tokens[m].t === 'p' && ASSIGN_OPS.has(tokens[m].v)) {
          return { ok: false, reason: `built-in "${t.v}" cannot be modified` };
        }
      }
    } else if (t.t === 'str' || t.t === 'tpl') {
      const lower = t.v.toLowerCase();
      const bad = DENIED_IN_STRINGS.find(w => lower.includes(w));
      if (bad) return { ok: false, reason: `text containing "${bad}" is not allowed in a validated script` };
      if (/\\(?:x[0-9a-f]{2}|u[0-9a-f]{4}|u\{)/i.test(t.v)) {
        // "\x63onstructor": escapes could spell a denied word.
        return { ok: false, reason: 'escape sequences in text are not allowed in a validated script' };
      }
    } else if (t.t === 'p' && t.v === '[') {
      const close = matchingBracket(tokens, k);
      if (close === -1) return { ok: false, reason: 'unbalanced brackets' };
      const prevIsValue = prev && (
        (prev.t === 'id' && !NON_VALUE_KEYWORDS.has(prev.v))
        || prev.t === 'str' || prev.t === 'tpl' || prev.t === 'num' || prev.t === 'tplx' || prev.t === 'regex'
        || (prev.t === 'p' && (prev.v === ')' || prev.v === ']' || prev.v === '}' || prev.v === '{'))
      );
      const afterClose = tokens[close + 1];
      const computedKey = afterClose && afterClose.t === 'p' && afterClose.v === ':';
      const afterQuestion = prev && prev.t === 'p' && prev.v === '?.';
      if (prevIsValue || computedKey || afterQuestion) {
        if (!isSafeIndex(tokens.slice(k + 1, close))) {
          return { ok: false, reason: 'computed property access is only allowed with a literal index' };
        }
      }
    } else if (t.t === 'tplx') {
      // Interpolated templates are fine as values; nothing to do (see the `[` rule above).
    }
  }
  return { ok: true };
}

module.exports = { screenScript, DENIED_IDENTIFIERS, MAX_SCRIPT_CHARS };
