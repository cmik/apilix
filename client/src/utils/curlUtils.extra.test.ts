import { describe, it, expect } from 'vitest';
import { parseCurlCommand, buildCurlCommand } from './curlUtils';
import type { CurlBuildParams } from './curlUtils';

// ─── buildCurlCommand ─────────────────────────────────────────────────────────

function baseParams(): CurlBuildParams {
  return {
    method: 'GET',
    url: 'https://api.example.com/users',
    headers: [],
    bodyMode: 'none',
    bodyRaw: '',
    bodyFormData: [],
    bodyUrlEncoded: [],
    authType: '',
    authBearer: '',
    authBasicUser: '',
    authBasicPass: '',
    authApiKeyName: '',
    authApiKeyValue: '',
  };
}

describe('buildCurlCommand — basic structure', () => {
  it('starts with curl -X METHOD', () => {
    const result = buildCurlCommand(baseParams());
    expect(result).toMatch(/^curl -X GET/);
  });

  it('ends with the quoted URL as the last part', () => {
    const result = buildCurlCommand(baseParams());
    const lines = result.split('\\\n');
    expect(lines[lines.length - 1].trim()).toBe("'https://api.example.com/users'");
  });

  it('joins parts with space-backslash-newline', () => {
    const params = { ...baseParams(), method: 'POST', bodyMode: 'raw', bodyRaw: 'data' };
    const result = buildCurlCommand(params);
    expect(result).toContain(' \\\n');
  });
});

describe('buildCurlCommand — auth', () => {
  it('adds bearer Authorization header', () => {
    const result = buildCurlCommand({
      ...baseParams(),
      authType: 'bearer',
      authBearer: 'my-secret-token',
    });
    expect(result).toContain("Authorization: Bearer my-secret-token");
  });

  it('adds -u for basic auth', () => {
    const result = buildCurlCommand({
      ...baseParams(),
      authType: 'basic',
      authBasicUser: 'admin',
      authBasicPass: 'hunter2',
    });
    expect(result).toContain('-u');
    expect(result).toContain('admin:hunter2');
  });

  it('adds apikey as -H header', () => {
    const result = buildCurlCommand({
      ...baseParams(),
      authType: 'apikey',
      authApiKeyName: 'X-API-Key',
      authApiKeyValue: 'key123',
    });
    expect(result).toContain('X-API-Key: key123');
  });

  it('does not emit auth when authType is empty', () => {
    const result = buildCurlCommand(baseParams());
    expect(result).not.toContain('Authorization');
    expect(result).not.toContain('-u ');
  });

  it('skips bearer header when authBearer is empty string', () => {
    const result = buildCurlCommand({ ...baseParams(), authType: 'bearer', authBearer: '' });
    expect(result).not.toContain('Authorization');
  });

  it('skips basic auth when both user and pass are empty', () => {
    const result = buildCurlCommand({
      ...baseParams(),
      authType: 'basic',
      authBasicUser: '',
      authBasicPass: '',
    });
    expect(result).not.toContain('-u ');
  });

  it('skips apikey header when name is empty', () => {
    const result = buildCurlCommand({ ...baseParams(), authType: 'apikey', authApiKeyName: '' });
    expect(result).not.toContain('-H');
  });
});

describe('buildCurlCommand — headers', () => {
  it('adds non-disabled headers', () => {
    const result = buildCurlCommand({
      ...baseParams(),
      headers: [
        { key: 'Accept', value: 'application/json' },
        { key: 'X-Custom', value: 'value' },
      ],
    });
    expect(result).toContain('Accept: application/json');
    expect(result).toContain('X-Custom: value');
  });

  it('skips disabled headers', () => {
    const result = buildCurlCommand({
      ...baseParams(),
      headers: [{ key: 'X-Disabled', value: 'skip', disabled: true }],
    });
    expect(result).not.toContain('X-Disabled');
  });

  it('skips headers with empty key', () => {
    const result = buildCurlCommand({
      ...baseParams(),
      headers: [{ key: '', value: 'should-be-skipped' }],
    });
    expect(result).not.toContain('should-be-skipped');
  });

  it('shell-quotes headers containing single quotes', () => {
    const result = buildCurlCommand({
      ...baseParams(),
      headers: [{ key: 'X-Custom', value: "it's here" }],
    });
    // The value should be escaped using '\'' shell quoting
    expect(result).toContain("X-Custom: it'\\''s here");
  });
});

