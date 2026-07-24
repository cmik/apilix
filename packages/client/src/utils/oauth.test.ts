import { describe, it, expect } from 'vitest';
import { buildAuthorizationUrl } from './oauth';

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
