import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { inferExtension, buildSuggestedFilename, saveResponseToFile } from './responseFileSave';

// ── inferExtension ───────────────────────────────────────────────────────────

describe('inferExtension', () => {
  it('returns .json for application/json', () => {
    expect(inferExtension('application/json')).toBe('.json');
  });

  it('strips charset params before matching', () => {
    expect(inferExtension('application/json; charset=utf-8')).toBe('.json');
  });

  it('returns .xml for application/xml', () => {
    expect(inferExtension('application/xml')).toBe('.xml');
  });

  it('returns .xml for text/xml', () => {
    expect(inferExtension('text/xml')).toBe('.xml');
  });

  it('returns .xml for application/soap+xml', () => {
    expect(inferExtension('application/soap+xml')).toBe('.xml');
  });

  it('returns .html for text/html', () => {
    expect(inferExtension('text/html')).toBe('.html');
  });

  it('returns .csv for text/csv', () => {
    expect(inferExtension('text/csv')).toBe('.csv');
  });

  it('returns .txt for text/plain', () => {
    expect(inferExtension('text/plain')).toBe('.txt');
  });

  it('returns binary extensions for ZIP and octet-stream responses', () => {
    expect(inferExtension('application/zip')).toBe('.zip');
    expect(inferExtension('application/octet-stream')).toBe('.bin');
  });

  it('returns .txt for unknown content types', () => {
    expect(inferExtension('application/vnd.unknown')).toBe('.bin');
    expect(inferExtension('image/png')).toBe('.png');
    expect(inferExtension('')).toBe('.txt');
  });
});

// ── buildSuggestedFilename ───────────────────────────────────────────────────

describe('buildSuggestedFilename', () => {
  it('returns response.json when content-type is application/json', () => {
    expect(buildSuggestedFilename({ 'content-type': 'application/json' })).toBe('response.json');
  });

  it('handles uppercase Content-Type header key', () => {
    expect(buildSuggestedFilename({ 'Content-Type': 'text/xml' })).toBe('response.xml');
  });

  it('uses a sanitized filename from Content-Disposition', () => {
    expect(buildSuggestedFilename({ 'content-disposition': 'attachment; filename="archive.zip"' })).toBe('archive.zip');
    expect(buildSuggestedFilename({ 'Content-Disposition': "attachment; filename*=UTF-8''monthly%20report.zip" })).toBe('monthly report.zip');
  });

  it('returns response.txt when headers are undefined', () => {
    expect(buildSuggestedFilename(undefined)).toBe('response.txt');
    expect(buildSuggestedFilename(undefined, true)).toBe('response.bin');
  });

  it('returns response.txt when content-type is missing', () => {
    expect(buildSuggestedFilename({})).toBe('response.txt');
  });
});

// ── saveResponseToFile — Electron branch ────────────────────────────────────

describe('saveResponseToFile (Electron)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls saveResponseFile with suggestedName and content', async () => {
    const saveResponseFile = vi.fn().mockResolvedValue({ canceled: false, filePath: '/tmp/response.json' });
    vi.stubGlobal('electronAPI', { saveResponseFile });
    const result = await saveResponseToFile('response.json', '{"ok":true}');
    expect(saveResponseFile).toHaveBeenCalledWith('response.json', '{"ok":true}');
    expect(result).toEqual({ ok: true, canceled: false, filePath: '/tmp/response.json' });
  });

  it('passes binary bytes unchanged to Electron', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff]);
    const saveResponseFile = vi.fn().mockResolvedValue({ canceled: false, filePath: '/tmp/archive.zip' });
    vi.stubGlobal('electronAPI', { saveResponseFile });

    await saveResponseToFile('archive.zip', bytes, 'application/zip');

    expect(saveResponseFile).toHaveBeenCalledWith('archive.zip', bytes);
  });

  it('returns canceled:true when user cancels the dialog', async () => {
    const saveResponseFile = vi.fn().mockResolvedValue({ canceled: true });
    vi.stubGlobal('electronAPI', { saveResponseFile });
    const result = await saveResponseToFile('response.json', 'body');
    expect(result).toEqual({ ok: true, canceled: true });
  });

  it('returns ok:false when IPC throws', async () => {
    const saveResponseFile = vi.fn().mockRejectedValue(new Error('disk full'));
    vi.stubGlobal('electronAPI', { saveResponseFile });
    const result = await saveResponseToFile('response.json', 'body');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('disk full');
  });
});

// ── saveResponseToFile — browser anchor fallback ─────────────────────────────
// vi.stubGlobal has known issues overriding built-in Node.js globals in the
// node test environment. Assign directly to globalThis and clean up manually.

describe('saveResponseToFile (browser anchor fallback)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  let savedDoc: unknown;
  let savedURL: unknown;
  let savedBlob: unknown;
  let savedPicker: unknown;

  beforeEach(() => {
    savedDoc = g.document;
    savedURL = g.URL;
    savedBlob = g.Blob;
    savedPicker = g.showSaveFilePicker;
  });

  afterEach(() => {
    g.document = savedDoc;
    g.URL = savedURL;
    g.Blob = savedBlob;
    g.showSaveFilePicker = savedPicker;
  });

  it('creates a download anchor with the correct filename', async () => {
    const clickSpy = vi.fn();
    const anchor = { href: '', download: '', click: clickSpy };
    const revokeSpy = vi.fn();
    g.document = {
      createElement: vi.fn().mockReturnValue(anchor),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
    };
    g.URL = { createObjectURL: vi.fn().mockReturnValue('blob:test'), revokeObjectURL: revokeSpy };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    g.Blob = function (this: any) { return this; };

    const result = await saveResponseToFile('response.xml', '<root/>');
    expect(anchor.download).toBe('response.xml');
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeSpy).toHaveBeenCalledWith('blob:test');
    expect(result).toEqual({ ok: true, canceled: false });
  });

  it('writes binary bytes through the File System Access API', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff]);
    const write = vi.fn();
    const close = vi.fn();
    g.showSaveFilePicker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({ write, close }),
    });

    const result = await saveResponseToFile('archive.zip', bytes, 'application/zip');

    const written = write.mock.calls[0][0] as ArrayBuffer;
    expect(Array.from(new Uint8Array(written))).toEqual(Array.from(bytes));
    expect(close).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, canceled: false });
  });

  it('returns error when browser APIs are unavailable', async () => {
    g.document = undefined;
    g.Blob = undefined;
    g.URL = undefined;
    const result = await saveResponseToFile('response.txt', 'body');
    expect(result.ok).toBe(false);
  });
});
