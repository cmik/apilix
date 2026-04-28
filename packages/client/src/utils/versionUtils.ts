type SemverParts = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

function parseSemver(value: string): SemverParts | null {
  const normalized = value.trim().replace(/^v/, '');
  const m = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

function comparePrereleaseIdentifiers(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum) return -1;
  if (bNum) return 1;
  return a.localeCompare(b);
}

export function compareSemver(a: string, b: string): number | null {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (!parsedA || !parsedB) return null;

  if (parsedA.major !== parsedB.major) return parsedA.major - parsedB.major;
  if (parsedA.minor !== parsedB.minor) return parsedA.minor - parsedB.minor;
  if (parsedA.patch !== parsedB.patch) return parsedA.patch - parsedB.patch;

  const aPrerelease = parsedA.prerelease;
  const bPrerelease = parsedB.prerelease;
  if (!aPrerelease.length && !bPrerelease.length) return 0;
  if (!aPrerelease.length) return 1;
  if (!bPrerelease.length) return -1;

  const length = Math.max(aPrerelease.length, bPrerelease.length);
  for (let i = 0; i < length; i += 1) {
    const aPart = aPrerelease[i];
    const bPart = bPrerelease[i];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    const compared = comparePrereleaseIdentifiers(aPart, bPart);
    if (compared !== 0) return compared;
  }
  return 0;
}

export function isVersionGreater(candidate: string, current: string): boolean {
  const compared = compareSemver(candidate, current);
  return compared !== null && compared > 0;
}

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/cmik/apilix/releases/latest';

/**
 * Fetches the latest Apilix release tag from GitHub and returns the version
 * string with any leading "v" stripped (e.g. "1.2.3").
 * Throws when the request fails, the response is not OK, or the payload shape
 * is unexpected — callers are responsible for error handling.
 */
export async function fetchLatestGitHubVersion(signal?: AbortSignal): Promise<string> {
  const res = await fetch(GITHUB_RELEASES_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    signal,
  });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  const data = await res.json() as { tag_name?: unknown };
  if (typeof data.tag_name !== 'string') throw new Error('Unexpected GitHub API response shape');
  return data.tag_name.replace(/^v/, '');
}
