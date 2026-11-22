import { describe, it, expect } from 'vitest';
import {
  addSchema, updateSchema, isSchemaNameTaken, validateSchemaName, uniqueSchemaName, stripSchemaLinks,
  setRequestSchemaLinks, resolveSchemaLink, schemasUsedByItems, readImportedSchemas, mergeImportedSchemas,
  SCHEMA_HISTORY_CAP, clampSchemaTimeoutMs, DEFAULT_SCHEMA_TIMEOUT_MS, MIN_SCHEMA_TIMEOUT_MS, MAX_SCHEMA_TIMEOUT_MS,
  findIgnoredKeywords, findSchemaUsage, findSchemaReferrers, duplicateSchema, buildSchemaExport, parseSchemaImport,
} from './responseSchemas';
import { buildPostmanExport } from './postmanExport';
import { validatePostmanCollection } from './postmanValidator';
import type { AppCollection, CollectionItem, ResponseSchema } from '../types';

const mk = (id: string, name: string, schema: Record<string, unknown> = { type: 'object' }): ResponseSchema => ({ id, name, schema, version: 1 });

describe('schema names', () => {
  it('are unique, case-insensitive and trimmed', () => {
    const list = [mk('a', 'User')];
    expect(isSchemaNameTaken(list, ' user ')).toBe(true);
    expect(isSchemaNameTaken(list, 'user', 'a')).toBe(false);
    expect(validateSchemaName(list, 'USER')).toMatch(/already exists/);
    expect(validateSchemaName(list, '  ')).toMatch(/required/);
    expect(uniqueSchemaName(list, 'User')).toBe('User (2)');
  });

  it('addSchema and updateSchema reject a colliding name', () => {
    const list = addSchema([], mk('a', 'User'));
    expect(addSchema(list, mk('b', 'user'))).toBe(list);
    const two = addSchema(list, mk('b', 'Order'));
    expect(updateSchema(two, 'b', { name: 'USER' })).toBe(two);
    expect(updateSchema(two, 'b', { name: 'Orders' }).find(s => s.id === 'b')!.name).toBe('Orders');
  });
});

describe('updateSchema versioning', () => {
  it('bumps the version and keeps a capped history only when the schema changes', () => {
    let list = addSchema([], mk('a', 'User', { type: 'object' }));
    list = updateSchema(list, 'a', { description: 'doc' });
    expect(list[0].version).toBe(1);
    expect(list[0].history ?? []).toHaveLength(0);
    for (let i = 0; i < 15; i++) list = updateSchema(list, 'a', { schema: { type: 'object', minProperties: i + 1 } });
    expect(list[0].version).toBe(16);
    expect(list[0].history).toHaveLength(SCHEMA_HISTORY_CAP);
    expect(list[0].history![0].version).toBe(15);
    // identical content does not bump
    const same = updateSchema(list, 'a', { schema: list[0].schema });
    expect(same[0].version).toBe(16);
  });
});

const tree = (links: Array<{ schemaId: string; match: string }>): CollectionItem[] => [
  { id: 'f', name: 'Folder', item: [{ id: 'r1', name: 'R1', request: { method: 'GET', url: 'http://x', apilix: { schemaLinks: links } } }] },
];

describe('links', () => {
  it('setRequestSchemaLinks sets and clears the extension field', () => {
    const items = tree([]);
    const set = setRequestSchemaLinks([{ id: 'r1', name: 'R1', request: { method: 'GET', url: 'x' } }], 'r1', [{ schemaId: 'a', match: '200' }]);
    expect(set[0].request!.apilix!.schemaLinks).toEqual([{ schemaId: 'a', match: '200' }]);
    const cleared = setRequestSchemaLinks(set, 'r1', []);
    expect(cleared[0].request!.apilix).toBeUndefined();
    expect(items).toBeTruthy();
  });

  it('stripSchemaLinks removes dangling links in nested folders', () => {
    const items = tree([{ schemaId: 'a', match: '200' }, { schemaId: 'b', match: 'default' }]);
    const out = stripSchemaLinks(items, 'a');
    expect(out[0].item![0].request!.apilix!.schemaLinks).toEqual([{ schemaId: 'b', match: 'default' }]);
    expect(stripSchemaLinks(out, 'b')[0].item![0].request!.apilix).toBeUndefined();
  });

  it('resolveSchemaLink: exact, class, default', () => {
    const links = [{ schemaId: 'd', match: 'default' }, { schemaId: 'c', match: '2xx' }, { schemaId: 'e', match: '201' }];
    expect(resolveSchemaLink(links, 201)?.schemaId).toBe('e');
    expect(resolveSchemaLink(links, 204)?.schemaId).toBe('c');
    expect(resolveSchemaLink(links, 500)?.schemaId).toBe('d');
    expect(resolveSchemaLink([{ schemaId: 'c', match: '2xx' }], 404)).toBeNull();
  });
});

