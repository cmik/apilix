'use strict';

/**
 * The real `apx.*` API surface, read from @apilix/core's script runtime by introspection (property
 * descriptors only: no getter of the assertion chain is ever invoked). One source of truth for:
 *  - scripts/gen-apx-reference.js (the reference embedded in the scripting prompt),
 *  - the deterministic pm.* -> apx.* converter (script-convert.js), which uses it to report what remains.
 */

const { DENIED_IDENTIFIERS } = require('./script-screen');

let cached = null;

/** `(a, b = 1, c)` -> [{ name: 'a' }, { name: 'b', optional: true }, ...] */
function paramsOf(fn) {
  const src = Function.prototype.toString.call(fn);
  const m = /^(?:async\s+)?(?:function\b)?\s*\*?\s*[\w$]*\s*\(/.exec(src);
  if (!m) {
    const arrow = /^(?:async\s+)?([\w$]+)\s*=>/.exec(src);
    return arrow ? [{ name: arrow[1] }] : [];
  }
  let depth = 1;
  let i = m[0].length;
  const start = i;
  for (; i < src.length && depth > 0; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  const inner = src.slice(start, i - 1);
  const parts = [];
  let cur = '';
  let d = 0;
  for (const c of inner) {
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
    if (c === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean).map((p) => {
    const eq = p.indexOf('=');
    return eq === -1 ? { name: p.replace(/^\.\.\./, '...') } : { name: p.slice(0, eq).trim(), optional: true };
  });
}

const FN_OWN_SKIP = new Set(['length', 'name', 'prototype', 'arguments', 'caller']);

function describe(value, depth) {
  if (typeof value === 'function') {
    const node = { kind: 'fn', params: paramsOf(value), children: {} };
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (FN_OWN_SKIP.has(k) || typeof d.value !== 'function') continue;
      node.children[k] = describe(d.value, depth + 1);
    }
    return node;
  }
  if (value && typeof value === 'object' && depth < 6) {
    const node = { kind: 'obj', children: {} };
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (typeof d.get === 'function' && d.value === undefined) {
        // A data getter (apx.collectionVariables): safe to read. Anything that throws is skipped.
        let v;
        try { v = value[k]; } catch { continue; }
        node.children[k] = describe(v, depth + 1);
      } else {
        node.children[k] = describe(d.value, depth + 1);
      }
    }
    return node;
  }
  return { kind: 'value', type: value === null ? 'null' : typeof value };
}

/** Members of `apx.expect(x)`: getters are listed WITHOUT being read (reading one runs an assertion). */
function describeExpect(obj) {
  const props = [];
  const methods = [];
  let deep = null;
  for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(obj))) {
    if (typeof d.get === 'function') props.push(k);
    else if (typeof d.value === 'function') methods.push({ name: k, params: paramsOf(d.value) });
    else if (d.value && typeof d.value === 'object' && k === 'deep') deep = Object.keys(d.value);
  }
  return { props, methods, deep };
}

/** @returns {{ tree: object, expect: { props: string[], methods: Array<{name:string, params:object[]}>, deep: string[]|null } }} */
function getApxSurface() {
  if (cached) return cached;
  const { createApx } = require('@apilix/core/script-runtime');
  const apx = createApx({ code: 200, status: 'OK', responseTime: 1, headers: {}, body: '{}', jsonData: {} }, {}, {}, {}, {}, {}, [], [], {}, [], {});
  const tree = describe(apx, 0);
  // `apx.expect` is a factory: its chain is described separately.
  const exp = describeExpect(apx.expect(1));
  const deepObj = Object.getOwnPropertyDescriptor(apx.expect(1), 'deep');
  if (deepObj && deepObj.value && typeof deepObj.value === 'object') exp.deep = Object.keys(deepObj.value);
  cached = { tree, expect: exp };
  return cached;
}

const signature = (name, params) => `${name}(${(params || []).map(p => (p.optional ? `${p.name}?` : p.name)).join(', ')})`;

/** Is this member refused in model-written scripts (network, flow control...)? */
function isRefusedName(name) { return DENIED_IDENTIFIERS.has(name); }

module.exports = { getApxSurface, paramsOf, signature, isRefusedName };
