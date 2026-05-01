import type { CollectionItem, CollectionAuth, CollectionEvent, RunnerIteration, AppCollection } from '../types';

export function findItemInTree(items: CollectionItem[], id: string): CollectionItem | null {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.item) {
      const found = findItemInTree(item.item, id);
      if (found) return found;
    }
  }
  return null;
}

export function renameItemById(items: CollectionItem[], id: string, newName: string): CollectionItem[] {
  return items.map(item => {
    if (item.id === id) return { ...item, name: newName };
    if (item.item) return { ...item, item: renameItemById(item.item, id, newName) };
    return item;
  });
}

export function updateItemById(items: CollectionItem[], id: string, updated: CollectionItem): CollectionItem[] {
  return items.map(item => {
    if (item.id === id) return updated;
    if (item.item) return { ...item, item: updateItemById(item.item, id, updated) };
    return item;
  });
}

export function removeItemById(items: CollectionItem[], id: string): CollectionItem[] {
  return items
    .filter(item => item.id !== id)
    .map(item => item.item ? { ...item, item: removeItemById(item.item, id) } : item);
}

export function addItemToFolder(items: CollectionItem[], folderId: string, newItem: CollectionItem): CollectionItem[] {
  return items.map(item => {
    if (item.id === folderId) {
      return { ...item, item: [...(item.item || []), newItem] };
    }
    if (Array.isArray(item.item)) {
      return { ...item, item: addItemToFolder(item.item, folderId, newItem) };
    }
    return item;
  });
}

// Recursively bake inherited auth into requests that have no explicit auth set.
// Folders with explicit auth override the inherited value for their subtree.
// noauth on a folder means "block inheritance here".
export function applyInheritedAuth(items: CollectionItem[], inherited: CollectionAuth | undefined): CollectionItem[] {
  return items.map(item => {
    if (item.item) {
      // folder: its own auth (if set and not 'inherit') overrides inherited auth for its children
      const folderAuth = (item.auth && item.auth.type !== 'inherit') ? item.auth : inherited;
      return { ...item, item: applyInheritedAuth(item.item, folderAuth) };
    }
    // request: if auth is undefined or 'inherit', apply inherited auth
    const shouldInherit = !item.request?.auth || item.request.auth.type === 'inherit';
    if (item.request && shouldInherit && inherited) {
      return { ...item, request: { ...item.request, auth: inherited } };
    }
    return item;
  });
}

function deepCloneWithNewIds(item: CollectionItem): CollectionItem {
  const newId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return {
    ...item,
    id: newId,
    item: item.item ? item.item.map(child => deepCloneWithNewIds(child)) : undefined,
  };
}

export function duplicateItem(items: CollectionItem[], itemId: string): CollectionItem[] {
  const result: CollectionItem[] = [];
  for (const item of items) {
    if (item.id === itemId) {
      result.push(item);
      const clone = deepCloneWithNewIds(item);
      result.push({ ...clone, name: `Copy of ${item.name}` });
    } else if (item.item) {
      result.push({ ...item, item: duplicateItem(item.item, itemId) });
    } else {
      result.push(item);
    }
  }
  return result;
}

// ─── Drag & Drop Helpers ──────────────────────────────────────────────────────

/** Remove an item by id and return both the modified tree and the extracted item. */
export function extractItemById(
  items: CollectionItem[],
  id: string,
): { items: CollectionItem[]; extracted: CollectionItem | null } {
  let extracted: CollectionItem | null = null;
  function extract(nodes: CollectionItem[]): CollectionItem[] {
    const result: CollectionItem[] = [];
    for (const node of nodes) {
      if (node.id === id) {
        extracted = node;
      } else {
        result.push(node.item ? { ...node, item: extract(node.item) } : node);
      }
    }
    return result;
  }
  return { items: extract(items), extracted };
}

