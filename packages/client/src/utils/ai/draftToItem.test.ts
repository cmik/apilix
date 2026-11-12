import { describe, expect, it } from 'vitest';
import { draftToItem, draftTestScript, normalizeUrl } from './draftToItem';
import { validatePostmanCollection } from '../postmanValidator';
import type { RequestDraft } from './aiTypes';
import type { CollectionItem } from '../../types';

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const wrap = (item: CollectionItem) => ({ info: { name: 'c', schema: SCHEMA }, item: [item] });
const expectValid = (item: CollectionItem) => {
  const r = validatePostmanCollection(wrap(item));
  expect(r.errors).toEqual([]);
  expect(r.valid).toBe(true);
};

const full: RequestDraft = {
  name: 'Create user',
  method: 'POST',
  url: '{{baseUrl}}/users?notify=true',
  headers: [{ key: 'Content-Type', value: 'application/json' }],
  query: [{ key: 'dry run', value: 'a&b' }],
  body: { mode: 'raw', raw: '{"name":"Ada"}', language: 'json' },
  auth: { type: 'bearer', token: '{{token}}' },
  tests: "apx.test('Status is 201', () => { apx.expect(apx.response.code).to.equal(201); });",
  preRequest: "apx.environment.set('ts', '1');",
  variablesToCapture: [{ name: 'userId', path: 'data.id' }],
};

