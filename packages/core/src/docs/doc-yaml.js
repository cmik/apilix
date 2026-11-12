'use strict';

/**
 * Tiny YAML serializer for plain JSON-compatible data (objects, arrays,
 * strings, numbers, booleans, null). Used for OpenAPI YAML output so that
 * @apilix/core does not need a YAML dependency.
 */

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;

function scalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  const s = String(value);
  if (PLAIN_KEY.test(s) && !RESERVED.test(s)) return s;
  return JSON.stringify(s);
}

function key(k) {
  return PLAIN_KEY.test(k) && !RESERVED.test(k) ? k : JSON.stringify(k);
}

function isContainer(v) {
  return v !== null && typeof v === 'object';
}

function emit(value, indent) {
  const pad = '  '.repeat(indent);
  const lines = [];
  if (Array.isArray(value)) {
    if (!value.length) return ['[]'];
    for (const item of value) {
      if (isContainer(item) && (Array.isArray(item) ? item.length : Object.keys(item).length)) {
        const sub = emit(item, indent + 1);
        lines.push(`${pad}- ${sub[0].trimStart()}`, ...sub.slice(1));
      } else {
        lines.push(`${pad}- ${isContainer(item) ? (Array.isArray(item) ? '[]' : '{}') : scalar(item)}`);
      }
    }
    return lines;
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (!entries.length) return ['{}'];
  for (const [k, v] of entries) {
    if (isContainer(v)) {
      const empty = Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0;
      if (empty) {
        lines.push(`${pad}${key(k)}: ${Array.isArray(v) ? '[]' : '{}'}`);
      } else {
        lines.push(`${pad}${key(k)}:`, ...emit(v, indent + 1));
      }
    } else {
      lines.push(`${pad}${key(k)}: ${scalar(v)}`);
    }
  }
  return lines;
}

function toYaml(value) {
  if (!isContainer(value)) return `${scalar(value)}\n`;
  return `${emit(value, 0).join('\n')}\n`;
}

module.exports = { toYaml };
