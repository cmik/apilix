/**
 * workspaceMerge — three-way merge engine for WorkspaceData.
 *
 * Consumes base + local + remote snapshots, computes diffs from each side,
 * and produces a `MergeResult` with:
 *  - A merged `WorkspaceData` (auto-resolved where possible, defaulting to
 *    local for conflicts so the merge is never destructive by default).
 *  - A list of `MergeConflictNode` items that require user review.
 *  - An `autoMergedCount`.
 *
 * Conflict taxonomy:
 *  - field-overlap: both sides changed the same field of the same entity
 *  - delete-vs-edit: one side deleted an entity the other modified
 *  - rename-vs-rename: both sides renamed the same entity to different names
 *  - move-vs-edit: one side moved an item, the other edited it
 *  - json-conflict: body merge succeeded as JSON but has key-level conflicts
 *  - json-parse-fallback: body/script merge fell back to line-based diff
 */

import type {
  WorkspaceData,
  AppCollection,
  AppEnvironment,
  CollectionItem,
  MockRoute,
  MergeResult,
  MergeConflictNode,
  ConflictDomain,
  ConflictKind,
} from '../../types';
import { diffWorkspace, deepEqual, type EntityChange } from './workspaceDiffer';
import { mergeJson, mergeText } from './textMerge';

// ─── Public API ───────────────────────────────────────────────────────────────

export function mergeWorkspaces(
  base: WorkspaceData,
  local: WorkspaceData,
  remote: WorkspaceData,
): MergeResult {
  const localDiff = diffWorkspace(base, local);
  const remoteDiff = diffWorkspace(base, remote);

  const conflicts: MergeConflictNode[] = [];
  let autoMergedCount = 0;

  const merged: WorkspaceData = {
    ...base,
    collections: mergeCollections(base, local, remote, localDiff, remoteDiff, conflicts, () => autoMergedCount++),
    environments: mergeEnvironments(base.environments, local.environments, remote.environments, localDiff, remoteDiff, conflicts, () => autoMergedCount++),
    globalVariables: mergeFlatRecord('global', 'globalVariables', base.globalVariables, local.globalVariables, remote.globalVariables, conflicts, () => autoMergedCount++),
    collectionVariables: mergeCollectionVars(base.collectionVariables, local.collectionVariables, remote.collectionVariables, conflicts, () => autoMergedCount++),
    mockRoutes: mergeMockRoutes(base.mockRoutes, local.mockRoutes, remote.mockRoutes, localDiff, remoteDiff, conflicts, () => autoMergedCount++),
    mockCollections: local.mockCollections, // last-write-wins (rarely edited by teams)
    mockPort: local.mockPort !== base.mockPort ? local.mockPort : remote.mockPort,
    cookieJar: local.cookieJar, // session-local; don't merge
    activeEnvironmentId: local.activeEnvironmentId,
  };

  return { merged, conflicts, autoMergedCount };
}

// ─── Collections ──────────────────────────────────────────────────────────────

function mergeCollections(
  base: WorkspaceData,
  local: WorkspaceData,
  remote: WorkspaceData,
  localDiff: ReturnType<typeof diffWorkspace>,
  remoteDiff: ReturnType<typeof diffWorkspace>,
  conflicts: MergeConflictNode[],
  onAuto: () => void,
): AppCollection[] {
  const baseMap = new Map(base.collections.map(c => [c._id, c]));
  const localMap = new Map(local.collections.map(c => [c._id, c]));
  const remoteMap = new Map(remote.collections.map(c => [c._id, c]));

  const localColChanges = indexById(localDiff.collections);
  const remoteColChanges = indexById(remoteDiff.collections);
  const localReqChanges = indexById(localDiff.requests);
  const remoteReqChanges = indexById(remoteDiff.requests);

  const allIds = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
  const result: AppCollection[] = [];

  for (const id of allIds) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);

    const localChange = localColChanges.get(id);
    const remoteChange = remoteColChanges.get(id);

    // Both deleted
    if (!l && !r) continue;
    // Only remote has it (added)
    if (!l && !b && r) { result.push(r); onAuto(); continue; }
    // Only local has it (added)
    if (l && !b && !r) { result.push(l); onAuto(); continue; }
    // Remote deleted, local kept
    if (l && b && !r) {
      if (localChange?.kind === 'modified') {
        // delete-vs-edit: keep local, record conflict
        result.push(l);
        conflicts.push(makeConflict(id, 'collection', 'delete-vs-edit', l.info.name, b, l, null));
      } else {
        onAuto(); // remote deletion wins
      }
      continue;
    }
    // Local deleted, remote kept
    if (!l && b && r) {
      if (remoteChange?.kind === 'modified') {
        result.push(r);
        conflicts.push(makeConflict(id, 'collection', 'delete-vs-edit', r.info.name, b, null, r));
      } else {
        onAuto(); // local deletion wins
      }
      continue;
    }

    if (!l || !r) continue; // guard

    // Both present — merge top-level collection metadata
    const merged = mergeCollectionShape(b ?? null, l, r, conflicts, onAuto);
    // Merge items within the collection
    merged.item = mergeItems(
      b?.item ?? [],
      l.item ?? [],
      r.item ?? [],
      [l.info.name],
      localReqChanges,
      remoteReqChanges,
      conflicts,
      onAuto,
    );
    result.push(merged);
  }

  return result;
}