/** Insert newItem before/after targetId, or as last child of targetId (when position='inside'). */
export function insertItemInTree(
  items: CollectionItem[],
  newItem: CollectionItem,
  targetId: string,
  position: 'before' | 'after' | 'inside',
): CollectionItem[] {
  if (position === 'inside') {
    return items.map(node => {
      if (node.id === targetId && Array.isArray(node.item)) {
        return { ...node, item: [...node.item, newItem] };
      }
      if (node.item) return { ...node, item: insertItemInTree(node.item, newItem, targetId, position) };
      return node;
    });
  }
  const result: CollectionItem[] = [];
  for (const node of items) {
    if (node.id === targetId) {
      if (position === 'before') result.push(newItem, node);
      else result.push(node, newItem);
    } else {
      result.push(node.item ? { ...node, item: insertItemInTree(node.item, newItem, targetId, position) } : node);
    }
  }
  return result;
}

/** Move sourceId to before/after/inside targetId within the same tree. */
export function moveItemInTree(
  items: CollectionItem[],
  sourceId: string,
  targetId: string,
  position: 'before' | 'after' | 'inside',
): CollectionItem[] {
  if (sourceId === targetId) return items;
  const { items: withoutSource, extracted } = extractItemById(items, sourceId);
  if (!extracted) return items;
  return insertItemInTree(withoutSource, extracted, targetId, position);
}

/** Returns true if targetId is a descendant of ancestorId anywhere in the tree. */
export function isDescendantOf(
  items: CollectionItem[],
  ancestorId: string,
  targetId: string,
): boolean {
  function walkChildren(nodes: CollectionItem[]): boolean {
    for (const node of nodes) {
      if (node.id === targetId) return true;
      if (node.item && walkChildren(node.item)) return true;
    }
    return false;
  }
  function findAncestor(nodes: CollectionItem[]): boolean {
    for (const node of nodes) {
      if (node.id === ancestorId) return node.item ? walkChildren(node.item) : false;
      if (node.item && findAncestor(node.item)) return true;
    }
    return false;
  }
  return findAncestor(items);
}

export interface AuthSourceInfo {
  kind: 'folder' | 'collection';
  /** The folder's item id, or undefined when the source is the collection root. */
  id: string | undefined;
  name: string;
}

/**
 * Like resolveInheritedAuth but also returns which folder/collection provides the auth.
 */
export function resolveInheritedAuthWithSource(
  items: CollectionItem[],
  targetId: string,
  collectionAuth: CollectionAuth | undefined,
  collectionName: string,
): { auth: CollectionAuth | undefined; source: AuthSourceInfo } {
  const collectionSource: AuthSourceInfo = { kind: 'collection', id: undefined, name: collectionName };

  function walk(
    nodes: CollectionItem[],
    inherited: CollectionAuth | undefined,
    source: AuthSourceInfo,
  ): { found: true; auth: CollectionAuth | undefined; source: AuthSourceInfo } | { found: false } {
    for (const node of nodes) {
      if (node.id === targetId) return { found: true, auth: inherited, source };
      if (node.item) {
        let nextInherited = inherited;
        let nextSource = source;
        if (node.auth && node.auth.type !== 'inherit') {
          nextInherited = node.auth;
          nextSource = { kind: 'folder', id: node.id, name: node.name };
        }
        const result = walk(node.item, nextInherited, nextSource);
        if (result.found) return result;
      }
    }
    return { found: false };
  }

  const result = walk(items, collectionAuth, collectionSource);
  if (result.found) return { auth: result.auth, source: result.source };
  return { auth: collectionAuth, source: collectionSource };
}

// Walk the collection tree and return the effective (parent) auth for a given request ID.
// This is the auth the request would inherit if its own auth is set to 'inherit'.
export function resolveInheritedAuth(
  items: CollectionItem[],
  targetId: string,
  collectionAuth: CollectionAuth | undefined,
): CollectionAuth | undefined {
  function walk(
    nodes: CollectionItem[],
    inherited: CollectionAuth | undefined,
  ): { found: true; auth: CollectionAuth | undefined } | { found: false } {
    for (const node of nodes) {
      if (node.id === targetId) return { found: true, auth: inherited };
      if (node.item) {
        const folderAuth = (node.auth && node.auth.type !== 'inherit') ? node.auth : inherited;
        const result = walk(node.item, folderAuth);
        if (result.found) return result;
      }
    }
    return { found: false };
  }
  const result = walk(items, collectionAuth);
  return result.found ? result.auth : collectionAuth;
}

