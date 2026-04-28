/**
 * workspaceDiffer — structural differ for WorkspaceData.
 *
 * Produces domain-scoped change sets between two workspace snapshots.
 * Supports stable matching by entity id with a normalized fallback for
 * requests (name + method + url path) when ids diverge after import or
 * duplication.
 *
 * Output is fed to workspaceMerge.ts for three-way merge computation.
 */

import type {
  WorkspaceData,
  AppCollection,
  AppEnvironment,
  CollectionItem,
  MockRoute,
} from '../../types';

// ─── Change set types ─────────────────────────────────────────────────────────

export type ChangeKind =
  | 'added'
  | 'removed'
  | 'modified'
  | 'renamed'
  | 'moved';

export interface EntityChange<T> {
  kind: ChangeKind;
  id: string;
  /** Human-readable label for display */
  label: string;
  base?: T;
  theirs?: T;
  /** Path within the collection tree (for request-level changes) */
  path?: string[];
}

export interface WorkspaceDiff {
  collections: EntityChange<AppCollection>[];
  requests: EntityChange<CollectionItem>[];
  environments: EntityChange<AppEnvironment>[];
  globalVariables: EntityChange<Record<string, string>>[];
  collectionVariables: EntityChange<Record<string, string>>[];
  mockRoutes: EntityChange<MockRoute>[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute a structural diff from `base` to `changed`.
 * Used for both local→changed and remote→changed sides in three-way merge.
 */
export function diffWorkspace(base: WorkspaceData, changed: WorkspaceData): WorkspaceDiff {
  return {
    collections: diffCollectionShapes(base, changed),
    requests: diffRequests(base, changed),
    environments: diffEnvironments(base.environments, changed.environments),
    globalVariables: diffFlatRecord('global', base.globalVariables, changed.globalVariables),
    collectionVariables: diffCollectionVars(base.collectionVariables, changed.collectionVariables),
    mockRoutes: diffMockRoutes(base.mockRoutes, changed.mockRoutes),
  };
}

// ─── Collections (top-level shape only, not items) ───────────────────────────

function diffCollectionShapes(base: WorkspaceData, changed: WorkspaceData): EntityChange<AppCollection>[] {
  const changes: EntityChange<AppCollection>[] = [];
  const baseMap = new Map(base.collections.map(c => [c._id, c]));
  const changedMap = new Map(changed.collections.map(c => [c._id, c]));

  for (const [id, col] of changedMap) {
    if (!baseMap.has(id)) {
      changes.push({ kind: 'added', id, label: col.info.name, theirs: col });
    } else {
      const b = baseMap.get(id)!;
      if (b.info.name !== col.info.name) {
        changes.push({ kind: 'renamed', id, label: col.info.name, base: b, theirs: col });
      }
    }
  }
  for (const [id, col] of baseMap) {
    if (!changedMap.has(id)) {
      changes.push({ kind: 'removed', id, label: col.info.name, base: col });
    }
  }
  return changes;
}

// ─── Requests (deep tree walk) ────────────────────────────────────────────────

function diffRequests(base: WorkspaceData, changed: WorkspaceData): EntityChange<CollectionItem>[] {
  const changes: EntityChange<CollectionItem>[] = [];
  const baseFlat = flattenItems(base.collections);
  const changedFlat = flattenItems(changed.collections);

  const baseById = new Map(baseFlat.map(r => [r.item.id ?? '', r]));
  const changedById = new Map(changedFlat.map(r => [r.item.id ?? '', r]));

  // Remove empty-id fallback bucket
  baseById.delete('');
  changedById.delete('');

  const unmatchedBase = new Map(baseById);
  const unmatchedChanged = new Map(changedById);

  // Primary match: same id
  for (const [id, cr] of changedById) {
    if (baseById.has(id)) {
      const br = baseById.get(id)!;
      unmatchedBase.delete(id);
      unmatchedChanged.delete(id);

      // Check for parent path change (move)
      const pathChanged = br.path.join('/') !== cr.path.join('/');
      const contentChanged = !deepEqual(br.item, cr.item);

      if (pathChanged && contentChanged) {
        changes.push({ kind: 'modified', id, label: cr.item.name, base: br.item, theirs: cr.item, path: cr.path });
      } else if (pathChanged) {
        changes.push({ kind: 'moved', id, label: cr.item.name, base: br.item, theirs: cr.item, path: cr.path });
      } else if (contentChanged) {
        changes.push({ kind: 'modified', id, label: cr.item.name, base: br.item, theirs: cr.item, path: cr.path });
      }
    }
  }

  // Fallback: heuristic match for unmatched items (import/duplication survivors)
  const matchedHeuristic = new Set<string>();
  for (const [cid, cr] of unmatchedChanged) {
    const cKey = normalizeRequestKey(cr.item);
    for (const [bid, br] of unmatchedBase) {
      if (matchedHeuristic.has(bid)) continue;
      if (normalizeRequestKey(br.item) === cKey) {
        matchedHeuristic.add(bid);
        unmatchedBase.delete(bid);
        unmatchedChanged.delete(cid);

        if (!deepEqual(br.item, cr.item)) {
          changes.push({ kind: 'modified', id: cid, label: cr.item.name, base: br.item, theirs: cr.item, path: cr.path });
        }
        break;
      }
    }
  }

  // Remaining unmatched = pure add / remove
  for (const [id, cr] of unmatchedChanged) {
    changes.push({ kind: 'added', id, label: cr.item.name, theirs: cr.item, path: cr.path });
  }
  for (const [id, br] of unmatchedBase) {
    changes.push({ kind: 'removed', id, label: br.item.name, base: br.item, path: br.path });
  }

  return changes;
}

// ─── Environments ─────────────────────────────────────────────────────────────

function diffEnvironments(
  base: AppEnvironment[],
  changed: AppEnvironment[],
): EntityChange<AppEnvironment>[] {
  const changes: EntityChange<AppEnvironment>[] = [];
  const baseMap = new Map(base.map(e => [e._id, e]));
  const changedMap = new Map(changed.map(e => [e._id, e]));

  for (const [id, env] of changedMap) {
    if (!baseMap.has(id)) {
      changes.push({ kind: 'added', id, label: env.name, theirs: env });
    } else {
      const b = baseMap.get(id)!;
      if (!deepEqual(b, env)) {
        const kind = b.name !== env.name ? 'renamed' : 'modified';
        changes.push({ kind, id, label: env.name, base: b, theirs: env });
      }
    }
  }
  for (const [id, env] of baseMap) {
    if (!changedMap.has(id)) {
      changes.push({ kind: 'removed', id, label: env.name, base: env });
    }
  }
  return changes;
}

// ─── Global variables ─────────────────────────────────────────────────────────

function diffFlatRecord(
  id: string,
  base: Record<string, string>,
  changed: Record<string, string>,
): EntityChange<Record<string, string>>[] {
  if (deepEqual(base, changed)) return [];
  return [{ kind: 'modified', id, label: id, base, theirs: changed }];
}

// ─── Per-collection variables ─────────────────────────────────────────────────

function diffCollectionVars(
  base: Record<string, Record<string, string>>,
  changed: Record<string, Record<string, string>>,
): EntityChange<Record<string, string>>[] {
  const changes: EntityChange<Record<string, string>>[] = [];
  const allIds = new Set([...Object.keys(base), ...Object.keys(changed)]);
  for (const id of allIds) {
    const b = base[id] ?? {};
    const c = changed[id] ?? {};
    if (!deepEqual(b, c)) {
      changes.push({ kind: 'modified', id, label: `Collection vars (${id})`, base: b, theirs: c });
    }
  }
  return changes;
}

// ─── Mock routes ──────────────────────────────────────────────────────────────

function diffMockRoutes(base: MockRoute[], changed: MockRoute[]): EntityChange<MockRoute>[] {
  const changes: EntityChange<MockRoute>[] = [];
  const baseMap = new Map(base.map(r => [r.id, r]));
  const changedMap = new Map(changed.map(r => [r.id, r]));

  for (const [id, route] of changedMap) {
    if (!baseMap.has(id)) {
      changes.push({ kind: 'added', id, label: `${route.method} ${route.path}`, theirs: route });
    } else {
      const b = baseMap.get(id)!;
      if (!deepEqual(b, route)) {
        changes.push({ kind: 'modified', id, label: `${route.method} ${route.path}`, base: b, theirs: route });
      }
    }
  }
  for (const [id, route] of baseMap) {
    if (!changedMap.has(id)) {
      changes.push({ kind: 'removed', id, label: `${route.method} ${route.path}`, base: route });
    }
  }
  return changes;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface FlatRequest {
  item: CollectionItem;
  /** breadcrumb from collection root */
  path: string[];
}

function flattenItems(collections: AppCollection[]): FlatRequest[] {
  const result: FlatRequest[] = [];
  for (const col of collections) {
    walkItems(col.item ?? [], [col.info.name], result);
  }
  return result;
}

function walkItems(items: CollectionItem[], path: string[], out: FlatRequest[]): void {
  for (const item of items) {
    out.push({ item, path });
    if (item.item?.length) {
      walkItems(item.item, [...path, item.name], out);
    }
  }
}

function normalizeRequestKey(item: CollectionItem): string {
  const method = item.request?.method?.toUpperCase() ?? '';
  const url =
    typeof item.request?.url === 'string'
      ? item.request.url
      : (item.request?.url?.raw ?? '');
  // Strip scheme, host, query, fragments to compare paths only
  const pathOnly = url.replace(/^https?:\/\/[^/]*/, '').replace(/\?.*$/, '').replace(/#.*$/, '');
  return `${method}:${item.name.trim().toLowerCase()}:${pathOnly}`;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (!deepEqual((a as Record<string, unknown>)[ka[i]], (b as Record<string, unknown>)[kb[i]])) return false;
  }
  return true;
}
