import { describe, it, expect } from 'vitest';
import type { SyncProvider } from '../types';
import {
  deriveKey,
  encryptField,
  decryptField,
  buildSyncExportPackage,
  parseSyncExportPackage,
  decryptSyncExportConfig,
  isEncryptedEnvelope,
  encryptWorkspaceData,
  decryptWorkspaceData,
  computeIntegrityHash,
  verifyIntegrityHash,
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
    const config = { bucket: 'my-bucket', accessKeyId: 'AKID', secretAccessKey: 'SECRET', endpoint: '', remoteWorkspaceId: 'remote-id' };
    const pkg = await buildSyncExportPackage('My Workspace', 's3', config);
    expect(pkg.encrypted).toBe(false);
    expect(pkg.encryptedFields).toHaveLength(0);
    expect(pkg.config.accessKeyId).toBe('AKID');
    expect(pkg.config.secretAccessKey).toBe('SECRET');
    expect(pkg.salt).toBeUndefined();
  });

  it('populates required fields', async () => {
    const pkg = await buildSyncExportPackage('Prod Workspace', 's3', { bucket: 'b', remoteWorkspaceId: 'remote-123' });
    expect(pkg.apilixSyncExport).toBe('1');
    expect(pkg.remoteWorkspaceId).toBe('remote-123');
    expect(pkg.workspaceName).toBe('Prod Workspace');
    expect(pkg.provider).toBe('s3');
  });
});

describe('buildSyncExportPackage — encrypted', () => {
  it('encrypts secret fields and leaves non-secret fields plain', async () => {
    const config = { bucket: 'my-bucket', accessKeyId: 'AKID', secretAccessKey: 'SECRET', remoteWorkspaceId: 'r-id' };
    const pkg = await buildSyncExportPackage('My WS', 's3', config, 'super-secret');
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
    const config = { accessKeyId: 'AKID', bucket: 'b', remoteWorkspaceId: 'r-id' };
    const pkg = await buildSyncExportPackage('WS', 's3', config, 'pass');
    expect(pkg.encryptedFields).toContain('accessKeyId');
    expect(pkg.encryptedFields).not.toContain('secretAccessKey');
  });
});

// ─── buildSyncExportPackage + decryptSyncExportConfig round-trip ──────────────

describe('buildSyncExportPackage + decryptSyncExportConfig round-trip', () => {
  it('decrypted config equals original config', async () => {
    const config = { bucket: 'b', accessKeyId: 'AKID', secretAccessKey: 'SECRET', endpoint: 'http://localhost:9000', remoteWorkspaceId: 'r-ws-1' };
    const pkg = await buildSyncExportPackage('WS', 's3', config, 'my-pass');
    const decrypted = await decryptSyncExportConfig(pkg, 'my-pass');
    expect(decrypted.bucket).toBe(config.bucket);
    expect(decrypted.accessKeyId).toBe(config.accessKeyId);
    expect(decrypted.secretAccessKey).toBe(config.secretAccessKey);
    expect(decrypted.endpoint).toBe(config.endpoint);
  });

  it('throws "Wrong passphrase" when using incorrect passphrase', async () => {
    const config = { accessKeyId: 'AKID', secretAccessKey: 'SECRET', remoteWorkspaceId: 'r-ws-2' };
    const pkg = await buildSyncExportPackage('WS', 's3', config, 'correct-pass');
    await expect(decryptSyncExportConfig(pkg, 'wrong-pass')).rejects.toThrow('Wrong passphrase');
  });

  it('returns config unchanged when encrypted: false', async () => {
    const config = { bucket: 'b', accessKeyId: 'AKID', remoteWorkspaceId: 'r-ws-3' };
    const pkg = await buildSyncExportPackage('WS', 's3', config);
    const result = await decryptSyncExportConfig(pkg, 'irrelevant');
    expect(result).toEqual(config);
  });
});

