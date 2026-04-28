/**
 * syncExportUtils — cryptographic helpers for sync config sharing and remote data encryption.
 *
 * Responsibilities:
 *  1. **Sync config export/import** — build and parse portable `.json` packages that let a
 *     user share provider credentials (S3, Git, HTTP, Team) with a teammate. Secret fields are
 *     optionally encrypted with AES-256-GCM + PBKDF2 (200 000 iterations, SHA-256).
 *
 *  2. **Sharing policies** — a `SyncSharePolicy` can be embedded in an encrypted export.
 *     Its integrity is protected by HMAC-SHA-256 (domain-separated key, `crypto.subtle.verify`
 *     for constant-time comparison) so tampering is detectable on import.
 *
 *  3. **Remote workspace data encryption** — `encryptWorkspaceData` / `decryptWorkspaceData`
 *     wrap an entire `WorkspaceData` object in an `EncryptedDataEnvelope` (AES-256-GCM).
 *     `syncEngine` calls these transparently on every push / pull when `encryptRemote` is set.
 *
 * All cryptographic operations use the Web Crypto API (`crypto.subtle`) and are available in
 * both Electron renderer and browser contexts.
 */

import type { SyncExportPackage, SyncProvider, SyncSharePolicy, WorkspaceData, EncryptedDataEnvelope } from '../types';

// ─── Constants ────────────────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 200_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/** Fields that are treated as secrets per provider and will be encrypted. */
const SECRET_FIELDS: Partial<Record<SyncProvider, string[]>> = {
  s3: ['accessKeyId', 'secretAccessKey', '_remotePassphrase'],
  minio: ['accessKeyId', 'secretAccessKey', '_remotePassphrase'],
  git: ['token', '_remotePassphrase'],
  http: ['token', '_remotePassphrase'],
  team: ['token', '_remotePassphrase'],
};

// ─── Web Crypto helpers ────────────────────────────────────────────────────────

/** Derive a 256-bit AES-GCM key from a passphrase + salt using PBKDF2. */
export async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' } as Pbkdf2Params,
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt a UTF-8 string. Returns base64([iv (12 bytes) || ciphertext]). */
export async function encryptField(value: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(value));
  const combined = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), IV_BYTES);
  // Avoid spreading large Uint8Array into variadic String.fromCharCode
  let binary = '';
  for (let i = 0; i < combined.length; i++) binary += String.fromCharCode(combined[i]);
  return btoa(binary);
}

/** Decrypt a value produced by encryptField. Throws a descriptive error on wrong passphrase. */
export async function decryptField(encoded: string, key: CryptoKey): Promise<string> {
  let combined: Uint8Array;
  try {
    combined = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  } catch {
    throw new Error('Encrypted field is corrupt (invalid base64)');
  }
  if (combined.length <= IV_BYTES) {
    throw new Error('Encrypted field is too short to be valid');
  }
  const iv = combined.slice(0, IV_BYTES);
  const ciphertext = combined.slice(IV_BYTES);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'OperationError') {
      throw new Error('Wrong passphrase — decryption failed');
    }
    throw err;
  }
  return new TextDecoder().decode(plaintext);
}

// ─── Remote workspace data encryption ─────────────────────────────────────────

/**
 * Type-guard to detect an encrypted-data envelope stored on a remote provider.
 * Used in syncEngine to decide whether to decrypt after pull.
 */
export function isEncryptedEnvelope(data: unknown): data is EncryptedDataEnvelope {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return (
    obj._apilixEncrypted === true &&
    typeof obj.ciphertext === 'string' &&
    typeof obj.salt === 'string'
  );
}

/**
 * Encrypt a WorkspaceData object with a passphrase. The resulting
 * EncryptedDataEnvelope is stored on the remote provider instead of the
 * raw JSON so the data is protected at rest.
 */
export async function encryptWorkspaceData(
  data: WorkspaceData,
  passphrase: string,
): Promise<EncryptedDataEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = await encryptField(JSON.stringify(data), key);
  return {
    _apilixEncrypted: true,
    ciphertext,
    salt: btoa(String.fromCharCode(...salt)),
  };
}

