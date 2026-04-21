import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkspaceData } from '../types';

// storageDriver accesses `window.electronAPI` at call time (not at import time),
// so we can stub `window` before invoking functions.  The functions under test
// (`encryptWorkspaceSecrets`, `decryptWorkspaceSecrets`, `encryptValue`,
// `decryptValue`) do NOT touch localStorage, so no localStorage stub is needed.

// Provide a minimal `window` global so that `eAPI()` doesn't throw a
// ReferenceError when running under the Vitest node environment.
vi.stubGlobal('window', { electronAPI: undefined });

import {
  encryptWorkspaceSecrets,
  decryptWorkspaceSecrets,
  encryptValue,
  decryptValue,
} from './storageDriver';

// ─── Factories ────────────────────────────────────────────────────────────────

function makeData(overrides: Partial<WorkspaceData> = {}): WorkspaceData {
  return {
    collections: [],
    environments: [],
    activeEnvironmentId: null,
    collectionVariables: {},
    globalVariables: {},
    cookieJar: {},
    mockCollections: [],
    mockRoutes: [],
    mockPort: 3002,
    ...overrides,
  };
}

// ─── encryptValue / decryptValue — browser mode (no electronAPI) ─────────────

describe('encryptValue — browser mode', () => {
  beforeEach(() => {
    // Ensure no electronAPI is present
    (window as unknown as Record<string, unknown>).electronAPI = undefined;
  });

  it('returns the value unchanged when electronAPI is absent', async () => {
    const result = await encryptValue('my-secret');
    expect(result).toBe('my-secret');
  });

  it('returns an empty string unchanged', async () => {
    expect(await encryptValue('')).toBe('');
  });
});

describe('decryptValue — browser mode', () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).electronAPI = undefined;
  });

  it('returns the value unchanged when electronAPI is absent', async () => {
    const result = await decryptValue('some-blob');
    expect(result).toBe('some-blob');
  });
});

// ─── encryptValue / decryptValue — Electron mode ─────────────────────────────

describe('encryptValue — Electron mode', () => {
  afterEach(() => {
    (window as unknown as Record<string, unknown>).electronAPI = undefined;
  });

  it('returns the encrypted string from encryptString', async () => {
    const mockEncrypt = vi.fn().mockResolvedValue('ENC:abc123');
    (window as unknown as Record<string, unknown>).electronAPI = { encryptString: mockEncrypt };

    const result = await encryptValue('plaintext');
    expect(result).toBe('ENC:abc123');
    expect(mockEncrypt).toHaveBeenCalledWith('plaintext');
  });

  it('falls back to plaintext when encryptString returns null', async () => {
    (window as unknown as Record<string, unknown>).electronAPI = {
      encryptString: vi.fn().mockResolvedValue(null),
    };
    const result = await encryptValue('fallback');
    expect(result).toBe('fallback');
  });
});

describe('decryptValue — Electron mode', () => {
  afterEach(() => {
    (window as unknown as Record<string, unknown>).electronAPI = undefined;
  });

  it('returns the decrypted string from decryptString', async () => {
    const mockDecrypt = vi.fn().mockResolvedValue('plaintext');
    (window as unknown as Record<string, unknown>).electronAPI = { decryptString: mockDecrypt };

    const result = await decryptValue('ENC:abc123');
    expect(result).toBe('plaintext');
    expect(mockDecrypt).toHaveBeenCalledWith('ENC:abc123');
  });

  it('emits a console.warn and returns the raw blob when decryptString returns null', async () => {
    (window as unknown as Record<string, unknown>).electronAPI = {
      decryptString: vi.fn().mockResolvedValue(null),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await decryptValue('ENC:corrupted');
    expect(result).toBe('ENC:corrupted');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('decryptValue'),
    );
    warnSpy.mockRestore();
  });
});

// ─── encryptWorkspaceSecrets — browser mode (no-op) ──────────────────────────

