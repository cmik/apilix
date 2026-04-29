'use strict';

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
      return String(Math.floor(Math.random() * (max - min + 1)) + min);
    }
    if (fn === 'randomFloat') {
      const parsedMin = parseFloat(parts[0]);
      const parsedMax = parseFloat(parts[1]);
      const min = isNaN(parsedMin) ? 0 : parsedMin;
      const max = isNaN(parsedMax) ? 1 : parsedMax;
      return (Math.random() * (max - min) + min).toFixed(2);
    }
    if (fn === 'randomItem') {
      return parts[Math.floor(Math.random() * parts.length)] ?? '';
    }
    return null;
  }
  // No-argument tokens
  switch (token) {
    case '$guid':
    case '$uuid':
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    case '$timestamp':
      return String(Date.now());
    case '$isoTimestamp':
    case '$isoDate':
      return new Date().toISOString();
    case '$randomInt':
      return String(Math.floor(Math.random() * 10000));
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
  return str.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const trimmed = key.trim();
    if (trimmed.startsWith('$')) {
      const dynamic = resolveDynamic(trimmed);
      return dynamic !== null ? dynamic : match;
    }
    return vars[trimmed] !== undefined ? vars[trimmed] : match;
  });
}

module.exports = { resolveVariables };
