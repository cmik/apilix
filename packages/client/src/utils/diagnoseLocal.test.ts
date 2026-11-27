import { describe, it, expect } from 'vitest';
import { diagnoseLocal, jwtExpiry, LOCAL_DIAGNOSIS_IDS, type LocalDiagnosisInput } from './diagnoseLocal';

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: object) => `${b64url({ alg: 'HS256' })}.${b64url(payload)}.sig`;
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const ids = (i: LocalDiagnosisInput) => diagnoseLocal({ now: NOW, ...i }).map(d => d.id);

describe('diagnoseLocal (table)', () => {
  const cases: Array<[string, LocalDiagnosisInput, string[]]> = [
    ['healthy 200 gives nothing', { status: 200, url: 'https://a.test/x' }, []],
    ['unresolved var in URL on 404', { status: 404, url: 'https://a.test/{{userId}}/x' }, ['unresolved-variable']],
    ['unresolved var on transport error', { status: 0, error: 'getaddrinfo ENOTFOUND {{host}}', url: 'https://{{host}}/x' }, ['unresolved-variable', 'dns-failure']],
    ['dynamic variable is not reported', { status: 404, url: 'https://a.test/{{$guid}}' }, []],
    ['spaces inside braces still detected', { status: 500, url: 'https://a.test/{{ id }}' }, ['unresolved-variable']],
    ['ECONNREFUSED', { status: 0, error: 'connect ECONNREFUSED 127.0.0.1:3000', url: 'http://localhost:3000' }, ['connection-refused']],
    ['DNS ENOTFOUND', { status: 0, error: 'getaddrinfo ENOTFOUND nope.invalid', url: 'https://nope.invalid' }, ['dns-failure']],
    ['DNS EAI_AGAIN', { status: 0, error: 'getaddrinfo EAI_AGAIN api.test', url: 'https://api.test' }, ['dns-failure']],
    ['TLS self signed', { status: 0, error: 'self-signed certificate', url: 'https://a.test' }, ['tls-error']],
    ['TLS code', { status: 0, error: 'unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)', url: 'https://a.test' }, ['tls-error']],
    ['TLS wrong version', { status: 0, error: 'write EPROTO ... SSL routines:ssl3_get_record:wrong version number', url: 'https://a.test' }, ['tls-error']],
    ['401 with expired JWT', { status: 401, url: 'https://a.test', requestHeaders: { Authorization: `Bearer ${jwt({ exp: NOW / 1000 - 3600 })}` } }, ['jwt-expired']],
    ['401 with expired JWT, header array, lowercase name', { status: 401, url: 'https://a.test', requestHeaders: [{ key: 'authorization', value: `bearer ${jwt({ exp: NOW / 1000 - 60 })}` }] }, ['jwt-expired']],
    ['401 with valid JWT', { status: 401, url: 'https://a.test', requestHeaders: { Authorization: `Bearer ${jwt({ exp: NOW / 1000 + 3600 })}` } }, []],
    ['401 with JWT without exp', { status: 401, url: 'https://a.test', requestHeaders: { Authorization: `Bearer ${jwt({ sub: 'x' })}` } }, []],
    ['401 with opaque token', { status: 401, url: 'https://a.test', requestHeaders: { Authorization: 'Bearer abc' } }, []],
    ['403 with expired JWT is not a 401', { status: 403, url: 'https://a.test', requestHeaders: { Authorization: `Bearer ${jwt({ exp: 1 })}` } }, []],
    ['400 POST with body and no content-type', { status: 400, method: 'POST', url: 'https://a.test', requestBody: '{"a":1}', requestHeaders: { Accept: '*/*' } }, ['missing-content-type']],
    ['400 POST with content-type', { status: 400, method: 'POST', url: 'https://a.test', requestBody: '{"a":1}', requestHeaders: { 'content-type': 'application/json' } }, []],
    ['400 GET never flagged', { status: 400, method: 'GET', url: 'https://a.test', requestBody: 'x', requestHeaders: {} }, []],
    ['400 POST with empty body', { status: 400, method: 'POST', url: 'https://a.test', requestBody: '  ', requestHeaders: {} }, []],
    ['200 POST without content-type is fine', { status: 200, method: 'POST', url: 'https://a.test', requestBody: 'x', requestHeaders: {} }, []],
    ['404 with double slash in path', { status: 404, url: 'https://a.test/api//users' }, ['double-slash-404']],
    ['404 with only the scheme slashes', { status: 404, url: 'https://a.test/api/users' }, []],
    ['404 with // in the query only', { status: 404, url: 'https://a.test/api?next=//x' }, []],
    ['500 with double slash is not reported', { status: 500, url: 'https://a.test/api//users' }, []],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => expect(ids(input)).toEqual(expected));
  }

  it('never puts the token in a diagnosis', () => {
    const token = jwt({ exp: 1 });
    const out = diagnoseLocal({ status: 401, now: NOW, url: 'https://a.test', requestHeaders: { Authorization: `Bearer ${token}` } });
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain(token);
  });

  it('every id it can return is in LOCAL_DIAGNOSIS_IDS', () => {
    const all = [
      ...ids({ status: 404, url: 'https://a/{{x}}//y' }),
      ...ids({ status: 0, error: 'ECONNREFUSED' }), ...ids({ status: 0, error: 'ENOTFOUND' }), ...ids({ status: 0, error: 'CERT_HAS_EXPIRED' }),
      ...ids({ status: 401, requestHeaders: { Authorization: `Bearer ${jwt({ exp: 1 })}` } }),
      ...ids({ status: 400, method: 'POST', requestBody: 'x' }),
    ];
    expect(all.length).toBe(7);
    for (const id of all) expect(LOCAL_DIAGNOSIS_IDS).toContain(id);
  });

  it('jwtExpiry tolerates garbage', () => {
    expect(jwtExpiry('a.b.c')).toBeNull();
    expect(jwtExpiry('x')).toBeNull();
    expect(jwtExpiry(jwt({ exp: 'soon' }))).toBeNull();
    expect(jwtExpiry(jwt({ exp: 42 }))).toBe(42);
  });
});