function mergeCollectionShape(
  b: AppCollection | null,
  l: AppCollection,
  r: AppCollection,
  conflicts: MergeConflictNode[],
  onAuto: () => void,
): AppCollection {
  const merged = { ...l };

  // Detect rename-vs-rename
  const lName = l.info.name;
  const rName = r.info.name;
  const bName = b?.info.name ?? lName;
  if (lName !== bName && rName !== bName && lName !== rName) {
    conflicts.push(makeConflict(l._id, 'collection', 'rename-vs-rename', lName, bName, lName, rName));
  } else if (lName === bName && rName !== bName) {
    merged.info = { ...l.info, name: rName };
    onAuto();
  } else if (lName !== bName && rName === bName) {
    // local rename wins (already in merged)
    onAuto();
  }

  return merged;
}

// ─── Items (recursive) ───────────────────────────────────────────────────────

function mergeItems(
  base: CollectionItem[],
  local: CollectionItem[],
  remote: CollectionItem[],
  path: string[],
  localReqChanges: Map<string, EntityChange<CollectionItem>>,
  remoteReqChanges: Map<string, EntityChange<CollectionItem>>,
  conflicts: MergeConflictNode[],
  onAuto: () => void,
): CollectionItem[] {
  const baseMap = new Map(base.map(i => [i.id ?? i.name, i]));
  const localMap = new Map(local.map(i => [i.id ?? i.name, i]));
  const remoteMap = new Map(remote.map(i => [i.id ?? i.name, i]));

  // Preserve local ordering; append remote-only additions at the end
  const ordered: CollectionItem[] = [];
  const seen = new Set<string>();

  const processItem = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);

    const b = baseMap.get(key);
    const l = localMap.get(key);
    const r = remoteMap.get(key);

    if (!l && !r) return; // both deleted
    if (l && !b && !r) { ordered.push(l); onAuto(); return; } // local added
    if (r && !b && !l) { ordered.push(r); onAuto(); return; } // remote added

    const lc = localReqChanges.get(key);
    const rc = remoteReqChanges.get(key);

    // delete-vs-edit
    if (!l && b && r && rc?.kind === 'modified') {
      ordered.push(r);
      conflicts.push(makeConflict(key, 'request', 'delete-vs-edit', r.name, b, null, r, path));
      return;
    }
    if (!r && b && l && lc?.kind === 'modified') {
      ordered.push(l);
      conflicts.push(makeConflict(key, 'request', 'delete-vs-edit', l.name, b, l, null, path));
      return;
    }
    if (!l || !r) { onAuto(); return; } // clean deletion by one side

    // Both present — merge request/folder
    const isFolder = Boolean(l.item);
    if (isFolder) {
      const mergedFolder: CollectionItem = {
        ...l,
        item: mergeItems(
          b?.item ?? [],
          l.item ?? [],
          r.item ?? [],
          [...path, l.name],
          localReqChanges,
          remoteReqChanges,
          conflicts,
          onAuto,
        ),
      };
      // Rename-vs-rename for folders
      if (b && l.name !== b.name && r.name !== b.name && l.name !== r.name) {
        conflicts.push(makeConflict(key, 'request', 'rename-vs-rename', l.name, b.name, l.name, r.name, path));
      }
      ordered.push(mergedFolder);
    } else {
      const mergedItem = mergeRequestItem(b ?? null, l, r, path, conflicts, onAuto);
      ordered.push(mergedItem);
    }
  };

  // Process local items first (preserve local order)
  for (const item of local) {
    processItem(item.id ?? item.name);
  }
  // Then remote additions not seen yet
  for (const item of remote) {
    const key = item.id ?? item.name;
    if (!localMap.has(key)) {
      processItem(key);
    }
  }

  return ordered;
}