/** Extract the trimmed script code for a given listen type from an event array, or null if absent/empty. */
function extractEventCode(events: CollectionEvent[] | undefined, listen: 'prerequest' | 'test'): string | null {
  const ev = (events ?? []).find(e => e.listen === listen);
  if (!ev) return null;
  const code = Array.isArray(ev.script.exec) ? ev.script.exec.join('\n') : (ev.script.exec ?? '');
  return code.trim() || null;
}

export interface AncestorScripts {
  /** Pre-request code blocks from outermost ancestor to innermost folder (not including the request itself). */
  prereqs: string[];
  /** Test code blocks from outermost ancestor to innermost folder (not including the request itself). */
  tests: string[];
}

/**
 * Walk the collection tree and return the accumulated pre-request and test script
 * code blocks contributed by the collection root and all ancestor folders of targetId.
 * The request's own scripts are NOT included — call site is responsible for appending them.
 * Order is outermost-first (collection → folder… → innermost folder).
 */
export function collectAncestorScripts(
  items: CollectionItem[],
  targetId: string,
  collectionEvents?: CollectionEvent[],
): AncestorScripts {
  const collPrereq = extractEventCode(collectionEvents, 'prerequest');
  const collTest = extractEventCode(collectionEvents, 'test');
  const initial: AncestorScripts = {
    prereqs: collPrereq ? [collPrereq] : [],
    tests: collTest ? [collTest] : [],
  };

  function walk(
    nodes: CollectionItem[],
    acc: AncestorScripts,
  ): { found: true; scripts: AncestorScripts } | { found: false } {
    for (const node of nodes) {
      if (node.id === targetId) return { found: true, scripts: acc };
      if (node.item) {
        const folderPrereq = extractEventCode(node.event, 'prerequest');
        const folderTest = extractEventCode(node.event, 'test');
        const next: AncestorScripts = {
          prereqs: folderPrereq ? [...acc.prereqs, folderPrereq] : acc.prereqs,
          tests: folderTest ? [...acc.tests, folderTest] : acc.tests,
        };
        const result = walk(node.item, next);
        if (result.found) return result;
      }
    }
    return { found: false };
  }

  const result = walk(items, initial);
  return result.found ? result.scripts : initial;
}

/** Collect all request (leaf) IDs from a subtree. */
export function getAllRequestIds(items: CollectionItem[]): string[] {
  function walk(nodes: CollectionItem[], acc: string[]): void {
    for (const item of nodes) {
      if (item.item) {
        walk(item.item, acc);
        continue;
      }
      if (item.request && item.id) acc.push(item.id);
    }
  }

  const requestIds: string[] = [];
  walk(items, requestIds);
  return requestIds;
}

/** Collect all request names from a collection subtree (for autocomplete). */
export function flattenRequestNames(items: CollectionItem[]): string[] {
  const names: string[] = [];
  function walk(arr: CollectionItem[]) {
    for (const it of arr) {
      if (it.request && it.name) names.push(it.name);
      if (it.item) walk(it.item);
    }
  }
  walk(items);
  return names;
}

/** Collect all request id+name pairs from a collection subtree (for autocomplete). */
export function flattenRequestItems(items: CollectionItem[]): Array<{ id: string; name: string }> {
  const result: Array<{ id: string; name: string }> = [];
  function walk(arr: CollectionItem[]) {
    for (const it of arr) {
      if (it.request && it.id && it.name) result.push({ id: it.id, name: it.name });
      if (it.item) walk(it.item);
    }
  }
  walk(items);
  return result;
}

