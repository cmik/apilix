import { describe, it, expect } from 'vitest';
import type { CollectionItem, CollectionAuth, CollectionEvent } from '../types';
import {
  findItemInTree,
  renameItemById,
  updateItemById,
  removeItemById,
  addItemToFolder,
  duplicateItem,
  extractItemById,
  insertItemInTree,
  moveItemInTree,
  isDescendantOf,
  applyInheritedAuth,
  resolveInheritedAuth,
  collectAncestorScripts,
  sortItemsByName,
  sortChildrenByName,
} from './treeHelpers';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function req(id: string, name: string): CollectionItem {
  return { id, name, request: { method: 'GET', url: 'https://example.com' } };
}

function folder(id: string, name: string, children: CollectionItem[]): CollectionItem {
  return { id, name, item: children };
}

function makeTree(): CollectionItem[] {
  return [
    req('r1', 'Request 1'),
    folder('f1', 'Folder 1', [
      req('r2', 'Request 2'),
      folder('f2', 'Folder 2', [
        req('r3', 'Request 3'),
      ]),
    ]),
  ];
}

// ─── findItemInTree ───────────────────────────────────────────────────────────

describe('findItemInTree', () => {
  it('finds a top-level item', () => {
    const tree = makeTree();
    expect(findItemInTree(tree, 'r1')?.name).toBe('Request 1');
  });

  it('finds a nested item', () => {
    const tree = makeTree();
    expect(findItemInTree(tree, 'r3')?.name).toBe('Request 3');
  });

  it('finds a folder', () => {
    const tree = makeTree();
    expect(findItemInTree(tree, 'f2')?.name).toBe('Folder 2');
  });

  it('returns null for a missing id', () => {
    expect(findItemInTree(makeTree(), 'nonexistent')).toBeNull();
  });

  it('returns null on empty tree', () => {
    expect(findItemInTree([], 'r1')).toBeNull();
  });
});

// ─── renameItemById ───────────────────────────────────────────────────────────

describe('renameItemById', () => {
  it('renames a top-level item', () => {
    const result = renameItemById(makeTree(), 'r1', 'Renamed');
    expect(findItemInTree(result, 'r1')?.name).toBe('Renamed');
  });

  it('renames a nested item', () => {
    const result = renameItemById(makeTree(), 'r3', 'Deep Renamed');
    expect(findItemInTree(result, 'r3')?.name).toBe('Deep Renamed');
  });

  it('returns a new array reference (immutable)', () => {
    const tree = makeTree();
    const result = renameItemById(tree, 'r1', 'New');
    expect(result).not.toBe(tree);
  });

  it('is a no-op for unknown id', () => {
    const tree = makeTree();
    const result = renameItemById(tree, 'unknown', 'X');
    expect(result.map(i => i.name)).toEqual(tree.map(i => i.name));
  });
});

// ─── updateItemById ───────────────────────────────────────────────────────────

describe('updateItemById', () => {
  it('replaces a top-level item', () => {
    const tree = makeTree();
    const updated = { ...req('r1', 'Updated Request') };
    const result = updateItemById(tree, 'r1', updated);
    expect(findItemInTree(result, 'r1')?.name).toBe('Updated Request');
  });

  it('replaces a deeply nested item', () => {
    const tree = makeTree();
    const updated = req('r3', 'Updated R3');
    const result = updateItemById(tree, 'r3', updated);
    expect(findItemInTree(result, 'r3')?.name).toBe('Updated R3');
  });
});

// ─── removeItemById ───────────────────────────────────────────────────────────

describe('removeItemById', () => {
  it('removes a top-level item', () => {
    const result = removeItemById(makeTree(), 'r1');
    expect(findItemInTree(result, 'r1')).toBeNull();
    expect(result.length).toBe(1);
  });

  it('removes a nested item', () => {
    const result = removeItemById(makeTree(), 'r3');
    expect(findItemInTree(result, 'r3')).toBeNull();
  });

  it('is a no-op for unknown id', () => {
    const tree = makeTree();
    const result = removeItemById(tree, 'nope');
    expect(result.length).toBe(tree.length);
  });
});

// ─── addItemToFolder ─────────────────────────────────────────────────────────

