'use strict';

const axios = require('axios');
const { fromAxiosError } = require('../errors');

const DEFAULT_BASE = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

function messagesUrl(baseUrl) {
  const base = String(baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  return /\/v\d+$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
}

/**
 * One Messages API call. Structured output uses a single forced tool whose
 * input_schema is the target schema (root must be an object schema).
 * @returns {{ data?: any, text: string, usage: { inputTokens: number, outputTokens: number } }}
 */
async function call({ config, transport = {}, system, messages, schema, schemaName = 'respond', signal, maxTokens }) {
  const body = {
    model: config.model,
    max_tokens: maxTokens || 1024,
    messages,
  };
  if (system) body.system = system;
  if (schema) {
    body.tools = [{ name: schemaName, description: 'Return the answer in this exact structure.', input_schema: schema }];
    body.tool_choice = { type: 'tool', name: schemaName };
  }
  const http = transport.axiosInstance || axios;
  let res;
  try {
    res = await http.post(messagesUrl(config.baseUrl), body, {
      headers: {
        'x-api-key': config.apiKey || '',
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
      },
      timeout: config.timeoutMs,
      signal,
      httpAgent: transport.httpAgent,
      httpsAgent: transport.httpsAgent,
      ...(transport.proxy !== undefined ? { proxy: transport.proxy } : {}),
    });
  } catch (err) {
    throw fromAxiosError(err);
  }
  const content = Array.isArray(res.data && res.data.content) ? res.data.content : [];
  const toolUse = content.find(c => c.type === 'tool_use');
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('');
  const usage = {
    inputTokens: (res.data && res.data.usage && res.data.usage.input_tokens) || 0,
    outputTokens: (res.data && res.data.usage && res.data.usage.output_tokens) || 0,
  };
  if (schema) {
    return toolUse ? { data: toolUse.input, text: JSON.stringify(toolUse.input), usage } : { data: undefined, text, usage };
  }
  return { text, usage };
}

module.exports = { call, messagesUrl };
