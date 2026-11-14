'use strict';

const { estimateTokens, truncateText, truncateJson } = require('./budget');
const { buildShapeSchema, shapeOfText, prepareRequest, prepareResponseHead, prepareExistingTests } = require('./shape');
const { redactContext, scrubSecretValues, scrubTokenPatterns } = require('./redact');

const MAX_EXISTING_TESTS_CHARS = 1500;

const DEFAULT_MAX_CONTEXT_TOKENS = 8000;

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
  // The same helpers as the assert-suggest payload, then the same final scrub: what is shown is what is sent.
  const finalize = (text) => {
    const t = settings.redactSecrets !== false ? scrubTokenPatterns(text) : text;
    return scrubSecretValues(t, secretValues);
  };
  if (value.request) {
    pushText('Request', finalize(JSON.stringify(prepareRequest(value.request, item && item.name, shapeOnly), null, 2)));
  }
  const testScript = value.scripts && value.scripts.test;
  if (testScript) {
    const sent = prepareExistingTests(testScript, shapeOnly, MAX_EXISTING_TESTS_CHARS);
    pushText(shapeOnly ? 'Existing tests (titles only)' : 'Test script', finalize(shapeOnly ? JSON.stringify(sent.existingTestTitles, null, 2) : sent.existingTests));
  }

  if (value.response) {
    const head = JSON.stringify(prepareResponseHead(value.response, response, shapeOnly), null, 2);
    pushText('Response (status and headers)', finalize(head));
    const body = typeof value.response.body === 'string' ? value.response.body : '';
    const parsed = tryParse(body);
    if (shapeOnly) {
      pushText('Response body (shape only)', JSON.stringify(shapeOfText(body), null, 2));
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
