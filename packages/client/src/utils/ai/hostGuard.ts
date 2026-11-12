import type { CollectionItem } from '../../types';
import type { RequestDraft } from './aiTypes';

/**
 * Exfiltration guard for a generated request.
 *
 * A model can be steered (by an instruction or by text inside the collection it is shown) into writing a
 * request to a host the user never uses while attaching `{{secret}}` variables to it. The proposal dialog
 * blocks Apply behind an explicit acknowledgement when BOTH hold:
 *  - the URL host is not `{{baseUrl}}` and not the host of a neighbouring request / the modified request;
 *  - the draft references a secret variable in the URL, headers, auth, query or body.
 */

/** Manual fallback for hosts the URL parser cannot take (`{{variable}}` parts). Backslash counts as `/`, as in WHATWG URLs. */
function manualHost(rest: string): string | null {
  const authority = rest.split(/[/\\?#]/, 1)[0];
  const afterUser = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  const noPort = afterUser.replace(/:\d{0,5}$/, '');
  // Only a bare `{{placeholder}}` stands for itself: `{{baseUrl}}.evil.test` is another host.
  if (/^\{\{[^{}]{1,100}\}\}$/.test(noPort)) return noPort;
  return noPort.toLowerCase() || null;
}

/**
 * Comparable host of a URL: lower-cased, punycode, no scheme / user info / port / trailing dot, decided the
 * way the URL parser the request engine uses would decide it (`https://evil.test\@good.test` is evil.test;
 * `//evil.test/x` is a host). `{{var}}` hosts are kept as-is. null = no host (relative URL).
 */
export function hostOf(url: string | undefined | null): string | null {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  if (!u) return null;
  if (/^[\\/]{2,}/.test(u)) return hostOf(`https://${u.replace(/^[\\/]+/, '')}`);
  if (/^[\\/]/.test(u)) return null;
  if (u.includes('{{')) {
    return manualHost(u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''));
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`;
  try {
    const host = new URL(candidate).hostname.replace(/\.$/, '');
    return host || null;
  } catch {
    return manualHost(u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''));
  }
}

/** Hosts of the items a user already works with (neighbours, the request being modified). */
export function knownHostsOf(items: Array<CollectionItem | null | undefined>): string[] {
  const out = new Set<string>();
  for (const it of items) {
    const url = it?.request?.url;
    const h = hostOf(typeof url === 'string' ? url : url?.raw);
    if (h) out.add(h);
  }
  return Array.from(out);
}

function referencedVariables(text: string | undefined): string[] {
  if (!text) return [];
  return Array.from(text.matchAll(/\{\{\s*([^{}\s]{1,100})\s*\}\}/g), m => m[1]);
}

/** Names of secret variables referenced anywhere a value leaves the machine. */
export function secretVariablesUsed(draft: RequestDraft, secretNames: ReadonlySet<string>): string[] {
  if (!secretNames.size) return [];
  const texts: string[] = [draft.url];
  for (const p of draft.headers ?? []) texts.push(p.value ?? '');
  for (const p of draft.query ?? []) texts.push(p.value ?? '');
  const a = draft.auth;
  if (a) texts.push(a.token ?? '', a.username ?? '', a.password ?? '', a.value ?? '');
  const b = draft.body;
  if (b) {
    texts.push(b.raw ?? '');
    for (const p of b.formdata ?? []) texts.push(p.value ?? '');
    for (const p of b.urlencoded ?? []) texts.push(p.value ?? '');
  }
  const used = new Set<string>();
  for (const t of texts) for (const v of referencedVariables(t)) if (secretNames.has(v)) used.add(v);
  return Array.from(used);
}

export interface ExfiltrationRisk { host: string; variables: string[] }

export function exfiltrationRisk(
  draft: RequestDraft,
  opts: { secretNames: ReadonlySet<string>; knownHosts: readonly string[] },
): ExfiltrationRisk | null {
  const host = hostOf(draft.url);
  if (!host) return null;
  if (host === '{{baseUrl}}' || opts.knownHosts.includes(host)) return null;
  const variables = secretVariablesUsed(draft, opts.secretNames);
  return variables.length ? { host, variables } : null;
}