function mergeRequestItem(
  b: CollectionItem | null,
  l: CollectionItem,
  r: CollectionItem,
  path: string[],
  conflicts: MergeConflictNode[],
  onAuto: () => void,
): CollectionItem {
  const merged: CollectionItem = { ...l };
  const id = l.id ?? l.name;

  // Name
  if (b && l.name !== b.name && r.name !== b.name && l.name !== r.name) {
    conflicts.push(makeConflict(id, 'request', 'rename-vs-rename', l.name, b.name, l.name, r.name, path));
  } else if (b && l.name === b.name && r.name !== b.name) {
    merged.name = r.name;
    onAuto();
  }

  // Request body
  if (l.request?.body?.raw !== undefined || r.request?.body?.raw !== undefined) {
    const bRaw = b?.request?.body?.raw ?? '';
    const lRaw = l.request?.body?.raw ?? '';
    const rRaw = r.request?.body?.raw ?? '';

    if (lRaw !== rRaw) {
      const jsonResult = mergeJson(bRaw, lRaw, rRaw);
      const usedJsonMerge = jsonResult !== null;
      const textResult = jsonResult ?? mergeText(bRaw, lRaw, rRaw);
      if (textResult.autoMerged) {
        merged.request = {
          ...(l.request ?? r.request!),
          body: { ...((l.request?.body ?? r.request?.body) ?? { mode: 'raw' }), raw: textResult.text },
        };
        onAuto();
      } else {
        // Field overlap in body — use local for now, record conflict
        conflicts.push({
          id: `${id}#body`,
          domain: 'request',
          kind: usedJsonMerge ? 'json-conflict' : (textResult.hunks.length ? 'json-parse-fallback' : 'field-overlap'),
          label: `${l.name} — body`,
          path,
          base: bRaw || null,
          local: lRaw,
          remote: rRaw,
        });
      }
    }
  }

  // Scripts
  for (const listen of ['prerequest', 'test'] as const) {
    const bScript = scriptExec(b?.event, listen);
    const lScript = scriptExec(l.event, listen);
    const rScript = scriptExec(r.event, listen);

    if (lScript !== rScript) {
      if (bScript === lScript) {
        // Only remote changed — apply remote script
        merged.event = setScript(merged.event, listen, rScript);
        onAuto();
      } else if (bScript === rScript) {
        // Only local changed — keep local (already in merged)
        onAuto();
      } else {
        // Both changed
        const textResult = mergeText(bScript, lScript, rScript);
        if (textResult.autoMerged) {
          merged.event = setScript(merged.event, listen, textResult.text);
          onAuto();
        } else {
          conflicts.push({
            id: `${id}#${listen}`,
            domain: 'request',
            kind: 'field-overlap',
            label: `${l.name} — ${listen} script`,
            path,
            base: bScript || null,
            local: lScript,
            remote: rScript,
          });
        }
      }
    }
  }

  // Headers: merge by key
  if (l.request?.header || r.request?.header) {
    const bHeaders = b?.request?.header ?? [];
    const lHeaders = l.request?.header ?? [];
    const rHeaders = r.request?.header ?? [];
    const mergedHeaders = mergeKeyValueArray(bHeaders, lHeaders, rHeaders);
    if (merged.request) {
      merged.request = { ...merged.request, header: mergedHeaders };
    }
  }

  return merged;
}

// ─── Environments ─────────────────────────────────────────────────────────────