describe('draftToItem', () => {
  it('maps a full draft to a valid Postman item', () => {
    const item = draftToItem(full, { id: 'new1' });
    expect(item.id).toBe('new1');
    expect(item.name).toBe('Create user');
    expect(item.request?.method).toBe('POST');
    const url = item.request!.url as { raw: string; host: string[]; path: string[]; query: Array<{ key: string; value: string }> };
    expect(url.raw).toBe('{{baseUrl}}/users?notify=true&dry%20run=a%26b');
    expect(url.host).toEqual(['{{baseUrl}}']);
    expect(url.path).toEqual(['users']);
    expect(url.query.map(q => q.key)).toEqual(['notify', 'dry run']);
    expect(item.request?.body).toMatchObject({ mode: 'raw', raw: '{"name":"Ada"}', options: { raw: { language: 'json' } } });
    expect(item.request?.auth).toEqual({ type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] });
    expect(item.event?.map(e => e.listen)).toEqual(['prerequest', 'test']);
    const tests = (item.event![1].script.exec as string[]).join('\n');
    expect(tests).toContain('apx.environment.set("userId", apx.response.json()["data"]["id"]);');
    expectValid(item);
  });

  it('handles an empty body, no auth and no scripts', () => {
    const item = draftToItem({ name: 'Ping', method: 'GET', url: 'https://api.test/ping', body: { mode: 'none' } });
    expect(item.request?.body).toBeUndefined();
    expect(item.request?.auth).toBeUndefined();
    expect(item.event).toBeUndefined();
    expectValid(item);
    const emptyRaw = draftToItem({ name: 'x', method: 'POST', url: 'https://x.test', body: { mode: 'raw', raw: '   ' } });
    expect(emptyRaw.request?.body).toBeUndefined();
    expectValid(emptyRaw);
  });

  it('adds a scheme to a URL without one and refuses other schemes', () => {
    expect(normalizeUrl('api.example.com/users')).toBe('https://api.example.com/users');
    expect(normalizeUrl('localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(normalizeUrl('{{baseUrl}}/x')).toBe('{{baseUrl}}/x');
    expect(normalizeUrl('/v1/users')).toBe('/v1/users');
    expect(normalizeUrl('javascript:alert(1)')).toBe('');
    expect(normalizeUrl('file:///etc/passwd')).toBe('');
    const item = draftToItem({ name: 'x', method: 'GET', url: 'api.example.com:8443/users/42' });
    const url = item.request!.url as { raw: string; protocol: string; host: string[]; port: string; path: string[] };
    expect(url).toMatchObject({ raw: 'https://api.example.com:8443/users/42', protocol: 'https', host: ['api', 'example', 'com'], port: '8443', path: ['users', '42'] });
    expectValid(item);
  });

  it('builds formdata and urlencoded bodies, apikey and basic auth', () => {
    const form = draftToItem({ name: 'f', method: 'POST', url: 'https://x.test', body: { mode: 'formdata', formdata: [{ key: 'a', value: '1' }, { key: '', value: 'dropped' }] }, auth: { type: 'apikey', key: 'X-Key', value: '{{apiKey}}', in: 'query' } });
    expect(form.request?.body).toEqual({ mode: 'formdata', formdata: [{ key: 'a', value: '1', type: 'text' }] });
    expect(form.request?.auth?.apikey).toEqual([{ key: 'key', value: 'X-Key', type: 'string' }, { key: 'value', value: '{{apiKey}}', type: 'string' }, { key: 'in', value: 'query', type: 'string' }]);
    expectValid(form);
    const enc = draftToItem({ name: 'e', method: 'POST', url: 'https://x.test', body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: 'b' }] }, auth: { type: 'basic', username: '{{u}}', password: '{{p}}' } });
    expect(enc.request?.body).toEqual({ mode: 'urlencoded', urlencoded: [{ key: 'a', value: 'b' }] });
    expectValid(enc);
  });

  it('never keeps a literal credential in auth', () => {
    const item = draftToItem({ name: 'x', method: 'GET', url: 'https://x.test', auth: { type: 'bearer', token: 'sk-live-abcdef123456' } });
    expect(item.request?.auth?.bearer?.[0].value).toBe('');
    expectValid(item);
  });

  it('survives garbage: unknown method, wrong types, control characters, huge values', () => {
    const evil = { name: 'x\r\ny'.repeat(200), method: 'TRACE', url: 5, headers: [{ key: 'A\r\nB', value: 'v\r\nw' }, null, { key: 7 }], query: 'nope', body: { mode: 'graphql', raw: 'x' }, tests: 42, variablesToCapture: [{ name: 'bad name', path: 'a;b' }, null, { name: 'ok', path: 'x.y' }] } as unknown as RequestDraft;
    const item = draftToItem(evil);
    expect(item.request?.method).toBe('GET');
    expect(item.name.length).toBeLessThanOrEqual(200);
    expect(item.name).not.toMatch(/[\r\n]/);
    expect(item.request?.header).toEqual([{ key: 'A B', value: 'v w' }]);
    expect(item.request?.body).toBeUndefined();
    expect((item.event![0].script.exec as string[]).join('\n')).toBe('apx.environment.set("ok", apx.response.json()["x"]["y"]);');
    expectValid(item);
    expectValid(draftToItem(null as unknown as RequestDraft));
    expectValid(draftToItem({} as RequestDraft));
  });

  it('does not duplicate a capture the tests already perform', () => {
    const script = draftTestScript({ tests: "apx.environment.set('userId', apx.response.json().id);", variablesToCapture: [{ name: 'userId', path: 'id' }] });
    expect(script.match(/environment\.set/g)).toHaveLength(1);
  });

  it('modify mode keeps id, description, examples and settings; absent auth keeps the existing one', () => {
    const base: CollectionItem = {
      id: 'orig', name: 'Old name', description: 'docs',
      request: { method: 'GET', url: 'https://x.test', auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{t}}' }] }, description: 'req docs', requestSettings: { timeout: 5 } },
      response: [{ name: 'ex', code: 200, body: '{}' }],
    };
    const item = draftToItem({ name: 'New name', method: 'GET', url: 'https://x.test?page=1' }, { base });
    expect(item.id).toBe('orig');
    expect(item.description).toBe('docs');
    expect(item.response).toEqual(base.response);
    expect(item.request?.description).toBe('req docs');
    expect(item.request?.requestSettings).toEqual({ timeout: 5 });
    expect(item.request?.auth?.type).toBe('bearer');
    expect(item.name).toBe('New name');
    expectValid(item);
  });
});
