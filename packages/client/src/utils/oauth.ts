/**
 * Client-side OAuth 2.0 utilities for Authorization Code flow with PKCE
 */

/**
 * Generate a random string for PKCE code verifier (43-128 characters)
 */
export function generatePKCEVerifier(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const verifierLength = 128;
  const maxRandomValue = 256 - (256 % chars.length);
  let verifier = '';

  while (verifier.length < verifierLength) {
    const randomBytes = new Uint8Array(verifierLength - verifier.length);
    crypto.getRandomValues(randomBytes);

    for (const byte of randomBytes) {
      if (byte < maxRandomValue) {
        verifier += chars.charAt(byte % chars.length);
        if (verifier.length === verifierLength) {
          break;
        }
      }
    }
  }
  return verifier;
}

/**
 * Generate PKCE code challenge from verifier using SHA256
 * Note: This requires a polyfill or crypto support
 */
export async function generatePKCEChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashBase64 = btoa(String.fromCharCode.apply(null, hashArray as any))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return hashBase64;
}

/**
 * Generate a random state parameter for OAuth security
 */
export function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build the authorization URL for Authorization Code flow with PKCE.
 * Safely merges with any query parameters already present in authorizationUrl
 * by using the URL constructor when the input is a valid absolute URL.
 */
export function buildAuthorizationUrl(
  authorizationUrl: string,
  clientId: string,
  redirectUrl: string,
  scopes: string[] = [],
  state: string = '',
  codeChallenge: string = '',
  authorizationParams: Array<{ key: string; value: string; disabled?: boolean }> = []
): string {
  const resolvedState = state || generateState();

  // Prefer URL constructor so existing query params in authorizationUrl are
  // preserved and we never produce a double-? in the final URL.
  let url: URL | null = null;
  try {
    url = new URL(authorizationUrl);
  } catch {
    // Falls through to the string-concatenation path below (e.g. relative URLs)
  }

  if (url) {
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', resolvedState);
    if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));
    if (codeChallenge) {
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    for (const p of authorizationParams) {
      if (!p.disabled && p.key) url.searchParams.append(p.key, p.value);
    }
    return url.toString();
  }

  // Fallback: string concatenation for relative or otherwise unparseable URLs
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUrl,
    response_type: 'code',
    state: resolvedState,
  });
  if (scopes.length > 0) params.append('scope', scopes.join(' '));
  if (codeChallenge) {
    params.append('code_challenge', codeChallenge);
    params.append('code_challenge_method', 'S256');
  }
  for (const p of authorizationParams) {
    if (!p.disabled && p.key) params.append(p.key, p.value);
  }
  const sep = authorizationUrl.includes('?') ? '&' : '?';
  return `${authorizationUrl}${sep}${params.toString()}`;
}

/**
 * Parse authorization code from callback URL
 */
export function parseAuthorizationCallback(
  callbackUrl: string
): { code: string | null; state: string | null; error: string | null } {
  const url = new URL(callbackUrl);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  return { code, state, error };
}

/**
 * Open authorization URL in a new window for Authorization Code flow WITHOUT PKCE
 * Returns a promise that resolves with the authorization code
 */
export async function openAuthorizationWindowPlain(
  authorizationUrl: string,
  clientId: string,
  redirectUrl: string,
  scopes: string[] = [],
  authorizationParams: Array<{ key: string; value: string; disabled?: boolean }> = []
): Promise<{ code: string; state: string; codeVerifier: string } | null> {
  const state = generateState();
  // No PKCE for this flow: empty code challenge
  const url = buildAuthorizationUrl(authorizationUrl, clientId, redirectUrl, scopes, state, '', authorizationParams);

  // Open in a new window
  const width = 500;
  const height = 600;
  const left = (window.innerWidth - width) / 2;
  const top = (window.innerHeight - height) / 2;

  const window1 = window.open(
    url,
    'OAuth Authorization',
    `width=${width},height=${height},left=${left},top=${top}`
  );

  if (!window1) {
    return null;
  }

  // Poll for the callback
  return new Promise(resolve => {
    const checkInterval = setInterval(() => {
      try {
        const href = window1.location.href;
        if (href && href.includes('oauth/callback')) {
          const { code, state: returnedState } = parseAuthorizationCallback(href);
          clearInterval(checkInterval);
          window1.close();
          if (code && returnedState === state) {
            resolve({ code, state, codeVerifier: '' });
          } else {
            resolve(null);
          }
        }
      } catch (e) {
        // Different origin, keep waiting
      }

      // Timeout after 5 minutes
      if (Date.now() - start > 5 * 60 * 1000) {
        clearInterval(checkInterval);
        window1.close();
        resolve(null);
      }
    }, 500);

    const start = Date.now();
  });
}

/**
 * Open authorization URL in a new window for user to authorize
 * Returns a promise that resolves with the authorization code
 */
export async function openAuthorizationWindow(
  authorizationUrl: string,
  clientId: string,
  redirectUrl: string,
  scopes: string[] = [],
  authorizationParams: Array<{ key: string; value: string; disabled?: boolean }> = []
): Promise<{ code: string; state: string; codeVerifier: string } | null> {
  const verifier = generatePKCEVerifier();
  const challenge = await generatePKCEChallenge(verifier);
  const state = generateState();

  const url = buildAuthorizationUrl(authorizationUrl, clientId, redirectUrl, scopes, state, challenge, authorizationParams);

  // Open in a new window
  const width = 500;
  const height = 600;
  const left = (window.innerWidth - width) / 2;
  const top = (window.innerHeight - height) / 2;

  const window1 = window.open(
    url,
    'OAuth Authorization',
    `width=${width},height=${height},left=${left},top=${top}`
  );

  if (!window1) {
    return null;
  }

  // Poll for the callback (this is a simple approach; production would use postMessage)
  return new Promise(resolve => {
    const checkInterval = setInterval(() => {
      try {
        // Try to access window location (will throw if different origin)
        const href = window1.location.href;
        if (href && href.includes('oauth/callback')) {
          const { code, state: returnedState } = parseAuthorizationCallback(href);
          clearInterval(checkInterval);
          window1.close();
          if (code && returnedState === state) {
            resolve({ code, state, codeVerifier: verifier });
          } else {
            resolve(null);
          }
        }
      } catch (e) {
        // Different origin, keep waiting
      }

      // Timeout after 5 minutes
      if (Date.now() - start > 5 * 60 * 1000) {
        clearInterval(checkInterval);
        window1.close();
        resolve(null);
      }
    }, 500);

    const start = Date.now();
  });
}
