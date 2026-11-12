'use strict';

const axios = require('axios');
const { fromAxiosError, AiError } = require('../errors');

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

async function post(http, config, transport, body, signal) {
  const headers = { 'content-type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  return http.post(chatUrl(config.baseUrl), body, {
    headers,
    timeout: config.timeoutMs,
    signal,
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
  const baseBody = {
    model: config.model,
    max_tokens: maxTokens || 1024,
  };
  const withSystem = (sys) => (sys ? [{ role: 'system', content: sys }, ...messages] : messages);
  let res;
  try {
    if (schema) {
      try {
        res = await post(http, config, transport, {
          ...baseBody,
          messages: withSystem(system),
          response_format: { type: 'json_schema', json_schema: { name: schemaName, schema, strict: false } },
        }, signal);
      } catch (err) {
        const status = err && err.response && err.response.status;
        if (status !== 400 && status !== 422) throw err;
        const hint = `Reply with a single JSON value matching this JSON schema and nothing else:\n${JSON.stringify(schema)}`;
        res = await post(http, config, transport, {
          ...baseBody,
          messages: withSystem(system ? `${system}\n\n${hint}` : hint),
        }, signal);
      }
    } else {
      res = await post(http, config, transport, { ...baseBody, messages: withSystem(system) }, signal);
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

module.exports = { call, chatUrl, parseJsonLoose };
