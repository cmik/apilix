import { describe, it, expect } from 'vitest';
import type { CollectionItem, CollectionAuth } from '../types';
import {
  getAllRequestIds,
  flattenRequestNames,
  flattenRequestItems,
  resolveInheritedAuthWithSource,
} from './treeHelpers';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function req(id: string, name: string): CollectionItem {
  return { id, name, request: { method: 'GET', url: 'https://example.com' } };
}

function folder(id: string, name: string, children: CollectionItem[]): CollectionItem {
  return { id, name, item: children };
}

// ─── getAllRequestIds ─────────────────────────────────────────────────────────

describe('getAllRequestIds', () => {
  it('returns ids for all leaf requests at top level', () => {
    const tree = [req('r1', 'R1'), req('r2', 'R2')];
    expect(getAllRequestIds(tree)).toEqual(['r1', 'r2']);
  });

  it('traverses nested folders and collects request ids', () => {
    const tree = [
      folder('f1', 'F1', [
        req('r2', 'R2'),
        folder('f2', 'F2', [req('r3', 'R3')]),
      ]),
      req('r1', 'R1'),
    ];
    const ids = getAllRequestIds(tree);
    expect(ids).toContain('r1');
    expect(ids).toContain('r2');
    expect(ids).toContain('r3');
    // Folder ids should NOT be in the list
    expect(ids).not.toContain('f1');
    expect(ids).not.toContain('f2');
  });

  it('returns empty array for empty tree', () => {
    expect(getAllRequestIds([])).toEqual([]);
  });

  it('returns empty array when tree contains only folders with no requests', () => {
    const tree = [folder('f1', 'F1', [])];
    expect(getAllRequestIds(tree)).toEqual([]);
  });

  it('skips items without a request field (pure folders)', () => {
    const tree: CollectionItem[] = [
      { id: 'f1', name: 'Folder', item: [] },
    ];
    expect(getAllRequestIds(tree)).toEqual([]);
  });

  it('skips items with no id even if they have a request', () => {
    const tree: CollectionItem[] = [
      { id: '', name: 'No ID', request: { method: 'GET', url: 'https://example.com' } },
    ];
    // id is falsy — should be skipped
    expect(getAllRequestIds(tree)).toEqual([]);
  });
});

// ─── flattenRequestNames ──────────────────────────────────────────────────────

describe('flattenRequestNames', () => {
  it('returns names of all top-level request items', () => {
    const tree = [req('r1', 'Get Users'), req('r2', 'Create User')];
    expect(flattenRequestNames(tree)).toEqual(['Get Users', 'Create User']);
  });

  it('traverses nested folders for names', () => {
    const tree = [
      folder('f1', 'Auth', [
        req('r1', 'Login'),
        folder('f2', 'Sub', [req('r2', 'Logout')]),
      ]),
    ];
    const names = flattenRequestNames(tree);
    expect(names).toContain('Login');
    expect(names).toContain('Logout');
  });

  it('does not include folder names', () => {
    const tree = [
      folder('f1', 'FolderName', [req('r1', 'RequestName')]),
    ];
    const names = flattenRequestNames(tree);
    expect(names).not.toContain('FolderName');
    expect(names).toContain('RequestName');
  });

  it('returns empty array for empty tree', () => {
    expect(flattenRequestNames([])).toEqual([]);
  });

  it('skips items that have no name', () => {
    const tree: CollectionItem[] = [
      { id: 'r1', name: '', request: { method: 'GET', url: 'https://example.com' } },
    ];
    // name is falsy — should be excluded
    expect(flattenRequestNames(tree)).toEqual([]);
  });
});

// ─── flattenRequestItems ──────────────────────────────────────────────────────

