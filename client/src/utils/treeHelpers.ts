import type { PostmanItem, PostmanAuth } from '../types';

export function findItemInTree(items: PostmanItem[], id: string): PostmanItem | null {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.item) {
      const found = findItemInTree(item.item, id);
      if (found) return found;
    }
  }
  return null;
}

export function renameItemById(items: PostmanItem[], id: string, newName: string): PostmanItem[] {
  return items.map(item => {
    if (item.id === id) return { ...item, name: newName };
    if (item.item) return { ...item, item: renameItemById(item.item, id, newName) };
    return item;
  });
}

export function updateItemById(items: PostmanItem[], id: string, updated: PostmanItem): PostmanItem[] {
  return items.map(item => {
    if (item.id === id) return updated;
    if (item.item) return { ...item, item: updateItemById(item.item, id, updated) };
    return item;
  });
}

export function removeItemById(items: PostmanItem[], id: string): PostmanItem[] {
  return items
    .filter(item => item.id !== id)
    .map(item => item.item ? { ...item, item: removeItemById(item.item, id) } : item);
}

export function addItemToFolder(items: PostmanItem[], folderId: string, newItem: PostmanItem): PostmanItem[] {
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
export function applyInheritedAuth(items: PostmanItem[], inherited: PostmanAuth | undefined): PostmanItem[] {
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

function deepCloneWithNewIds(item: PostmanItem): PostmanItem {
  const newId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return {
    ...item,
    id: newId,
    item: item.item ? item.item.map(child => deepCloneWithNewIds(child)) : undefined,
  };
}

export function duplicateItem(items: PostmanItem[], itemId: string): PostmanItem[] {
  const result: PostmanItem[] = [];
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
  items: PostmanItem[],
  id: string,
): { items: PostmanItem[]; extracted: PostmanItem | null } {
  let extracted: PostmanItem | null = null;
  function extract(nodes: PostmanItem[]): PostmanItem[] {
    const result: PostmanItem[] = [];
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
  items: PostmanItem[],
  newItem: PostmanItem,
  targetId: string,
  position: 'before' | 'after' | 'inside',
): PostmanItem[] {
  if (position === 'inside') {
    return items.map(node => {
      if (node.id === targetId && Array.isArray(node.item)) {
        return { ...node, item: [...node.item, newItem] };
      }
      if (node.item) return { ...node, item: insertItemInTree(node.item, newItem, targetId, position) };
      return node;
    });
  }
  const result: PostmanItem[] = [];
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
  items: PostmanItem[],
  sourceId: string,
  targetId: string,
  position: 'before' | 'after' | 'inside',
): PostmanItem[] {
  if (sourceId === targetId) return items;
  const { items: withoutSource, extracted } = extractItemById(items, sourceId);
  if (!extracted) return items;
  return insertItemInTree(withoutSource, extracted, targetId, position);
}

/** Returns true if targetId is a descendant of ancestorId anywhere in the tree. */
export function isDescendantOf(
  items: PostmanItem[],
  ancestorId: string,
  targetId: string,
): boolean {
  function walkChildren(nodes: PostmanItem[]): boolean {
    for (const node of nodes) {
      if (node.id === targetId) return true;
      if (node.item && walkChildren(node.item)) return true;
    }
    return false;
  }
  function findAncestor(nodes: PostmanItem[]): boolean {
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
  items: PostmanItem[],
  targetId: string,
  collectionAuth: PostmanAuth | undefined,
): PostmanAuth | undefined {
  function walk(
    nodes: PostmanItem[],
    inherited: PostmanAuth | undefined,
  ): { found: true; auth: PostmanAuth | undefined } | { found: false } {
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
