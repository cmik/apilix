// ─── cURL Parser ─────────────────────────────────────────────────────────────

export interface CurlParsed {
  method: string;
  url: string;
  headers: Array<{ key: string; value: string }>;
  bodyRaw: string;
  bodyMode: 'raw' | 'urlencoded' | 'formdata' | 'none';
  bodyRawLang: 'json' | 'xml' | 'html' | 'text';
  bodyFormData: Array<{ key: string; value: string }>;
  bodyUrlEncoded: Array<{ key: string; value: string }>;
  authType: '' | 'basic';
  authBasicUser: string;
  authBasicPass: string;
}

function tokenizeCurl(str: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < str.length) {
    while (i < str.length && /[ \t]/.test(str[i])) i++;
    if (i >= str.length) break;
    const ch = str[i];
    // ANSI-C quoting: $'...'
    if (ch === '$' && str[i + 1] === "'") {
      i += 2;
      let tok = '';
      while (i < str.length && str[i] !== "'") {
        if (str[i] === '\\') {
          i++;
          const esc = str[i] ?? '';
          if (esc === 'n') tok += '\n';
          else if (esc === 't') tok += '\t';
          else if (esc === 'r') tok += '\r';
          else tok += esc;
        } else {
          tok += str[i];
        }
        i++;
      }
      i++;
      tokens.push(tok);
    } else if (ch === '"' || ch === "'") {
      i++;
      let tok = '';
      while (i < str.length && str[i] !== ch) {
        if (str[i] === '\\' && ch === '"') {
          i++;
          tok += str[i] ?? '';
        } else {
          tok += str[i];
        }
        i++;
      }
      i++;
      tokens.push(tok);
    } else {
      let tok = '';
      while (i < str.length && !/[ \t]/.test(str[i])) {
        tok += str[i];
        i++;
      }
      tokens.push(tok);
    }
  }
  return tokens;
}

export function parseCurlCommand(curlStr: string): CurlParsed | null {
  const normalized = curlStr.trim().replace(/\\\r?\n/g, ' ').replace(/\r?\n/g, ' ');
  if (!/^curl\s/i.test(normalized)) return null;

  const tokens = tokenizeCurl(normalized.slice(normalized.toLowerCase().indexOf('curl ') + 5));
  let method = '';
  let url = '';
  const headers: Array<{ key: string; value: string }> = [];
  let bodyRaw = '';
  let bodyMode: CurlParsed['bodyMode'] = 'none';
  const bodyFormData: Array<{ key: string; value: string }> = [];
  const bodyUrlEncoded: Array<{ key: string; value: string }> = [];
  let authBasicUser = '';
  let authBasicPass = '';
  let authType: CurlParsed['authType'] = '';

  // Flags that consume the next token but are otherwise ignored
  const skipWithArg = new Set([
    '-o', '--output', '--connect-timeout', '--max-time',
    '--proxy', '-x', '--cert', '--key', '--cacert', '--capath',
    '-c', '--cookie-jar', '--resolve',
  ]);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let flag = t;
    let inlineVal: string | undefined;
    const eqIdx = t.indexOf('=');
    if (eqIdx > 0 && t.startsWith('-')) {
      flag = t.slice(0, eqIdx);
      inlineVal = t.slice(eqIdx + 1);
    }
    const nextArg = (): string => {
      if (inlineVal !== undefined) return inlineVal;
      return tokens[++i] ?? '';
    };

    if (flag === '-X' || flag === '--request') {
      method = nextArg().toUpperCase();
    } else if (flag === '-H' || flag === '--header') {
      const h = nextArg();
      const ci = h.indexOf(':');
      if (ci !== -1) headers.push({ key: h.slice(0, ci).trim(), value: h.slice(ci + 1).trim() });
    } else if (flag === '-d' || flag === '--data' || flag === '--data-raw' || flag === '--data-binary' || flag === '--data-ascii') {
      const val = nextArg();
      if (!val.startsWith('@')) {
        bodyRaw = bodyRaw ? bodyRaw + '&' + val : val;
        bodyMode = 'raw';
      }
    } else if (flag === '--data-urlencode') {
      const val = nextArg();
      const ei = val.indexOf('=');
      if (ei !== -1) {
        bodyUrlEncoded.push({ key: val.slice(0, ei), value: val.slice(ei + 1) });
        bodyMode = 'urlencoded';
      } else {
        bodyRaw = bodyRaw ? bodyRaw + '&' + val : val;
        bodyMode = 'raw';
      }
    } else if (flag === '-F' || flag === '--form' || flag === '--form-string') {
      const val = nextArg();
      const ei = val.indexOf('=');
      if (ei !== -1) bodyFormData.push({ key: val.slice(0, ei), value: val.slice(ei + 1) });
      bodyMode = 'formdata';
    } else if (flag === '-u' || flag === '--user') {
      const val = nextArg();
      const ci = val.indexOf(':');
      authBasicUser = ci !== -1 ? val.slice(0, ci) : val;
      authBasicPass = ci !== -1 ? val.slice(ci + 1) : '';
      authType = 'basic';
    } else if (flag === '-b' || flag === '--cookie') {
      // Treat outgoing cookie values as a Cookie header
      headers.push({ key: 'Cookie', value: nextArg() });
    } else if (flag === '-A' || flag === '--user-agent') {
      headers.push({ key: 'User-Agent', value: nextArg() });
    } else if (flag === '--url') {
      url = nextArg();
    } else if (flag === '--get' || flag === '-G') {
      method = 'GET';
    } else if (flag === '--head' || flag === '-I') {
      method = 'HEAD';
    } else if (skipWithArg.has(flag) && inlineVal === undefined) {
      i++; // skip consumed argument
    } else if (!t.startsWith('-') && !url) {
      url = t;
    }
  }

  if (!url) return null;
  if (!method) method = bodyMode !== 'none' ? 'POST' : 'GET';

  const ct = headers.find(h => h.key.toLowerCase() === 'content-type')?.value ?? '';
  const bodyRawLang: CurlParsed['bodyRawLang'] = ct.includes('json') ? 'json' : ct.includes('xml') ? 'xml' : ct.includes('html') ? 'html' : 'text';

  // If Content-Type is urlencoded and we have raw body, parse it into key/value pairs
  if (ct.includes('application/x-www-form-urlencoded') && bodyRaw && bodyMode === 'raw') {
    bodyRaw.split('&').forEach(pair => {
      const ei = pair.indexOf('=');
      if (ei !== -1) {
        try {
          bodyUrlEncoded.push({ key: decodeURIComponent(pair.slice(0, ei)), value: decodeURIComponent(pair.slice(ei + 1)) });
        } catch {
          bodyUrlEncoded.push({ key: pair.slice(0, ei), value: pair.slice(ei + 1) });
        }
      }
    });
    bodyMode = 'urlencoded';
    bodyRaw = '';
  }

  return {
    method, url, headers, bodyRaw, bodyMode, bodyRawLang,
    bodyFormData, bodyUrlEncoded, authType, authBasicUser, authBasicPass,
  };
}

