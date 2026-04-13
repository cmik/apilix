'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { makeHttpsAgent } = require('./tlsUtils');

const allowInsecureTls = process.env.OAUTH_ALLOW_INSECURE_TLS === 'true';

// Pre-created agents for both SSL modes — reused across requests to preserve connection pooling.
// agentVerify includes the system CA store (Windows cert store + Mozilla bundle) so that
// enterprise / corporate CAs trusted by the OS are also honoured.
const agentVerify   = makeHttpsAgent(true);
const agentInsecure = makeHttpsAgent(false);

const httpClient = axios.create({
  httpsAgent: allowInsecureTls ? agentInsecure : agentVerify,
  timeout: 30000,
  validateStatus: () => true, // never throw based on status code
});

/**
 * Build an axios config object that respects the oauth2Config sslVerification setting.
 * Undefined is treated as false (verification disabled). Always returns an explicit
 * cached Agent to preserve connection pooling.
 */
function buildRequestConfig(oauth2Config) {
  return {
    httpsAgent: oauth2Config.sslVerification === true ? agentVerify : agentInsecure,
  };
}

// ─── PKCE Helper Functions ────────────────────────────────────────────────────

/**
 * Generate a PKCE code verifier (43-128 chars, unreserved chars only)
 */
function generatePKCEVerifier() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let verifier = '';
  for (let i = 0; i < 128; i++) {
    verifier += chars.charAt(crypto.randomInt(chars.length));
  }
  return verifier;
}

/**
 * Generate PKCE code challenge from verifier (SHA256 hash, base64url encoded)
 */
function generatePKCEChallenge(verifier) {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return base64URLEncode(hash);
}

/**
 * Verify that verifier matches the challenge
 */
function verifyPKCEChallenge(verifier, challenge) {
  const computed = generatePKCEChallenge(verifier);
  return computed === challenge;
}

/**
 * Base64 URL encode (used by PKCE)
 */
function base64URLEncode(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// ─── OAuth 2.0 Token Exchange ─────────────────────────────────────────────────

/**
 * Refresh or obtain an OAuth 2.0 access token
 * @param {Object} oauth2Config - OAuth 2.0 configuration from CollectionAuth.oauth2
 * @param {Object} vars - Variables for resolving {{}} placeholders
 * @returns {Promise<{accessToken, refreshToken, expiresAt}>}
 */
async function refreshOAuth2Token(oauth2Config, vars = {}) {
  if (!oauth2Config) {
    throw new Error('OAuth 2.0 config is required');
  }

  const { grantType, scopes, customHeaders } = oauth2Config;
  const clientId = resolveVariables(oauth2Config.clientId, vars);
  const clientSecret = resolveVariables(oauth2Config.clientSecret, vars);
  const tokenUrl = resolveVariables(oauth2Config.tokenUrl, vars);
  const refreshToken = resolveVariables(oauth2Config.refreshToken, vars);

  if (!clientId || !tokenUrl) {
    throw new Error('Missing required OAuth 2.0 fields: clientId and tokenUrl');
  }

  let tokenBody = {};
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    ...buildCustomHeaders(customHeaders, vars),
  };

  try {
    switch (grantType) {
      case 'client_credentials': {
        if (!clientSecret) {
          throw new Error('clientSecret is required for client_credentials grant');
        }
        tokenBody = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: scopes ? scopes.join(' ') : '',
        });
        break;
      }

      case 'refresh_token': {
        if (!refreshToken) {
          throw new Error('refreshToken is required for refresh_token grant');
        }
        if (!clientSecret) {
          throw new Error('clientSecret is required for refresh_token grant');
        }
        tokenBody = new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
        });
        break;
      }

      case 'authorization_code': {
        // Authorization Code flow tokens should normally be obtained client-side after user authorizes.
        // This is a fallback handler if the server needs to re-exchange a code.
        throw new Error('Authorization Code exchange should be handled client-side; ensure token was obtained before making this request');
      }

      default:
        throw new Error(`Unsupported grant type: ${grantType}`);
    }

    const response = await httpClient.post(tokenUrl, tokenBody, { headers, ...buildRequestConfig(oauth2Config) });

    if (response.status >= 400) {
      throw new Error(`Token endpoint returned ${response.status}: ${JSON.stringify(response.data)}`);
    }

    const data = parseTokenResponseData(response.data);
    if (!data.access_token) {
      throw new Error(`Token endpoint did not return access_token: ${JSON.stringify(data)}`);
    }

    const expiresIn = data.expires_in || 3600; // default 1 hour if not specified
    const expiresAt = Date.now() + expiresIn * 1000;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken, // keep existing refresh token if not provided
      expiresAt,
    };
  } catch (error) {
    throw new Error(`OAuth 2.0 token refresh failed: ${error.message}`);
  }
}

