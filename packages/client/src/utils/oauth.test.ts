import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildAuthorizationUrl, openAuthorizationWindow, openAuthorizationWindowPlain } from './oauth';

describe('OAuth utilities', () => {
  describe('buildAuthorizationUrl', () => {
    it('builds a basic authorization URL with standard PKCE parameters', () => {
      const url = buildAuthorizationUrl(
        'https://example.com/authorize',
        'client123',
        'http://localhost:3000/callback',
        ['openid', 'profile'],
        'state123',
        'challenge123'
      );

      expect(url).toContain('https://example.com/authorize?');
      expect(url).toContain('client_id=client123');
      expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback');
      expect(url).toContain('response_type=code');
      expect(url).toContain('state=state123');
      expect(url).toContain('scope=openid+profile');
      expect(url).toContain('code_challenge=challenge123');
      expect(url).toContain('code_challenge_method=S256');
    });

    it('appends additional authorization parameters', () => {
      const params = [
        { key: 'audience', value: 'my-api', disabled: false },
        { key: 'prompt', value: 'login', disabled: false },
      ];

      const url = buildAuthorizationUrl(
        'https://example.com/authorize',
        'client123',
        'http://localhost:3000/callback',
        [],
        'state123',
        'challenge123',
        params
      );

      expect(url).toContain('audience=my-api');
      expect(url).toContain('prompt=login');
    });

    it('skips disabled authorization parameters', () => {
      const params = [
        { key: 'audience', value: 'my-api', disabled: false },
        { key: 'nonce', value: 'nonce123', disabled: true },
      ];

      const url = buildAuthorizationUrl(
        'https://example.com/authorize',
        'client123',
        'http://localhost:3000/callback',
        [],
        'state123',
        'challenge123',
        params
      );

      expect(url).toContain('audience=my-api');
      expect(url).not.toContain('nonce=nonce123');
    });

    it('skips authorization parameters with empty keys', () => {
      const params = [
        { key: '', value: 'value1', disabled: false },
        { key: 'validkey', value: 'value2', disabled: false },
      ];

      const url = buildAuthorizationUrl(
        'https://example.com/authorize',
        'client123',
        'http://localhost:3000/callback',
        [],
        'state123',
        'challenge123',
        params
      );

      expect(url).toContain('validkey=value2');
      expect(url).not.toContain('=value1');
    });

    it('works with no authorization parameters', () => {
      const url = buildAuthorizationUrl(
        'https://example.com/authorize',
        'client123',
        'http://localhost:3000/callback',
        [],
        'state123',
        'challenge123',
        []
      );

      expect(url).toContain('client_id=client123');
      expect(url).not.toContain('undefined');
    });

    it('omits PKCE parameters when codeChallenge is empty (for non-PKCE flow)', () => {
      const url = buildAuthorizationUrl(
        'https://example.com/authorize',
        'client123',
        'http://localhost:3000/callback',
        ['openid', 'profile'],
        'state123',
        '', // empty challenge for plain Authorization Code
        []
      );

      expect(url).toContain('client_id=client123');
      expect(url).toContain('response_type=code');
      expect(url).toContain('state=state123');
      expect(url).toContain('scope=openid+profile');
      expect(url).not.toContain('code_challenge');
      expect(url).not.toContain('code_challenge_method');
    });

    it('preserves existing query parameters in authorizationUrl without double ?', () => {
      const url = buildAuthorizationUrl(
        'https://example.com/authorize?tenant=acme',
        'client123',
        'http://localhost:3000/callback',
        [],
        'state123',
        'challenge123'
      );

      expect(url).toContain('tenant=acme');
      expect(url).toContain('client_id=client123');
      // Must not contain double question mark
      expect(url.split('?').length - 1).toBe(1);
    });

    it('works with empty scopes array', () => {
      const url = buildAuthorizationUrl(
        'https://example.com/authorize',
        'client123',
        'http://localhost:3000/callback',
        [],
        'state123',
        'challenge123'
      );

      expect(url).toContain('client_id=client123');
      // scope should not be appended if empty
      const scopeIndex = url.indexOf('scope=');
      expect(scopeIndex).toBe(-1);
    });

    it('properly encodes special characters in parameter values', () => {
      const params = [
        { key: 'custom_param', value: 'value with spaces', disabled: false },
      ];

      const url = buildAuthorizationUrl(
        'https://example.com/authorize',
        'client123',
        'http://localhost:3000/callback',
        [],
        'state123',
        'challenge123',
        params
      );

      expect(url).toContain('custom_param=value+with+spaces');
    });
  });
});

// ─── Electron OAuth flow ──────────────────────────────────────────────────────

/**
 * Mock EventSource that allows tests to synchronously emit SSE events.
 * A reference to the most recently created instance is stored in `latestSrc`
 * so individual tests can trigger events after the function under test opens
 * the stream.
 */
class MockEventSource {
  url: string;
  handlers: Record<string, ((e?: any) => void)[]> = {};
  onerror: ((e?: any) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource._latest = this;
  }

  static _latest: MockEventSource | null = null;

  addEventListener(type: string, fn: (e?: any) => void) {
    (this.handlers[type] ??= []).push(fn);
  }

  close() {
    this.closed = true;
  }

  /** Simulate the server pushing an SSE event. */
  emit(type: string, data?: object) {
    if (type === 'error') {
      this.onerror?.call(this);
    } else {
      const e = { data: JSON.stringify(data ?? {}) };
      this.handlers[type]?.forEach(fn => fn(e));
    }
  }
}

