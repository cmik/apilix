/**
 * Deterministic "probable cause" for a failed request. Pure: no network, no AI, no state, no clock unless
 * `now` is omitted. The result is shown next to the response and, when the user asks for it, passed to
 * "Explain with AI" as context by RULE ID only (the server maps an id to its own fixed sentence), so nothing
 * derived from the request (a variable name, a host, a token claim) ever travels through this channel.
 */

export type LocalDiagnosisId =
  | 'unresolved-variable'
  | 'connection-refused'
  | 'dns-failure'
  | 'tls-error'
  | 'jwt-expired'
  | 'missing-content-type'
  | 'double-slash-404';

export interface LocalDiagnosis {
  id: LocalDiagnosisId;
  /** Fixed one-line title (no request data). */
  title: string;
  /** What was seen and what to try. May name a variable: displayed locally only. */
  detail: string;
  confidence: 'high' | 'medium';
}

export interface LocalDiagnosisInput {
  method?: string;
  /** The URL as sent (resolved) when known, else the raw one. */
  url?: string;
  /** Headers actually sent. */
  requestHeaders?: Record<string, string> | Array<{ key: string; value: string }>;
  requestBody?: string;
  /** 0 or undefined for a transport failure. */
  status?: number;
  /** Transport error message (the engine's `response.error`). */
  error?: string | null;
  /** Epoch ms; injectable for tests. */
  now?: number;
}

/** Ids the server accepts as context (kept in sync with packages/ai/src/explain-failure.js). */
export const LOCAL_DIAGNOSIS_IDS: readonly LocalDiagnosisId[] = [
  'unresolved-variable', 'connection-refused', 'dns-failure', 'tls-error', 'jwt-expired', 'missing-content-type', 'double-slash-404',
];

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const TLS_RE = /CERT_[A-Z_]+|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL|EPROTO|certificate|SSL routines|wrong version number|handshake/i;

function headerMap(h: LocalDiagnosisInput['requestHeaders']): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(h)) {
    for (const p of h) if (p && typeof p.key === 'string') out[p.key.toLowerCase()] = String(p.value ?? '');
  } else if (h && typeof h === 'object') {
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v ?? '');
  }
  return out;
}

/** The `exp` claim (seconds) of a JWT, or null when the token is not a decodable JWT. Never throws. */
export function jwtExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}

function pathOf(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(url);
  return m ? m[1] : null;
}

export function diagnoseLocal(input: LocalDiagnosisInput): LocalDiagnosis[] {
  const status = typeof input.status === 'number' ? input.status : 0;
  const error = typeof input.error === 'string' ? input.error : '';
  const failed = !!error || status === 0 || status >= 400;
  if (!failed) return [];
  const out: LocalDiagnosis[] = [];
  const url = input.url ?? '';
  const headers = headerMap(input.requestHeaders);

  const names = new Set<string>();
  for (const m of url.matchAll(VAR_RE)) if (!m[1].startsWith('$')) names.add(m[1]);
  if (names.size) {
    const list = [...names].slice(0, 5).map(n => `{{${n}}}`).join(', ');
    out.push({
      id: 'unresolved-variable',
      title: 'The URL still contains an unresolved variable',
      detail: `${list} ${names.size > 1 ? 'have' : 'has'} no value in the active environment, collection or globals. Select the right environment or define the variable.`,
      confidence: 'high',
    });
  }

  if (/ECONNREFUSED/i.test(error)) {
    out.push({ id: 'connection-refused', title: 'The connection was refused', detail: 'Nothing is listening on that host and port. Check that the server is running and that the port in the URL is right.', confidence: 'high' });
  } else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(error)) {
    out.push({ id: 'dns-failure', title: 'The host name could not be resolved', detail: 'DNS has no answer for the host. Check the spelling of the host, a missing variable in the URL, your network or VPN.', confidence: 'high' });
  } else if (error && TLS_RE.test(error)) {
    out.push({ id: 'tls-error', title: 'The TLS handshake or certificate check failed', detail: 'The certificate is untrusted, expired or does not match the host, or the server does not speak HTTPS on this port. For a self-signed development server, adjust the request SSL setting.', confidence: 'high' });
  }

  if (status === 401) {
    const auth = headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    const exp = m ? jwtExpiry(m[1]) : null;
    const now = input.now ?? Date.now();
    if (exp !== null && exp * 1000 < now) {
      const mins = Math.max(1, Math.round((now - exp * 1000) / 60000));
      out.push({ id: 'jwt-expired', title: 'The bearer token has expired', detail: `The JWT sent in Authorization expired about ${mins} minute${mins === 1 ? '' : 's'} ago (exp claim). Request a new token.`, confidence: 'high' });
    }
  }

  const method = (input.method ?? '').toUpperCase();
  if (!error && status >= 400 && input.requestBody && input.requestBody.trim() && method !== 'GET' && method !== 'HEAD' && !headers['content-type']) {
    out.push({ id: 'missing-content-type', title: 'The request has a body but no Content-Type header', detail: 'Servers often reject or misparse a body without Content-Type. Add one (for example application/json).', confidence: 'medium' });
  }

  if (status === 404) {
    const p = pathOf(url);
    if (p && p.includes('//')) {
      out.push({ id: 'double-slash-404', title: 'The URL path contains a double slash', detail: 'A "//" in the path often comes from a base URL ending with "/" followed by a path starting with "/". Many servers answer 404.', confidence: 'medium' });
    }
  }
  return out;
}
