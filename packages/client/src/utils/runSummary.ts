import type { RunnerIteration } from '../types';

/**
 * Deterministic grouping of a run's failures by root cause (same URL template, same status, same message),
 * and the local one-paragraph summary. No AI, no network. The groups are also what "Summarize with AI"
 * sends: aggregated metadata and at most MAX_EXAMPLES examples per group, never a body or a header; every free text
 * (message, example name, failure name and error) goes through messageTemplate, so no response value is carried.
 */

export const MAX_EXAMPLES = 3;
export const MAX_GROUPS = 30;
const MAX_FAILURES_PER_EXAMPLE = 3;

export interface RunFailureExample {
  name: string;
  method: string;
  /** URL template (see urlTemplate). */
  url: string;
  status: number;
  failures: Array<{ name: string; error: string }>;
}

export interface RunFailureGroup {
  key: string;
  count: number;
  method: string;
  url: string;
  status: number;
  /** The first failure message, with quoted values and numbers replaced by placeholders. */
  message: string;
  examples: RunFailureExample[];
}

export interface RunSummaryData {
  totals: { requests: number; failedRequests: number; groups: number };
  groups: RunFailureGroup[];
  /** Plain-text summary built from the groups, shown without any AI. */
  local: string;
}

const ID_RE = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

/** `https://h/users/42/orders?x=1` -> `https://h/users/:id/orders`: no query, no userinfo, id-like segments replaced. */
export function urlTemplate(raw: string): string {
  let s = raw.split('#')[0].split('?')[0];
  const m = /^([a-z][a-z0-9+.-]*:\/\/)?([^/]*)(\/.*)?$/i.exec(s);
  if (!m) return s.slice(0, 300);
  const authority = m[2].includes('@') ? m[2].slice(m[2].lastIndexOf('@') + 1) : m[2];
  const path = (m[3] ?? '').split('/').map(seg => (!seg.includes('{{') && (ID_RE.test(seg) || /\d{4,}/.test(seg)) ? ':id' : seg)).join('/');
  s = `${m[1] ?? ''}${authority}${path}`;
  return s.slice(0, 300);
}

/** Quoted strings and numbers become placeholders so that messages differing only by a value group together. */
export function messageTemplate(msg: string): string {
  return msg
    .replace(/https?:\/\/\S+/gi, '<string>')
    // Emails, token by token: a `\S+@\S+` regex rescans a long unbroken run from every start (quadratic).
    .split(/(\s+)/)
    .map(tok => { const at = tok.indexOf('@', 1); return at !== -1 && at < tok.length - 1 && !/^\s/.test(tok) ? '<string>' : tok; })
    .join('')
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\n\r\u2028\u2029])*\1/g, '<string>')
    .replace(/-?\b\d+(?:\.\d+)?\b/g, '<number>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function buildRunSummary(results: RunnerIteration[]): RunSummaryData {
  let requests = 0;
  let failedRequests = 0;
  const byKey = new Map<string, RunFailureGroup>();
  for (const iter of results) {
    for (const r of iter.results) {
      requests++;
      const failures: Array<{ name: string; error: string }> = [];
      if (r.error) failures.push({ name: 'Request error', error: r.error });
      for (const t of r.testResults ?? []) if (t.passed === false) failures.push({ name: t.name, error: t.error ?? '' });
      if (!failures.length) continue;
      failedRequests++;
      const url = urlTemplate(r.resolvedUrl || r.url || '');
      const first = failures[0];
      const message = messageTemplate(first.error ? `${first.name}: ${first.error}` : first.name);
      const key = `${r.method} ${url} ${r.status} ${message}`;
      let g = byKey.get(key);
      if (!g) { g = { key, count: 0, method: r.method, url, status: r.status, message, examples: [] }; byKey.set(key, g); }
      g.count++;
      if (g.examples.length < MAX_EXAMPLES) {
        g.examples.push({
          name: messageTemplate(r.name),
          method: r.method,
          url,
          status: r.status,
          // Same masking as the group message: an assertion error quotes values taken from the response.
          failures: failures.slice(0, MAX_FAILURES_PER_EXAMPLE).map(f => ({ name: messageTemplate(f.name), error: messageTemplate(f.error) })),
        });
      }
    }
  }
  const all = [...byKey.values()].sort((a, b) => b.count - a.count);
  const groups = all.slice(0, MAX_GROUPS);
  const totals = { requests, failedRequests, groups: all.length };
  const lines = [`${failedRequests} of ${requests} request${requests === 1 ? '' : 's'} failed, in ${all.length} group${all.length === 1 ? '' : 's'} of similar failures.`];
  for (const g of groups.slice(0, 3)) {
    lines.push(`${g.count}x ${g.method} ${g.url} ${g.status ? `returned ${g.status}` : 'got no response'}: ${g.message}`);
  }
  if (all.length > 3) lines.push(`and ${all.length - 3} more group${all.length - 3 === 1 ? '' : 's'}.`);
  return { totals, groups, local: lines.join('\n') };
}
