import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { inferAssertions, isSuggestionPresent, type InferenceInput } from './assertionInference';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runScript } = require('@apilix/core/script-runtime') as {
  runScript: (code: string, response: unknown, variables: unknown, deps: unknown, ctx: unknown) => Promise<{ tests: { name: string; passed: boolean; error?: string }[]; error?: string }>;
};

const body = {
  id: '3f2b8c1e-8a53-4f0e-9d6a-0a7a3c5d9e11',
  name: 'Ada',
  email: 'ada@example.com',
  status: 'active',
  active: true,
  age: 36,
  nickname: null,
  created_at: '2026-01-02T03:04:05Z',
  profile: { website: 'https://ada.test', bio: 'x', address: { city: 'London', zip: '123' } },
  roles: ['admin', 'dev'],
  orders: [{ order_id: 7, total: 12.5, placed: '2026-01-01' }],
  access_token: 'abc.def.ghi',
};

const input = (over: Partial<InferenceInput> = {}): InferenceInput => ({
  status: 200,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
  responseTime: 120,
  ...over,
});

const byTitle = (list: ReturnType<typeof inferAssertions>, re: RegExp) => list.find(s => re.test(s.title));

describe('inferAssertions', () => {
  it('suggests status, content type and timing', () => {
    const list = inferAssertions(input());
    expect(byTitle(list, /^Status code is 200$/)?.recommended).toBe(true);
    expect(byTitle(list, /^Content-Type is application\/json$/)?.script).toContain("headers.get('Content-Type')");
    const timing = byTitle(list, /^Response time is below/)!;
    expect(timing.kind).toBe('timing');
    expect(timing.recommended).toBe(false);
    expect(timing.volatile).toBe(true);
  });

  it('describes object shapes by type, depth-limited to 3', () => {
    const list = inferAssertions(input());
    const root = byTitle(list, /^response has the expected fields$/)!;
    expect(root.script).toContain("apx.response.json()?.name).to.be.a('string')");
    expect(root.script).toContain("apx.response.json()?.age).to.be.a('number')");
    expect(root.script).toContain("apx.response.json()?.active).to.be.a('boolean')");
    expect(root.script).toContain("?.roles).to.be.an('array')");
    expect(root.script).not.toContain('nickname'); // null says nothing about the type
    expect(byTitle(list, /^profile has the expected fields$/)).toBeTruthy();
    expect(byTitle(list, /^profile\.address has the expected fields$/)).toBeTruthy();
    expect(byTitle(list, /^orders\[0\] has the expected fields$/)).toBeTruthy();
  });

  it('recognises UUID, ISO date, email and URL formats; flags volatile ones', () => {
    const list = inferAssertions(input());
    expect(byTitle(list, /^id is a UUID$/)?.volatile).toBe(true);
    expect(byTitle(list, /^email is an email address$/)?.volatile).toBe(false);
    expect(byTitle(list, /^created_at is an ISO date$/)?.volatile).toBe(true);
    expect(byTitle(list, /^profile\.website is a URL$/)).toBeTruthy();
  });

  it('never asserts a volatile or free-text value, only stable enum-like fields', () => {
    const list = inferAssertions(input());
    expect(byTitle(list, /^status equals active$/)?.recommended).toBe(false);
    expect(list.some(s => /equals/.test(s.title) && /(name|email|id|created_at|bio)/.test(s.title))).toBe(false);
    for (const s of list) expect(s.script).not.toContain('Ada');
  });

  it('proposes variable captures for ids and tokens, unchecked by default', () => {
    const list = inferAssertions(input());
    const caps = list.filter(s => s.kind === 'capture');
    const names = caps.map(c => c.title);
    expect(names).toContain('Save id as id');
    expect(names).toContain('Save access_token as accessToken');
    expect(caps.every(c => !c.recommended)).toBe(true);
    expect(caps.find(c => /accessToken/.test(c.title))!.script).toBe("apx.environment.set(\"accessToken\", apx.response.json()?.access_token);");
  });

  it('handles a top-level array by describing its first item', () => {
    const list = inferAssertions(input({ body: JSON.stringify([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]) }));
    expect(byTitle(list, /^Response is a non-empty array$/)).toBeTruthy();
    expect(byTitle(list, /^response\[0\] has the expected fields$/)).toBeTruthy();
    expect(inferAssertions(input({ body: '[]' })).some(s => s.title === 'Response is an array')).toBe(true);
  });

  it('skips body inference for binary, empty or oversized payloads, and degrades for non-JSON', () => {
    expect(inferAssertions(input({ bodyBase64: 'AAEC' })).every(s => ['status', 'header', 'timing'].includes(s.kind))).toBe(true);
    expect(inferAssertions(input({ body: '   ' })).every(s => ['status', 'header', 'timing'].includes(s.kind))).toBe(true);
    expect(inferAssertions(input({ body: 'x'.repeat(1_000_001) })).every(s => ['status', 'header', 'timing'].includes(s.kind))).toBe(true);
    const text = inferAssertions(input({ body: '<html>hi</html>' }));
    expect(text.some(s => s.title === 'Body is not empty')).toBe(true);
  });

  it('is deterministic and bounded', () => {
    expect(inferAssertions(input())).toEqual(inferAssertions(input()));
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i]));
    const root = byTitle(inferAssertions(input({ body: JSON.stringify(wide) })), /^response has the expected fields$/)!;
    expect(root.script.split('\n').length).toBeLessThanOrEqual(15 + 2);
  });

  it('does not throw on garbage input', () => {
    expect(() => inferAssertions({ status: NaN, headers: undefined as never, body: undefined as never })).not.toThrow();
  });
});

