import { describe, it, expect } from 'vitest';
import {
  deriveKey,
  encryptField,
  decryptField,
  buildSyncExportPackage,
  parseSyncExportPackage,
  decryptSyncExportConfig,
} from './syncExportUtils';

// ─── deriveKey ────────────────────────────────────────────────────────────────

describe('deriveKey', () => {
  it('returns a CryptoKey without throwing', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey('my-passphrase', salt);
    expect(key).toBeDefined();
    expect(key.type).toBe('secret');
    expect(key.algorithm.name).toBe('AES-GCM');
  });
});

// ─── encryptField / decryptField ─────────────────────────────────────────────

describe('encryptField / decryptField', () => {
  it('round-trips a plaintext value', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey('test-pass', salt);
    const original = 'AKIAIOSFODNN7EXAMPLE';
    const encrypted = await encryptField(original, key);
    expect(encrypted).not.toBe(original);
    const decrypted = await decryptField(encrypted, key);
    expect(decrypted).toBe(original);
  });

  it('produces a different ciphertext each call (random IV)', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey('test-pass', salt);
    const a = await encryptField('hello', key);
    const b = await encryptField('hello', key);
    expect(a).not.toBe(b);
  });

  it('throws "Wrong passphrase" when decrypting with a different key', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const rightKey = await deriveKey('correct', salt);
    const wrongKey = await deriveKey('wrong', salt);
    const encrypted = await encryptField('secret-value', rightKey);
    await expect(decryptField(encrypted, wrongKey)).rejects.toThrow('Wrong passphrase');
  });

  it('throws on corrupt base64 input', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey('pass', salt);
    await expect(decryptField('!!!not-base64!!!', key)).rejects.toThrow();
  });
});

// ─── buildSyncExportPackage ───────────────────────────────────────────────────

describe('buildSyncExportPackage — unencrypted', () => {
  it('returns encrypted: false with no encryptedFields', async () => {
    const config = { bucket: 'my-bucket', accessKeyId: 'AKID', secretAccessKey: 'SECRET', endpoint: '' };
    const pkg = await buildSyncExportPackage('ws-id', 'My Workspace', 's3', config);
    expect(pkg.encrypted).toBe(false);
    expect(pkg.encryptedFields).toHaveLength(0);
    expect(pkg.config.accessKeyId).toBe('AKID');
    expect(pkg.config.secretAccessKey).toBe('SECRET');
    expect(pkg.salt).toBeUndefined();
  });

  it('populates required fields', async () => {
    const pkg = await buildSyncExportPackage('ws-123', 'Prod Workspace', 's3', { bucket: 'b' });
    expect(pkg.apilixSyncExport).toBe('1');
    expect(pkg.workspaceId).toBe('ws-123');
    expect(pkg.workspaceName).toBe('Prod Workspace');
    expect(pkg.provider).toBe('s3');
  });
});

describe('buildSyncExportPackage — encrypted', () => {
  it('encrypts secret fields and leaves non-secret fields plain', async () => {
    const config = { bucket: 'my-bucket', accessKeyId: 'AKID', secretAccessKey: 'SECRET' };
    const pkg = await buildSyncExportPackage('ws-id', 'My WS', 's3', config, 'super-secret');
    expect(pkg.encrypted).toBe(true);
    expect(pkg.encryptedFields).toContain('accessKeyId');
    expect(pkg.encryptedFields).toContain('secretAccessKey');
    expect(pkg.config.accessKeyId).not.toBe('AKID');
    expect(pkg.config.secretAccessKey).not.toBe('SECRET');
    // Non-secret field must remain plaintext
    expect(pkg.config.bucket).toBe('my-bucket');
    expect(pkg.salt).toBeDefined();
  });

  it('only lists fields that are present in config', async () => {
    // accessKeyId present, secretAccessKey absent
    const config = { accessKeyId: 'AKID', bucket: 'b' };
    const pkg = await buildSyncExportPackage('ws-id', 'WS', 's3', config, 'pass');
    expect(pkg.encryptedFields).toContain('accessKeyId');
    expect(pkg.encryptedFields).not.toContain('secretAccessKey');
  });
});

// ─── buildSyncExportPackage + decryptSyncExportConfig round-trip ──────────────

describe('buildSyncExportPackage + decryptSyncExportConfig round-trip', () => {
  it('decrypted config equals original config', async () => {
    const config = { bucket: 'b', accessKeyId: 'AKID', secretAccessKey: 'SECRET', endpoint: 'http://localhost:9000' };
    const pkg = await buildSyncExportPackage('ws-id', 'WS', 's3', config, 'my-pass');
    const decrypted = await decryptSyncExportConfig(pkg, 'my-pass');
    expect(decrypted.bucket).toBe(config.bucket);
    expect(decrypted.accessKeyId).toBe(config.accessKeyId);
    expect(decrypted.secretAccessKey).toBe(config.secretAccessKey);
    expect(decrypted.endpoint).toBe(config.endpoint);
  });

  it('throws "Wrong passphrase" when using incorrect passphrase', async () => {
    const config = { accessKeyId: 'AKID', secretAccessKey: 'SECRET' };
    const pkg = await buildSyncExportPackage('ws-id', 'WS', 's3', config, 'correct-pass');
    await expect(decryptSyncExportConfig(pkg, 'wrong-pass')).rejects.toThrow('Wrong passphrase');
  });

  it('returns config unchanged when encrypted: false', async () => {
    const config = { bucket: 'b', accessKeyId: 'AKID' };
    const pkg = await buildSyncExportPackage('ws-id', 'WS', 's3', config);
    const result = await decryptSyncExportConfig(pkg, 'irrelevant');
    expect(result).toEqual(config);
  });
});