// ─── parseSyncExportPackage ────────────────────────────────────────────────────

describe('parseSyncExportPackage', () => {
  const valid = {
    apilixSyncExport: '1',
    remoteWorkspaceId: 'rws-abc',
    workspaceName: 'My WS',
    provider: 's3',
    config: { bucket: 'b' },
    encrypted: false,
    encryptedFields: [],
  };

  it('returns the package for a valid input', () => {
    const pkg = parseSyncExportPackage(valid);
    expect(pkg.remoteWorkspaceId).toBe('rws-abc');
    expect(pkg.workspaceName).toBe('My WS');
    expect(pkg.provider).toBe('s3');
    expect(pkg.encrypted).toBe(false);
  });

  it('throws on wrong sentinel', () => {
    expect(() => parseSyncExportPackage({ ...valid, apilixSyncExport: '2' })).toThrow('Invalid sync export file');
  });

  it('throws on missing remoteWorkspaceId', () => {
    const { remoteWorkspaceId: _, ...rest } = valid;
    expect(() => parseSyncExportPackage(rest)).toThrow('remoteWorkspaceId');
  });

  it('accepts legacy files that have workspaceId instead of remoteWorkspaceId', () => {
    const legacy = { ...valid, workspaceId: 'old-ws-id' };
    const { remoteWorkspaceId: _, ...withoutRemote } = legacy;
    const pkg = parseSyncExportPackage(withoutRemote);
    expect(pkg.remoteWorkspaceId).toBe('old-ws-id');
  });

  it('injects remoteWorkspaceId into returned config', () => {
    const pkg = parseSyncExportPackage(valid);
    expect(pkg.config.remoteWorkspaceId).toBe('rws-abc');
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
    // remoteWorkspaceId must be injected into config
    expect(parsed.config.remoteWorkspaceId).toBe('rws-abc');
  });

  it('does not check salt or encryptedFields length when encrypted=false', () => {
    // These checks only apply to encrypted packages; unencrypted packages with
    // an empty encryptedFields array are fine.
    expect(() => parseSyncExportPackage(valid)).not.toThrow();
  });
});

// ─── isEncryptedEnvelope ─────────────────────────────────────────────────────

describe('isEncryptedEnvelope', () => {
  it('returns true for a valid envelope object', () => {
    const envelope = { _apilixEncrypted: true, ciphertext: btoa('ctext'), salt: btoa('salt') };
    expect(isEncryptedEnvelope(envelope)).toBe(true);
  });

  it('returns false when _apilixEncrypted is not true', () => {
    expect(isEncryptedEnvelope({ _apilixEncrypted: false, ciphertext: 'a', salt: 'b' })).toBe(false);
    expect(isEncryptedEnvelope({ ciphertext: 'a', salt: 'b' })).toBe(false);
    expect(isEncryptedEnvelope(null)).toBe(false);
    expect(isEncryptedEnvelope(42)).toBe(false);
    expect(isEncryptedEnvelope('string')).toBe(false);
    expect(isEncryptedEnvelope({})).toBe(false);
  });

  it('returns false when ciphertext or salt are missing (malformed envelope)', () => {
    expect(isEncryptedEnvelope({ _apilixEncrypted: true })).toBe(false);
    expect(isEncryptedEnvelope({ _apilixEncrypted: true, ciphertext: 'abc' })).toBe(false);
    expect(isEncryptedEnvelope({ _apilixEncrypted: true, salt: 'xyz' })).toBe(false);
    expect(isEncryptedEnvelope({ _apilixEncrypted: true, ciphertext: 42, salt: 'xyz' })).toBe(false);
  });
});

// ─── encryptWorkspaceData / decryptWorkspaceData ──────────────────────────────