describe('addItemToFolder', () => {
  it('adds a child to the target folder', () => {
    const tree = makeTree();
    const newItem = req('r4', 'New Request');
    const result = addItemToFolder(tree, 'f1', newItem);
    const f1 = findItemInTree(result, 'f1')!;
    expect(f1.item?.some(i => i.id === 'r4')).toBe(true);
  });

  it('adds a child to a nested folder', () => {
    const tree = makeTree();
    const newItem = req('r5', 'Deep New');
    const result = addItemToFolder(tree, 'f2', newItem);
    const f2 = findItemInTree(result, 'f2')!;
    expect(f2.item?.some(i => i.id === 'r5')).toBe(true);
  });

  it('does not modify folders that are not the target', () => {
    const tree = makeTree();
    const result = addItemToFolder(tree, 'f2', req('r5', 'R5'));
    const f1 = findItemInTree(result, 'f1')!;
    expect(f1.item?.some(i => i.id === 'r5')).toBe(false);
  });
});

// ─── duplicateItem ────────────────────────────────────────────────────────────

describe('duplicateItem', () => {
  it('inserts a copy immediately after the original', () => {
    const tree = makeTree();
    const result = duplicateItem(tree, 'r1');
    const r1Idx = result.findIndex(i => i.id === 'r1');
    expect(result[r1Idx + 1].name).toBe('Copy of Request 1');
  });

  it('assigns a different id to the duplicate', () => {
    const tree = makeTree();
    const result = duplicateItem(tree, 'r1');
    const origId = 'r1';
    const copy = result.find(i => i.name === 'Copy of Request 1')!;
    expect(copy.id).not.toBe(origId);
  });

  it('regenerates all child ids in a duplicated folder', () => {
    const tree = makeTree();
    const result = duplicateItem(tree, 'f1');
    const copyFolder = result.find(i => i.name === 'Copy of Folder 1')!;
    const origChildIds = new Set(['r2', 'f2', 'r3']);
    function collectIds(items: CollectionItem[]): string[] {
      return items.flatMap(i => [i.id!, ...(i.item ? collectIds(i.item) : [])]);
    }
    const copyIds = collectIds([copyFolder]);
    expect(copyIds.some(id => origChildIds.has(id))).toBe(false);
  });
});

// ─── extractItemById ─────────────────────────────────────────────────────────

describe('extractItemById', () => {
  it('removes the item from top level and returns it', () => {
    const tree = makeTree();
    const { items, extracted } = extractItemById(tree, 'r1');
    expect(extracted?.id).toBe('r1');
    expect(findItemInTree(items, 'r1')).toBeNull();
  });

  it('removes a nested item and returns it', () => {
    const tree = makeTree();
    const { items, extracted } = extractItemById(tree, 'r3');
    expect(extracted?.id).toBe('r3');
    expect(findItemInTree(items, 'r3')).toBeNull();
  });

  it('returns null extracted for unknown id', () => {
    const { extracted } = extractItemById(makeTree(), 'nope');
    expect(extracted).toBeNull();
  });
});

// ─── insertItemInTree ─────────────────────────────────────────────────────────

describe('insertItemInTree', () => {
  it('inserts before a top-level item', () => {
    const tree = [req('a', 'A'), req('b', 'B')];
    const result = insertItemInTree(tree, req('x', 'X'), 'b', 'before');
    const idx = result.findIndex(i => i.id === 'x');
    expect(result[idx + 1].id).toBe('b');
  });

  it('inserts after a top-level item', () => {
    const tree = [req('a', 'A'), req('b', 'B')];
    const result = insertItemInTree(tree, req('x', 'X'), 'a', 'after');
    const idx = result.findIndex(i => i.id === 'a');
    expect(result[idx + 1].id).toBe('x');
  });

  it('inserts inside a folder as last child', () => {
    const tree = [folder('f', 'F', [req('a', 'A')])];
    const result = insertItemInTree(tree, req('x', 'X'), 'f', 'inside');
    const f = findItemInTree(result, 'f')!;
    expect(f.item?.[f.item.length - 1].id).toBe('x');
  });
});

// ─── moveItemInTree ───────────────────────────────────────────────────────────

describe('moveItemInTree', () => {
  it('moves an item to a different position', () => {
    const tree = [req('a', 'A'), req('b', 'B'), req('c', 'C')];
    const result = moveItemInTree(tree, 'c', 'a', 'before');
    expect(result[0].id).toBe('c');
    expect(result[1].id).toBe('a');
  });

  it('returns original tree when source === target', () => {
    const tree = makeTree();
    const result = moveItemInTree(tree, 'r1', 'r1', 'after');
    expect(result).toBe(tree);
  });

  it('returns original tree when source is not found', () => {
    const tree = makeTree();
    const result = moveItemInTree(tree, 'ghost', 'r1', 'after');
    expect(result).toBe(tree);
  });
});

// ─── isDescendantOf ───────────────────────────────────────────────────────────

