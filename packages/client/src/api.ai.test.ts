import { describe, it, expect, vi, beforeAll } from 'vitest';

let mod: typeof import('./api');
beforeAll(async () => {
  vi.stubGlobal('window', { location: { protocol: 'http:' } });
  mod = await import('./api');
});

describe('toAiApiError', () => {
  it('maps a server error body to code/status/message', () => {
    const err = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { status: 401, data: { error: 'The AI provider rejected the credentials', code: 'AUTH' } },
    });
    const e = mod.toAiApiError(err);
    expect(e).toBeInstanceOf(mod.AiApiError);
    expect(e.code).toBe('AUTH');
    expect(e.status).toBe(401);
    expect(e.message).toBe('The AI provider rejected the credentials');
  });

  it('413 -> a clear "too large" message, whatever the body says', () => {
    const err = Object.assign(new Error('Request failed with status code 413'), { isAxiosError: true, response: { status: 413, data: '<html>PayloadTooLargeError</html>' } });
    const e = mod.toAiApiError(err);
    expect(e.code).toBe('TOO_LARGE');
    expect(e.status).toBe(413);
    expect(e.message).toMatch(/too large to send to the model/);
    expect(e.message).not.toMatch(/PayloadTooLarge/);
  });

  it('no response → NETWORK', () => {
    const e = mod.toAiApiError(Object.assign(new Error('Network Error'), { isAxiosError: true }));
    expect(e.code).toBe('NETWORK');
  });

  it('non-axios errors → INTERNAL; AiApiError passes through', () => {
    expect(mod.toAiApiError(new Error('boom')).code).toBe('INTERNAL');
    const orig = new mod.AiApiError('x', 'TOO_LARGE', 413);
    expect(mod.toAiApiError(orig)).toBe(orig);
  });
});
