// ─── OAuth 2.0 Types ──────────────────────────────────────────────────────────

export type OAuth2GrantType = 'authorization_code' | 'client_credentials' | 'refresh_token';
export type OAuth2PresetProvider = 'google' | 'github' | 'azure_ad' | null;

export interface OAuth2CustomHeader {
  key: string;
  value: string;
}

export interface OAuth2Config {
  grantType: OAuth2GrantType;
  clientId: string;
  clientSecret: string; // required for confidential clients
  authorizationUrl?: string; // required for Authorization Code flow
  tokenUrl: string; // required for all flows
  scopes?: string[]; // space-separated request
  redirectUrl?: string; // defaults to http://localhost:3000/oauth/callback in Electron
  refreshToken?: string;
  accessToken?: string; // current token, refreshed before request
  expiresAt?: number; // token expiration timestamp (ms since epoch)
  state?: string; // PKCE state for Authorization Code flow
  codeChallenge?: string; // PKCE code challenge, derived from verifier
  codeVerifier?: string; // PKCE code verifier (client-side only, not persisted)
  presetProvider?: OAuth2PresetProvider;
  customHeaders?: OAuth2CustomHeader[]; // for token endpoint
}

export interface OAuth2TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number; // seconds until expiration
  token_type?: string; // typically "Bearer"
  scope?: string;
}

export interface OAuth2TokenRefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface OAuth2PresetConfig {
  displayName: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopeDescription: string;
  documentationUrl: string;
  revokeUrl?: string;
  defaultScopes?: string[];
}
