'use strict';

/**
 * Uniform random number in [0, 1) backed by the Web Crypto API (Node >= 19 and browsers),
 * so generated dynamic values (`$guid`, `$randomInt`, …) never rely on random01().
 */
function random01() {
  const buf = new Uint32Array(2);
  globalThis.crypto.getRandomValues(buf);
  // 53 random bits → double in [0, 1)
  return ((buf[0] >>> 5) * 67108864 + (buf[1] >>> 6)) / 9007199254740992;
}

/**
 * Resolve a $-prefixed dynamic token to a generated value.
 * Returns the generated string, or null if the token is not recognised.
 *
 * @param {string} token  Trimmed token starting with '$', e.g. '$guid' or '$randomInt(1,100)'.
 * @returns {string|null}
 */
function resolveDynamic(token) {
  // Parameterised: $randomInt(min,max), $randomFloat(min,max), $randomItem(a,b,c)
  const pm = token.match(/^\$(\w+)\(([^)]*)\)$/);
  if (pm) {
    const fn = pm[1];
    const parts = pm[2].split(',').map(s => s.trim());
    if (fn === 'randomInt') {
      const parsedMin = parseInt(parts[0], 10);
      const parsedMax = parseInt(parts[1], 10);
      const min = isNaN(parsedMin) ? 0 : parsedMin;
      const max = isNaN(parsedMax) ? 9999 : parsedMax;
      return String(Math.floor(random01() * (max - min + 1)) + min);
    }
    if (fn === 'randomFloat') {
      const parsedMin = parseFloat(parts[0]);
      const parsedMax = parseFloat(parts[1]);
      const min = isNaN(parsedMin) ? 0 : parsedMin;
      const max = isNaN(parsedMax) ? 1 : parsedMax;
      return (random01() * (max - min) + min).toFixed(2);
    }
    if (fn === 'randomItem') {
      return parts[Math.floor(random01() * parts.length)] ?? '';
    }
    return null;
  }
  // No-argument tokens
  switch (token) {
    case '$guid':
    case '$uuid':
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.floor(random01() * 16);
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    case '$timestamp':
      return String(Date.now());
    case '$isoTimestamp':
    case '$isoDate':
      return new Date().toISOString();
    case '$randomInt':
      return String(Math.floor(random01() * 10000));
    default:
      return null;
  }
}

/**
 * Resolve {{variable}} tokens in a string against a flat key-value map.
 * Tokens starting with '$' are resolved as dynamic values (UUID, timestamp, etc.)
 * before the map lookup, so they cannot be shadowed by user-defined variables.
 * Non-string values are returned as-is. Unknown tokens are left unchanged.
 *
 * @param {unknown} str  Value to resolve (only strings are processed).
 * @param {Record<string, string>} vars  Key-value variable map.
 * @returns {unknown} Resolved value.
 */
function resolveVariables(str, vars) {
  if (typeof str !== 'string') return str;
  // Linear scan equivalent to /\{\{([^}]+)\}\}/g. The regex rescans to the end of the string for every
  // unterminated "{{" (quadratic on "{{{{{{..."); here the next "}" position is cached between starts.
  let out = '';
  let last = 0;
  let close = -1; // index of the first "}" at or after the current search position
  let i = str.indexOf('{{');
  while (i !== -1) {
    if (close < i + 2) {
      close = str.indexOf('}', i + 2);
      if (close === -1) break; // no "}" left: no later "{{" can terminate either
    }
    if (close > i + 2 && str.charCodeAt(close + 1) === 125 /* } */) {
      const match = str.slice(i, close + 2);
      const trimmed = str.slice(i + 2, close).trim();
      let rep;
      if (trimmed.startsWith('$')) {
        const dynamic = resolveDynamic(trimmed);
        rep = dynamic !== null ? dynamic : match;
      } else {
        rep = vars[trimmed] !== undefined ? vars[trimmed] : match;
      }
      out += str.slice(last, i) + rep;
      last = close + 2;
      i = str.indexOf('{{', last);
    } else {
      i = str.indexOf('{{', i + 1);
    }
  }
  return last === 0 && out === '' ? str : out + str.slice(last);
}

module.exports = { resolveVariables };