// ─── cURL Exporter ───────────────────────────────────────────────────────────

export interface CurlBuildParams {
  method: string;
  url: string;
  headers: Array<{ key: string; value: string; disabled?: boolean }>;
  bodyMode: string;
  bodyRaw: string;
  bodyFormData: Array<{ key: string; value: string }>;
  bodyUrlEncoded: Array<{ key: string; value: string }>;
  authType: string;
  authBearer: string;
  authBasicUser: string;
  authBasicPass: string;
  authApiKeyName: string;
  authApiKeyValue: string;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function buildCurlCommand(p: CurlBuildParams): string {
  const parts: string[] = [`curl -X ${p.method}`];

  // Auth
  if (p.authType === 'bearer' && p.authBearer) {
    parts.push(`  -H ${shellQuote(`Authorization: Bearer ${p.authBearer}`)}`);
  } else if (p.authType === 'basic' && (p.authBasicUser || p.authBasicPass)) {
    parts.push(`  -u ${shellQuote(`${p.authBasicUser}:${p.authBasicPass}`)}`);
  } else if (p.authType === 'apikey' && p.authApiKeyName) {
    parts.push(`  -H ${shellQuote(`${p.authApiKeyName}: ${p.authApiKeyValue}`)}`);
  }

  // Headers
  for (const h of p.headers) {
    if (h.disabled) continue;
    if (!h.key) continue;
    parts.push(`  -H ${shellQuote(`${h.key}: ${h.value}`)}`);
  }

  // Body
  if (p.bodyMode === 'raw' && p.bodyRaw) {
    parts.push(`  --data-raw ${shellQuote(p.bodyRaw)}`);
  } else if (p.bodyMode === 'urlencoded') {
    for (const e of p.bodyUrlEncoded) {
      if (e.key) parts.push(`  --data-urlencode ${shellQuote(`${e.key}=${e.value}`)}`);
    }
  } else if (p.bodyMode === 'formdata') {
    for (const f of p.bodyFormData) {
      if (f.key) parts.push(`  -F ${shellQuote(`${f.key}=${f.value}`)}`);
    }
  }

  // URL (always last)
  parts.push(`  ${shellQuote(p.url)}`);

  return parts.join(' \\\n');
}
