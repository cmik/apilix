'use strict';

/**
 * Resolve {{variable}} tokens in a string against a flat key-value map.
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
    return vars[trimmed] !== undefined ? vars[trimmed] : match;
  });
}

module.exports = { resolveVariables };