function mergeEnvironments(
  base: AppEnvironment[],
  local: AppEnvironment[],
  remote: AppEnvironment[],
  localDiff: ReturnType<typeof diffWorkspace>,
  remoteDiff: ReturnType<typeof diffWorkspace>,
  conflicts: MergeConflictNode[],
  onAuto: () => void,
): AppEnvironment[] {
  const baseMap = new Map(base.map(e => [e._id, e]));
  const localMap = new Map(local.map(e => [e._id, e]));
  const remoteMap = new Map(remote.map(e => [e._id, e]));

  const lChanges = indexById(localDiff.environments);
  const rChanges = indexById(remoteDiff.environments);

  const allIds = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
  const result: AppEnvironment[] = [];

  for (const id of allIds) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);

    if (!l && !r) continue;
    if (!l && !b && r) { result.push(r); onAuto(); continue; }
    if (l && !b && !r) { result.push(l); onAuto(); continue; }

    if (!l && b && r) {
      if (rChanges.get(id)?.kind === 'modified') {
        result.push(r);
        conflicts.push(makeConflict(id, 'environment', 'delete-vs-edit', r.name, b, null, r));
      } else { onAuto(); }
      continue;
    }
    if (!r && b && l) {
      if (lChanges.get(id)?.kind === 'modified') {
        result.push(l);
        conflicts.push(makeConflict(id, 'environment', 'delete-vs-edit', l.name, b, l, null));
      } else { onAuto(); }
      continue;
    }

    if (!l || !r) continue;

    const mergedEnv: AppEnvironment = { ...l };

    // Name
    const bName = b?.name ?? l.name;
    if (l.name !== bName && r.name !== bName && l.name !== r.name) {
      conflicts.push(makeConflict(id, 'environment', 'rename-vs-rename', l.name, bName, l.name, r.name));
    } else if (l.name === bName && r.name !== bName) {
      mergedEnv.name = r.name;
      onAuto();
    }

    // Values: merge by key name
    const bVals = Object.fromEntries((b?.values ?? []).map(v => [v.key, v.value]));
    const lVals = Object.fromEntries(l.values.map(v => [v.key, v.value]));
    const rVals = Object.fromEntries(r.values.map(v => [v.key, v.value]));

    const allKeys = new Set([...Object.keys(bVals), ...Object.keys(lVals), ...Object.keys(rVals)]);
    const mergedValues: AppEnvironment['values'] = [];

    for (const key of allKeys) {
      const bv = bVals[key];
      const lv = lVals[key];
      const rv = rVals[key];

      const lChanged = lv !== bv;
      const rChanged = rv !== bv;

      if (!lChanged && !rChanged) {
        if (lv !== undefined) mergedValues.push({ key, value: lv, enabled: true });
      } else if (lChanged && !rChanged) {
        if (lv !== undefined) mergedValues.push({ key, value: lv, enabled: true });
        else { /* deleted by local */ }
        onAuto();
      } else if (!lChanged && rChanged) {
        if (rv !== undefined) mergedValues.push({ key, value: rv, enabled: true });
        else { /* deleted by remote */ }
        onAuto();
      } else {
        // Both changed
        if (lv === rv) {
          if (lv !== undefined) mergedValues.push({ key, value: lv, enabled: true });
          onAuto();
        } else {
          mergedValues.push({ key, value: lv ?? '', enabled: true }); // default local
          conflicts.push({
            id: `${id}#${key}`,
            domain: 'environment',
            kind: 'field-overlap',
            label: `${mergedEnv.name} — ${key}`,
            base: bv ?? null,
            local: lv ?? '',
            remote: rv ?? '',
          });
        }
      }
    }

    mergedEnv.values = mergedValues;
    result.push(mergedEnv);
  }

  return result;
}

// ─── Global variables ─────────────────────────────────────────────────────────

function mergeFlatRecord(
  id: string,
  domain: ConflictDomain,
  base: Record<string, string>,
  local: Record<string, string>,
  remote: Record<string, string>,
  conflicts: MergeConflictNode[],
  onAuto: () => void,
): Record<string, string> {
  const merged: Record<string, string> = { ...local };
  const allKeys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);

  for (const key of allKeys) {
    const b = base[key];
    const l = local[key];
    const r = remote[key];
    const lChanged = l !== b;
    const rChanged = r !== b;

    if (!lChanged && !rChanged) {
      if (l !== undefined) merged[key] = l; else delete merged[key];
    } else if (lChanged && !rChanged) {
      if (l !== undefined) merged[key] = l; else delete merged[key];
      onAuto();
    } else if (!lChanged && rChanged) {
      if (r !== undefined) merged[key] = r; else delete merged[key];
      onAuto();
    } else {
      if (l === r) {
        if (l !== undefined) merged[key] = l; else delete merged[key];
        onAuto();
      } else {
        if (l !== undefined) merged[key] = l; else delete merged[key];
        conflicts.push({
          id: `${id}#${key}`,
          domain,
          kind: 'field-overlap',
          label: `${key}`,
          base: b ?? null,
          local: l ?? '',
          remote: r ?? '',
        });
      }
    }
  }

  return merged;
}

// ─── Per-collection variables ─────────────────────────────────────────────────

function mergeCollectionVars(
  base: Record<string, Record<string, string>>,
  local: Record<string, Record<string, string>>,
  remote: Record<string, Record<string, string>>,
  conflicts: MergeConflictNode[],
  onAuto: () => void,
): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = { ...local };
  const allIds = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);

  for (const id of allIds) {
    result[id] = mergeFlatRecord(
      id,
      'collectionVariables',
      base[id] ?? {},
      local[id] ?? {},
      remote[id] ?? {},
      conflicts,
      onAuto,
    );
  }
  return result;
}

// ─── Mock routes ──────────────────────────────────────────────────────────────