describe('encryptWorkspaceSecrets — browser mode', () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).electronAPI = undefined;
  });

  it('returns a new object (not the same reference as the input)', async () => {
    const data = makeData();
    const result = await encryptWorkspaceSecrets(data);
    expect(result).not.toBe(data);
  });

  it('does not mutate the input object', async () => {
    const env = { _id: 'e1', name: 'Prod', values: [{ key: 'TOKEN', value: 'secret', enabled: true, secret: true }] };
    const data = makeData({ environments: [env] });
    const inputValueRef = data.environments[0].values[0];
    await encryptWorkspaceSecrets(data);
    // The original input row must not have changed
    expect(data.environments[0].values[0]).toBe(inputValueRef);
    expect(data.environments[0].values[0].value).toBe('secret');
  });

  it('passes secret values through unchanged in browser mode', async () => {
    const data = makeData({
      environments: [
        { _id: 'e1', name: 'Prod', values: [{ key: 'TOKEN', value: 'abc', enabled: true, secret: true }] },
      ],
    });
    const result = await encryptWorkspaceSecrets(data);
    expect(result.environments[0].values[0].value).toBe('abc');
  });

  it('passes non-secret values through unchanged', async () => {
    const data = makeData({
      environments: [
        { _id: 'e1', name: 'Prod', values: [{ key: 'HOST', value: 'https://api.example.com', enabled: true, secret: false }] },
      ],
    });
    const result = await encryptWorkspaceSecrets(data);
    expect(result.environments[0].values[0].value).toBe('https://api.example.com');
  });

  it('handles multiple environments correctly', async () => {
    const data = makeData({
      environments: [
        { _id: 'e1', name: 'Staging', values: [{ key: 'A', value: 'a', enabled: true, secret: true }] },
        { _id: 'e2', name: 'Prod', values: [{ key: 'B', value: 'b', enabled: true, secret: false }] },
      ],
    });
    const result = await encryptWorkspaceSecrets(data);
    expect(result.environments).toHaveLength(2);
    expect(result.environments[0].values[0].value).toBe('a');
    expect(result.environments[1].values[0].value).toBe('b');
  });

  it('handles an environment with no values', async () => {
    const data = makeData({ environments: [{ _id: 'e1', name: 'Empty', values: [] }] });
    const result = await encryptWorkspaceSecrets(data);
    expect(result.environments[0].values).toHaveLength(0);
  });

  it('handles a workspace with no environments', async () => {
    const data = makeData({ environments: [] });
    const result = await encryptWorkspaceSecrets(data);
    expect(result.environments).toHaveLength(0);
  });
});

// ─── decryptWorkspaceSecrets — browser mode (no-op) ──────────────────────────

describe('decryptWorkspaceSecrets — browser mode', () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).electronAPI = undefined;
  });

  it('returns a new object (not the same reference as the input)', async () => {
    const data = makeData();
    const result = await decryptWorkspaceSecrets(data);
    expect(result).not.toBe(data);
  });

  it('does not mutate the input object', async () => {
    const env = { _id: 'e1', name: 'Prod', values: [{ key: 'TOKEN', value: 'ENC:abc', enabled: true, secret: true }] };
    const data = makeData({ environments: [env] });
    const inputValueRef = data.environments[0].values[0];
    await decryptWorkspaceSecrets(data);
    expect(data.environments[0].values[0]).toBe(inputValueRef);
  });

  it('passes secret values through unchanged in browser mode', async () => {
    const data = makeData({
      environments: [
        { _id: 'e1', name: 'Prod', values: [{ key: 'TOKEN', value: 'ENC:xyz', enabled: true, secret: true }] },
      ],
    });
    const result = await decryptWorkspaceSecrets(data);
    expect(result.environments[0].values[0].value).toBe('ENC:xyz');
  });

  it('does not touch non-secret values', async () => {
    const data = makeData({
      environments: [
        { _id: 'e1', name: 'Prod', values: [{ key: 'HOST', value: 'https://api.example.com', enabled: true }] },
      ],
    });
    const result = await decryptWorkspaceSecrets(data);
    expect(result.environments[0].values[0].value).toBe('https://api.example.com');
  });
});

// ─── encryptWorkspaceSecrets / decryptWorkspaceSecrets — Electron mode ────────