describe('Postman round-trip of the apilix extension', () => {
  const schemas = [mk('s1', 'Pet', { type: 'object', properties: { owner: { $ref: 'Owner' } } }), mk('s2', 'Owner'), mk('s3', 'Unused')];
  const col: AppCollection = {
    _id: 'c1',
    info: { name: 'Col', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: tree([{ schemaId: 's1', match: '2xx' }]),
  };

  it('exports linked schemas plus their $ref closure and stays a valid v2.1 collection', () => {
    expect(schemasUsedByItems(col.item, schemas).map(s => s.name)).toEqual(['Pet', 'Owner']);
    const exported = buildPostmanExport(col, schemas);
    expect(exported.apilix!.schemas!.map(s => s.name)).toEqual(['Pet', 'Owner']);
    const res = validatePostmanCollection(JSON.parse(JSON.stringify(exported)));
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
    expect(res.version).toBe('2.1');
  });

  it('omits the extension when nothing is linked', () => {
    const exported = buildPostmanExport({ ...col, item: tree([]) }, schemas);
    expect('apilix' in exported).toBe(false);
  });

  it('import keeps request links, extracts schemas, and merges names safely', () => {
    const exported = JSON.parse(JSON.stringify(buildPostmanExport(col, schemas)));
    const read = readImportedSchemas(exported.apilix);
    expect(read.map(s => s.id)).toEqual(['s1', 's2']);
    expect(exported.item[0].item[0].request.apilix.schemaLinks).toEqual([{ schemaId: 's1', match: '2xx' }]);
    // same ids already present: nothing added
    expect(mergeImportedSchemas(schemas, read).added).toBe(0);
    // name clash with a different id: renamed
    const merged = mergeImportedSchemas([mk('zz', 'Pet')], read);
    expect(merged.renamed).toBe(1);
    expect(merged.schemas.map(s => s.name).sort()).toEqual(['Owner', 'Pet', 'Pet (2)']);
  });

  it('readImportedSchemas ignores malformed input', () => {
    expect(readImportedSchemas(undefined)).toEqual([]);
    expect(readImportedSchemas({ schemas: [null, 1, { id: 1 }, { id: 'a', name: 'x', schema: [] }, { id: 'a', name: 'ok', schema: {} }] }).map(s => s.name)).toEqual(['ok']);
  });
});

describe('schema library helpers', () => {
  const mk = (id: string, name: string, schema: Record<string, unknown> = { type: 'object' }): ResponseSchema => ({ id, name, schema, version: 1 });
  const req = (id: string, name: string, links: Array<{ schemaId: string; match: string }>): CollectionItem => ({ id, name, request: { method: 'GET', url: { raw: '/x' }, apilix: { schemaLinks: links } } } as unknown as CollectionItem);
  const col = (_id: string, name: string, item: CollectionItem[]) => ({ _id, info: { name }, item });

  it('clampSchemaTimeoutMs clamps and defaults', () => {
    expect(clampSchemaTimeoutMs(undefined)).toBe(DEFAULT_SCHEMA_TIMEOUT_MS);
    expect(clampSchemaTimeoutMs('x')).toBe(DEFAULT_SCHEMA_TIMEOUT_MS);
    expect(clampSchemaTimeoutMs(NaN)).toBe(DEFAULT_SCHEMA_TIMEOUT_MS);
    expect(clampSchemaTimeoutMs(5)).toBe(MIN_SCHEMA_TIMEOUT_MS);
    expect(clampSchemaTimeoutMs(1e9)).toBe(MAX_SCHEMA_TIMEOUT_MS);
    expect(clampSchemaTimeoutMs(1234.6)).toBe(1235);
  });

  it('findSchemaUsage walks folders across collections', () => {
    const folder = { name: 'F', item: [req('r2', 'Deep', [{ schemaId: 's1', match: '2xx' }])] } as unknown as CollectionItem;
    const usage = findSchemaUsage([col('c1', 'One', [req('r1', 'Top', [{ schemaId: 's1', match: '200' }, { schemaId: 's2', match: 'default' }]), folder]), col('c2', 'Two', [req('r3', 'Other', [{ schemaId: 's2', match: '200' }])])], 's1');
    expect(usage.map(u => [u.collectionName, u.requestName, u.match])).toEqual([['One', 'Top', '200'], ['One', 'Deep', '2xx']]);
    expect(findSchemaUsage([], 's1')).toEqual([]);
  });

  it('findSchemaReferrers finds $ref by name', () => {
    const pet = mk('p', 'Pet');
    const pets = mk('ps', 'Pets', { type: 'array', items: { $ref: 'Pet' } });
    expect(findSchemaReferrers([pet, pets, mk('x', 'X')], pet).map(s => s.name)).toEqual(['Pets']);
  });

  it('duplicateSchema: new id, unique name, version 1, deep copy, no history', () => {
    const src: ResponseSchema = { ...mk('a', 'User', { type: 'object', properties: { a: { type: 'string' } } }), version: 4, history: [{ version: 3, schema: {}, updatedAt: 'x' }] };
    const copy = duplicateSchema([src, mk('b', 'user copy')], src, 'n1');
    expect(copy).toMatchObject({ id: 'n1', name: 'User copy (2)', version: 1 });
    expect(copy.history).toBeUndefined();
    expect(copy.schema).toEqual(src.schema);
    expect(copy.schema).not.toBe(src.schema);
  });

  it('export then import round-trips; bare JSON Schema and junk are handled', () => {
    const file = JSON.stringify(buildSchemaExport([{ ...mk('a', 'User'), history: [{ version: 1, schema: {}, updatedAt: 'x' }] }]));
    expect(file).not.toContain('history');
    const r = parseSchemaImport(file, 'x.json', () => 'new');
    expect('schemas' in r && r.schemas[0]).toMatchObject({ id: 'a', name: 'User', version: 1 });
    const bare = parseSchemaImport('{"type":"string","title":"Token"}', 'tok.json', () => 'gen');
    expect('schemas' in bare && bare.schemas[0]).toMatchObject({ id: 'gen', name: 'Token' });
    const named = parseSchemaImport('{"type":"string"}', 'my-schema.json', () => 'gen');
    expect('schemas' in named && named.schemas[0].name).toBe('my-schema');
    expect(parseSchemaImport('nope', 'a.json', () => 'g')).toEqual({ error: 'The file is not valid JSON' });
    expect('error' in parseSchemaImport('[{"x":1}]', 'a.json', () => 'g')).toBe(true);
    expect('error' in parseSchemaImport('3', 'a.json', () => 'g')).toBe(true);
  });
});

describe('import and editor hardening', () => {
  it('the schema time limit cap is 10000 ms', () => {
    expect(MAX_SCHEMA_TIMEOUT_MS).toBe(10000);
    expect(clampSchemaTimeoutMs(60000)).toBe(10000);
  });

  it('mergeImportedSchemas rewrites by-name $refs when it renames for a name clash, and reports skipped ids', () => {
    const existing = [mk('zz', 'Pet'), mk('keep', 'Kept')];
    const incoming = [
      mk('p', 'Pet', { type: 'object', properties: { owner: { $ref: 'Owner' }, friend: { $ref: 'Pet' } } }),
      mk('o', 'Owner', { type: 'object', properties: { pet: { $ref: 'Pet' }, local: { $ref: '#/$defs/x' } } }),
      mk('keep', 'Kept'),
    ];
    const res = mergeImportedSchemas(existing, incoming);
    expect(res.renamed).toBe(1);
    expect(res.added).toBe(2);
    expect(res.skipped).toBe(1);
    expect(res.skippedNames).toEqual(['Kept']);
    const pet2 = res.schemas.find(s => s.id === 'p')!;
    expect(pet2.name).toBe('Pet (2)');
    expect(JSON.stringify(pet2.schema)).toContain('"$ref":"Owner"');
    expect(JSON.stringify(pet2.schema)).toContain('"$ref":"Pet (2)"'); // self reference follows the rename
    const owner = res.schemas.find(s => s.id === 'o')!;
    expect(JSON.stringify(owner.schema)).toContain('"$ref":"Pet (2)"');
    expect(JSON.stringify(owner.schema)).toContain('"$ref":"#/$defs/x"');
    // the originals are not mutated
    expect(JSON.stringify(incoming[0].schema)).toContain('"$ref":"Pet"');
  });

  it('findIgnoredKeywords reports 2019/2020 keywords only as keywords', () => {
    expect(findIgnoredKeywords({ type: 'array', prefixItems: [{ type: 'string' }], unevaluatedProperties: false })).toEqual(['prefixItems', 'unevaluatedProperties']);
    expect(findIgnoredKeywords({ properties: { prefixItems: { type: 'string' } }, enum: [{ prefixItems: 1 }], default: { unevaluatedItems: 1 } })).toEqual([]);
    expect(findIgnoredKeywords({ properties: { a: { items: { unevaluatedItems: false } } } })).toEqual(['unevaluatedItems']);
    expect(findIgnoredKeywords({ type: 'object' })).toEqual([]);
  });
});
