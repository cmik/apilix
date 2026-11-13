import { describe, expect, it } from 'vitest';
import { diffLines, diffViews, hasChanges, itemToView } from './itemDiff';
import { mergeSuggestions } from './mergeSuggestions';
import { aiFeatureReady, collectNeighbors, collectVariableMeta, findParentFolderId, isHttpRestItem } from './nlContext';
import { DEFAULT_AI_SETTINGS } from '../aiDefaults';
import type { AssertionSuggestion } from '../assertionInference';
import type { CollectionItem } from '../../types';

const req = (id: string, extra: Partial<CollectionItem> = {}, request: Partial<NonNullable<CollectionItem['request']>> = {}): CollectionItem => ({
  id, name: id, request: { method: 'GET', url: `https://api.test/${id}`, ...request }, ...extra,
});

describe('diffLines', () => {
  it('marks additions, removals and unchanged lines', () => {
    const d = diffLines('a\nb\nc', 'a\nc\nd');
    expect(d).toEqual([
      { type: 'same', text: 'a' }, { type: 'del', text: 'b' }, { type: 'same', text: 'c' }, { type: 'add', text: 'd' },
    ]);
    expect(hasChanges(diffLines('x', 'x'))).toBe(false);
    expect(diffLines('', 'a')).toEqual([{ type: 'add', text: 'a' }]);
    expect(diffLines('a', '')).toEqual([{ type: 'del', text: 'a' }]);
  });
  it('degrades to a full replacement on very long input instead of hanging', () => {
    const big = Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n');
    const d = diffLines(big, `${big}\nmore`);
    expect(d.filter(l => l.type === 'del')).toHaveLength(1000);
  });
});

describe('itemToView / diffViews', () => {
  it('reports only changed fields, with scripts as text', () => {
    const before = req('r', { event: [{ listen: 'test', script: { type: 'text/javascript', exec: ['a();'] } }] }, { header: [{ key: 'A', value: '1' }] });
    const after = req('r', { event: [{ listen: 'test', script: { type: 'text/javascript', exec: ['a();', 'b();'] } }] }, { header: [{ key: 'A', value: '1' }, { key: 'X-Tenant', value: '{{tenant}}' }], method: 'POST' });
    const changes = diffViews(itemToView(before), itemToView(after)).map(c => c.field);
    expect(changes).toEqual(['method', 'headers', 'tests']);
    expect(diffViews(itemToView(before), itemToView(before))).toEqual([]);
  });
  it('never prints credential literals in the auth summary', () => {
    const v = itemToView(req('r', {}, { auth: { type: 'bearer', bearer: [{ key: 'token', value: 'sk-live-secret' }] } }));
    expect(v.auth).toBe('bearer token=(set)');
    const ref = itemToView(req('r', {}, { auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] } }));
    expect(ref.auth).toBe('bearer token={{token}}');
  });
});

describe('mergeSuggestions', () => {
  const local = (id: string, title: string, script: string): AssertionSuggestion => ({ id, title, kind: 'body', script, confidence: 'medium', recommended: true });
  it('puts AI suggestions first, drops duplicates of them, keeps other local ones', () => {
    const merged = mergeSuggestions(
      [local('s1', 'Status code is 201', 'A'), local('s2', 'user.id is a UUID', 'B'), local('s3', 'Body is not empty', 'C')],
      [
        { id: 'ai1', title: 'status code is  201', kind: 'status', script: 'A2', confidence: 'high' },
        { id: 'ai2', title: 'Role is a known value', kind: 'body', script: 'B', confidence: 'medium' },
        { id: 'ai3', title: 'Role is a known value', kind: 'body', script: 'Z', confidence: 'low', volatile: true },
      ],
    );
    expect(merged.map(s => s.id)).toEqual(['ai-ai1', 'ai-ai2', 's3']);
    expect(merged[0]).toMatchObject({ source: 'ai', recommended: true });
    expect(merged[1].recommended).toBe(false);
  });
  it('is the identity on local suggestions when the model returned nothing', () => {
    const l = [local('s1', 'a', 'x')];
    expect(mergeSuggestions(l, [])).toEqual(l);
  });
  it('never pre-checks volatile, capture or timing AI suggestions', () => {
    const m = mergeSuggestions([], [
      { id: '1', title: 'v', kind: 'body', script: '1', confidence: 'high', volatile: true },
      { id: '2', title: 'c', kind: 'capture', script: '2', confidence: 'high' },
      { id: '3', title: 't', kind: 'timing', script: '3', confidence: 'high' },
    ]);
    expect(m.every(s => !s.recommended)).toBe(true);
  });
});