describe('isDescendantOf', () => {
  it('returns true when targetId is a direct child of ancestorId', () => {
    expect(isDescendantOf(makeTree(), 'f1', 'r2')).toBe(true);
  });

  it('returns true for a deeply nested descendant', () => {
    expect(isDescendantOf(makeTree(), 'f1', 'r3')).toBe(true);
  });

  it('returns false when the item is not a descendant', () => {
    expect(isDescendantOf(makeTree(), 'f2', 'r1')).toBe(false);
  });

  it('returns false when ancestorId does not exist', () => {
    expect(isDescendantOf(makeTree(), 'never', 'r1')).toBe(false);
  });

  it('returns false when ancestor has no children', () => {
    expect(isDescendantOf(makeTree(), 'r1', 'r2')).toBe(false);
  });
});

// ─── applyInheritedAuth ──────────────────────────────────────────────────────

describe('applyInheritedAuth', () => {
  const bearerAuth: CollectionAuth = { type: 'bearer', bearer: [{ key: 'token', value: 'tok123' }] };

  it('applies inherited auth to a request without explicit auth', () => {
    const tree: CollectionItem[] = [
      { id: 'r', name: 'R', request: { method: 'GET', url: 'https://a.com' } },
    ];
    const result = applyInheritedAuth(tree, bearerAuth);
    expect(result[0].request?.auth?.type).toBe('bearer');
  });

  it('does not override explicit auth on a request', () => {
    const noAuth: CollectionAuth = { type: 'noauth' };
    const tree: CollectionItem[] = [
      { id: 'r', name: 'R', request: { method: 'GET', url: 'https://a.com', auth: noAuth } },
    ];
    const result = applyInheritedAuth(tree, bearerAuth);
    expect(result[0].request?.auth?.type).toBe('noauth');
  });

  it('a folder with its own auth overrides inherited auth for children', () => {
    const folderAuth: CollectionAuth = { type: 'basic', basic: [{ key: 'username', value: 'u' }] };
    const tree: CollectionItem[] = [
      folder('f', 'F', [
        { id: 'r', name: 'R', request: { method: 'GET', url: 'https://a.com' } },
      ]),
    ];
    (tree[0] as CollectionItem).auth = folderAuth;
    const result = applyInheritedAuth(tree, bearerAuth);
    const child = findItemInTree(result, 'r')!;
    expect(child.request?.auth?.type).toBe('basic');
  });
});

// ─── resolveInheritedAuth ────────────────────────────────────────────────────

describe('resolveInheritedAuth', () => {
  const bearerAuth: CollectionAuth = { type: 'bearer', bearer: [{ key: 'token', value: 'tok' }] };

  it('returns collection auth for a top-level request', () => {
    const tree = [req('r1', 'R1')];
    expect(resolveInheritedAuth(tree, 'r1', bearerAuth)).toEqual(bearerAuth);
  });

  it('returns folder auth when folder has explicit auth', () => {
    const folderAuth: CollectionAuth = { type: 'basic', basic: [] };
    const tree: CollectionItem[] = [
      { id: 'f', name: 'F', auth: folderAuth, item: [req('r', 'R')] },
    ];
    expect(resolveInheritedAuth(tree, 'r', bearerAuth)).toEqual(folderAuth);
  });

  it('returns collection auth when folder leaves auth as inherit', () => {
    const tree: CollectionItem[] = [
      { id: 'f', name: 'F', auth: { type: 'inherit' }, item: [req('r', 'R')] },
    ];
    expect(resolveInheritedAuth(tree, 'r', bearerAuth)).toEqual(bearerAuth);
  });
});

// ─── collectAncestorScripts ──────────────────────────────────────────────────

describe('collectAncestorScripts', () => {
  function makeEvent(listen: 'prerequest' | 'test', code: string): CollectionEvent {
    return { listen, script: { type: 'text/javascript', exec: [code] } };
  }

  it('returns empty arrays when there are no collection events and no ancestor folders', () => {
    const tree = [req('r', 'R')];
    const result = collectAncestorScripts(tree, 'r');
    expect(result.prereqs).toEqual([]);
    expect(result.tests).toEqual([]);
  });

  it('includes collection-level scripts', () => {
    const tree = [req('r', 'R')];
    const collEvents: CollectionEvent[] = [makeEvent('prerequest', 'collection();')];
    const result = collectAncestorScripts(tree, 'r', collEvents);
    expect(result.prereqs).toEqual(['collection();']);
  });

  it('includes folder scripts in outermost-first order', () => {
    const tree: CollectionItem[] = [
      {
        id: 'f1', name: 'F1',
        event: [makeEvent('prerequest', 'folder1();')],
        item: [
          {
            id: 'f2', name: 'F2',
            event: [makeEvent('prerequest', 'folder2();')],
            item: [req('r', 'R')],
          },
        ],
      },
    ];
    const result = collectAncestorScripts(tree, 'r');
    expect(result.prereqs).toEqual(['folder1();', 'folder2();']);
  });

  it('does not include the target request itself', () => {
    const tree: CollectionItem[] = [
      {
        id: 'f', name: 'F',
        event: [makeEvent('test', 'folder-test();')],
        item: [
          {
            ...req('r', 'R'),
            event: [makeEvent('test', 'request-test();')],
          },
        ],
      },
    ];
    const result = collectAncestorScripts(tree, 'r');
    expect(result.tests).toEqual(['folder-test();']);
    expect(result.tests).not.toContain('request-test();');
  });

  it('returns empty when targetId is not in the tree', () => {
    const tree = [req('r1', 'R1')];
    const result = collectAncestorScripts(tree, 'nonexistent');
    expect(result.prereqs).toEqual([]);
    expect(result.tests).toEqual([]);
  });
});

