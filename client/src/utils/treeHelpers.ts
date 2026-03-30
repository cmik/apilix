import type { PostmanItem, PostmanAuth } from '../types';

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
