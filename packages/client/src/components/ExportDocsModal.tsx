import { useMemo, useState } from 'react';
import { useApp } from '../store';
import type { AppCollection, DocsExportOptions, DocsFormat, DocsResult, DocsTheme } from '../types';
import { DOC_SNIPPET_LANGUAGES } from '../utils/docsCodeGenAdapter';
import { docsFilename, exportCollectionDocs } from '../utils/docsExport';
import { saveResponseToFile } from '../utils/responseFileSave';
import { useToast } from './Toast';

interface ExportDocsModalProps {
  collection: AppCollection;
  /** Optional folder scope (folder item id and display name). */
  folder?: { id: string; name: string };
  onClose: () => void;
}

const FORMAT_LABELS: Record<DocsFormat, string> = {
  html: 'HTML',
  markdown: 'Markdown',
  openapi: 'OpenAPI',
};

const PREVIEW_LIMIT = 30000;

export default function ExportDocsModal({ collection, folder, onClose }: ExportDocsModalProps) {
  const { getActiveEnvironment, secretSet } = useApp();
  const toast = useToast();
  const env = getActiveEnvironment();

  const [format, setFormat] = useState<DocsFormat>('html');
  const [openapiFormat, setOpenapiFormat] = useState<'json' | 'yaml'>('yaml');
  const [openapiVersion, setOpenapiVersion] = useState<'3.0.3' | '3.1.0'>('3.0.3');
  const [variableMode, setVariableMode] = useState<'keep' | 'resolve'>('keep');
  const [snippets, setSnippets] = useState<Set<string>>(new Set());
  const [includeExamples, setIncludeExamples] = useState(true);
  const [theme, setTheme] = useState<DocsTheme>('dark');
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [saving, setSaving] = useState(false);

  const options: DocsExportOptions = useMemo(() => ({
    format,
    openapiFormat,
    openapiVersion,
    folder: folder?.id,
    variableMode,
    snippetLanguages: format === 'openapi' ? [] : DOC_SNIPPET_LANGUAGES.filter(l => snippets.has(l.id)).map(l => l.id),
    includeExamples,
    includeCredentials,
    theme,
  }), [format, openapiFormat, openapiVersion, folder?.id, variableMode, snippets, includeExamples, includeCredentials, theme]);

  const generated = useMemo<{ result: DocsResult | null; error: string | null }>(() => {
    try {
      return { result: exportCollectionDocs(collection, options, { environment: env, secretValues: secretSet }), error: null };
    } catch (err) {
      return { result: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [collection, options, env, secretSet]);

  const { result, error } = generated;

  function toggleSnippet(id: string) {
    setSnippets(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleSave() {
    if (!result) return;
    setSaving(true);
    try {
      const name = folder ? `${collection.info.name}-${folder.name}` : collection.info.name;
      const res = await saveResponseToFile(docsFilename(name, result), result.content, result.mimeType);
      if (!res.ok) toast.error(`Export failed: ${res.error}`);
      else if (!res.canceled) {
        toast.success('Documentation exported.');
        if (result.warnings.length) toast.warning(`${result.warnings.length} warning(s): ${result.warnings[0]}`);
        onClose();
      }
    } finally {
      setSaving(false);
    }
  }

  const segBtn = (active: boolean) =>
    `flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${active ? 'bg-orange-600 text-white' : 'text-slate-400 hover:text-slate-200'}`;
  const sectionLabel = 'text-xs font-semibold text-slate-400 uppercase tracking-wide block mb-2';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full max-w-5xl mx-4 flex flex-col max-h-[88vh]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700 shrink-0">
          <h2 className="text-sm font-semibold text-slate-200">
            Export documentation
            <span className="ml-2 text-slate-500 font-normal">
              {collection.info.name}{folder ? ` / ${folder.name}` : ''}
            </span>
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none" aria-label="Close">×</button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Options */}
          <div className="w-72 shrink-0 overflow-y-auto px-5 py-4 space-y-4 border-r border-slate-700">
            <section>
              <span className={sectionLabel}>Format</span>
              <div className="flex gap-1 rounded-md bg-slate-800 p-0.5">
                {(Object.keys(FORMAT_LABELS) as DocsFormat[]).map(f => (
                  <button key={f} onClick={() => setFormat(f)} className={segBtn(format === f)}>{FORMAT_LABELS[f]}</button>
                ))}
              </div>
            </section>

            {format === 'openapi' && (
              <section className="space-y-2">
                <span className={sectionLabel}>OpenAPI</span>
                <div className="flex gap-1 rounded-md bg-slate-800 p-0.5">
                  {(['yaml', 'json'] as const).map(f => (
                    <button key={f} onClick={() => setOpenapiFormat(f)} className={segBtn(openapiFormat === f)}>{f.toUpperCase()}</button>
                  ))}
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input type="checkbox" className="accent-orange-500" checked={openapiVersion === '3.1.0'}
                    onChange={e => setOpenapiVersion(e.target.checked ? '3.1.0' : '3.0.3')} />
                  Use OpenAPI 3.1 (default 3.0.3)
                </label>
              </section>
            )}

            {format === 'html' && (
              <section>
                <span className={sectionLabel}>Theme</span>
                <div className="flex gap-1 rounded-md bg-slate-800 p-0.5">
                  {(['dark', 'light', 'auto'] as const).map(t => (
                    <button key={t} onClick={() => setTheme(t)} className={segBtn(theme === t)}>{t[0].toUpperCase() + t.slice(1)}</button>
                  ))}
                </div>
              </section>
            )}

            <section>
              <span className={sectionLabel}>Variables</span>
              <div className="flex gap-1 rounded-md bg-slate-800 p-0.5">
                <button onClick={() => setVariableMode('keep')} className={segBtn(variableMode === 'keep')}>Keep {'{{var}}'}</button>
                <button onClick={() => setVariableMode('resolve')} className={segBtn(variableMode === 'resolve')}>Resolve</button>
              </div>
              {variableMode === 'resolve' && (
                <p className="mt-1.5 text-xs text-slate-500">
                  {env ? `Uses non-secret values from "${env.name}".` : 'No active environment; only collection variables are used.'} Secret values are never substituted.
                </p>
              )}
            </section>

            <section>
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input type="checkbox" className="accent-orange-500" checked={includeExamples} onChange={e => setIncludeExamples(e.target.checked)} />
                Include saved examples
              </label>
            </section>

            {format !== 'openapi' && (
              <section>
                <span className={sectionLabel}>Code snippets</span>
                <ul className="space-y-0.5">
                  {DOC_SNIPPET_LANGUAGES.map(l => (
                    <li key={l.id}>
                      <label className="flex items-center gap-2 px-1 py-0.5 text-xs text-slate-300 cursor-pointer hover:text-slate-100">
                        <input type="checkbox" className="accent-orange-500" checked={snippets.has(l.id)} onChange={() => toggleSnippet(l.id)} />
                        {l.label}
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
                <input type="checkbox" className="accent-orange-500 mt-0.5" checked={includeCredentials} onChange={e => setIncludeCredentials(e.target.checked)} />
                Include credentials
              </label>
              {includeCredentials ? (
                <p className="mt-1.5 text-xs text-amber-400">
                  Warning: literal tokens, passwords and API keys stored in this collection will appear in the exported file. Do not share it publicly. Secret environment values are still masked.
                </p>
              ) : (
                <p className="mt-1.5 text-xs text-slate-500">Credentials are redacted by default; {'{{variable}}'} references are kept.</p>
              )}
            </section>
          </div>

          {/* Preview */}
          <div className="flex-1 min-w-0 flex flex-col px-4 py-4 min-h-0">
            <span className={sectionLabel}>Preview</span>
            {error ? (
              <p className="text-xs text-red-400">{error}</p>
            ) : result && format === 'html' ? (
              <iframe
                title="Documentation preview"
                sandbox=""
                srcDoc={result.content}
                className="flex-1 min-h-[320px] w-full rounded border border-slate-700 bg-white"
              />
            ) : result ? (
              <pre className="flex-1 min-h-[320px] overflow-auto rounded border border-slate-700 bg-slate-950 p-3 text-xs text-slate-300 whitespace-pre-wrap">
                {result.content.length > PREVIEW_LIMIT ? `${result.content.slice(0, PREVIEW_LIMIT)}\n\n… preview truncated …` : result.content}
              </pre>
            ) : null}
            {result && result.warnings.length > 0 && (
              <ul className="mt-2 max-h-16 overflow-y-auto text-xs text-amber-400 list-disc pl-4">
                {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-slate-700 flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 text-xs rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 font-medium transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!result || saving}
            className="px-3 py-1.5 text-xs rounded bg-orange-600 hover:bg-orange-500 text-white font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Save…
          </button>
        </div>
      </div>
    </div>
  );
}
