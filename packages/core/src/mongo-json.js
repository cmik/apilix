'use strict';

const JSON5 = require('json5');
const { ObjectId } = require('mongodb');

function looksLikeHexObjectId(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value);
}

function parseExtendedDate(raw) {
  const isValidInputType = typeof raw === 'string' || (typeof raw === 'number' && Number.isFinite(raw));
  if (!isValidInputType) {
    throw new Error(`Invalid $date value: ${JSON.stringify(raw)}`);
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid $date value: ${JSON.stringify(raw)}`);
  }
  return date;
}

function convertExtendedMongoTypes(value) {
  if (Array.isArray(value)) {
    return value.map(convertExtendedMongoTypes);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  if (Object.keys(value).length === 1 && Object.prototype.hasOwnProperty.call(value, '$oid')) {
    const oid = value.$oid;
    if (looksLikeHexObjectId(oid)) {
      return new ObjectId(oid);
    }
    return value;
  }

  if (Object.keys(value).length === 1 && Object.prototype.hasOwnProperty.call(value, '$date')) {
    return parseExtendedDate(value.$date);
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = convertExtendedMongoTypes(v);
  }
  return out;
}

// Mongo-shell-style constructor literals rewritten (as raw text, before JSON parsing) into
// their Extended JSON object form. Each entry returns the replacement text for a matched
// `Name("value")` / `new Name("value")` call, or null to leave the call untouched.
const SHELL_CONSTRUCTORS = {
  ObjectId: (rawValue) => (looksLikeHexObjectId(rawValue) ? `{ "$oid": "${rawValue}" }` : null),
  ISODate: (rawValue) => `{ "$date": "${rawValue}" }`,
};
const SHELL_CONSTRUCTOR_NAMES = Object.keys(SHELL_CONSTRUCTORS);

function rewriteMongoShellLiterals(text) {
  const src = String(text);
  const len = src.length;
  let i = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  let out = '';

  while (i < len) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
        quote = '';
      }
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    const isNew = src.startsWith('new', i) && (i === 0 || !/[A-Za-z0-9_$]/.test(src[i - 1])) && (i + 3 >= len || /\s/.test(src[i + 3]));
    let fnStart = isNew ? i + 3 : i;
    if (isNew) {
      while (fnStart < len && /\s/.test(src[fnStart])) fnStart += 1;
    }

    const constructorName = SHELL_CONSTRUCTOR_NAMES.find(
      (name) => src.startsWith(name, fnStart) && !(fnStart > 0 && /[A-Za-z0-9_$]/.test(src[fnStart - 1]))
    );
    if (!constructorName) {
      out += ch;
      i += 1;
      continue;
    }

    let j = fnStart + constructorName.length;
    while (j < len && /\s/.test(src[j])) j += 1;
    if (j >= len || src[j] !== '(') {
      out += ch;
      i += 1;
      continue;
    }
    j += 1;
    while (j < len && /\s/.test(src[j])) j += 1;
    if (j >= len || (src[j] !== '"' && src[j] !== "'")) {
      out += ch;
      i += 1;
      continue;
    }

    const strQuote = src[j];
    j += 1;
    const valueStart = j;
    let strEscaped = false;
    while (j < len) {
      const c = src[j];
      if (strEscaped) {
        strEscaped = false;
        j += 1;
        continue;
      }
      if (c === '\\') {
        strEscaped = true;
        j += 1;
        continue;
      }
      if (c === strQuote) break;
      j += 1;
    }
    if (j >= len) {
      out += ch;
      i += 1;
      continue;
    }
    const rawValue = src.slice(valueStart, j);
    j += 1;
    while (j < len && /\s/.test(src[j])) j += 1;
    if (j >= len || src[j] !== ')') {
      out += ch;
      i += 1;
      continue;
    }

    const replacement = SHELL_CONSTRUCTORS[constructorName](rawValue);
    if (replacement === null) {
      out += ch;
      i += 1;
      continue;
    }

    out += replacement;
    i = j + 1;
  }

  return out;
}

function parseMongoLikeJson(text) {
  try {
    return JSON5.parse(String(text));
  } catch (err) {
    const rewritten = rewriteMongoShellLiterals(text);
    if (rewritten === String(text)) throw err;
    return JSON5.parse(rewritten);
  }
}

function parseExtendedJson(text) {
  return convertExtendedMongoTypes(parseMongoLikeJson(text));
}

function parseJsonObject(text, fallback = {}, options = {}) {
  const { strict = false, label = 'JSON object' } = options;
  if (!text || !String(text).trim()) return fallback;
  try {
    const parsed = parseExtendedJson(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    if (strict) {
      throw new Error(`${label} must be an object`);
    }
    return fallback;
  } catch (err) {
    if (strict) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid ${label}: ${message}`);
    }
    return fallback;
  }
}

function parseJsonArray(text, fallback = [], options = {}) {
  const { strict = false, label = 'JSON array' } = options;
  if (!text || !String(text).trim()) return fallback;
  try {
    const parsed = parseExtendedJson(text);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (strict) {
      throw new Error(`${label} must be an array`);
    }
    return fallback;
  } catch (err) {
    if (strict) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid ${label}: ${message}`);
    }
    return fallback;
  }
}

module.exports = {
  looksLikeHexObjectId,
  convertExtendedMongoTypes,
  rewriteMongoShellLiterals,
  parseMongoLikeJson,
  parseExtendedJson,
  parseJsonObject,
  parseJsonArray,
};
