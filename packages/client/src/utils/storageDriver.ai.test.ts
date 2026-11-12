import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as Storage from './storageDriver';
import { DEFAULT_AI_SETTINGS } from './aiDefaults';

const KEY = 'sk-ant-REAL-KEY-123456789';
const settings = { ...DEFAULT_AI_SETTINGS, enabled: true, model: 'm' };

function makeLocalStorage() {
  const m = new Map<string, string>();
  return {
    m,
    api: {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => { m.set(k, v); },
      removeItem: (k: string) => { m.delete(k); },
    },
  };
}

interface ElectronOpts { encrypt?: (v: string) => string | null; decrypt?: (v: string) => string | null }
function makeElectron(opts: ElectronOpts = {}) {
  const files = new Map<string, unknown>();
  const api = {
    getDataDir: async () => '/data',
    readJsonFile: async (p: string) => (files.has(p) ? JSON.parse(JSON.stringify(files.get(p))) : null),
    writeJsonFile: async (p: string, d: unknown) => { files.set(p, JSON.parse(JSON.stringify(d))); },
    encryptString: async (v: string) => (opts.encrypt ? opts.encrypt(v) : `ENC:${Buffer.from(v).toString('base64')}`),
    decryptString: async (v: string) => (opts.decrypt ? opts.decrypt(v) : Buffer.from(v.replace(/^ENC:/, ''), 'base64').toString()),
  };
  return { files, api };
}

let ls: ReturnType<typeof makeLocalStorage>;
function setup(electron?: ReturnType<typeof makeElectron>) {
  ls = makeLocalStorage();
  vi.stubGlobal('localStorage', ls.api);
  vi.stubGlobal('window', electron ? { electronAPI: electron.api } : {});
  Storage.setSessionAiKey(null);
}

beforeEach(() => { vi.unstubAllGlobals(); });

describe('AI config storage — Electron', () => {
  it('writes the key encrypted, never in clear, never to localStorage', async () => {
    const e = makeElectron();
    setup(e);
    const status = await Storage.writeAiConfig(settings, KEY, { remember: true });
    expect(status).toBe('ok');
    const raw = JSON.stringify([...e.files.values()]);
    expect(raw).not.toContain(KEY);
    expect(raw).toContain('encryptedApiKey');
    expect(JSON.stringify([...ls.m.entries()])).not.toContain(KEY);
    expect(JSON.stringify([...ls.m.entries()])).not.toContain('ENC:');
    const loaded = await Storage.readAiConfig();
    expect(loaded).toEqual({ settings, apiKey: KEY, keyStatus: 'ok' });
  });

  it('does not write the key at all when the keychain is unavailable (encryptString → null)', async () => {
    const e = makeElectron({ encrypt: () => null });
    setup(e);
    const status = await Storage.writeAiConfig(settings, KEY, { remember: true });
    expect(status).toBe('unavailable');
    expect(JSON.stringify([...e.files.values()])).not.toContain(KEY);
    expect(JSON.stringify([...e.files.values()])).not.toContain('encryptedApiKey');
    expect(JSON.stringify([...ls.m.entries()])).not.toContain(KEY);
    // Still usable for this session.
    expect((await Storage.readAiConfig()).apiKey).toBe(KEY);
    expect((await Storage.readAiConfig()).keyStatus).toBe('session-only');
  });

  it('failed decryption → needs-reentry, and the ciphertext is never returned', async () => {
    const e = makeElectron();
    setup(e);
    await Storage.writeAiConfig(settings, KEY, { remember: true });
    Storage.setSessionAiKey(null);
    const broken = makeElectron({ decrypt: () => null });
    broken.files.set('/data/ai-config.json', [...e.files.values()][0]);
    vi.stubGlobal('window', { electronAPI: broken.api });
    const loaded = await Storage.readAiConfig();
    expect(loaded.keyStatus).toBe('needs-reentry');
    expect(loaded.apiKey).toBeNull();
    expect(JSON.stringify(loaded)).not.toContain('ENC:');
    expect(loaded.settings).toEqual(settings);
  });

  it('a throwing decryptString is also needs-reentry', async () => {
    const e = makeElectron({ decrypt: () => { throw new Error('keychain locked'); } });
    setup(e);
    e.files.set('/data/ai-config.json', { settings, encryptedApiKey: 'ENC:xxxx' });
    expect((await Storage.readAiConfig()).keyStatus).toBe('needs-reentry');
  });

  it('remember:false keeps the key in memory only', async () => {
    const e = makeElectron();
    setup(e);
    expect(await Storage.writeAiConfig(settings, KEY, { remember: false })).toBe('session-only');
    expect(JSON.stringify([...e.files.values()])).not.toContain('encryptedApiKey');
    expect(JSON.stringify([...e.files.values()])).not.toContain(KEY);
    expect((await Storage.readAiConfig()).apiKey).toBe(KEY);
  });

  it('settings-only write (apiKey undefined) preserves the stored key; null removes it', async () => {
    const e = makeElectron();
    setup(e);
    await Storage.writeAiConfig(settings, KEY, { remember: true });
    Storage.setSessionAiKey(null);
    expect(await Storage.writeAiConfig({ ...settings, model: 'other' }, undefined, { remember: true })).toBe('ok');
    const loaded = await Storage.readAiConfig();
    expect(loaded.apiKey).toBe(KEY);
    expect(loaded.settings?.model).toBe('other');
    expect(await Storage.writeAiConfig(settings, null, { remember: true })).toBe('none');
    expect((await Storage.readAiConfig()).apiKey).toBeNull();
  });

  it('clearAiKey removes the key but keeps the settings', async () => {
    const e = makeElectron();
    setup(e);
    await Storage.writeAiConfig(settings, KEY, { remember: true });
    await Storage.clearAiKey();
    const loaded = await Storage.readAiConfig();
    expect(loaded.apiKey).toBeNull();
    expect(loaded.keyStatus).toBe('none');
    expect(loaded.settings).toEqual(settings);
  });

  it('first run: no file → no settings, no key', async () => {
    setup(makeElectron());
    expect(await Storage.readAiConfig()).toEqual({ settings: null, apiKey: null, keyStatus: 'none' });
  });
});