/**
 * Exchange authorization code for access token (Authorization Code flow)
 * @param {Object} oauth2Config - OAuth 2.0 configuration
 * @param {string} authorizationCode - Authorization code from provider
 * @param {string} codeVerifier - PKCE verifier (if PKCE was used)
 * @param {Object} vars - Variables for resolving placeholders
 * @returns {Promise<{accessToken, refreshToken, expiresAt}>}
 */
async function exchangeAuthorizationCodeForToken(oauth2Config, authorizationCode, codeVerifier, vars = {}) {
  if (!oauth2Config) {
    throw new Error('OAuth 2.0 config is required');
  }

  const clientId = resolveVariables(oauth2Config.clientId, vars);
  const clientSecret = resolveVariables(oauth2Config.clientSecret, vars);
  const tokenUrl = resolveVariables(oauth2Config.tokenUrl, vars);
  const redirectUrl = resolveVariables(oauth2Config.redirectUrl, vars);

  if (!clientId || !tokenUrl || !authorizationCode) {
    throw new Error('Missing required fields for authorization code exchange');
  }

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code: authorizationCode,
    redirect_uri: redirectUrl || 'http://localhost:3000/oauth/callback',
  });

  // Add client_secret if confidential client
  if (clientSecret) {
    tokenBody.append('client_secret', clientSecret);
  }

  // Add PKCE verifier if present
  if (codeVerifier) {
    tokenBody.append('code_verifier', codeVerifier);
  }

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    ...buildCustomHeaders(oauth2Config.customHeaders, vars),
  };

  try {
    const response = await httpClient.post(tokenUrl, tokenBody, { headers, ...buildRequestConfig(oauth2Config) });

    if (response.status >= 400) {
      throw new Error(`Token endpoint returned ${response.status}: ${JSON.stringify(response.data)}`);
    }

    const data = parseTokenResponseData(response.data);
    if (!data.access_token) {
      throw new Error(`Token endpoint did not return access_token`);
    }

    const expiresIn = data.expires_in || 3600;
    const expiresAt = Date.now() + expiresIn * 1000;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
    };
  } catch (error) {
    throw new Error(`Authorization code exchange failed: ${error.message}`);
  }
}

/**
 * Validate OAuth 2.0 configuration based on grant type
 */
function validateOAuth2Config(oauth2Config) {
  if (!oauth2Config) {
    return { valid: false, errors: ['OAuth 2.0 config is required'] };
  }

  const errors = [];
  const { grantType, clientId, clientSecret, authorizationUrl, tokenUrl } = oauth2Config;

  if (!grantType) errors.push('grantType is required');
  if (!clientId) errors.push('clientId is required');
  if (!tokenUrl) errors.push('tokenUrl is required');

  if (grantType === 'authorization_code' && !authorizationUrl) {
    errors.push('authorizationUrl is required for authorization_code grant');
  }

  if ((grantType === 'client_credentials' || grantType === 'refresh_token') && !clientSecret) {
    errors.push(`clientSecret is required for ${grantType} grant`);
  }

  if (grantType === 'refresh_token' && !oauth2Config.refreshToken) {
    errors.push('refreshToken is required for refresh_token grant');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Build custom headers from the OAuth config, resolving variables
 */
function buildCustomHeaders(customHeaders, vars = {}) {
  const headers = {};
  if (customHeaders && Array.isArray(customHeaders)) {
    customHeaders.forEach(h => {
      if (h.key && h.value) {
        const value = resolveVariables(h.value, vars);
        headers[h.key] = value;
      }
    });
  }
  return headers;
}

/**
 * Parse a token endpoint response defensively.
 * Some providers (e.g. GitHub) return application/x-www-form-urlencoded unless
 * Accept: application/json is sent. Axios may return the raw string in that case.
 */
function parseTokenResponseData(raw) {
  if (raw && typeof raw === 'object') {
    return raw; // axios already parsed JSON
  }
  if (typeof raw === 'string') {
    // Try form-encoded (e.g. "access_token=abc&token_type=bearer&...")
    try {
      const params = new URLSearchParams(raw);
      if (params.has('access_token')) {
        const obj = {};
        params.forEach((v, k) => { obj[k] = v; });
        return obj;
      }
    } catch (_) {
      // ignore
    }
    // Fall back to JSON parse
    try {
      return JSON.parse(raw);
    } catch (_) {
      // ignore
    }
  }
  return raw ?? {};
}

/**
 * Simple variable resolution (copied from executor.js)
 */
function resolveVariables(str, vars) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const trimmed = key.trim();
    return vars[trimmed] !== undefined ? vars[trimmed] : match;
  });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  generatePKCEVerifier,
  generatePKCEChallenge,
  verifyPKCEChallenge,
  refreshOAuth2Token,
  exchangeAuthorizationCodeForToken,
  validateOAuth2Config,
};