describe('buildCurlCommand — body modes', () => {
  it('adds --data-raw for raw body', () => {
    const result = buildCurlCommand({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'raw',
      bodyRaw: '{"key":"value"}',
    });
    expect(result).toContain('--data-raw');
    expect(result).toContain('{"key":"value"}');
  });

  it('skips --data-raw when bodyRaw is empty', () => {
    const result = buildCurlCommand({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'raw',
      bodyRaw: '',
    });
    expect(result).not.toContain('--data-raw');
  });

  it('adds --data-urlencode for urlencoded pairs', () => {
    const result = buildCurlCommand({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'urlencoded',
      bodyUrlEncoded: [
        { key: 'username', value: 'alice' },
        { key: 'password', value: 'secret' },
      ],
    });
    expect(result).toContain('--data-urlencode');
    expect(result).toContain('username=alice');
    expect(result).toContain('password=secret');
  });

  it('skips urlencoded pairs with empty key', () => {
    const result = buildCurlCommand({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'urlencoded',
      bodyUrlEncoded: [{ key: '', value: 'orphan' }],
    });
    expect(result).not.toContain('--data-urlencode');
  });

  it('adds -F for formdata pairs', () => {
    const result = buildCurlCommand({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'formdata',
      bodyFormData: [
        { key: 'file', value: 'data.csv' },
        { key: 'type', value: 'text/csv' },
      ],
    });
    expect(result).toContain('-F');
    expect(result).toContain('file=data.csv');
    expect(result).toContain('type=text/csv');
  });

  it('skips formdata pairs with empty key', () => {
    const result = buildCurlCommand({
      ...baseParams(),
      method: 'POST',
      bodyMode: 'formdata',
      bodyFormData: [{ key: '', value: 'ignored' }],
    });
    expect(result).not.toContain('-F');
  });
});

// ─── parseCurlCommand — additional edge cases ─────────────────────────────────

describe('parseCurlCommand — --data-binary flag', () => {
  it('treats --data-binary like --data', () => {
    const result = parseCurlCommand('curl --data-binary \'{"x":1}\' https://example.com');
    expect(result?.bodyMode).toBe('raw');
    expect(result?.bodyRaw).toBe('{"x":1}');
  });
});

describe('parseCurlCommand — --data-ascii flag', () => {
  it('treats --data-ascii like --data', () => {
    const result = parseCurlCommand("curl --data-ascii 'hello=world' https://example.com");
    expect(result?.bodyMode).toBe('raw');
    expect(result?.bodyRaw).toBe('hello=world');
  });
});

describe('parseCurlCommand — --url flag', () => {
  it('accepts URL from --url flag', () => {
    const result = parseCurlCommand('curl --url https://api.example.com/items');
    expect(result?.url).toBe('https://api.example.com/items');
  });
});

describe('parseCurlCommand — -G / --get flag', () => {
  it('sets method to GET with -G', () => {
    const result = parseCurlCommand('curl -G https://example.com');
    expect(result?.method).toBe('GET');
  });
});

describe('parseCurlCommand — -I / --head flag', () => {
  it('sets method to HEAD with -I', () => {
    const result = parseCurlCommand('curl -I https://example.com');
    expect(result?.method).toBe('HEAD');
  });

  it('sets method to HEAD with --head', () => {
    const result = parseCurlCommand('curl --head https://example.com');
    expect(result?.method).toBe('HEAD');
  });
});

describe('parseCurlCommand — -b / --cookie flag', () => {
  it('adds a Cookie header', () => {
    const result = parseCurlCommand('curl -b "session=abc123" https://example.com');
    expect(result?.headers).toContainEqual({ key: 'Cookie', value: 'session=abc123' });
  });
});

