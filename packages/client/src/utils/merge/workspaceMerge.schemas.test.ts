import { describe, it, expect } from 'vitest';
import { mergeWorkspaces, applySchemaResolution } from './workspaceMerge';
import type { WorkspaceData, ResponseSchema } from '../../types';

const ws = (schemas?: ResponseSchema[]): WorkspaceData => ({
  collections: [], environments: [], activeEnvironmentId: null, collectionVariables: {}, globalVariables: {},
  cookieJar: {}, mockCollections: [], mockRoutes: [], mockPort: 3002, ...(schemas ? { responseSchemas: schemas } : {}),
});
const s = (id: string, name: string, version = 1): ResponseSchema => ({ id, name, schema: { type: 'object', title: `${name}${version}` }, version });

describe('mergeWorkspace response schemas', () => {
  it('merges additions from both sides and edits from one side', () => {
    const base = ws([s('a', 'A')]);
    const local = ws([s('a', 'A', 2), s('l', 'L')]);
    const remote = ws([s('a', 'A'), s('r', 'R')]);
    const { merged } = mergeWorkspaces(base, local, remote);
    expect(merged.responseSchemas!.map(x => x.id).sort()).toEqual(['a', 'l', 'r']);
    expect(merged.responseSchemas!.find(x => x.id === 'a')!.version).toBe(2);
  });

  it('keeps names unique when both sides add the same name', () => {
    const { merged } = mergeWorkspaces(ws([]), ws([s('l', 'Pet')]), ws([s('r', 'Pet')]));
    expect(merged.responseSchemas!.map(x => x.name).sort()).toEqual(['Pet', 'Pet (2)']);
  });

  it('leaves workspaces without schemas untouched', () => {
    expect(mergeWorkspaces(ws(), ws(), ws()).merged.responseSchemas).toBeUndefined();
  });
});

describe('mergeWorkspace response schemas: change detection', () => {
  it('ignores updatedAt/version/history differences when content is identical', () => {
    const base = ws([{ ...s('a', 'A'), updatedAt: '2020-01-01' }]);
    const local = ws([{ ...s('a', 'A'), version: 2, updatedAt: '2021-01-01', history: [{ version: 1, schema: { type: 'object' }, updatedAt: 'x' }] }]);
    const remote = ws([{ ...s('a', 'A'), version: 3, updatedAt: '2022-01-01' }]);
    const { merged, conflicts, autoMergedCount } = mergeWorkspaces(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(autoMergedCount).toBe(0);
    expect(merged.responseSchemas).toHaveLength(1);
  });

  it('a content edit on one side still merges when the other side only touched metadata', () => {
    const base = ws([s('a', 'A')]);
    const local = ws([{ ...s('a', 'A'), updatedAt: 'later' }]);
    const remote = ws([{ ...s('a', 'A'), schema: { type: 'string' } }]);
    const { merged, conflicts } = mergeWorkspaces(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged.responseSchemas![0].schema).toEqual({ type: 'string' });
  });

  it('a remote without responseSchemas (older client) is "no change", not "all deleted"', () => {
    const base = ws([s('a', 'A')]);
    const local = ws([s('a', 'A'), s('l', 'L')]);
    const remote = ws(); // undefined responseSchemas
    const { merged, conflicts } = mergeWorkspaces(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(merged.responseSchemas!.map(x => x.id).sort()).toEqual(['a', 'l']);
  });
});

describe('mergeWorkspace response schema conflicts', () => {
  const edited = (id: string, name: string, title: string, version: number): ResponseSchema => ({ id, name, schema: { type: 'object', title }, version });

  it('records a conflict (local kept meanwhile) when both sides edited the same schema differently', () => {
    const base = ws([edited('a', 'A', 'base', 1)]);
    const local = ws([edited('a', 'A', 'local', 2)]);
    const remote = ws([edited('a', 'A', 'remote', 3)]);
    const { merged, conflicts } = mergeWorkspaces(base, local, remote);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ id: 'a', domain: 'responseSchema', kind: 'field-overlap', label: 'A' });
    expect(JSON.parse(conflicts[0].local).schema.title).toBe('local');
    expect(JSON.parse(conflicts[0].remote).schema.title).toBe('remote');
    expect(merged.responseSchemas![0].schema).toEqual({ type: 'object', title: 'local' });
  });

  it('is not a conflict when both sides made the identical edit or only one side edited', () => {
    const base = ws([edited('a', 'A', 'base', 1)]);
    const same = mergeWorkspaces(base, ws([edited('a', 'A', 'x', 2)]), ws([edited('a', 'A', 'x', 2)]));
    expect(same.conflicts).toHaveLength(0);
    const one = mergeWorkspaces(base, ws([edited('a', 'A', 'x', 2)]), ws([edited('a', 'A', 'base', 1)]));
    expect(one.conflicts).toHaveLength(0);
    expect(one.merged.responseSchemas![0].version).toBe(2);
  });

  it('delete-vs-edit is a conflict; deleted side is kept as the (empty) local value', () => {
    const base = ws([edited('a', 'A', 'base', 1)]);
    const { merged, conflicts } = mergeWorkspaces(base, ws([]), ws([edited('a', 'A', 'remote', 2)]));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('delete-vs-edit');
    expect(conflicts[0].local).toBe('');
    expect(merged.responseSchemas).toEqual([]);
  });

  it('applySchemaResolution: remote replaces, empty deletes, restores a deleted schema, keeps names unique, ignores junk', () => {
    const data = ws([edited('a', 'A', 'local', 2), edited('b', 'B', 'b', 1)]);
    applySchemaResolution(data, 'a', JSON.stringify(edited('a', 'A', 'remote', 3)));
    expect(data.responseSchemas![0].schema).toEqual({ type: 'object', title: 'remote' });
    applySchemaResolution(data, 'a', '{not json');
    applySchemaResolution(data, 'a', '{"x":1}');
    expect(data.responseSchemas![0].version).toBe(3);
    applySchemaResolution(data, 'b', '');
    expect(data.responseSchemas!.map(x => x.id)).toEqual(['a']);
    applySchemaResolution(data, 'c', JSON.stringify(edited('c', 'a', 'dup', 1)));
    expect(data.responseSchemas!.map(x => x.name)).toEqual(['A', 'a (2)']);
  });
});
