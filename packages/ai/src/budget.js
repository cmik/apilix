'use strict';

const { AiError } = require('./errors');

/** Rough token estimate (chars / 4). Labelled "estimate" everywhere it is shown. */
function estimateTokens(text) {
  if (text === undefined || text === null) return 0;
  return Math.ceil(String(text).length / 4);
}

function truncateText(text, maxTokens) {
  const str = text === undefined || text === null ? '' : String(text);
  const originalTokens = estimateTokens(str);
  if (originalTokens <= maxTokens) return { text: str, truncated: false, originalTokens };
  const keep = Math.max(0, maxTokens * 4);
  return { text: `${str.slice(0, keep)}\n…[truncated]`, truncated: true, originalTokens };
}

/** Shrink a JSON value: cap array length and nesting depth. */
function truncateJson(value, { maxTokens = Infinity, maxArrayItems = 5, maxDepth = 6 } = {}) {
  let truncated = false;
  const walk = (node, depth) => {
    if (Array.isArray(node)) {
      if (depth >= maxDepth) { truncated = true; return '[…]'; }
      let arr = node;
      if (node.length > maxArrayItems) { truncated = true; arr = node.slice(0, maxArrayItems); }
      return arr.map(n => walk(n, depth + 1));
    }
    if (node && typeof node === 'object') {
      if (depth >= maxDepth) { truncated = true; return '{…}'; }
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, depth + 1);
      return out;
    }
    return node;
  };
  let result = walk(value, 0);
  if (Number.isFinite(maxTokens) && estimateTokens(JSON.stringify(result)) > maxTokens) {
    truncated = true;
    result = truncateText(JSON.stringify(result), maxTokens).text;
  }
  return { value: result, truncated };
}

/** Throw TOO_LARGE when the summed parts exceed the budget. */
function assertWithinBudget(parts, maxContextTokens) {
  const total = (parts || []).reduce((n, p) => n + estimateTokens(p), 0);
  if (total > maxContextTokens) {
    throw new AiError('TOO_LARGE', `Context is about ${total} tokens, above the ${maxContextTokens} limit`);
  }
  return total;
}

module.exports = { estimateTokens, truncateText, truncateJson, assertWithinBudget };