describe('Electron OAuth flow', () => {
  beforeEach(() => {
    MockEventSource._latest = null;
    // The test runs in Node (no jsdom), so we must provide `window` ourselves.
    vi.stubGlobal('window', {
      electronAPI: { serverPort: 9999 },
      open: vi.fn().mockReturnValue(null),
    });
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    MockEventSource._latest = null;
  });

  // ── openAuthorizationWindowPlain ────────────────────────────────────────────
  // EventSource is created synchronously (no await before it), so latestSrc
  // is available immediately after calling openAuthorizationWindowPlain().

  describe('openAuthorizationWindowPlain — Electron path', () => {
    it('resolves with code when SSE delivers a code event', async () => {
      const resultPromise = openAuthorizationWindowPlain(
        'https://auth.example.com/authorize',
        'client-id',
        'http://localhost:3000/callback',
        ['openid'],
      );

      const src = MockEventSource._latest!;
      expect(src).not.toBeNull();
      src.emit('code', { code: 'auth_code_plain', error: null });

      const result = await resultPromise;
      expect(result).not.toBeNull();
      expect(result!.code).toBe('auth_code_plain');
      expect(result!.state).toBeTruthy();
      expect(result!.codeVerifier).toBe(''); // no PKCE in plain flow
    });

    it('returns null when SSE times out', async () => {
      const resultPromise = openAuthorizationWindowPlain(
        'https://auth.example.com/authorize',
        'client-id',
        'http://localhost:3000/callback',
        [],
      );
      MockEventSource._latest!.emit('timeout');
      expect(await resultPromise).toBeNull();
    });

    it('returns null when the SSE connection errors', async () => {
      const resultPromise = openAuthorizationWindowPlain(
        'https://auth.example.com/authorize',
        'client-id',
        'http://localhost:3000/callback',
        [],
      );
      MockEventSource._latest!.emit('error');
      expect(await resultPromise).toBeNull();
    });

    it('returns null when the code event carries an OAuth error', async () => {
      const resultPromise = openAuthorizationWindowPlain(
        'https://auth.example.com/authorize',
        'client-id',
        'http://localhost:3000/callback',
        [],
      );
      MockEventSource._latest!.emit('code', { code: null, error: 'access_denied' });
      expect(await resultPromise).toBeNull();
    });

    it('uses the Electron server port in the authorization URL redirect_uri', async () => {
      const resultPromise = openAuthorizationWindowPlain(
        'https://auth.example.com/authorize',
        'client-id',
        'http://localhost:3000/callback', // should be overridden
        [],
      );

      const calledUrl = (window.open as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Foauth%2Fcallback');

      MockEventSource._latest!.emit('timeout');
      await resultPromise;
    });

    it('subscribes to the SSE stream on the Electron server port', async () => {
      const resultPromise = openAuthorizationWindowPlain(
        'https://auth.example.com/authorize',
        'client-id',
        'http://localhost:3000/callback',
        [],
      );

      expect(MockEventSource._latest!.url).toContain(
        'http://localhost:9999/api/oauth/auth-callback-stream'
      );

      MockEventSource._latest!.emit('timeout');
      await resultPromise;
    });
  });

  // ── openAuthorizationWindow (PKCE) ──────────────────────────────────────────
  // generatePKCEChallenge is async, so EventSource is created after an await.
  // Tests must yield with setTimeout(0) before accessing MockEventSource._latest.

  describe('openAuthorizationWindow (PKCE) — Electron path', () => {
    it('resolves with code and non-empty codeVerifier when SSE delivers a code event', async () => {
      const resultPromise = openAuthorizationWindow(
        'https://auth.example.com/authorize',
        'client-id',
        'http://localhost:3000/callback',
        ['openid'],
      );

      // Wait until EventSource is created — means openAuthorizationWindow has
      // resumed past `await generatePKCEChallenge` and called window.open.
      await vi.waitFor(() => { if (!MockEventSource._latest) throw new Error('pending'); });

      const src = MockEventSource._latest!;
      expect(src).not.toBeNull();
      src.emit('code', { code: 'pkce_auth_code', error: null });

      const result = await resultPromise;
      expect(result).not.toBeNull();
      expect(result!.code).toBe('pkce_auth_code');
      expect(result!.codeVerifier).not.toBe(''); // PKCE verifier must be set
      expect(result!.state).toBeTruthy();
    });

    it('returns null when SSE times out', async () => {
      const resultPromise = openAuthorizationWindow(
        'https://auth.example.com/authorize',
        'client-id',
        'http://localhost:3000/callback',
        [],
      );

      await vi.waitFor(() => { if (!MockEventSource._latest) throw new Error('pending'); });
      MockEventSource._latest!.emit('timeout');
      expect(await resultPromise).toBeNull();
    });

    it('uses the Electron server port in the authorization URL redirect_uri', async () => {
      const resultPromise = openAuthorizationWindow(
        'https://auth.example.com/authorize',
        'client-id',
        'http://localhost:3000/callback',
        [],
      );

      await vi.waitFor(() => { if (!MockEventSource._latest) throw new Error('pending'); });

      const calledUrl = (window.open as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Foauth%2Fcallback');

      MockEventSource._latest!.emit('timeout');
      await resultPromise;
    });
  });
});
