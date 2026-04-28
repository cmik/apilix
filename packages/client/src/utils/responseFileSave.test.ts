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

  it('returns .txt for unknown content types', () => {
    expect(inferExtension('application/octet-stream')).toBe('.txt');
    expect(inferExtension('image/png')).toBe('.txt');
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

  it('returns response.txt when headers are undefined', () => {
    expect(buildSuggestedFilename(undefined)).toBe('response.txt');
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

  beforeEach(() => {
    savedDoc = g.document;
    savedURL = g.URL;
    savedBlob = g.Blob;
  });

  afterEach(() => {
    g.document = savedDoc;
    g.URL = savedURL;
    g.Blob = savedBlob;
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

  it('returns error when browser APIs are unavailable', async () => {
    g.document = undefined;
    g.Blob = undefined;
    g.URL = undefined;
    const result = await saveResponseToFile('response.txt', 'body');
    expect(result.ok).toBe(false);
  });
});