describe('parseCurlCommand — -A / --user-agent flag', () => {
  it('adds a User-Agent header', () => {
    const result = parseCurlCommand('curl -A "MyAgent/1.0" https://example.com');
    expect(result?.headers).toContainEqual({ key: 'User-Agent', value: 'MyAgent/1.0' });
  });
});

describe('parseCurlCommand — urlencoded body from Content-Type header', () => {
  it('parses raw body into key-value pairs when Content-Type is application/x-www-form-urlencoded', () => {
    const result = parseCurlCommand(
      'curl -X POST -H "Content-Type: application/x-www-form-urlencoded" -d "user=alice&role=admin" https://example.com'
    );
    expect(result?.bodyMode).toBe('urlencoded');
    expect(result?.bodyUrlEncoded).toContainEqual({ key: 'user', value: 'alice' });
    expect(result?.bodyUrlEncoded).toContainEqual({ key: 'role', value: 'admin' });
  });
});

describe('parseCurlCommand — ANSI-C quoting $\'...\'', () => {
  it('expands escape sequences in $\'...\' quoted strings', () => {
    const result = parseCurlCommand("curl -H $'X-Custom: line1\\nline2' https://example.com");
    expect(result?.headers).toBeDefined();
    // The header value should contain a real newline
    const header = result?.headers.find(h => h.key === 'X-Custom');
    expect(header?.value).toContain('\n');
  });
});

describe('parseCurlCommand — skipped flags with inline = syntax', () => {
  it('handles --connect-timeout=5 without consuming next token as URL', () => {
    const result = parseCurlCommand('curl --connect-timeout=5 https://api.example.com');
    expect(result?.url).toBe('https://api.example.com');
  });
});

describe('parseCurlCommand — flag with inline = value', () => {
  it('parses -X=POST using inline = syntax', () => {
    const result = parseCurlCommand('curl -X=POST https://example.com');
    expect(result?.method).toBe('POST');
  });
});

describe('parseCurlCommand — multiple data flags concatenated', () => {
  it('joins multiple -d flags with & separator', () => {
    const result = parseCurlCommand('curl -d "a=1" -d "b=2" https://example.com');
    expect(result?.bodyRaw).toContain('a=1');
    expect(result?.bodyRaw).toContain('b=2');
    expect(result?.bodyRaw).toContain('&');
  });
});

describe('parseCurlCommand — basic auth without password', () => {
  it('parses -u username without colon separator', () => {
    const result = parseCurlCommand('curl -u alice https://example.com');
    expect(result?.authType).toBe('basic');
    expect(result?.authBasicUser).toBe('alice');
    expect(result?.authBasicPass).toBe('');
  });
});

describe('parseCurlCommand — case insensitive curl prefix', () => {
  it('accepts CURL in uppercase', () => {
    const result = parseCurlCommand('CURL https://example.com');
    expect(result?.url).toBe('https://example.com');
  });
});

describe('parseCurlCommand — xml body', () => {
  it('detects xml body language from Content-Type', () => {
    const result = parseCurlCommand(
      'curl -X POST -H "Content-Type: application/xml" -d "<root/>" https://example.com'
    );
    expect(result?.bodyRawLang).toBe('xml');
  });
});

describe('parseCurlCommand — html body', () => {
  it('detects html body language from Content-Type', () => {
    const result = parseCurlCommand(
      'curl -X POST -H "Content-Type: text/html" -d "<html/>" https://example.com'
    );
    expect(result?.bodyRawLang).toBe('html');
  });
});

describe('parseCurlCommand — --data-urlencode without = sign', () => {
  it('falls back to raw mode when no = found in data-urlencode value', () => {
    const result = parseCurlCommand('curl --data-urlencode "justvalue" https://example.com');
    expect(result?.bodyMode).toBe('raw');
    expect(result?.bodyRaw).toBe('justvalue');
  });
});

describe('parseCurlCommand — --form-string', () => {
  it('parses --form-string like -F', () => {
    const result = parseCurlCommand('curl --form-string "field=value" https://example.com');
    expect(result?.bodyMode).toBe('formdata');
    expect(result?.bodyFormData).toContainEqual({ key: 'field', value: 'value' });
  });
});
