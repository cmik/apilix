'use strict';

/**
 * Describe the undocumented parts of a DocModel with an LLM.
 *
 * Input is a DocModel produced by `buildDocModel` (already name-redacted). It is scrubbed once more
 * (known secret values, token shapes) before anything is sent, split into token-bounded batches,
 * and every answer is checked against the ids / parameter names that were actually asked about.
 */

const { AiError } = require('./errors');
const { estimateTokens, truncateText } = require('./budget');
const { scrubSecretValues, scrubTokenPatterns, REDACTED } = require('./redact');
const { getPrompt } = require('./prompts');

const COLLECTION_KEY = '__collection__';
const MAX_BATCHES = 20;
const MAX_ENTRIES_PER_BATCH = 25;
const MAX_DESCRIPTION_CHARS = 400;
const OUTPUT_RESERVE_TOKENS = 1500;
const SKIPPED_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'content-type', 'accept', 'user-agent', 'host', 'content-length', 'accept-encoding', 'connection']);

function missing(list, skip) {
  return (Array.isArray(list) ? list : []).filter(e => e && e.key && !e.description && !(skip && skip(e)));
}

/** Entries (collection, folders, requests) that lack a description or have undocumented parameters. */
function collectEntries(model) {
  const entries = [];
  if (!model.description) entries.push({ id: COLLECTION_KEY, kind: 'collection', name: model.title });
  const walk = (nodes, trail) => {
    for (const n of nodes) {
      if (n.type === 'folder') {
        if (!n.description) entries.push({ id: n.id, kind: 'folder', name: n.name, folder: trail.join(' / ') || undefined });
        walk(n.children || [], trail.concat(n.name));
      }
    }
  };
  walk(model.tree, []);
  for (const r of model.requests) {
    const params = [];
    const add = (list, where, skip) => {
      for (const p of missing(list, skip)) params.push({ name: p.key, in: where, ...(p.value && p.value !== REDACTED ? { example: p.value } : {}) });
    };
    add(r.pathVariables, 'path');
    add(r.query, 'query');
    add(r.headers, 'header', e => SKIPPED_HEADERS.has(String(e.key).toLowerCase()));
    if (r.body && Array.isArray(r.body.fields)) add(r.body.fields, 'body');
    if (!r.description || params.length) {
      const entry = {
        id: r.id,
        kind: 'request',
        name: r.name,
        method: r.method,
        url: r.fullUrl,
        ...(r.folderPath.length ? { folder: r.folderPath.join(' / ') } : {}),
        ...(r.description ? { hasDescription: true } : {}),
        ...(params.length ? { params } : {}),
      };
      if (r.body && r.body.mode === 'raw' && r.body.raw) entry.body = truncateText(r.body.raw, 250).text;
      const ex = (r.examples || []).find(e => e.body);
      if (ex) entry.exampleResponse = { status: ex.status || ex.code, body: truncateText(ex.body, 200).text };
      entries.push(entry);
    }
  }
  return entries;
}

/** Split entries into batches that fit the context budget. */
function buildBatches(entries, { maxContextTokens = 8000, secretValues, redactSecrets = true } = {}) {
  const budget = Math.max(500, maxContextTokens - OUTPUT_RESERVE_TOKENS);
  const batches = [];
  let current = [];
  let used = 0;
  for (const raw of entries) {
    let text = JSON.stringify(raw);
    if (redactSecrets !== false) text = scrubTokenPatterns(text);
    text = scrubSecretValues(text, secretValues);
    const entry = JSON.parse(text);
    const cost = estimateTokens(text);
    if (current.length && (used + cost > budget || current.length >= MAX_ENTRIES_PER_BATCH)) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(entry);
    used += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

function cleanText(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_CHARS);
}

/** Keep only what was asked: known ids, known parameter names, non-empty text. */
function sanitizeAnswer(batch, items) {
  const asked = new Map(batch.map(e => [e.id, e]));
  const out = {};
  for (const it of Array.isArray(items) ? items : []) {
    const entry = asked.get(it && it.id);
    if (!entry) continue;
    const d = {};
    const text = cleanText(it.description);
    if (text && !entry.hasDescription) d.description = text;
    const params = {};
    const names = new Set((entry.params || []).map(p => p.name));
    for (const p of Array.isArray(it.params) ? it.params : []) {
      const t = cleanText(p && p.description);
      if (t && p && names.has(p.name)) params[p.name] = t;
    }
    if (Object.keys(params).length) d.params = params;
    if (d.description || d.params) out[it.id] = d;
  }
  return out;
}

/**
 * @param {{ provider: { complete: Function }, model: object, language?: string,
 *   maxContextTokens?: number, secretValues?: string[], redactSecrets?: boolean, signal?: AbortSignal }} input
 * @returns {Promise<{ descriptions: Record<string, {description?: string, params?: Record<string,string>}>,
 *   warnings: string[], usage: {inputTokens:number, outputTokens:number}, requested: number }>}
 */
async function describeDocs({ provider, model, language, maxContextTokens, secretValues, redactSecrets, signal }) {
  const entries = collectEntries(model);
  const usage = { inputTokens: 0, outputTokens: 0 };
  if (!entries.length) return { descriptions: {}, warnings: [], usage, requested: 0 };

  let batches = buildBatches(entries, { maxContextTokens, secretValues, redactSecrets });
  const warnings = [];
  if (batches.length > MAX_BATCHES) {
    warnings.push(`Too many entries: only the first ${MAX_BATCHES} batches were described.`);
    batches = batches.slice(0, MAX_BATCHES);
  }
  const descriptions = {};
  for (let i = 0; i < batches.length; i++) {
    const prompt = getPrompt('docDescribe', { language, data: JSON.stringify(batches[i], null, 1) });
    try {
      const r = await provider.complete({
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        schema: 'docDescribe',
        signal,
        maxTokens: 3000,
      });
      usage.inputTokens += r.usage.inputTokens;
      usage.outputTokens += r.usage.outputTokens;
      Object.assign(descriptions, sanitizeAnswer(batches[i], r.data && r.data.items));
    } catch (err) {
      if (err instanceof AiError && (err.code === 'ABORTED' || err.code === 'AUTH' || err.code === 'NO_PROVIDER')) throw err;
      // One bad batch must not lose the others.
      warnings.push(`Batch ${i + 1}/${batches.length} failed (${err instanceof AiError ? err.code : 'ERROR'}); its entries stay undocumented.`);
    }
  }
  return { descriptions, warnings, usage, requested: entries.length };
}

module.exports = { describeDocs, collectEntries, buildBatches, sanitizeAnswer, COLLECTION_KEY };