/**
 * Return the full display breadcrumb for a request:
 * "Collection Name > Folder A > … > Request Name"
 * Returns null if the collection or item cannot be found.
 */
export function getRequestBreadcrumb(
  collections: AppCollection[],
  collectionId: string,
  itemId: string,
): string | null {
  const prefix = getRequestBreadcrumbPrefix(collections, collectionId, itemId);
  if (!prefix) return null;
  const col = collections.find(c => c._id === collectionId);
  const item = col ? findItemInTree(col.item, itemId) : null;
  if (!item) return null;
  return [...prefix, item.name].join(' > ');
}

/**
 * Return the ancestor path segments for a request (collection name + folder names),
 * NOT including the request name itself.
 * Returns null if the collection or item cannot be found.
 * e.g. ["My API", "Users"] for a request inside the Users folder.
 */
export function getRequestBreadcrumbPrefix(
  collections: AppCollection[],
  collectionId: string,
  itemId: string,
): string[] | null {
  const col = collections.find(c => c._id === collectionId);
  if (!col) return null;

  function walk(items: CollectionItem[], path: string[]): string[] | null {
    for (const item of items) {
      if (item.id === itemId) return path;
      if (item.item) {
        const found = walk(item.item, [...path, item.name]);
        if (found) return found;
      }
    }
    return null;
  }

  return walk(col.item, [col.info.name]);
}

/**
 * Return the IDs of ancestor folders on the path to targetId within `items`.
 * Returns [] if the item is at the root level (no folder ancestors).
 * Returns null if targetId is not found anywhere in the tree.
 */