function mergeMockRoutes(
  base: MockRoute[],
  local: MockRoute[],
  remote: MockRoute[],
  localDiff: ReturnType<typeof diffWorkspace>,
  remoteDiff: ReturnType<typeof diffWorkspace>,
  conflicts: MergeConflictNode[],
  onAuto: () => void,
): MockRoute[] {
  const baseMap = new Map(base.map(r => [r.id, r]));
  const localMap = new Map(local.map(r => [r.id, r]));
  const remoteMap = new Map(remote.map(r => [r.id, r]));
  const lChanges = indexById(localDiff.mockRoutes);
  const rChanges = indexById(remoteDiff.mockRoutes);

  const result: MockRoute[] = [];
  const allIds = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);

  for (const id of allIds) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);

    if (!l && !r) continue;
    if (!l && !b && r) { result.push(r); onAuto(); continue; }
    if (l && !b && !r) { result.push(l); onAuto(); continue; }
    if (!l && b && r) {
      if (rChanges.get(id)?.kind === 'modified') {
        result.push(r);
        conflicts.push(makeConflict(id, 'mockRoute', 'delete-vs-edit', `${r.method} ${r.path}`, b, null, r));
      } else { onAuto(); }
      continue;
    }
    if (!r && b && l) {
      if (lChanges.get(id)?.kind === 'modified') {
        result.push(l);
        conflicts.push(makeConflict(id, 'mockRoute', 'delete-vs-edit', `${l.method} ${l.path}`, b, l, null));
      } else { onAuto(); }
      continue;
    }
    if (!l || !r) continue;

    if (deepEqual(l, r)) { result.push(l); onAuto(); continue; }
    if (deepEqual(b ?? {}, l)) { result.push(r); onAuto(); continue; }
    if (deepEqual(b ?? {}, r)) { result.push(l); onAuto(); continue; }

    result.push(l); // default local
    conflicts.push(makeConflict(id, 'mockRoute', 'field-overlap', `${l.method} ${l.path}`, b, l, r));
  }

  return result;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function makeConflict<T>(
  id: string,
  domain: ConflictDomain,
  kind: ConflictKind,
  label: string,
  base: T | null | undefined,
  local: T | null | undefined,
  remote: T | null | undefined,
  path?: string[],
): MergeConflictNode {
  return {
    id,
    domain,
    kind,
    label,
    path,
    base: base != null ? JSON.stringify(base, null, 2) : null,
    local: local != null ? JSON.stringify(local, null, 2) : '',
    remote: remote != null ? JSON.stringify(remote, null, 2) : '',
  };
}

function indexById<T>(changes: EntityChange<T>[]): Map<string, EntityChange<T>> {
  return new Map(changes.map(c => [c.id, c]));
}

function scriptExec(events: import('../../types').CollectionEvent[] | undefined, listen: 'prerequest' | 'test'): string {
  const ev = events?.find(e => e.listen === listen);
  if (!ev) return '';
  const exec = ev.script.exec;
  return Array.isArray(exec) ? exec.join('\n') : (exec ?? '');
}

function setScript(
  events: import('../../types').CollectionEvent[] | undefined,
  listen: 'prerequest' | 'test',
  exec: string,
): import('../../types').CollectionEvent[] {
  const existing: import('../../types').CollectionEvent[] = events ? [...events] : [];
  const idx = existing.findIndex(e => e.listen === listen);
  const ev: import('../../types').CollectionEvent = {
    listen,
    script: { type: 'text/javascript', exec: exec.split('\n') },
  };
  if (idx >= 0) {
    existing[idx] = ev;
  } else {
    existing.push(ev);
  }
  return existing;
}

function mergeKeyValueArray<T extends { key: string; value: string }>(
  base: T[],
  local: T[],
  remote: T[],
): T[] {
  const bMap = new Map(base.map(h => [h.key, h]));
  const lMap = new Map(local.map(h => [h.key, h]));
  const rMap = new Map(remote.map(h => [h.key, h]));
  const allKeys = new Set([...bMap.keys(), ...lMap.keys(), ...rMap.keys()]);
  const result: T[] = [];

  for (const key of allKeys) {
    const b = bMap.get(key);
    const l = lMap.get(key);
    const r = rMap.get(key);

    if (!l && !r) continue;
    if (!l) { if (r) result.push(r); continue; }
    if (!r) { result.push(l); continue; }

    const lChanged = !deepEqual(b, l);
    const rChanged = !deepEqual(b, r);

    if (!lChanged && rChanged) result.push(r);
    else result.push(l); // local default, including both-changed
  }

  return result;
}

// Re-export EntityChange for consumers
export type { EntityChange };
