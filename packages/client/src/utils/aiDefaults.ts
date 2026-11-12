import type { AiFeatureKey, AiSettings } from '../types';

export const AI_FEATURE_KEYS: AiFeatureKey[] = [
  'nlGenerate', 'assertSuggest', 'diagnose', 'scriptAssist', 'docDescribe', 'dataGen', 'smartImport',
];

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  provider: 'anthropic',
  model: '',
  maxContextTokens: 8000,
  redactSecrets: true,
  sendResponseBodies: true,
  consentGiven: false,
  features: {
    nlGenerate: false,
    assertSuggest: false,
    diagnose: false,
    scriptAssist: false,
    docDescribe: false,
    dataGen: false,
    smartImport: false,
  },
};

export const AI_PROVIDER_DEFAULT_BASE: Record<AiSettings['provider'], string> = {
  anthropic: 'https://api.anthropic.com',
  'openai-compat': 'https://api.openai.com/v1',
};

/** Trim and drop trailing slashes; returns '' for blank input. */
export function normalizeBaseUrl(input: string | undefined): string {
  return (input ?? '').trim().replace(/\/+$/, '');
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Returns an error message, or null when the settings can be saved and sent to the server. */
export function validateAiSettings(s: AiSettings): string | null {
  if (s.baseUrl && !isHttpUrl(s.baseUrl)) return 'Base URL must start with http:// or https://';
  if (!Number.isInteger(s.maxContextTokens) || s.maxContextTokens < 500 || s.maxContextTokens > 200000) {
    return 'Max context must be between 500 and 200000 tokens';
  }
  if (s.enabled && !s.model.trim()) return 'Enter a model name to enable AI features';
  return null;
}

/** Merge persisted/partial settings over the defaults (features merged key by key). */
export function mergeAiSettings(base: AiSettings, patch: Partial<Omit<AiSettings, 'features'>> & { features?: Partial<Record<AiFeatureKey, boolean>> }): AiSettings {
  return { ...base, ...patch, features: { ...base.features, ...(patch.features ?? {}) } };
}