/**
 * Decrypt an EncryptedDataEnvelope back to WorkspaceData.
 * Throws "Wrong passphrase" if the passphrase is incorrect.
 */
export async function decryptWorkspaceData(
  envelope: EncryptedDataEnvelope,
  passphrase: string,
): Promise<WorkspaceData> {
  const salt = Uint8Array.from(atob(envelope.salt), c => c.charCodeAt(0));
  const key = await deriveKey(passphrase, salt);
  const plaintext = await decryptField(envelope.ciphertext, key);
  return JSON.parse(plaintext) as WorkspaceData;
}

// ─── Integrity hash (for export sharePolicy tamper-detection) ─────────────────

/**
 * Derive an HMAC-SHA-256 CryptoKey from a passphrase + salt using PBKDF2.
 *
 * Uses a domain-separated passphrase ("apilix-hmac:<passphrase>") so the
 * derived key material is provably distinct from the AES-GCM key derived by
 * deriveKey() even when the same passphrase and salt are supplied.
 */
async function deriveHmacKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  // Domain-separation: prefix differs from the bare passphrase used by deriveKey()
  const domainPassphrase = 'apilix-hmac:' + passphrase;
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(domainPassphrase), 'PBKDF2', false, ['deriveBits']);
  const rawBytes = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' } as Pbkdf2Params,
    keyMaterial,
    256,
  );
  return crypto.subtle.importKey(
    'raw',
    rawBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Compute an HMAC-SHA-256 over JSON.stringify({sharePolicy, remoteWorkspaceId})
 * using a key derived from the export passphrase + salt.
 * Returns the MAC as a base64 string.
 */
export async function computeIntegrityHash(
  sharePolicy: SyncSharePolicy,
  remoteWorkspaceId: string,
  passphrase: string,
  salt: Uint8Array,
): Promise<string> {
  const hmacKey = await deriveHmacKey(passphrase, salt);
  const payload = new TextEncoder().encode(JSON.stringify({ sharePolicy, remoteWorkspaceId }));
  const mac = await crypto.subtle.sign('HMAC', hmacKey, payload);
  let binary = '';
  const bytes = new Uint8Array(mac);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Verify an HMAC-SHA-256 integrity hash previously computed by computeIntegrityHash.
 * Uses crypto.subtle.verify for constant-time comparison — avoids timing side-channels.
 * Returns false if the passphrase is wrong or the data has been tampered with.
 */
export async function verifyIntegrityHash(
  sharePolicy: SyncSharePolicy,
  remoteWorkspaceId: string,
  passphrase: string,
  saltBase64: string,
  expectedHash: string,
): Promise<boolean> {
  try {
    const salt = Uint8Array.from(atob(saltBase64), c => c.charCodeAt(0));
    const hmacKey = await deriveHmacKey(passphrase, salt);
    const payload = new TextEncoder().encode(JSON.stringify({ sharePolicy, remoteWorkspaceId }));
    const expectedBytes = Uint8Array.from(atob(expectedHash), c => c.charCodeAt(0));
    return await crypto.subtle.verify('HMAC', hmacKey, expectedBytes, payload);
  } catch {
    return false;
  }
}

// ─── Package builder ──────────────────────────────────────────────────────────

/**
 * Build a portable sync export package.
 *
 * @param workspaceName Human-readable name embedded in the file.
 * @param provider      Sync provider (e.g. 's3').
 * @param config        Provider config fields (may contain secrets). Must include
 *                      `remoteWorkspaceId` for S3/MinIO so teammates resolve the
 *                      same object key without needing the local workspace ID.
 * @param passphrase    When provided, encrypts all secret fields for this provider.
 * @param options       Optional sharing policy and remote passphrase embedding.
 */
export async function buildSyncExportPackage(
  workspaceName: string,
  provider: SyncProvider,
  config: Record<string, string>,
  passphrase?: string,
  options?: {
    sharePolicy?: SyncSharePolicy;
    remotePassphrase?: string;
  },
): Promise<SyncExportPackage> {
  const secretKeys = SECRET_FIELDS[provider] ?? [];

  // Embed remote passphrase into config so it gets encrypted with the other secrets
  const workingConfig: Record<string, string> = { ...config };
  if (options?.remotePassphrase) {
    workingConfig['_remotePassphrase'] = options.remotePassphrase;
  }

  if (passphrase && passphrase.length > 0 && secretKeys.length > 0) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const key = await deriveKey(passphrase, salt);
    const encryptedConfig: Record<string, string> = { ...workingConfig };
    const encryptedFields: string[] = [];
    for (const k of secretKeys) {
      if (encryptedConfig[k]) {
        encryptedConfig[k] = await encryptField(encryptedConfig[k], key);
        encryptedFields.push(k);
      }
    }
    if (encryptedFields.length > 0) {
      const saltBase64 = btoa(String.fromCharCode(...salt));
      let integrityHash: string | undefined;
      if (options?.sharePolicy) {
        integrityHash = await computeIntegrityHash(
          options.sharePolicy,
          workingConfig.remoteWorkspaceId ?? '',
          passphrase,
          salt,
        );
      }
      return {
        apilixSyncExport: '1',
        remoteWorkspaceId: workingConfig.remoteWorkspaceId ?? '',
        workspaceName,
        provider,
        config: encryptedConfig,
        encrypted: true,
        encryptedFields,
        salt: saltBase64,
        ...(options?.remotePassphrase ? { remoteEncryption: { enabled: true } } : {}),
        ...(options?.sharePolicy ? { sharePolicy: options.sharePolicy } : {}),
        ...(integrityHash ? { integrityHash } : {}),
      };
    }
  }

  // Unencrypted path: _remotePassphrase must never appear in cleartext output.
  // Drop it from config regardless of whether the caller supplied it — the UI
  // warns, but the builder enforces the invariant unconditionally.
  const safeConfig = { ...workingConfig };
  delete safeConfig['_remotePassphrase'];

  return {
    apilixSyncExport: '1',
    remoteWorkspaceId: workingConfig.remoteWorkspaceId ?? '',
    workspaceName,
    provider,
    config: safeConfig,
    encrypted: false,
    encryptedFields: [],
    ...(options?.remotePassphrase ? { remoteEncryption: { enabled: true } } : {}),
    ...(options?.sharePolicy ? { sharePolicy: options.sharePolicy } : {}),
  };
}

// ─── Package parser ────────────────────────────────────────────────────────────

const KNOWN_PROVIDERS = new Set<SyncProvider>(['s3', 'minio', 'git', 'http', 'team']);

/** Parse and validate an unknown value as a SyncExportPackage. Throws on invalid input. */
export function parseSyncExportPackage(raw: unknown): SyncExportPackage {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid sync export file — expected a JSON object');
  }
  let obj = raw as Record<string, unknown>;

  if (obj.apilixSyncExport !== '1') {
    throw new Error('Invalid sync export file — missing or unsupported format marker');
  }
  // Backward compat: files exported before remoteWorkspaceId was introduced used workspaceId
  if (!obj.remoteWorkspaceId && typeof obj.workspaceId === 'string') {
    obj = { ...obj, remoteWorkspaceId: obj.workspaceId };
  }
  if (typeof obj.remoteWorkspaceId !== 'string' || !obj.remoteWorkspaceId) {
    throw new Error('Invalid sync export file — missing remoteWorkspaceId');
  }
  if (typeof obj.workspaceName !== 'string' || !obj.workspaceName) {
    throw new Error('Invalid sync export file — missing workspaceName');
  }
  if (typeof obj.provider !== 'string' || !obj.provider) {
    throw new Error('Invalid sync export file — missing provider');
  }
  if (!KNOWN_PROVIDERS.has(obj.provider as SyncProvider)) {
    throw new Error(`Invalid sync export file — unknown provider "${obj.provider}". Expected one of: ${[...KNOWN_PROVIDERS].join(', ')}`);
  }
  if (!obj.config || typeof obj.config !== 'object' || Array.isArray(obj.config)) {
    throw new Error('Invalid sync export file — missing or invalid config');
  }
  // Validate all config values are strings and block prototype-poisoning keys
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const rawConfig = obj.config as Record<string, unknown>;
  const safeConfig: Record<string, string> = Object.create(null);
  for (const k of Object.keys(rawConfig)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    if (typeof rawConfig[k] !== 'string') {
      throw new Error(`Invalid sync export file — config["${k}"] must be a string`);
    }
    safeConfig[k] = rawConfig[k] as string;
  }
  if (typeof obj.encrypted !== 'boolean') {
    throw new Error('Invalid sync export file — missing encrypted flag');
  }
  if (!Array.isArray(obj.encryptedFields)) {
    throw new Error('Invalid sync export file — missing encryptedFields');
  }
  if (!(obj.encryptedFields as unknown[]).every(f => typeof f === 'string')) {
    throw new Error('Invalid sync export file — encryptedFields must be an array of strings');
  }

  // Invariant: an encrypted package must carry a non-empty salt so decryption
  // can succeed. Catching this at parse time avoids a confusing late failure
  // inside decryptSyncExportConfig.
  if (obj.encrypted === true) {
    if (typeof obj.salt !== 'string' || obj.salt.length === 0) {
      throw new Error('Invalid sync export file — encrypted package is missing salt');
    }
    if ((obj.encryptedFields as string[]).length === 0) {
      throw new Error('Invalid sync export file — encrypted package must list at least one encryptedField');
    }
    const unknownFields = (obj.encryptedFields as string[]).filter(
      k => !Object.prototype.hasOwnProperty.call(safeConfig, k),
    );
    if (unknownFields.length > 0) {
      throw new Error(`Invalid sync export file — encryptedFields references keys not present in config: ${unknownFields.join(', ')}`);
    }
  }

  return {
    apilixSyncExport: '1',
    remoteWorkspaceId: obj.remoteWorkspaceId as string,
    workspaceName: obj.workspaceName as string,
    provider: obj.provider as SyncProvider,
    config: { ...safeConfig, remoteWorkspaceId: obj.remoteWorkspaceId as string },
    encrypted: obj.encrypted as boolean,
    encryptedFields: obj.encryptedFields as string[],
    salt: typeof obj.salt === 'string' ? obj.salt : undefined,
    remoteEncryption: (obj.remoteEncryption && typeof obj.remoteEncryption === 'object' && typeof (obj.remoteEncryption as Record<string, unknown>).enabled === 'boolean')
      ? { enabled: (obj.remoteEncryption as Record<string, unknown>).enabled as boolean }
      : undefined,
    sharePolicy: (obj.sharePolicy && typeof obj.sharePolicy === 'object' && typeof (obj.sharePolicy as Record<string, unknown>).forceReadOnly === 'boolean' && typeof (obj.sharePolicy as Record<string, unknown>).sharingEnabled === 'boolean')
      ? { forceReadOnly: (obj.sharePolicy as Record<string, unknown>).forceReadOnly as boolean, sharingEnabled: (obj.sharePolicy as Record<string, unknown>).sharingEnabled as boolean }
      : undefined,
    integrityHash: typeof obj.integrityHash === 'string' ? obj.integrityHash : undefined,
  };
}

// ─── Decryption ────────────────────────────────────────────────────────────────

/**
 * Decrypt all encrypted fields in an export package config.
 * Returns a new config object with plaintext values.
 * Throws if passphrase is wrong or salt is missing.
 */
export async function decryptSyncExportConfig(
  pkg: SyncExportPackage,
  passphrase: string,
): Promise<Record<string, string>> {
  if (!pkg.encrypted || pkg.encryptedFields.length === 0) {
    return { ...pkg.config };
  }
  if (!pkg.salt) {
    throw new Error('Invalid sync export file — encrypted package is missing salt');
  }
  const salt = Uint8Array.from(atob(pkg.salt), c => c.charCodeAt(0));
  const key = await deriveKey(passphrase, salt);

  const decrypted: Record<string, string> = { ...pkg.config };
  for (const k of pkg.encryptedFields) {
    if (decrypted[k]) {
      decrypted[k] = await decryptField(decrypted[k], key);
    }
  }
  return decrypted;
}

// ─── File download ─────────────────────────────────────────────────────────────

/** Trigger a browser/Electron download of a JSON file. */
export function downloadJsonFile(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
