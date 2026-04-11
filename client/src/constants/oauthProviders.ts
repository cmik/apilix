import type { OAuth2PresetConfig } from '../types/oauth';

export const OAUTH2_PRESET_PROVIDERS: Record<string, OAuth2PresetConfig> = {
  google: {
    displayName: 'Google OAuth',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopeDescription: 'openid profile email',
    documentationUrl: 'https://developers.google.com/identity/protocols/oauth2',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    defaultScopes: ['openid', 'profile', 'email'],
  },
  github: {
    displayName: 'GitHub OAuth',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopeDescription: 'repo workflow read:user',
    documentationUrl: 'https://docs.github.com/en/developers/apps/building-oauth-apps',
    defaultScopes: ['repo', 'workflow', 'read:user'],
  },
  azure_ad: {
    displayName: 'Azure AD OAuth',
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopeDescription: 'openid profile email',
    documentationUrl: 'https://docs.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-auth-code-flow',
    defaultScopes: ['openid', 'profile', 'email'],
  },
};

export const PRESET_PROVIDER_LIST = [
  { label: 'Custom', value: null },
  { label: 'Google', value: 'google' },
  { label: 'GitHub', value: 'github' },
  { label: 'Azure AD', value: 'azure_ad' },
] as const;

export const GRANT_TYPE_LIST = [
  { label: 'Authorization Code (PKCE)', value: 'authorization_code' },
  { label: 'Client Credentials', value: 'client_credentials' },
  { label: 'Refresh Token', value: 'refresh_token' },
] as const;
