import { useState } from 'react';
import type { OAuth2Config, OAuth2GrantType } from '../types/oauth';
import { OAUTH2_PRESET_PROVIDERS, PRESET_PROVIDER_LIST, GRANT_TYPE_LIST } from '../constants/oauthProviders';

interface OAuthConfigPanelProps {
  config: Partial<OAuth2Config>;
  onChange: (config: Partial<OAuth2Config>) => void;
  onRefreshToken?: () => Promise<void>;
  onGetAuthorizationCode?: () => Promise<void>;
  isRefreshing?: boolean;
  isGettingAuthCode?: boolean;
}

export default function OAuthConfigPanel({
  config,
  onChange,
  onRefreshToken,
  onGetAuthorizationCode,
  isRefreshing = false,
  isGettingAuthCode = false,
}: OAuthConfigPanelProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handlePresetChange = (presetValue: string | null) => {
    const newConfig: Partial<OAuth2Config> = {
      ...config,
      presetProvider: presetValue as any,
    };

    if (presetValue && OAUTH2_PRESET_PROVIDERS[presetValue]) {
      const preset = OAUTH2_PRESET_PROVIDERS[presetValue];
      newConfig.authorizationUrl = preset.authorizationUrl;
      newConfig.tokenUrl = preset.tokenUrl;
      newConfig.scopes = preset.defaultScopes;
    }

    onChange(newConfig);
  };

  const handleGrantTypeChange = (grantType: OAuth2GrantType) => {
    onChange({ ...config, grantType });
  };

  const handleClientIdChange = (clientId: string) => {
    onChange({ ...config, clientId });
  };

  const handleClientSecretChange = (clientSecret: string) => {
    onChange({ ...config, clientSecret });
  };

  const handleAuthorizationUrlChange = (authorizationUrl: string) => {
    onChange({ ...config, authorizationUrl });
  };

  const handleTokenUrlChange = (tokenUrl: string) => {
    onChange({ ...config, tokenUrl });
  };

  const handleScopesChange = (scopesStr: string) => {
    const scopes = scopesStr.split(/\s+/).filter(s => s.trim());
    onChange({ ...config, scopes });
  };

  const handleRefreshTokenChange = (refreshToken: string) => {
    onChange({ ...config, refreshToken });
  };

  const handleAccessTokenChange = (accessToken: string) => {
    onChange({ ...config, accessToken });
  };

  const handleRedirectUrlChange = (redirectUrl: string) => {
    onChange({ ...config, redirectUrl });
  };

  const presetConfig =
    config.presetProvider && OAUTH2_PRESET_PROVIDERS[config.presetProvider]
      ? OAUTH2_PRESET_PROVIDERS[config.presetProvider]
      : null;

  const expiresAt = config.expiresAt;
  const now = Date.now();
  const isTokenExpired = expiresAt && expiresAt <= now;
  const isTokenExpiringSoon = expiresAt && expiresAt > now && expiresAt <= now + 5 * 60 * 1000;
  const minutesUntilExpiry = expiresAt ? Math.floor((expiresAt - now) / 60000) : 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Preset Provider Selector */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-slate-400">Preset Provider</label>
        <select
          value={config.presetProvider ?? ''}
          onChange={e => handlePresetChange(e.target.value || null)}
          className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
        >
          {PRESET_PROVIDER_LIST.map(provider => (
            <option key={provider.value ?? 'custom'} value={provider.value ?? ''}>
              {provider.label}
            </option>
          ))}
        </select>
        {presetConfig && (
          <a
            href={presetConfig.documentationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-orange-400 hover:text-orange-300 mt-1"
          >
            View setup guide →
          </a>
        )}
      </div>

      {/* Grant Type Selector */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-slate-400">Grant Type</label>
        <select
          value={config.grantType ?? 'authorization_code'}
          onChange={e => handleGrantTypeChange(e.target.value as OAuth2GrantType)}
          className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-orange-500"
        >
          {GRANT_TYPE_LIST.map(gt => (
            <option key={gt.value} value={gt.value}>
              {gt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Client ID */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-slate-400">
          Client ID <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={config.clientId ?? ''}
          onChange={e => handleClientIdChange(e.target.value)}
          placeholder="{{clientId}}"
          className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
        />
      </div>

      {/* Client Secret */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-slate-400">
          Client Secret <span className="text-red-500">*</span>
        </label>
        <input
          type="password"
          value={config.clientSecret ?? ''}
          onChange={e => handleClientSecretChange(e.target.value)}
          placeholder="{{clientSecret}}"
          className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
        />
      </div>

      {/* Authorization URL (for Authorization Code) */}
      {config.grantType === 'authorization_code' && (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-slate-400">
            Authorization URL <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={config.authorizationUrl ?? ''}
            onChange={e => handleAuthorizationUrlChange(e.target.value)}
            placeholder="https://provider.com/oauth/authorize"
            className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
          />
        </div>
      )}

      {/* Token URL */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-slate-400">
          Token URL <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={config.tokenUrl ?? ''}
          onChange={e => handleTokenUrlChange(e.target.value)}
          placeholder="https://provider.com/oauth/token"
          className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
        />
      </div>

      {/* Scopes */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-slate-400">Scopes (space-separated)</label>
        <input
          type="text"
          value={(config.scopes ?? []).join(' ')}
          onChange={e => handleScopesChange(e.target.value)}
          placeholder="openid profile email"
          className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
        />
      </div>

      {/* Redirect URL */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-slate-400">Redirect URL</label>
        <input
          type="text"
          value={config.redirectUrl ?? 'http://localhost:3000/oauth/callback'}
          onChange={e => handleRedirectUrlChange(e.target.value)}
          className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
        />
      </div>

      {/* Get Authorization Code Button (for Authorization Code flow) */}
      {config.grantType === 'authorization_code' && (
        <button
          onClick={onGetAuthorizationCode}
          disabled={isGettingAuthCode || !config.clientId || !config.authorizationUrl || !config.tokenUrl}
          className="mt-3 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-sm rounded font-medium transition-colors w-full"
        >
          {isGettingAuthCode ? 'Opening browser...' : 'Get Authorization Code'}
        </button>
      )}

      {/* Token Status Section */}
      {config.accessToken && (
        <div className="bg-slate-700/40 border border-slate-600 rounded px-3 py-2.5 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${
                isTokenExpired
                  ? 'bg-red-500'
                  : isTokenExpiringSoon
                    ? 'bg-yellow-500'
                    : 'bg-green-500'
              }`}
            />
            <span className="text-xs font-medium">
              {isTokenExpired ? 'Token Expired' : isTokenExpiringSoon ? 'Expiring Soon' : 'Token Valid'}
            </span>
          </div>

          {expiresAt && (
            <div className="text-xs text-slate-400">
              {isTokenExpired
                ? 'Token has expired. Click "Refresh Token" to obtain a new one.'
                : isTokenExpiringSoon
                  ? `Expires in ${minutesUntilExpiry} minute${minutesUntilExpiry !== 1 ? 's' : ''}`
                  : `Expires in ${minutesUntilExpiry} minute${minutesUntilExpiry !== 1 ? 's' : ''}`}
            </div>
          )}

          <button
            onClick={onRefreshToken}
            disabled={isRefreshing}
            className="mt-2 px-3 py-1.5 bg-orange-600 hover:bg-orange-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-xs rounded font-medium transition-colors"
          >
            {isRefreshing ? 'Refreshing...' : 'Refresh Token Now'}
          </button>
        </div>
      )}

      {/* Advanced Settings */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="text-xs text-orange-400 hover:text-orange-300 mt-2 self-start"
      >
        {showAdvanced ? '▼ Hide Advanced' : '▶ Show Advanced'}
      </button>

      {showAdvanced && (
        <div className="border-t border-slate-600 pt-3 mt-2 flex flex-col gap-3">
          {/* Refresh Token */}
          {config.grantType === 'refresh_token' && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-slate-400">
                Refresh Token <span className="text-red-500">*</span>
              </label>
              <input
                type="password"
                value={config.refreshToken ?? ''}
                onChange={e => handleRefreshTokenChange(e.target.value)}
                placeholder="{{refreshToken}}"
                className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-100 focus:outline-none focus:border-orange-500"
              />
            </div>
          )}

          {/* Access Token (read-only in most cases) */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-400">Current Access Token (read-only)</label>
            <div className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm font-mono text-slate-400 truncate">
              {config.accessToken
                ? `${config.accessToken.substring(0, 10)}...${config.accessToken.substring(config.accessToken.length - 10)}`
                : '(none)'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
