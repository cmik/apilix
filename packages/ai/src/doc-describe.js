'use strict';

/**
 * Describe the undocumented parts of a DocModel with an LLM.
 *
 * Input is a DocModel produced by `buildDocModel` (already name-redacted). It is scrubbed once more
 * (known secret values, token shapes) before anything is sent, split into token-bounded batches,
 * and every answer is checked against the ids / parameter names that were actually asked about.
 */

const { neutralizeAiText } = require('@apilix/core/docs');
const { AiError } = require('./errors');
const { estimateTokens, truncateText } = require('./budget');
const { scrubSecretValues, scrubTokenPatterns, REDACTED } = require('./redact');
const { getPrompt } = require('./prompts');

const COLLECTION_KEY = '__collection__';
const MAX_BATCHES = 20;
const MAX_CONSECUTIVE_FAILURES = 2;
const MAX_ENTRIES_PER_BATCH = 25;
const MAX_DESCRIPTION_CHARS = 400;
const OUTPUT_RESERVE_TOKENS = 1500;
const SYSTEM_RESERVE_TOKENS = 500;
// Per-field caps: body and exampleResponse were already bounded, everything else was not.
const MAX_NAME_CHARS = 200;
const MAX_URL_CHARS = 300;
const MAX_FOLDER_CHARS = 200;
const MAX_EXAMPLE_CHARS = 80;
const MAX_PARAMS_PER_ENTRY = 40;
const SKIPPED_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'content-type', 'accept', 'user-agent', 'host', 'content-length', 'accept-encoding', 'connection']);

/** Parameter key shared with the doc model: the same name can exist in path, query, header and body. */
function paramKey(where, name) { return `${where}:${name}`; }

