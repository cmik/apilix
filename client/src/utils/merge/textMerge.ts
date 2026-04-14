/**
 * textMerge — JSON-aware and line-based hunk diff/merge utilities.
 *
 * Used by workspaceMerge.ts to produce fine-grained conflict hunks for
 * request body, scripts, and arbitrary string fields.
 *
 * Strategy:
 *  1. If all three versions parse as JSON objects/arrays, merge at the
 *     key/index level so non-overlapping key edits auto-resolve.
 *  2. Otherwise fall back to line-based LCS diff. Consecutive changed
 *     lines are grouped into hunks; a hunk is a conflict only when both
 *     local and remote changed the same lines relative to base.
 */

// ─── Public types ──────────────────────────────────────────────────────────────

export interface Hunk {
  startLine: number;
  /** If `isConflict` is false this hunk is already auto-resolved. */
  isConflict: boolean;
  base: string[];
  local: string[];
  remote: string[];
  /** Set when the user has made a resolution choice for this hunk. */
  resolved?: string[];
}

export interface TextMergeResult {
  /** True when every hunk has `isConflict === false` or a `resolved` value. */
  autoMerged: boolean;
  text: string;
  hunks: Hunk[];
  /** When the merge could not be performed even partially. */
  error?: string;
}

// ─── JSON structural merge ────────────────────────────────────────────────────

/**
 * Key-level three-way merge for JSON objects/arrays.
 * Returns `null` when the inputs are not all JSON objects/arrays.
 */
export function mergeJson(
  base: string,
  local: string,
  remote: string,
): TextMergeResult | null {
  let bj: unknown, lj: unknown, rj: unknown;
  try {
    bj = JSON.parse(base);
    lj = JSON.parse(local);
    rj = JSON.parse(remote);
  } catch {
    return null;
  }

  if (!isPlainObject(bj) && !Array.isArray(bj)) return null;
  if (!isPlainObject(lj) && !Array.isArray(lj)) return null;
  if (!isPlainObject(rj) && !Array.isArray(rj)) return null;

  const { merged, conflicts } = mergeObjects(
    bj as Record<string, unknown>,
    lj as Record<string, unknown>,
    rj as Record<string, unknown>,
  );

  if (conflicts.length === 0) {
    return { autoMerged: true, text: JSON.stringify(merged, null, 2), hunks: [] };
  }

  // Build a conflict-annotated string for display
  const lines = JSON.stringify(merged, null, 2).split('\n');
  const hunks: Hunk[] = conflicts.map((c, i) => ({
    startLine: i,
    isConflict: true,
    base: [JSON.stringify(c.base, null, 2)],
    local: [JSON.stringify(c.local, null, 2)],
    remote: [JSON.stringify(c.remote, null, 2)],
  }));

  return { autoMerged: false, text: lines.join('\n'), hunks };
}

interface ObjectConflict {
  key: string;
  base: unknown;
  local: unknown;
  remote: unknown;
}

function mergeObjects(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
): { merged: Record<string, unknown>; conflicts: ObjectConflict[] } {
  const merged: Record<string, unknown> = { ...base };
  const conflicts: ObjectConflict[] = [];

  const allKeys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);

  for (const key of allKeys) {
    const b = base[key];
    const l = local[key];
    const r = remote[key];

    const localChanged = !jsonEqual(b, l);
    const remoteChanged = !jsonEqual(b, r);

    if (!localChanged && !remoteChanged) {
      merged[key] = b;
    } else if (localChanged && !remoteChanged) {
      if (l === undefined) {
        delete merged[key];
      } else {
        merged[key] = l;
      }
    } else if (!localChanged && remoteChanged) {
      if (r === undefined) {
        delete merged[key];
      } else {
        merged[key] = r;
      }
    } else {
      // Both changed
      if (jsonEqual(l, r)) {
        merged[key] = l; // Same resolution independently — auto-accept
      } else if (
        isPlainObject(b) &&
        isPlainObject(l) &&
        isPlainObject(r)
      ) {
        // Recurse into nested objects
        const sub = mergeObjects(
          b as Record<string, unknown>,
          l as Record<string, unknown>,
          r as Record<string, unknown>,
        );
        merged[key] = sub.merged;
        conflicts.push(...sub.conflicts.map(c => ({ ...c, key: `${key}.${c.key}` })));
      } else {
        merged[key] = l; // Default to local for display; mark as conflict
        conflicts.push({ key, base: b, local: l, remote: r });
      }
    }
  }

  return { merged, conflicts };
}

