/**
 * Utility for saving an HTTP response body to a local file.
 * Works in both Electron (native Save As dialog) and browser (download link).
 */

const CONTENT_TYPE_EXT_MAP: [RegExp, string][] = [
  [/application\/json/i, '.json'],
  [/application\/(?:xml|soap\+xml)|text\/xml/i, '.xml'],
  [/text\/html/i, '.html'],
  [/text\/csv/i, '.csv'],
  [/application\/javascript|text\/javascript/i, '.js'],
  [/application\/x-yaml|text\/yaml/i, '.yaml'],
  [/text\/plain/i, '.txt'],
];

export function inferExtension(contentType: string): string {
  const bare = contentType.split(';')[0].trim();
  for (const [pattern, ext] of CONTENT_TYPE_EXT_MAP) {
    if (pattern.test(bare)) return ext;
  }
  return '.txt';
}

export function buildSuggestedFilename(headers: Record<string, string> | undefined): string {
  const ct =
    headers?.['content-type'] ??
    headers?.['Content-Type'] ??
    '';
  const ext = inferExtension(ct);
  return `response${ext}`;
}

export type SaveResponseResult =
  | { ok: true; canceled: false; filePath?: string }
  | { ok: true; canceled: true }
  | { ok: false; error: string };

type GlobalWithElectron = typeof globalThis & {
  electronAPI?: {
    saveResponseFile?: (path: string, content: string) => Promise<{ canceled: boolean; filePath?: string }>;
  };
  showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>;
  document?: Document;
  Blob?: typeof Blob;
  URL?: typeof URL;
};

export async function saveResponseToFile(
  suggestedName: string,
  content: string,
): Promise<SaveResponseResult> {
  const g = globalThis as GlobalWithElectron;

  // ── Electron ────────────────────────────────────────────────────────────
  if (g.electronAPI?.saveResponseFile) {
    try {
      const result = await g.electronAPI.saveResponseFile(suggestedName, content);
      if (result.canceled) return { ok: true, canceled: true };
      return { ok: true, canceled: false, filePath: result.filePath };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  // ── Browser: File System Access API ─────────────────────────────────────
  if (typeof g.showSaveFilePicker === 'function') {
    try {
      const handle = await g.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Response file', accept: { 'text/plain': ['.txt', '.json', '.xml', '.html', '.csv', '.js', '.yaml'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return { ok: true, canceled: false };
    } catch (err) {
      // AbortError means the user dismissed the picker — treat as cancel
      if (err instanceof Error && err.name === 'AbortError') {
        return { ok: true, canceled: true };
      }
      return { ok: false, error: String(err) };
    }
  }

  // ── Browser fallback: anchor download ───────────────────────────────────
  // Access only via globalThis to avoid bare `document`/`Blob`/`URL` identifier
  // references that would throw ReferenceError in non-browser environments.
  try {
    const BlobCtor = g.Blob;
    const URLApi = g.URL;
    const doc = g.document;
    if (!BlobCtor || !URLApi || !doc) {
      return { ok: false, error: 'Browser environment not available' };
    }
    const blob = new BlobCtor([content], { type: 'text/plain' });
    const url = (URLApi as typeof URL).createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = suggestedName;
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    (URLApi as typeof URL).revokeObjectURL(url);
    return { ok: true, canceled: false };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