function clip(v, max) {
  const str = v === undefined || v === null ? '' : String(v);
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

function missing(list, skip) {
  return (Array.isArray(list) ? list : []).filter(e => e && e.key && !e.description && !(skip && skip(e)));
}

/** Entries (collection, folders, requests) that lack a description or have undocumented parameters. */
function collectEntries(model, warnings, stats) {
  const entries = [];
  if (!model.description) entries.push({ id: COLLECTION_KEY, kind: 'collection', name: clip(model.title, MAX_NAME_CHARS) });
  const walk = (nodes, trail) => {
    for (const n of nodes) {
      if (n.type === 'folder') {
        if (!n.description) entries.push({ id: n.id, kind: 'folder', name: clip(n.name, MAX_NAME_CHARS), folder: clip(trail.join(' / '), MAX_FOLDER_CHARS) || undefined });
        walk(n.children || [], trail.concat(n.name));
      }
    }
  };
  walk(model.tree, []);
  for (const r of model.requests) {
    const params = [];
    const add = (list, where, skip) => {
      for (const p of missing(list, skip)) params.push({ name: clip(p.key, MAX_NAME_CHARS), in: where, ...(p.value && p.value !== REDACTED ? { example: clip(p.value, MAX_EXAMPLE_CHARS) } : {}) });
    };
    add(r.pathVariables, 'path');
    add(r.query, 'query');
    add(r.headers, 'header', e => SKIPPED_HEADERS.has(String(e.key).toLowerCase()));
    if (r.body && Array.isArray(r.body.fields)) add(r.body.fields, 'body');
    if (params.length > MAX_PARAMS_PER_ENTRY) {
      if (warnings) warnings.push(`"${clip(r.name, 60)}" has ${params.length} undocumented parameters: only the first ${MAX_PARAMS_PER_ENTRY} were sent.`);
      params.length = MAX_PARAMS_PER_ENTRY;
    }
    if (!r.description || params.length) {
      const entry = {
        id: r.id,
        kind: 'request',
        name: clip(r.name, MAX_NAME_CHARS),
        method: r.method,
        url: clip(r.fullUrl, MAX_URL_CHARS),
        ...(r.folderPath.length ? { folder: clip(r.folderPath.join(' / '), MAX_FOLDER_CHARS) } : {}),
        ...(r.description ? { hasDescription: true } : {}),
        ...(params.length ? { params } : {}),
      };
      if (r.body && r.body.mode === 'raw' && r.body.raw) entry.body = truncateText(r.body.raw, 250).text;
      const ex = (r.examples || []).find(e => e.body);
      if (ex) entry.exampleResponse = { status: ex.status || ex.code, body: truncateText(ex.body, 200).text };
      entries.push(entry);
    }
  }
  return dropDuplicateIds(entries, warnings, stats);
}

/**
 * Answers are matched back by id, so two entries sharing an id (common after an import or a
 * duplication) would both receive the same text, one of them wrongly. Skip every such entry.
 */
function dropDuplicateIds(entries, warnings, stats) {
  const counts = new Map();
  for (const e of entries) counts.set(e.id, (counts.get(e.id) || 0) + 1);
  const dup = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
  if (!dup.length) return entries;
  if (stats) stats.skipped += entries.filter(e => counts.get(e.id) > 1).length;
  if (warnings) {
    warnings.push(`Skipped ${dup.length} id(s) shared by several items (${dup.slice(0, 3).map(String).join(', ')}${dup.length > 3 ? ', …' : ''}): give them unique ids to get descriptions.`);
  }
  return entries.filter(e => counts.get(e.id) === 1);
}

/** Split entries into batches that fit the context budget. */
function buildBatches(entries, { maxContextTokens = 8000, secretValues, redactSecrets = true, warnings, stats } = {}) {
  const budget = Math.max(500, maxContextTokens - OUTPUT_RESERVE_TOKENS - SYSTEM_RESERVE_TOKENS);
  const batches = [];
  let current = [];
  let used = 0;
  for (const raw of entries) {
    let text = JSON.stringify(raw);
    if (redactSecrets !== false) text = scrubTokenPatterns(text);
    text = scrubSecretValues(text, secretValues);
    const entry = JSON.parse(text);
    // Cost what is actually sent: the prompt pretty-prints each batch (indentation is not free).
    const cost = estimateTokens(JSON.stringify(entry, null, 1)) + 2;
    if (cost > budget) {
      if (stats) stats.skipped++;
      if (warnings) warnings.push(`Skipped "${clip(entry.name || entry.id, 60)}": too large for the context budget even after trimming.`);
      continue;
    }
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
  // The model's output is untrusted: strip images, links, URLs and HTML (the same function the
  // document builder applies, so nothing relies on the caller having used this module).
  return neutralizeAiText(v).slice(0, MAX_DESCRIPTION_CHARS);
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
    const askedParams = entry.params || [];
    const keys = new Set(askedParams.map(p => paramKey(p.in, p.name)));
    for (const p of Array.isArray(it.params) ? it.params : []) {
      const t = cleanText(p && p.description);
      if (!t || !p) continue;
      let key = null;
      if (typeof p.in === 'string' && p.in) {
        key = paramKey(p.in, p.name);
      } else {
        // The model omitted "in": accept it only when the name is unambiguous for this entry.
        const same = askedParams.filter(a => a.name === p.name);
        if (same.length === 1) key = paramKey(same[0].in, same[0].name);
      }
      if (key && keys.has(key)) params[key] = t;
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
 *   warnings: string[], usage: {inputTokens:number, outputTokens:number}, requested: number,
 *   failedBatches: number, skipped: number }>}
 */
async function describeDocs({ provider, model, language, maxContextTokens, secretValues, redactSecrets, signal }) {
  const warnings = [];
  const stats = { skipped: 0 };
  const entries = collectEntries(model, warnings, stats);
  const usage = { inputTokens: 0, outputTokens: 0 };
  if (!entries.length) return { descriptions: {}, warnings, usage, requested: 0, failedBatches: 0, skipped: stats.skipped };

  let batches = buildBatches(entries, { maxContextTokens, secretValues, redactSecrets, warnings, stats });
  if (batches.length > MAX_BATCHES) {
    warnings.push(`Too many entries: only the first ${MAX_BATCHES} batches were described.`);
    stats.skipped += batches.slice(MAX_BATCHES).reduce((n, b) => n + b.length, 0);
    batches = batches.slice(0, MAX_BATCHES);
  }
  const descriptions = {};
  let consecutiveFailures = 0;
  let failedBatches = 0;
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
      consecutiveFailures = 0;
    } catch (err) {
      if (err instanceof AiError && (err.code === 'ABORTED' || err.code === 'AUTH' || err.code === 'NO_PROVIDER')) throw err;
      const code = err instanceof AiError ? err.code : 'ERROR';
      // One bad batch must not lose the others...
      warnings.push(`Batch ${i + 1}/${batches.length} failed (${code}); its entries stay undocumented.`);
      consecutiveFailures++;
      failedBatches++;
      // ...but a systemic failure must not keep hitting the provider with every remaining batch.
      const remaining = batches.length - i - 1;
      if (remaining > 0 && (code === 'RATE_LIMIT' || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)) {
        warnings.push(code === 'RATE_LIMIT'
          ? `Stopped after the provider rate limit was hit: ${remaining} remaining batch(es) were not described.`
          : `Stopped after ${consecutiveFailures} consecutive failures: ${remaining} remaining batch(es) were not described.`);
        break;
      }
    }
  }
  // `failedBatches` > 0 or `skipped` > 0 means some entries were not described (callers may treat that as an error).
  return { descriptions, warnings, usage, requested: entries.length, failedBatches, skipped: stats.skipped };
}

module.exports = { describeDocs, paramKey, collectEntries, buildBatches, sanitizeAnswer, COLLECTION_KEY };
