import type { CollectionItem, CollectionAuth } from '../types';

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
    // request: if auth is undefined or 'inherit', apply inherited (unless inherited is noauth)
    const shouldInherit = !item.request?.auth || item.request.auth.type === 'inherit';
    if (item.request && shouldInherit && inherited && inherited.type !== 'noauth') {
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