describe('encryptWorkspaceData / decryptWorkspaceData round-trip', () => {
  const sampleData = {
    collections: [],
    environments: [],
    activeEnvironmentId: null,
    collectionVariables: {},
    globalVariables: {},
    cookieJar: {},
    mockCollections: [],
    mockRoutes: [],
    mockPort: 3002,
  };

  it('round-trips workspace data', async () => {
    const envelope = await encryptWorkspaceData(sampleData, 'my-passphrase');
    expect(isEncryptedEnvelope(envelope)).toBe(true);
    const decrypted = await decryptWorkspaceData(envelope, 'my-passphrase');
    expect(decrypted).toEqual(sampleData);
  });

  it('produces different ciphertext each call (random salt)', async () => {
    const a = await encryptWorkspaceData(sampleData, 'pass');
    const b = await encryptWorkspaceData(sampleData, 'pass');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.salt).not.toBe(b.salt);
  });

  it('throws on wrong passphrase', async () => {
    const envelope = await encryptWorkspaceData(sampleData, 'correct');
    await expect(decryptWorkspaceData(envelope, 'wrong')).rejects.toThrow();
  });
});

// ─── computeIntegrityHash / verifyIntegrityHash ───────────────────────────────

describe('computeIntegrityHash / verifyIntegrityHash', () => {
  const policy = { forceReadOnly: true, sharingEnabled: true };
  const remoteId = 'remote-ws-abc';
  const passphrase = 'shared-passphrase';

  it('verifies correctly with the same inputs', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await computeIntegrityHash(policy, remoteId, passphrase, salt);
    expect(typeof hash).toBe('string');
    const saltB64 = btoa(String.fromCharCode(...salt));
    const valid = await verifyIntegrityHash(policy, remoteId, passphrase, saltB64, hash);
    expect(valid).toBe(true);
  });

  it('returns false for a tampered sharePolicy', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await computeIntegrityHash(policy, remoteId, passphrase, salt);
    const saltB64 = btoa(String.fromCharCode(...salt));
    const tampered = { ...policy, forceReadOnly: false };
    const valid = await verifyIntegrityHash(tampered, remoteId, passphrase, saltB64, hash);
    expect(valid).toBe(false);
  });

  it('returns false for a tampered remoteWorkspaceId', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await computeIntegrityHash(policy, remoteId, passphrase, salt);
    const saltB64 = btoa(String.fromCharCode(...salt));
    const valid = await verifyIntegrityHash(policy, 'different-id', passphrase, saltB64, hash);
    expect(valid).toBe(false);
  });

  it('returns false for wrong passphrase', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await computeIntegrityHash(policy, remoteId, passphrase, salt);
    const saltB64 = btoa(String.fromCharCode(...salt));
    const valid = await verifyIntegrityHash(policy, remoteId, 'wrong-passphrase', saltB64, hash);
    expect(valid).toBe(false);
  });
});

// ─── buildSyncExportPackage — with sharePolicy and remotePassphrase ────────────

