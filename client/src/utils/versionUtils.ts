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
