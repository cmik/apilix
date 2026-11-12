'use strict';

/**
 * Static screen applied to model-written scripts BEFORE they are dry-run.
 *
 * Why: the Apilix script sandbox is a `vm` context that shares host intrinsics (`Object`, `apx`
 * functions...). That is acceptable for scripts the user writes, but a script written by a model
 * (possibly steered by a prompt injection hidden in a response body) must not be able to reach
 * `Function` (via `.constructor`) or tamper with built-ins. The screen refuses everything that
 * could do so; a refused script is never executed (it is dropped, or shown as "not validated").
 *
 * It is a defence-in-depth filter, NOT a substitute for process isolation. Keep it conservative:
 * a false positive only costs one suggestion, a false negative would run hostile code.
 */

// Identifiers refused anywhere (including after a dot).
const DENIED_IDENTIFIERS = new Set([
  'constructor', '__proto__', 'prototype', 'this', 'eval', 'Function', 'AsyncFunction', 'GeneratorFunction',
  'process', 'require', 'module', 'exports', 'global', 'globalThis', 'window', 'self', 'import', 'with',
  'arguments', 'caller', 'callee', 'Reflect', 'Proxy', 'Symbol', 'WebAssembly', 'SharedArrayBuffer', 'Atomics',
  'getPrototypeOf', 'setPrototypeOf', 'defineProperty', 'defineProperties', 'assign', 'freeze', 'seal',
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

/** Tokenise just enough JavaScript to screen it. Throws ScreenError on anything it cannot follow. */
function tokenize(src, depth = 0) {
  if (depth > 5) throw new ScreenError('template literals are nested too deeply');
  const tokens = [];
  const n = src.length;
  let i = 0;
  const prevSig = () => tokens[tokens.length - 1];
  const regexAllowed = () => {
    const p = prevSig();
    if (!p) return true;
    if (p.t === 'num' || p.t === 'str' || p.t === 'tpl') return false;
    if (p.t === 'id') return NON_VALUE_KEYWORDS.has(p.v);
    if (p.t === 'p') return !(p.v === ')' || p.v === ']' || p.v === '}');
    return true;
  };
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
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
        if (src[j] === '\n') throw new ScreenError('unterminated string');
        if (src[j] === '\\') { v += src[j + 1] === undefined ? '' : `\\${src[j + 1]}`; j += 2; } else { v += src[j]; j++; }
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
        if (src[j] === '\\') { v += src[j + 1] === undefined ? '' : `\\${src[j + 1]}`; j += 2; continue; }
        if (src[j] === '`') { closed = true; break; }
        if (src[j] === '$' && src[j + 1] === '{') {
          let d = 1;
          let k = j + 2;
          while (k < n && d > 0) {
            if (src[k] === '{') d++;
            else if (src[k] === '}') d--;
            else if (src[k] === '`' || src[k] === '"' || src[k] === "'") {
              // Skip a nested string/template inside the expression.
              const q = src[k];
              k++;
              while (k < n && src[k] !== q) { if (src[k] === '\\') k++; k++; }
            }
            k++;
          }
          if (d !== 0) throw new ScreenError('unterminated template expression');
          // The expression content is screened like normal code, wrapped so `[` etc. keep their context.
          for (const tok of tokenize(src.slice(j + 2, k - 1), depth + 1)) tokens.push(tok);
          // Interpolation can build strings: keep a marker so computed access after it is refused.
          tokens.push({ t: 'tplx' });
          j = k;
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
        if (src[j] === '\n') throw new ScreenError('unterminated regular expression');
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j++;
      }
      if (j >= n) throw new ScreenError('unterminated regular expression');
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++;
      tokens.push({ t: 'str', v: '' }); // a regex literal behaves like a value, and is never a property key
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      while (j < n && /[0-9a-zA-Z_.]/.test(src[j])) j++;
      tokens.push({ t: 'num', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_$\u0080-￿]/.test(c) || c === '\\') {
      if (c === '\\') throw new ScreenError('unicode escapes in identifiers are not allowed');
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(src[j])) j++;
      tokens.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    // Punctuation: take the longest assignment-like operator, otherwise one character.
    const three = src.slice(i, i + 4);
    const op = ['>>>=', '**=', '||=', '&&=', '??=', '<<=', '>>=', '>>>', '...', '===', '!==', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '++', '--', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.']
      .find(o => three.startsWith(o));
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
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    if (t.t === 'id') {
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
        || prev.t === 'str' || prev.t === 'tpl' || prev.t === 'num' || prev.t === 'tplx'
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