describe('buildSyncExportPackage — sharing options', () => {
  const config = { bucket: 'b', accessKeyId: 'AKID', secretAccessKey: 'SECRET', remoteWorkspaceId: 'r-id' };
  const passphrase = 'share-pass';
  const sharePolicy = { forceReadOnly: true, sharingEnabled: true };

  it('embeds sharePolicy in returned package', async () => {
    const pkg = await buildSyncExportPackage('WS', 's3', config, passphrase, { sharePolicy });
    expect(pkg.sharePolicy).toEqual(sharePolicy);
  });

  it('includes integrityHash when sharePolicy and passphrase are present', async () => {
    const pkg = await buildSyncExportPackage('WS', 's3', config, passphrase, { sharePolicy });
    expect(pkg.integrityHash).toBeDefined();
    expect(typeof pkg.integrityHash).toBe('string');
  });

  it('integrityHash verifies successfully after round-trip', async () => {
    const pkg = await buildSyncExportPackage('WS', 's3', config, passphrase, { sharePolicy });
    expect(pkg.salt).toBeDefined();
    const valid = await verifyIntegrityHash(
      pkg.sharePolicy!,
      pkg.remoteWorkspaceId,
      passphrase,
      pkg.salt!,
      pkg.integrityHash!,
    );
    expect(valid).toBe(true);
  });

  it('embeds remotePassphrase into encrypted config when provided', async () => {
    const pkg = await buildSyncExportPackage('WS', 's3', config, passphrase, { remotePassphrase: 'enc-pass' });
    expect(pkg.encrypted).toBe(true);
    expect(pkg.encryptedFields).toContain('_remotePassphrase');
    expect(pkg.remoteEncryption).toEqual({ enabled: true });

    // Decrypt and confirm the passphrase is recoverable
    const decrypted = await decryptSyncExportConfig(pkg, passphrase);
    expect(decrypted._remotePassphrase).toBe('enc-pass');
  });

  it('does not include integrityHash when no passphrase is provided', async () => {
    const pkg = await buildSyncExportPackage('WS', 's3', config, undefined, { sharePolicy });
    expect(pkg.integrityHash).toBeUndefined();
  });

  it('never includes _remotePassphrase in plaintext when export is unencrypted', async () => {
    // No passphrase → unencrypted path; _remotePassphrase must be stripped
    const pkg = await buildSyncExportPackage('WS', 's3', config, undefined, { remotePassphrase: 'secret' });
    expect(pkg.encrypted).toBe(false);
    expect('_remotePassphrase' in pkg.config).toBe(false);
  });

  it('never includes _remotePassphrase in plaintext when no secrets match', async () => {
    // Provider with no secret fields matching → also falls through to unencrypted
    const minimalConfig = { remoteWorkspaceId: 'rid' };
    const pkg = await buildSyncExportPackage('WS', 'http' as SyncProvider, minimalConfig, 'pass', { remotePassphrase: 'secret' });
    // _remotePassphrase is in SECRET_FIELDS for http, so it will be encrypted;
    // but if config has no other fields and _remotePassphrase is the only secret,
    // it should still be encrypted (not leak). Confirm config does not have it plaintext.
    if (!pkg.encrypted) {
      expect('_remotePassphrase' in pkg.config).toBe(false);
    } else {
      // encrypted path — value must not equal plaintext 'secret'
      expect(pkg.config['_remotePassphrase']).not.toBe('secret');
    }
  });
});

// ─── parseSyncExportPackage — new optional fields ────────────────────────────

describe('parseSyncExportPackage — new optional fields', () => {
  const base = {
    apilixSyncExport: '1',
    remoteWorkspaceId: 'rws-new',
    workspaceName: 'New WS',
    provider: 's3',
    config: { bucket: 'b' },
    encrypted: false,
    encryptedFields: [],
  };

  it('parses sharePolicy when present', () => {
    const pkg = parseSyncExportPackage({ ...base, sharePolicy: { forceReadOnly: true, sharingEnabled: false } });
    expect(pkg.sharePolicy).toEqual({ forceReadOnly: true, sharingEnabled: false });
  });

  it('leaves sharePolicy undefined when absent', () => {
    const pkg = parseSyncExportPackage(base);
    expect(pkg.sharePolicy).toBeUndefined();
  });

  it('ignores malformed sharePolicy', () => {
    const pkg = parseSyncExportPackage({ ...base, sharePolicy: { forceReadOnly: 'yes', sharingEnabled: 1 } });
    expect(pkg.sharePolicy).toBeUndefined();
  });

  it('parses remoteEncryption when present', () => {
    const pkg = parseSyncExportPackage({ ...base, remoteEncryption: { enabled: true } });
    expect(pkg.remoteEncryption).toEqual({ enabled: true });
  });

  it('parses integrityHash when present', () => {
    const pkg = parseSyncExportPackage({ ...base, integrityHash: 'abc123' });
    expect(pkg.integrityHash).toBe('abc123');
  });
});
