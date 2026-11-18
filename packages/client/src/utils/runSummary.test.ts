import { describe, it, expect } from 'vitest';
import { buildRunSummary, urlTemplate, messageTemplate, MAX_EXAMPLES, MAX_GROUPS } from './runSummary';
import type { RunnerIteration, RunnerIterationResult } from '../types';

const res = (over: Partial<RunnerIterationResult> = {}): RunnerIterationResult => ({
  name: 'r', method: 'GET', url: 'https://api.test/users/1', status: 200, statusText: 'OK', responseTime: 1, testResults: [], error: null, ...over,
});
const iter = (results: RunnerIterationResult[], n = 1): RunnerIteration => ({ iteration: n, dataRow: {}, results });
const fail = (error: string, name = 'Status is 200') => [{ name, passed: false as const, error }];

describe('urlTemplate', () => {
  it.each([
    ['https://api.test/users/42/orders?token=abc#x', 'https://api.test/users/:id/orders'],
    ['https://u:p@api.test/a', 'https://api.test/a'],
    ['https://api.test/items/3f2b8c1e-8a53-4f0e-9d6a-0a7a3c5d9e11', 'https://api.test/items/:id'],
    ['https://api.test/v2/{{id}}', 'https://api.test/v2/{{id}}'],
    ['/relative/12345', '/relative/:id'],
    ['', ''],
  ])('%s -> %s', (input, expected) => expect(urlTemplate(input)).toBe(expected));
});

describe('messageTemplate', () => {
  it('replaces quoted values and numbers, collapses whitespace', () => {
    expect(messageTemplate("expected 401 to equal 200 for 'bob'  and \"x\"")).toBe('expected <number> to equal <number> for <string> and <string>');
  });
});

describe('buildRunSummary', () => {
  it('a clean run has no groups', () => {
    const s = buildRunSummary([iter([res(), res({ status: 404 })])]);
    expect(s.totals).toEqual({ requests: 2, failedRequests: 0, groups: 0 });
    expect(s.groups).toEqual([]);
  });

  it('groups by method + URL template + status + message template, biggest first, with at most 3 examples', () => {
    const results = [
      ...Array.from({ length: 5 }, (_, i) => res({ name: `u${i}`, url: `https://api.test/users/${1000 + i}`, status: 401, testResults: fail(`expected ${401 + i} to equal 200`) })),
      res({ name: 'o', url: 'https://api.test/orders', method: 'POST', status: 500, testResults: fail('boom') }),
      res({ name: 'ok' }),
      res({ name: 'skipped', testResults: [{ name: 's', passed: null, error: null, skipped: true }] }),
    ];
    const s = buildRunSummary([iter(results)]);
    expect(s.totals).toEqual({ requests: 8, failedRequests: 6, groups: 2 });
    expect(s.groups[0]).toMatchObject({ count: 5, method: 'GET', url: 'https://api.test/users/:id', status: 401 });
    expect(s.groups[0].examples).toHaveLength(MAX_EXAMPLES);
    expect(s.groups[0].examples.map(e => e.name)).toEqual(['u0', 'u1', 'u2']);
    expect(s.groups[1]).toMatchObject({ count: 1, method: 'POST', status: 500 });
    expect(s.local).toContain('6 of 8 requests failed, in 2 groups');
    expect(s.local).toContain('5x GET https://api.test/users/:id returned 401');
  });

  it('orders groups by size even when the biggest appears last', () => {
    const s = buildRunSummary([iter([
      res({ url: 'https://api.test/a', status: 500, testResults: fail('x') }),
      ...Array.from({ length: 3 }, () => res({ url: 'https://api.test/b', status: 500, testResults: fail('x') })),
    ])]);
    expect(s.groups.map(g => [g.url, g.count])).toEqual([['https://api.test/b', 3], ['https://api.test/a', 1]]);
  });

  it('a transport error counts as a failure, with status 0 and no response wording', () => {
    const s = buildRunSummary([iter([res({ status: 0, error: 'connect ECONNREFUSED 127.0.0.1:3000' })])]);
    expect(s.groups[0]).toMatchObject({ status: 0, count: 1 });
    expect(s.groups[0].examples[0].failures[0]).toEqual({ name: 'Request error', error: 'connect ECONNREFUSED 127.0.0.1:3000' });
    expect(s.local).toContain('got no response');
  });

  it('spans iterations; a different message or status is a different group', () => {
    const s = buildRunSummary([
      iter([res({ status: 401, testResults: fail('a') })], 1),
      iter([res({ status: 401, testResults: fail('a') }), res({ status: 403, testResults: fail('a') }), res({ status: 401, testResults: fail('b') })], 2),
    ]);
    expect(s.groups.map(g => g.count)).toEqual([2, 1, 1]);
  });

  it('carries no body, header or query value into a group', () => {
    const s = buildRunSummary([iter([res({ url: 'https://api.test/x?token=SECRET', resolvedUrl: 'https://api.test/x?token=SECRET', body: 'BODY', headers: { authorization: 'Bearer ABC' }, requestHeaders: { a: 'b' }, requestBody: 'RB', status: 400, testResults: fail('bad') })])]);
    const json = JSON.stringify(s.groups);
    for (const leaked of ['SECRET', 'BODY', 'ABC', 'RB"']) expect(json).not.toContain(leaked);
  });

  it('a run of 1000 failing requests is bounded: <= 30 groups, <= 3 examples each, totals keep the real numbers', () => {
    const results = Array.from({ length: 1000 }, (_, i) => res({ name: `r${i}`, url: `https://api.test/e${i}`, status: 500, testResults: fail('boom') }));
    const t = Date.now();
    const s = buildRunSummary([iter(results)]);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(s.totals).toEqual({ requests: 1000, failedRequests: 1000, groups: 1000 });
    expect(s.groups).toHaveLength(MAX_GROUPS);
    expect(s.groups.every(g => g.examples.length <= MAX_EXAMPLES)).toBe(true);
    expect(s.local).toContain('and 997 more groups.');
  });
});

describe('messageTemplate is linear', () => {
  it('an unclosed quote followed by thousands of escapes does not blow up', () => {
    const t = Date.now();
    messageTemplate(`expected 'abc${'\\n'.repeat(5000)}`);
    messageTemplate(`expected "abc${'\\"'.repeat(5000)}`);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('still masks escaped quotes inside a string, and leaves a line-broken quote alone', () => {
    expect(messageTemplate("expected 'it\\'s' to equal 'x'")).toBe('expected <string> to equal <string>');
    expect(messageTemplate("a 'b\nc' d")).toBe("a 'b c' d");
  });
});