describe('suggestions pass in the real script sandbox on the response they came from', () => {
  it('every suggestion runs green (status, header, timing, shape, formats, captures)', async () => {
    const inp = input();
    const list = inferAssertions(inp);
    expect(list.length).toBeGreaterThan(10);
    const response = {
      code: inp.status, status: 'OK', responseTime: inp.responseTime,
      headers: Object.fromEntries(Object.entries(inp.headers).map(([k, v]) => [k.toLowerCase(), v])),
      body: inp.body, jsonData: JSON.parse(inp.body),
    };
    for (const s of list) {
      const r = await runScript(s.script, response, {}, {}, null);
      expect(r.error, s.title).toBeFalsy();
      if (s.kind !== 'capture') {
        expect(r.tests.length, s.title).toBe(1);
        expect(r.tests[0].passed, `${s.title}: ${r.tests[0].error}`).toBe(true);
      }
    }
  });

  it('a suggestion fails when the response drifts (it is a real check)', async () => {
    const inp = input();
    const status = inferAssertions(inp)[0];
    const r = await runScript(status.script, { code: 500, status: 'ERR', responseTime: 1, headers: {}, body: '', jsonData: null }, {}, {}, null);
    expect(r.tests[0].passed).toBe(false);
  });
});

describe('isSuggestionPresent', () => {
  const s = { title: 'Status code is 200', kind: 'status' as const, script: 'apx.test("Status code is 200", () => {\n  apx.expect(apx.response.code).to.equal(200);\n});' };
  it('detects the same code or the same test name, ignoring other tests', () => {
    expect(isSuggestionPresent('', s)).toBe(false);
    expect(isSuggestionPresent(`// my tests\n${s.script}\n`, s)).toBe(true);
    expect(isSuggestionPresent("apx.test('Status code is 200', () => { /* hand written */ });", s)).toBe(true);
    expect(isSuggestionPresent('apx.test("Status code is 201", () => {});', s)).toBe(false);
  });
  it('captures are only detected by identical code', () => {
    const cap = { title: 'Save id as id', kind: 'capture' as const, script: 'apx.environment.set("id", apx.response.json()?.id);' };
    expect(isSuggestionPresent(cap.script, cap)).toBe(true);
    expect(isSuggestionPresent('apx.environment.set("id", 1);', cap)).toBe(false);
  });
});
