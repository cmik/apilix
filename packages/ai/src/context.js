'use strict';

const { redactContext } = require('./redact');
const { estimateTokens, truncateText, truncateJson } = require('./budget');
const { prepareResponseHeaders, shapeRequestHeaderList } = require('./shape');

const DEFAULT_MAX_CONTEXT_TOKENS = 8000;

/** Describe the structure of a JSON value: types only, never values. */
function buildShapeSchema(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (depth >= 6) return ['…'];
    return value.length ? [buildShapeSchema(value[0], depth + 1)] : [];
  }
  if (typeof value === 'object') {
    if (depth >= 6) return '{…}';
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = buildShapeSchema(v, depth + 1);
    return out;
  }
  return typeof value;
}

function execToText(exec) {
  return Array.isArray(exec) ? exec.join('\n') : typeof exec === 'string' ? exec : '';
}

function itemScripts(item) {
  const scripts = {};
  for (const ev of (item && item.event) || []) {
    const text = execToText(ev && ev.script && ev.script.exec);
    if (text.trim()) scripts[ev.listen === 'test' ? 'test' : 'preRequest'] = text;
  }
  return scripts;
}

/** Full mode keeps the redacted headers as they are; shape-only shows what the payload sends. */
function prepareResponseHeadersForPreview(headers, shapeOnly) {
  return shapeOnly ? prepareResponseHeaders(headers, true) : headers;
}

function tryParse(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

/**
 * Build what WOULD be sent to the model, fully redacted. No network call.
 * @param {{ item?: object, response?: object, variablesMeta?: Array<{name:string, scope?:string, secret?:boolean}>,
 *   secretValues?: string[], settings?: { maxContextTokens?: number, redactSecrets?: boolean, sendResponseBodies?: boolean } }} input
 * @returns {{ sections: Array<{label:string, text:string, truncated:boolean}>, estimatedTokens:number, redactions:number }}
 */
function buildPreviewContext(input = {}) {
  const { item, response, variablesMeta, secretValues, settings = {} } = input;
  const maxTokens = settings.maxContextTokens > 0 ? settings.maxContextTokens : DEFAULT_MAX_CONTEXT_TOKENS;
  const { value, redactions } = redactContext(
    {
      request: item && item.request,
      response,
      scripts: itemScripts(item),
    },
    { secretValues, redactSecrets: settings.redactSecrets !== false },
  );

  const sections = [];
  let remaining = maxTokens;
  const push = (label, text, truncated = false) => {
    sections.push({ label, text, truncated });
    remaining = Math.max(0, remaining - estimateTokens(text));
  };
  const pushText = (label, text) => {
    const t = truncateText(text, Math.max(remaining, 50));
    push(label, t.text, t.truncated);
  };

  const shapeOnly = settings.sendResponseBodies === false;
  if (value.request) {
    // Shape-only: request header values are not sent either (names + protocol metadata only), same as the payload.
    const req = shapeOnly && Array.isArray(value.request.header)
      ? { ...value.request, header: shapeRequestHeaderList(value.request.header) }
      : value.request;
    pushText('Request', JSON.stringify(req, null, 2));
  }
  if (value.scripts) {
    for (const [name, src] of Object.entries(value.scripts)) {
      pushText(name === 'test' ? 'Test script' : 'Pre-request script', src);
    }
  }

  if (value.response) {
    const head = JSON.stringify({ status: value.response.status, statusText: value.response.statusText, headers: prepareResponseHeadersForPreview(value.response.headers, shapeOnly) }, null, 2);
    pushText('Response (status and headers)', head);
    const body = typeof value.response.body === 'string' ? value.response.body : '';
    const parsed = tryParse(body);
    if (shapeOnly) {
      const shape = parsed.ok ? buildShapeSchema(parsed.value) : { type: 'text', length: body.length };
      pushText('Response body (shape only)', JSON.stringify(shape, null, 2));
    } else if (parsed.ok) {
      const tj = truncateJson(parsed.value, { maxTokens: Math.max(remaining, 50) });
      push('Response body', typeof tj.value === 'string' ? tj.value : JSON.stringify(tj.value, null, 2), tj.truncated);
    } else {
      pushText('Response body', body);
    }
  }

  if (Array.isArray(variablesMeta) && variablesMeta.length) {
    const names = variablesMeta
      .map(v => `${v.scope ? `${v.scope}: ` : ''}${v.name}${v.secret ? ' (secret, value never sent)' : ''}`)
      .join('\n');
    pushText('Available variable names', names);
  }

  const estimatedTokens = sections.reduce((n, s) => n + estimateTokens(s.text), 0);
  return { sections, estimatedTokens, redactions };
}

module.exports = { buildPreviewContext, buildShapeSchema, DEFAULT_MAX_CONTEXT_TOKENS };
