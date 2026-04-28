import { describe, it, expect } from 'vitest';
import type { CollectionItem, CollectionAuth, RunnerIteration } from '../types';
import {
  getAllRequestIds,
  flattenRequestNames,
  flattenRequestItems,
  resolveInheritedAuthWithSource,
  exportWorkflowCollection,
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

// ─── exportWorkflowCollection ────────────────────────────────────────────────

describe('exportWorkflowCollection', () => {
  it('creates a valid Postman v2.1 collection', () => {
    const iterations: RunnerIteration[] = [
      {
        iteration: 1,
        dataRow: {},
        results: [
          {
            name: 'Get Users',
            method: 'GET',
            url: 'https://api.example.com/users',
            resolvedUrl: 'https://api.example.com/users',
            status: 200,
            statusText: 'OK',
            responseTime: 100,
            testResults: [],
            error: null,
          },
        ],
      },
    ];

    const collection = exportWorkflowCollection('Test Run', 'My Collection', iterations);

    expect(collection.info._postman_id).toBeDefined();
    expect(collection.info.name).toBe('My Collection – Test Run');
    expect(collection.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    expect(collection.item).toHaveLength(1);
    expect(collection.item[0].name).toBe('Get Users');
    expect(collection.item[0].request?.method).toBe('GET');
    expect(collection.item[0].request?.url).toBe('https://api.example.com/users');
  });

  it('preserves exact iteration order', () => {
    const iterations: RunnerIteration[] = [
      {
        iteration: 1,
        dataRow: {},
        results: [
          { name: 'First', method: 'GET', url: 'http://a.com', status: 200, statusText: 'OK', responseTime: 0, testResults: [], error: null },
          { name: 'Second', method: 'POST', url: 'http://b.com', status: 201, statusText: 'Created', responseTime: 0, testResults: [], error: null },
        ],
      },
    ];

    const collection = exportWorkflowCollection('Test', 'Collection', iterations);

    expect(collection.item[0].name).toBe('First');
    expect(collection.item[1].name).toBe('Second');
  });

  it('keeps duplicates when request executed multiple times', () => {
    const iterations: RunnerIteration[] = [
      {
        iteration: 1,
        dataRow: {},
        results: [
          { name: 'Request A', method: 'GET', url: 'http://api.com', status: 200, statusText: 'OK', responseTime: 0, testResults: [], error: null },
        ],
      },
      {
        iteration: 2,
        dataRow: { row: '2' },
        results: [
          { name: 'Request A', method: 'GET', url: 'http://api.com', status: 200, statusText: 'OK', responseTime: 0, testResults: [], error: null },
        ],
      },
    ];

    const collection = exportWorkflowCollection('Test', 'Collection', iterations);

    expect(collection.item).toHaveLength(2);
    expect(collection.item[0].name).toBe('Request A');
    expect(collection.item[1].name).toBe('Request A');
  });

  it('uses resolvedUrl when available', () => {
    const iterations: RunnerIteration[] = [
      {
        iteration: 1,
        dataRow: {},
        results: [
          {
            name: 'Request',
            method: 'GET',
            url: 'https://{{host}}/users',
            resolvedUrl: 'https://api.example.com/users',
            status: 200,
            statusText: 'OK',
            responseTime: 0,
            testResults: [],
            error: null,
          },
        ],
      },
    ];

    const collection = exportWorkflowCollection('Test', 'Collection', iterations);

    expect(collection.item[0].request?.url).toBe('https://api.example.com/users');
  });

  it('falls back to url when resolvedUrl is undefined', () => {
    const iterations: RunnerIteration[] = [
      {
        iteration: 1,
        dataRow: {},
        results: [
          {
            name: 'Request',
            method: 'GET',
            url: 'https://api.example.com/users',
            status: 200,
            statusText: 'OK',
            responseTime: 0,
            testResults: [],
            error: null,
          },
        ],
      },
    ];

    const collection = exportWorkflowCollection('Test', 'Collection', iterations);

    expect(collection.item[0].request?.url).toBe('https://api.example.com/users');
  });

  it('maps requestHeaders as Record to header array', () => {
    const iterations: RunnerIteration[] = [
      {
        iteration: 1,
        dataRow: {},
        results: [
          {
            name: 'Request',
            method: 'GET',
            url: 'http://api.com',
            requestHeaders: { 'Authorization': 'Bearer token', 'Content-Type': 'application/json' },
            status: 200,
            statusText: 'OK',
            responseTime: 0,
            testResults: [],
            error: null,
          },
        ],
      },
    ];

    const collection = exportWorkflowCollection('Test', 'Collection', iterations);

    const headers = collection.item[0].request?.header;
    expect(headers).toBeDefined();
    expect(headers).toHaveLength(2);
    expect(headers).toContainEqual({ key: 'Authorization', value: 'Bearer token' });
    expect(headers).toContainEqual({ key: 'Content-Type', value: 'application/json' });
  });

  it('includes requestBody in the exported item', () => {
    const iterations: RunnerIteration[] = [
      {
        iteration: 1,
        dataRow: {},
        results: [
          {
            name: 'Create User',
            method: 'POST',
            url: 'http://api.com/users',
            requestBody: JSON.stringify({ name: 'John', age: 30 }),
            status: 201,
            statusText: 'Created',
            responseTime: 0,
            testResults: [],
            error: null,
          },
        ],
      },
    ];

    const collection = exportWorkflowCollection('Test', 'Collection', iterations);

    expect(collection.item[0].request?.body).toBeDefined();
    expect(collection.item[0].request?.body?.mode).toBe('raw');
    expect(collection.item[0].request?.body?.raw).toBe(JSON.stringify({ name: 'John', age: 30 }));
  });

  it('omits body when requestBody is undefined', () => {
    const iterations: RunnerIteration[] = [
      {
        iteration: 1,
        dataRow: {},
        results: [
          {
            name: 'Get Request',
            method: 'GET',
            url: 'http://api.com',
            status: 200,
            statusText: 'OK',
            responseTime: 0,
            testResults: [],
            error: null,
          },
        ],
      },
    ];

    const collection = exportWorkflowCollection('Test', 'Collection', iterations);

    expect(collection.item[0].request?.body).toBeUndefined();
  });

  it('handles empty iterations gracefully', () => {
    const collection = exportWorkflowCollection('Test', 'Collection', []);

    expect(collection.info._postman_id).toBeDefined();
    expect(collection.info.name).toBe('Collection – Test');
    expect(collection.item).toHaveLength(0);
  });

  it('handles multiple results within a single iteration', () => {
    const iterations: RunnerIteration[] = [
      {
        iteration: 1,
        dataRow: {},
        results: [
          { name: 'Step 1', method: 'GET', url: 'http://a.com', status: 200, statusText: 'OK', responseTime: 0, testResults: [], error: null },
          { name: 'Step 2', method: 'POST', url: 'http://b.com', status: 201, statusText: 'Created', responseTime: 0, testResults: [], error: null },
          { name: 'Step 3', method: 'PUT', url: 'http://c.com', status: 200, statusText: 'OK', responseTime: 0, testResults: [], error: null },
        ],
      },
    ];

    const collection = exportWorkflowCollection('Test', 'Collection', iterations);

    expect(collection.item).toHaveLength(3);
    expect(collection.item[0].name).toBe('Step 1');
    expect(collection.item[1].name).toBe('Step 2');
    expect(collection.item[2].name).toBe('Step 3');
  });
});