describe('AI config storage — web (localStorage)', () => {
  it('remember:true stores the key in localStorage', async () => {
    setup();
    expect(await Storage.writeAiConfig(settings, KEY, { remember: true })).toBe('ok');
    expect(await Storage.readAiConfig()).toEqual({ settings, apiKey: KEY, keyStatus: 'ok' });
  });

  it('remember:false writes nothing secret to localStorage', async () => {
    setup();
    expect(await Storage.writeAiConfig(settings, KEY, { remember: false })).toBe('session-only');
    expect(JSON.stringify([...ls.m.entries()])).not.toContain(KEY);
    expect((await Storage.readAiConfig()).keyStatus).toBe('session-only');
  });

  it('switching to remember:false removes a previously remembered key', async () => {
    setup();
    await Storage.writeAiConfig(settings, KEY, { remember: true });
    await Storage.writeAiConfig(settings, 'another-key-9999', { remember: false });
    expect(JSON.stringify([...ls.m.entries()])).not.toContain(KEY);
    expect(JSON.stringify([...ls.m.entries()])).not.toContain('another-key-9999');
  });

  it('clearAiKey wipes localStorage and memory', async () => {
    setup();
    await Storage.writeAiConfig(settings, KEY, { remember: true });
    await Storage.clearAiKey();
    expect(JSON.stringify([...ls.m.entries()])).not.toContain(KEY);
    expect((await Storage.readAiConfig()).apiKey).toBeNull();
  });
});

describe('AI config storage — write serialization', () => {
  it.each([['settings write first', true], ['key write first', false]])('a concurrent settings write never drops a saved key (%s)', async (_n, settingsFirst) => {
    const e = makeElectron();
    // Slow reads widen the read-modify-write window.
    const origRead = e.api.readJsonFile;
    e.api.readJsonFile = async (p: string) => { await new Promise(r => setTimeout(r, 15)); return origRead(p); };
    // A settings-only write lands late: without serialization it clobbers the key written meanwhile.
    const origWrite = e.api.writeJsonFile;
    e.api.writeJsonFile = async (p: string, d: unknown) => {
      if (!(d as { encryptedApiKey?: string }).encryptedApiKey) await new Promise(r => setTimeout(r, 40));
      return origWrite(p, d);
    };
    setup(e);
    const writeSettings = () => Storage.writeAiConfig({ ...settings, model: 'other' }, undefined, { remember: true });
    const writeKey = () => Storage.writeAiConfig(settings, KEY, { remember: true });
    await Promise.all(settingsFirst ? [writeSettings(), writeKey()] : [writeKey(), writeSettings()]);
    const loaded = await Storage.readAiConfig();
    expect(loaded.apiKey).toBe(KEY);
    expect(loaded.keyStatus).toBe('ok');
  });

  it('keeps the queue alive after a failed write', async () => {
    const e = makeElectron();
    setup(e);
    let fail = true;
    const origWrite = e.api.writeJsonFile;
    e.api.writeJsonFile = async (p: string, d: unknown) => { if (fail) { fail = false; throw new Error('disk'); } return origWrite(p, d); };
    await Storage.writeAiConfig(settings, KEY, { remember: true });
    const status = await Storage.writeAiConfig(settings, KEY, { remember: true });
    expect(status).toBe('ok');
  });
});
