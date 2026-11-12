'use strict';

const axios = require('axios');
const { fromAxiosError, AiError, providerMessage } = require('../errors');

const DEFAULT_BASE = 'https://api.openai.com/v1';

/** `http://localhost:11434` and `http://localhost:11434/v1` both resolve to …/v1/chat/completions. */
function chatUrl(baseUrl) {
  const base = String(baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  return /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function parseJsonLoose(text) {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

/** api.openai.com (default endpoint) uses `max_completion_tokens`; local servers keep `max_tokens`. */
function usesCompletionTokens(baseUrl) {
  if (!baseUrl) return true;
  try { return new URL(chatUrl(baseUrl)).hostname === 'api.openai.com'; } catch { return false; }
}

// Servers (and models) disagree on the name; remember what worked per destination+model.
const TOKEN_PARAM = new Map();
const tokenKey = (config) => `${String(config.baseUrl || DEFAULT_BASE).replace(/\/+$/, '')}|${config.model}`;

function rejectsParam(err, name) {
  const status = err && err.response && err.response.status;
  if (status !== 400 && status !== 422) return false;
  const msg = providerMessage(err.response.data);
  return msg.includes(name) && /unsupported|not supported|unrecognized|unknown|use|invalid/i.test(msg);
}

/** POST with the right output-limit parameter; on a 400 naming it, swaps it and retries once. */
async function postLimited(http, config, transport, body, limit, signal) {
  const key = tokenKey(config);
  const first = TOKEN_PARAM.get(key) || (usesCompletionTokens(config.baseUrl) ? 'max_completion_tokens' : 'max_tokens');
  const other = first === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
  try {
    const res = await post(http, config, transport, { ...body, [first]: limit }, signal);
    return res;
  } catch (err) {
    if (!rejectsParam(err, first)) throw err;
    const res = await post(http, config, transport, { ...body, [other]: limit }, signal);
    TOKEN_PARAM.set(key, other);
    return res;
  }
}

async function post(http, config, transport, body, signal) {
  const headers = { 'content-type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  return http.post(chatUrl(config.baseUrl), body, {
    headers,
    timeout: config.timeoutMs,
    signal,
    // Never follow redirects: the credential header would be replayed to another host.
    maxRedirects: 0,
    httpAgent: transport.httpAgent,
    httpsAgent: transport.httpsAgent,
    ...(transport.proxy !== undefined ? { proxy: transport.proxy } : {}),
  });
}

/**
 * One chat-completions call. Asks for `response_format: json_schema`; when the
 * server rejects it (older Ollama / LM Studio answer 400) it asks again with the
 * schema spelled out in the prompt. Output is validated by the caller.
 */
async function call({ config, transport = {}, system, messages, schema, schemaName = 'respond', signal, maxTokens }) {
  const http = transport.axiosInstance || axios;
  const limit = maxTokens || 1024;
  const baseBody = { model: config.model };
  const send = (body) => postLimited(http, config, transport, body, limit, signal);
  const withSystem = (sys) => (sys ? [{ role: 'system', content: sys }, ...messages] : messages);
  let res;
  try {
    if (schema) {
      try {
        res = await send({
          ...baseBody,
          messages: withSystem(system),
          response_format: { type: 'json_schema', json_schema: { name: schemaName, schema, strict: false } },
        });
      } catch (err) {
        const status = err && err.response && err.response.status;
        if (status !== 400 && status !== 422) throw err;
        const hint = `Reply with a single JSON value matching this JSON schema and nothing else:\n${JSON.stringify(schema)}`;
        res = await send({
          ...baseBody,
          messages: withSystem(system ? `${system}\n\n${hint}` : hint),
        });
      }
    } else {
      res = await send({ ...baseBody, messages: withSystem(system) });
    }
  } catch (err) {
    throw fromAxiosError(err);
  }
  const choice = res.data && Array.isArray(res.data.choices) ? res.data.choices[0] : null;
  const text = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
  if (!choice) throw new AiError('NETWORK', 'The AI provider returned an unexpected response');
  const usage = {
    inputTokens: (res.data.usage && res.data.usage.prompt_tokens) || 0,
    outputTokens: (res.data.usage && res.data.usage.completion_tokens) || 0,
  };
  return schema ? { data: parseJsonLoose(text), text, usage } : { text, usage };
}

module.exports = { call, chatUrl, parseJsonLoose, usesCompletionTokens };