describe('nlContext', () => {
  const tree: CollectionItem[] = [
    req('root1'),
    { id: 'f1', name: 'Users', item: [req('u1'), req('u2'), { id: 'f2', name: 'Admin', item: [req('a1', {}, { method: 'DELETE' })] }, req('gql', {}, { body: { mode: 'graphql', graphql: { query: '{a}' } } }), req('mongo', {}, { requestType: 'mongodb' })] },
  ];
  it('detects HTTP/REST items only', () => {
    expect(isHttpRestItem(tree[0])).toBe(true);
    expect(isHttpRestItem(tree[1])).toBe(false);
    expect(isHttpRestItem(req('g', {}, { body: { mode: 'graphql', graphql: { query: '{a}' } } }))).toBe(false);
    expect(isHttpRestItem(req('s', {}, { body: { mode: 'raw', soap: { action: 'a', version: '1.1' } } }))).toBe(false);
    expect(isHttpRestItem(req('m', {}, { requestType: 'mongodb' }))).toBe(false);
    expect(isHttpRestItem(req('q', {}, { requestType: 'sql' }))).toBe(false);
    expect(isHttpRestItem(req('w', {}, { method: 'WS' }))).toBe(false);
    expect(isHttpRestItem(null)).toBe(false);
  });
  it('collects up to 5 HTTP neighbours from the folder, direct children first, no GraphQL/Mongo', () => {
    const n = collectNeighbors(tree, 'f1');
    expect(n.map(x => x.id)).toEqual(['u1', 'u2', 'a1']);
    expect(collectNeighbors(tree, null).map(x => x.id)).toEqual(['root1', 'u1', 'u2', 'a1']);
    expect(collectNeighbors(tree, 'f1', 'u1').map(x => x.id)).toEqual(['u2', 'a1']);
    const many = Array.from({ length: 12 }, (_, i) => req(`m${i}`));
    expect(collectNeighbors(many, null)).toHaveLength(5);
    expect(collectNeighbors(tree, 'nope')).toEqual([]);
  });
  it('strips saved examples from neighbours', () => {
    const withExample = [req('e', { response: [{ name: 'ex', body: 'SECRET' }] })];
    expect(JSON.stringify(collectNeighbors(withExample, null))).not.toContain('SECRET');
  });
  it('finds the parent folder', () => {
    expect(findParentFolderId(tree, 'a1')).toBe('f2');
    expect(findParentFolderId(tree, 'root1')).toBeNull();
    expect(findParentFolderId(tree, 'zzz')).toBeUndefined();
  });
  it('lists variable names, never values', () => {
    const meta = collectVariableMeta({
      environments: [
        { _id: 'e1', name: 'dev', values: [{ key: 'baseUrl', value: 'https://dev.test', enabled: true }, { key: 'token', value: 'SECRET-VALUE-1', enabled: true, secret: true }, { key: 'off', value: 'x', enabled: false }] },
        { _id: 'e2', name: 'prod', values: [{ key: 'prodOnly', value: 'SECRET-VALUE-2', enabled: true, secret: true }] },
      ],
      activeEnvironmentId: 'e1',
      globalVariables: { g1: 'SECRET-VALUE-3' },
      globalVariableMeta: { g1: { secret: true } },
      collectionVariables: { c1: 'v' },
      collection: { variable: [{ key: 'c2', value: 'v' }, { key: 'c3', value: 'v', disabled: true }] },
    });
    expect(meta).toEqual([
      { name: 'baseUrl', scope: 'environment', secret: false },
      { name: 'token', scope: 'environment', secret: true },
      { name: 'g1', scope: 'global', secret: true },
      { name: 'c1', scope: 'collection', secret: false },
      { name: 'c2', scope: 'collection', secret: false },
    ]);
    expect(JSON.stringify(meta)).not.toContain('SECRET-VALUE');
  });
  it('gates features on enabled + consent + feature flag', () => {
    const on = { ...DEFAULT_AI_SETTINGS, enabled: true, consentGiven: true, features: { ...DEFAULT_AI_SETTINGS.features, nlGenerate: true } };
    expect(aiFeatureReady(on, 'nlGenerate')).toBe(true);
    expect(aiFeatureReady(on, 'assertSuggest')).toBe(false);
    expect(aiFeatureReady({ ...on, enabled: false }, 'nlGenerate')).toBe(false);
    expect(aiFeatureReady({ ...on, consentGiven: false }, 'nlGenerate')).toBe(false);
  });
});