// ─── parseSyncExportPackage ────────────────────────────────────────────────────

describe('parseSyncExportPackage', () => {
  const valid = {
    apilixSyncExport: '1',
    workspaceId: 'ws-abc',
    workspaceName: 'My WS',
    provider: 's3',
    config: { bucket: 'b' },
    encrypted: false,
    encryptedFields: [],
  };

  it('returns the package unchanged for a valid input', () => {
    const pkg = parseSyncExportPackage(valid);
    expect(pkg.workspaceId).toBe('ws-abc');
    expect(pkg.workspaceName).toBe('My WS');
    expect(pkg.provider).toBe('s3');
    expect(pkg.encrypted).toBe(false);
  });

  it('throws on wrong sentinel', () => {
    expect(() => parseSyncExportPackage({ ...valid, apilixSyncExport: '2' })).toThrow('Invalid sync export file');
  });

  it('throws on missing workspaceId', () => {
    const { workspaceId: _, ...rest } = valid;
    expect(() => parseSyncExportPackage(rest)).toThrow('workspaceId');
  });

  it('throws on missing workspaceName', () => {
    const { workspaceName: _, ...rest } = valid;
    expect(() => parseSyncExportPackage(rest)).toThrow('workspaceName');
  });

  it('throws on missing provider', () => {
    const { provider: _, ...rest } = valid;
    expect(() => parseSyncExportPackage(rest)).toThrow('provider');
  });

  it('throws on an unknown provider string', () => {
    expect(() => parseSyncExportPackage({ ...valid, provider: 'ftp' })).toThrow('unknown provider');
    expect(() => parseSyncExportPackage({ ...valid, provider: 'ftp' })).toThrow('ftp');
  });

  it('error message for unknown provider lists the allowed values', () => {
    let msg = '';
    try { parseSyncExportPackage({ ...valid, provider: 'ftp' }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/s3/);
    expect(msg).toMatch(/git/);
    expect(msg).toMatch(/http/);
    expect(msg).toMatch(/team/);
    expect(msg).toMatch(/minio/);
  });

  it('accepts all known providers', () => {
    for (const provider of ['s3', 'minio', 'git', 'http', 'team'] as const) {
      expect(() => parseSyncExportPackage({ ...valid, provider })).not.toThrow();
    }
  });

  it('throws on non-object input', () => {
    expect(() => parseSyncExportPackage('not an object')).toThrow('Invalid sync export file');
    expect(() => parseSyncExportPackage(null)).toThrow('Invalid sync export file');
    expect(() => parseSyncExportPackage([1, 2])).toThrow('Invalid sync export file');
  });

  it('throws when encrypted flag is missing', () => {
    const { encrypted: _, ...rest } = valid;
    expect(() => parseSyncExportPackage(rest)).toThrow('encrypted');
  });

  it('throws when encryptedFields is missing', () => {
    const { encryptedFields: _, ...rest } = valid;
    expect(() => parseSyncExportPackage(rest)).toThrow('encryptedFields');
  });

  // ── Encrypted invariant checks ────────────────────────────────────────────

  it('throws when encrypted=true and salt is absent', () => {
    const pkg = {
      ...valid,
      config: { accessKeyId: 'ENC' },
      encrypted: true,
      encryptedFields: ['accessKeyId'],
      // salt intentionally omitted
    };
    expect(() => parseSyncExportPackage(pkg)).toThrow('missing salt');
  });

  it('throws when encrypted=true and salt is an empty string', () => {
    const pkg = {
      ...valid,
      config: { accessKeyId: 'ENC' },
      encrypted: true,
      encryptedFields: ['accessKeyId'],
      salt: '',
    };
    expect(() => parseSyncExportPackage(pkg)).toThrow('missing salt');
  });

  it('throws when encrypted=true and encryptedFields is empty', () => {
    const pkg = {
      ...valid,
      config: { accessKeyId: 'ENC' },
      encrypted: true,
      encryptedFields: [],
      salt: btoa('some-salt-bytes'),
    };
    expect(() => parseSyncExportPackage(pkg)).toThrow('at least one encryptedField');
  });

  it('throws when encryptedFields references a key absent from config', () => {
    const pkg = {
      ...valid,
      config: { accessKeyId: 'ENC' },
      encrypted: true,
      encryptedFields: ['accessKeyId', 'secretAccessKey'],
      salt: btoa('some-salt-bytes'),
    };
    expect(() => parseSyncExportPackage(pkg)).toThrow('secretAccessKey');
  });

  it('accepts a valid encrypted package when all invariants are satisfied', () => {
    const pkg = {
      ...valid,
      config: { accessKeyId: 'ENC_AK', secretAccessKey: 'ENC_SK', bucket: 'my-bucket' },
      encrypted: true,
      encryptedFields: ['accessKeyId', 'secretAccessKey'],
      salt: btoa('sixteen-byte-sal'),
    };
    const parsed = parseSyncExportPackage(pkg);
    expect(parsed.encrypted).toBe(true);
    expect(parsed.salt).toBe(btoa('sixteen-byte-sal'));
    expect(parsed.encryptedFields).toEqual(['accessKeyId', 'secretAccessKey']);
  });

  it('does not check salt or encryptedFields length when encrypted=false', () => {
    // These checks only apply to encrypted packages; unencrypted packages with
    // an empty encryptedFields array are fine.
    expect(() => parseSyncExportPackage(valid)).not.toThrow();
  });
});