export function getAncestorItemIds(items: CollectionItem[], targetId: string): string[] | null {
  function walk(nodes: CollectionItem[], path: string[]): string[] | null {
    for (const node of nodes) {
      if (node.id === targetId) return path;
      if (node.item) {
        const found = walk(node.item, [...path, node.id]);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(items, []);
}

/** Sort a flat array of CollectionItems by name (locale-aware, stable). */
export function sortItemsByName(items: CollectionItem[]): CollectionItem[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => a.item.name.localeCompare(b.item.name, undefined, { sensitivity: 'base' }) || a.i - b.i)
    .map(({ item }) => item);
}

/**
 * Sort the direct children of a collection root or a specific folder.
 * When `folderId` is undefined, sorts the top-level `items` array.
 * When `folderId` is provided, sorts only that folder's direct children.
 * Returns a new array (does not mutate).
 */
export function sortChildrenByName(items: CollectionItem[], folderId?: string): CollectionItem[] {
  if (folderId === undefined) {
    return sortItemsByName(items);
  }
  return items.map(node => {
    if (node.id === folderId) {
      return { ...node, item: sortItemsByName(node.item || []) };
    }
    if (node.item) {
      return { ...node, item: sortChildrenByName(node.item, folderId) };
    }
    return node;
  });
}

// ─── Bulk Delete Helpers ──────────────────────────────────────────────────────

export interface BulkDeleteCandidate {
  id: string;
  name: string;
  kind: 'collection' | 'folder' | 'request';
  /** For collection candidates: same as id. For item candidates: the owning collection's _id. */
  collectionId: string;
  collectionName: string;
  /** Ancestor breadcrumb (e.g. "Folder A / Folder B"). Empty string for root-level items. */
  path: string;
}

function walkBulkCandidates(
  nodes: CollectionItem[],
  collectionId: string,
  collectionName: string,
  pathPrefix: string,
  result: BulkDeleteCandidate[],
): void {
  for (const node of nodes) {
    if (!node.id) continue;
    result.push({
      id: node.id,
      name: node.name,
      kind: Array.isArray(node.item) ? 'folder' : 'request',
      collectionId,
      collectionName,
      path: pathPrefix,
    });
    if (Array.isArray(node.item)) {
      const childPath = pathPrefix ? `${pathPrefix} / ${node.name}` : node.name;
      walkBulkCandidates(node.item, collectionId, collectionName, childPath, result);
    }
  }
}

/**
 * Build a flat list of all sibling collections and their descendants as bulk-delete candidates.
 * Used when the action is triggered at the collection level.
 */
export function getCollectionLevelCandidates(collections: AppCollection[]): BulkDeleteCandidate[] {
  const result: BulkDeleteCandidate[] = [];
  for (const col of collections) {
    result.push({
      id: col._id,
      name: col.info.name,
      kind: 'collection',
      collectionId: col._id,
      collectionName: col.info.name,
      path: '',
    });
    walkBulkCandidates(col.item, col._id, col.info.name, '', result);
  }
  return result;
}

/**
 * Build a flat list of sibling items (same parent container as targetId) and their descendants.
 * Used when the action is triggered on a folder or request inside a collection.
 */
export function getItemLevelCandidates(
  items: CollectionItem[],
  targetId: string,
  collectionId: string,
  collectionName: string,
): BulkDeleteCandidate[] {
  function findContainerWithPath(
    nodes: CollectionItem[],
    pathPrefix: string,
  ): { container: CollectionItem[]; pathPrefix: string } | null {
    if (nodes.some(n => n.id === targetId)) return { container: nodes, pathPrefix };
    for (const node of nodes) {
      if (node.item) {
        const childPath = pathPrefix ? `${pathPrefix} / ${node.name}` : node.name;
        const found = findContainerWithPath(node.item, childPath);
        if (found) return found;
      }
    }
    return null;
  }

  const containerResult = findContainerWithPath(items, '');
  if (!containerResult) return [];

  const result: BulkDeleteCandidate[] = [];
  walkBulkCandidates(containerResult.container, collectionId, collectionName, containerResult.pathPrefix, result);
  return result;
}

/**
 * Remove all items whose ids are present in the given set, recursively.
 */
export function removeItemsByIds(items: CollectionItem[], ids: Set<string>): CollectionItem[] {
  return items
    .filter(item => !item.id || !ids.has(item.id))
    .map(item => item.item ? { ...item, item: removeItemsByIds(item.item, ids) } : item);
}

/**
 * Export workflow from runner iterations into a Postman v2.1 collection.
 * Flattens all iterations and results in execution order, mapping each
 * RunnerIterationResult to a CollectionItem request.
 *
 * @param runName - Display name for the exported run
 * @param collectionName - Name of the original collection
 * @param iterations - Array of RunnerIteration objects from a runner execution
 * @returns AppCollection compatible with Postman v2.1 schema
 */
export function exportWorkflowCollection(
  runName: string,
  collectionName: string,
  iterations: RunnerIteration[]
): AppCollection {
  const items: CollectionItem[] = [];

  // Flatten all iterations and their results in order
  for (const iteration of iterations) {
    for (const result of iteration.results) {
      // Determine the URL to use (prefer resolvedUrl with fallback)
      const urlValue = result.resolvedUrl || result.url || '';

      // Convert requestHeaders Record to header array format
      const headerArray = result.requestHeaders
        ? Object.entries(result.requestHeaders).map(([key, value]) => ({
            key,
            value,
          }))
        : [];

      // Build the collection item
      const item: CollectionItem = {
        id: `${Math.random().toString(36).slice(2, 10)}`, // Generate unique ID
        name: result.name,
        request: {
          method: result.method,
          url: urlValue, // Can be string or parsed URL object, Postman accepts both
          header: headerArray,
          body:
            result.requestBody !== undefined && result.requestBody !== null
              ? {
                  mode: 'raw',
                  raw: result.requestBody,
                }
              : undefined,
        },
      };

      items.push(item);
    }
  }

  // Build the Postman v2.1 collection
  const _id = Math.random().toString(36).slice(2, 10);
  const collection: AppCollection = {
    _id,
    info: {
      _postman_id: _id,
      name: `${collectionName} – ${runName}`,
      description: `Exported workflow from runner execution: ${runName}`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: items,
  } as AppCollection;

  return collection;
}
