import type { AppEnvironment } from '../types';

const MIN_SECRET_LEN = 4;
export const SECRET_MASK = '••••••••';

/**
 * Build the set of plaintext secret values that should be redacted in the UI.
 * Only includes enabled rows from the currently active environment.
 */
export function buildSecretSet(
  environments: AppEnvironment[],
  activeEnvironmentId: string | null,
): Set<string> {
  const active = environments.find(e => e._id === activeEnvironmentId);
  if (!active) return new Set();
  const secrets = new Set<string>();
  for (const v of active.values) {
    if (v.secret && v.enabled !== false && v.value.length >= MIN_SECRET_LEN) {
      secrets.add(v.value);
    }
  }
  return secrets;
}

/**
 * Replace every occurrence of any known secret value in `text` with ••••••••.
 * Uses split/join to avoid regex special-character escaping issues.
 * Returns the original string unchanged when `secrets` is empty.
 */
export function maskSecrets(text: string, secrets: Set<string>): string {
  if (secrets.size === 0) return text;
  let result = text;
  // Sort longest-first so a longer secret is replaced before any shorter prefix
  // it might contain (e.g. "mykey_prod" before "mykey"), preventing partial leaks.
  const sorted = [...secrets].sort((a, b) => b.length - a.length);
  for (const secret of sorted) {
    result = result.split(secret).join(SECRET_MASK);
  }
  return result;
}