describe('flattenRequestItems', () => {
  it('returns id/name pairs for top-level requests', () => {
    const tree = [req('r1', 'R1'), req('r2', 'R2')];
    expect(flattenRequestItems(tree)).toEqual([
      { id: 'r1', name: 'R1' },
      { id: 'r2', name: 'R2' },
    ]);
  });

  it('traverses nested folders', () => {
    const tree = [
      folder('f1', 'Folder', [
        req('r1', 'Login'),
        folder('f2', 'SubFolder', [req('r2', 'Logout')]),
      ]),
    ];
    const result = flattenRequestItems(tree);
    expect(result.find(i => i.id === 'r1')?.name).toBe('Login');
    expect(result.find(i => i.id === 'r2')?.name).toBe('Logout');
  });

  it('does not include folders', () => {
    const tree = [
      folder('f1', 'FolderName', [req('r1', 'RequestName')]),
    ];
    const result = flattenRequestItems(tree);
    expect(result.find(i => i.id === 'f1')).toBeUndefined();
  });

  it('returns empty array for empty tree', () => {
    expect(flattenRequestItems([])).toEqual([]);
  });

  it('skips items missing id or name', () => {
    const tree: CollectionItem[] = [
      { id: '', name: 'No ID', request: { method: 'GET', url: 'https://example.com' } },
      { id: 'r1', name: '', request: { method: 'GET', url: 'https://example.com' } },
    ];
    expect(flattenRequestItems(tree)).toEqual([]);
  });
});

// ─── resolveInheritedAuthWithSource ──────────────────────────────────────────

describe('resolveInheritedAuthWithSource', () => {
  const bearerAuth: CollectionAuth = { type: 'bearer', bearer: [{ key: 'token', value: 'tok' }] };
  const basicAuth: CollectionAuth = { type: 'basic', basic: [{ key: 'username', value: 'u' }] };

  it('returns collection auth and collection source for top-level request', () => {
    const tree = [req('r1', 'R1')];
    const { auth, source } = resolveInheritedAuthWithSource(tree, 'r1', bearerAuth, 'My Collection');
    expect(auth).toEqual(bearerAuth);
    expect(source.kind).toBe('collection');
    expect(source.name).toBe('My Collection');
    expect(source.id).toBeUndefined();
  });

  it('returns folder auth and folder source when folder has explicit auth', () => {
    const tree: CollectionItem[] = [
      { id: 'f1', name: 'Auth Folder', auth: basicAuth, item: [req('r1', 'R1')] },
    ];
    const { auth, source } = resolveInheritedAuthWithSource(tree, 'r1', bearerAuth, 'Collection');
    expect(auth).toEqual(basicAuth);
    expect(source.kind).toBe('folder');
    expect(source.id).toBe('f1');
    expect(source.name).toBe('Auth Folder');
  });

  it('returns collection auth when folder uses inherit', () => {
    const tree: CollectionItem[] = [
      { id: 'f1', name: 'F1', auth: { type: 'inherit' }, item: [req('r1', 'R1')] },
    ];
    const { auth, source } = resolveInheritedAuthWithSource(tree, 'r1', bearerAuth, 'Collection');
    expect(auth).toEqual(bearerAuth);
    expect(source.kind).toBe('collection');
  });

  it('returns innermost folder auth for deeply nested requests', () => {
    const innerAuth: CollectionAuth = { type: 'apikey', apikey: [] };
    const tree: CollectionItem[] = [
      {
        id: 'f1', name: 'Outer', auth: basicAuth,
        item: [
          { id: 'f2', name: 'Inner', auth: innerAuth, item: [req('r1', 'R1')] },
        ],
      },
    ];
    const { auth, source } = resolveInheritedAuthWithSource(tree, 'r1', bearerAuth, 'Collection');
    expect(auth).toEqual(innerAuth);
    expect(source.id).toBe('f2');
    expect(source.name).toBe('Inner');
  });

  it('falls back to collection auth when targetId is not found', () => {
    const tree = [req('r1', 'R1')];
    const { auth, source } = resolveInheritedAuthWithSource(tree, 'nonexistent', bearerAuth, 'Collection');
    expect(auth).toEqual(bearerAuth);
    expect(source.kind).toBe('collection');
  });

  it('handles undefined collection auth', () => {
    const tree = [req('r1', 'R1')];
    const { auth, source } = resolveInheritedAuthWithSource(tree, 'r1', undefined, 'Collection');
    expect(auth).toBeUndefined();
    expect(source.kind).toBe('collection');
  });
});