describe('encryptWorkspaceSecrets — Electron mode', () => {
  afterEach(() => {
    (window as unknown as Record<string, unknown>).electronAPI = undefined;
  });

  it('encrypts only secret:true values using encryptString', async () => {
    const mockEncrypt = vi.fn().mockImplementation((v: string) => Promise.resolve(`ENC(${v})`));
    (window as unknown as Record<string, unknown>).electronAPI = { encryptString: mockEncrypt };

    const data = makeData({
      environments: [
        {
          _id: 'e1', name: 'Prod',
          values: [
            { key: 'SECRET_KEY', value: 'my-secret', enabled: true, secret: true },
            { key: 'PUBLIC_KEY', value: 'public-value', enabled: true, secret: false },
          ],
        },
      ],
    });

    const result = await encryptWorkspaceSecrets(data);
    expect(result.environments[0].values[0].value).toBe('ENC(my-secret)');
    expect(result.environments[0].values[1].value).toBe('public-value');
    expect(mockEncrypt).toHaveBeenCalledTimes(1);
    expect(mockEncrypt).toHaveBeenCalledWith('my-secret');
  });

  it('preserves the secret flag and other metadata on encrypted rows', async () => {
    (window as unknown as Record<string, unknown>).electronAPI = {
      encryptString: vi.fn().mockResolvedValue('ENC:result'),
    };

    const data = makeData({
      environments: [
        {
          _id: 'e1', name: 'Prod',
          values: [{ key: 'TOKEN', value: 'plaintext', enabled: false, secret: true }],
        },
      ],
    });

    const result = await encryptWorkspaceSecrets(data);
    const row = result.environments[0].values[0];
    expect(row.secret).toBe(true);
    expect(row.enabled).toBe(false);
    expect(row.key).toBe('TOKEN');
    expect(row.value).toBe('ENC:result');
  });
});

describe('decryptWorkspaceSecrets — Electron mode', () => {
  afterEach(() => {
    (window as unknown as Record<string, unknown>).electronAPI = undefined;
  });

  it('decrypts only secret:true values using decryptString', async () => {
    const mockDecrypt = vi.fn().mockImplementation((v: string) =>
      Promise.resolve(v.replace('ENC:', 'PLAIN:')),
    );
    (window as unknown as Record<string, unknown>).electronAPI = { decryptString: mockDecrypt };

    const data = makeData({
      environments: [
        {
          _id: 'e1', name: 'Prod',
          values: [
            { key: 'SECRET_KEY', value: 'ENC:abc', enabled: true, secret: true },
            { key: 'PUBLIC_KEY', value: 'public-value', enabled: true, secret: false },
          ],
        },
      ],
    });

    const result = await decryptWorkspaceSecrets(data);
    expect(result.environments[0].values[0].value).toBe('PLAIN:abc');
    expect(result.environments[0].values[1].value).toBe('public-value');
    expect(mockDecrypt).toHaveBeenCalledTimes(1);
    expect(mockDecrypt).toHaveBeenCalledWith('ENC:abc');
  });

  it('handles multiple environments each with a mix of secret and non-secret values', async () => {
    (window as unknown as Record<string, unknown>).electronAPI = {
      decryptString: vi.fn().mockImplementation((v: string) => Promise.resolve(`DEC(${v})`)),
    };

    const data = makeData({
      environments: [
        { _id: 'e1', name: 'S', values: [{ key: 'A', value: 'enc-a', enabled: true, secret: true }] },
        { _id: 'e2', name: 'P', values: [{ key: 'B', value: 'plain-b', enabled: true, secret: false }] },
      ],
    });

    const result = await decryptWorkspaceSecrets(data);
    expect(result.environments[0].values[0].value).toBe('DEC(enc-a)');
    expect(result.environments[1].values[0].value).toBe('plain-b');
  });

  it('is the inverse of encryptWorkspaceSecrets in Electron mode', async () => {
    const store: Record<string, string> = {};
    let counter = 0;
    (window as unknown as Record<string, unknown>).electronAPI = {
      encryptString: vi.fn().mockImplementation((v: string) => {
        const key = `ENC${counter++}`;
        store[key] = v;
        return Promise.resolve(key);
      }),
      decryptString: vi.fn().mockImplementation((v: string) => Promise.resolve(store[v] ?? null)),
    };

    const original = makeData({
      environments: [
        {
          _id: 'e1', name: 'Prod',
          values: [
            { key: 'API_KEY', value: 'super-secret', enabled: true, secret: true },
            { key: 'BASE_URL', value: 'https://api.example.com', enabled: true, secret: false },
          ],
        },
      ],
    });

    const encrypted = await encryptWorkspaceSecrets(original);
    const decrypted = await decryptWorkspaceSecrets(encrypted);

    expect(decrypted.environments[0].values[0].value).toBe('super-secret');
    expect(decrypted.environments[0].values[1].value).toBe('https://api.example.com');
  });
});