// ─── Line-based hunk merge ────────────────────────────────────────────────────

/** Three-way line-based text merge. The primary fallback for scripts, non-JSON bodies. */
export function mergeText(base: string, local: string, remote: string): TextMergeResult {
  const baseLines = splitLines(base);
  const localLines = splitLines(local);
  const remoteLines = splitLines(remote);

  const localHunks = buildDiffHunks(baseLines, localLines);
  const remoteHunks = buildDiffHunks(baseLines, remoteLines);

  const result: string[] = [];
  const hunks: Hunk[] = [];
  let i = 0; // cursor in base

  // Merge hunk lists sorted by start position
  const allBoundaries = sortedUnion(
    localHunks.map(h => h.baseStart),
    remoteHunks.map(h => h.baseStart),
  );

  const lhMap = new Map(localHunks.map(h => [h.baseStart, h]));
  const rhMap = new Map(remoteHunks.map(h => [h.baseStart, h]));

  for (const pos of allBoundaries) {
    const lh = lhMap.get(pos);
    const rh = rhMap.get(pos);

    if (!lh && !rh) continue;

    const end = Math.max(lh?.baseEnd ?? pos, rh?.baseEnd ?? pos);

    // Emit unchanged lines before this hunk
    result.push(...baseLines.slice(i, pos));
    i = end;

    const baseSlice = baseLines.slice(pos, end);
    const localSlice = lh ? lh.lines : baseSlice;
    const remoteSlice = rh ? rh.lines : baseSlice;

    if (arraysEqual(localSlice, remoteSlice)) {
      // Both sides made the same change — auto-accept
      result.push(...localSlice);
      hunks.push({
        startLine: result.length - localSlice.length,
        isConflict: false,
        base: baseSlice,
        local: localSlice,
        remote: remoteSlice,
        resolved: localSlice,
      });
    } else if (lh && !rh) {
      result.push(...localSlice);
    } else if (!lh && rh) {
      result.push(...remoteSlice);
    } else {
      // Both changed differently — conflict
      const placeholder = localSlice; // default to local in merged buf
      result.push(...placeholder);
      hunks.push({
        startLine: result.length - placeholder.length,
        isConflict: true,
        base: baseSlice,
        local: localSlice,
        remote: remoteSlice,
      });
    }
  }

  // Remaining unchanged lines
  result.push(...baseLines.slice(i));

  const autoMerged = hunks.every(h => !h.isConflict);
  return { autoMerged, text: result.join('\n'), hunks };
}

// ─── Diff primitives ──────────────────────────────────────────────────────────

interface DiffHunkRaw {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

function buildDiffHunks(base: string[], changed: string[]): DiffHunkRaw[] {
  const lcs = computeLCS(base, changed);
  const hunks: DiffHunkRaw[] = [];

  let bi = 0;
  let ci = 0;
  let li = 0; // cursor in LCS

  while (bi < base.length || ci < changed.length) {
    // Advance through matching LCS segment
    if (li < lcs.length && bi === lcs[li][0] && ci === lcs[li][1]) {
      bi++;
      ci++;
      li++;
      continue;
    }

    // Start of a differing region
    const bStart = bi;
    const replacementLines: string[] = [];

    // Consume until we hit the next LCS match
    while (bi < base.length || ci < changed.length) {
      if (
        li < lcs.length &&
        bi === lcs[li][0] &&
        ci === lcs[li][1]
      ) {
        break;
      }
      const nextLcsBase = lcs[li]?.[0] ?? Infinity;
      const nextLcsChanged = lcs[li]?.[1] ?? Infinity;
      // Advance base cursor if base has a deletion before the next LCS point
      if (bi < base.length && bi < nextLcsBase) {
        bi++;
      } else if (ci < changed.length && ci < nextLcsChanged) {
        // Added in changed
        replacementLines.push(changed[ci]);
        ci++;
      } else {
        // Both cursors are past their respective LCS positions — no more diffs
        break;
      }
    }

    hunks.push({ baseStart: bStart, baseEnd: bi, lines: replacementLines });
  }

  return hunks;
}

/** O(n*m) LCS — adequate for typical request body / script sizes (< 500 lines). */
function computeLCS(a: string[], b: string[]): [number, number][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack
  const result: [number, number][] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return result.reverse();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function sortedUnion(a: number[], b: number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
