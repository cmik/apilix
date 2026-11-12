'use strict';

const HTTP_STATUS = {
  AUTH: 401,
  RATE_LIMIT: 429,
  INVALID_OUTPUT: 422,
  TOO_LARGE: 413,
  NO_PROVIDER: 409,
  DISABLED: 403,
  ABORTED: 499,
  TIMEOUT: 504,
  NETWORK: 502,
};

class AiError extends Error {
  /**
   * @param {keyof typeof HTTP_STATUS} code
   * @param {string} message
   * @param {{ retryable?: boolean }} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = HTTP_STATUS[code] || 500;
    this.retryable = opts.retryable === true;
  }
}

function httpStatusFor(code) {
  return HTTP_STATUS[code] || 500;
}

/**
 * Convert an axios (or generic) error into an AiError WITHOUT keeping the
 * original object: axios errors embed `config.headers` which holds the API key.
 */
function fromAxiosError(err) {
  if (err instanceof AiError) return err;
  const name = err && err.name;
  const code = err && err.code;
  if (name === 'CanceledError' || code === 'ERR_CANCELED') {
    return new AiError('ABORTED', 'Request aborted');
  }
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    return new AiError('TIMEOUT', 'The AI provider did not answer in time', { retryable: true });
  }
  const status = err && err.response && err.response.status;
  if (status === 401 || status === 403) {
    return new AiError('AUTH', 'The AI provider rejected the credentials');
  }
  if (status === 429) {
    return new AiError('RATE_LIMIT', 'The AI provider rate limit was reached', { retryable: true });
  }
  if (status) {
    const detail = providerMessage(err.response.data);
    return new AiError('NETWORK', `The AI provider returned HTTP ${status}${detail ? `: ${detail}` : ''}`, {
      retryable: status >= 500,
    });
  }
  return new AiError('NETWORK', `Could not reach the AI provider${code ? ` (${code})` : ''}`, { retryable: true });
}

function providerMessage(data) {
  try {
    const m = data && (data.error && (data.error.message || data.error)) || data && data.message;
    return typeof m === 'string' ? m.slice(0, 300) : '';
  } catch { return ''; }
}

module.exports = { AiError, httpStatusFor, fromAxiosError, providerMessage };