// ─── sortItemsByName ─────────────────────────────────────────────────────────

describe('sortItemsByName', () => {
  it('sorts items alphabetically', () => {
    const items = [req('r1', 'Zebra'), req('r2', 'Apple'), req('r3', 'Mango')];
    const result = sortItemsByName(items);
    expect(result.map(i => i.name)).toEqual(['Apple', 'Mango', 'Zebra']);
  });

  it('preserves ids and payloads after sort', () => {
    const items = [req('r1', 'Beta'), req('r2', 'Alpha')];
    const result = sortItemsByName(items);
    expect(result[0].id).toBe('r2');
    expect(result[1].id).toBe('r1');
  });

  it('is stable for items with the same name', () => {
    const items = [req('r1', 'Same'), req('r2', 'Same'), req('r3', 'Same')];
    const result = sortItemsByName(items);
    expect(result.map(i => i.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('does not mutate the original array', () => {
    const items = [req('r1', 'Z'), req('r2', 'A')];
    const original = [...items];
    const result = sortItemsByName(items);
    expect(items[0].id).toBe(original[0].id);
    expect(result).not.toBe(items);
  });

  it('handles empty array', () => {
    expect(sortItemsByName([])).toEqual([]);
  });

  it('handles single item', () => {
    const items = [req('r1', 'Solo')];
    expect(sortItemsByName(items)).toEqual(items);
  });
});

// ─── sortChildrenByName ──────────────────────────────────────────────────────

describe('sortChildrenByName', () => {
  it('sorts top-level items when no folderId given', () => {
    const items = [req('r1', 'Zebra'), req('r2', 'Apple')];
    const result = sortChildrenByName(items);
    expect(result.map(i => i.name)).toEqual(['Apple', 'Zebra']);
  });

  it('sorts only direct children of the target folder', () => {
    const items = [
      folder('f1', 'Folder', [req('r2', 'Zebra'), req('r1', 'Apple')]),
      req('r3', 'Outer'),
    ];
    const result = sortChildrenByName(items, 'f1');
    const f = result.find(i => i.id === 'f1')!;
    expect(f.item!.map(i => i.name)).toEqual(['Apple', 'Zebra']);
    // outer items unchanged
    expect(result.find(i => i.id === 'r3')).toBeDefined();
  });

  it('does not sort grandchildren when targeting a folder', () => {
    const grandchildren = [req('g2', 'Z'), req('g1', 'A')];
    const items = [
      folder('f1', 'Folder', [
        folder('f2', 'Subfolder', grandchildren),
        req('r1', 'Request'),
      ]),
    ];
    const result = sortChildrenByName(items, 'f1');
    const f1 = result.find(i => i.id === 'f1')!;
    const f2 = f1.item!.find(i => i.id === 'f2')!;
    // grandchildren order unchanged
    expect(f2.item!.map(i => i.id)).toEqual(['g2', 'g1']);
  });

  it('is a no-op for unknown folder id', () => {
    const items = [req('r1', 'Z'), req('r2', 'A')];
    const result = sortChildrenByName(items, 'nonexistent');
    expect(result.map(i => i.id)).toEqual(['r1', 'r2']);
  });

  it('sorts nested folder children recursively found', () => {
    const items = [
      folder('f1', 'Outer', [
        folder('f2', 'Inner', [req('r2', 'Z'), req('r1', 'A')]),
      ]),
    ];
    const result = sortChildrenByName(items, 'f2');
    const f1 = result.find(i => i.id === 'f1')!;
    const f2 = f1.item!.find(i => i.id === 'f2')!;
    expect(f2.item!.map(i => i.id)).toEqual(['r1', 'r2']);
  });
});
