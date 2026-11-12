import { useMemo, useState } from 'react';
import { useApp } from '../store';
import type { AppCollection, DocsExportOptions, DocsFormat, DocsResult, DocsTheme } from '../types';
import { DOC_SNIPPET_LANGUAGES } from '../utils/docsCodeGenAdapter';
import { docsFilename, exportCollectionDocs, maskCollectionForAi } from '../utils/docsExport';
import { buildAiRows, rowsToDescriptions, type AiDescriptionRow } from '../utils/docsAiRows';
import { AI_PROVIDER_DEFAULT_BASE } from '../utils/aiDefaults';
import { aiDescribeDocs, toAiApiError } from '../api';
import { IconSparkle } from './Icons';
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
  const { state, dispatch, getActiveEnvironment, secretSet } = useApp();
  const toast = useToast();
  const env = getActiveEnvironment();

  const [format, setFormat] = useState<DocsFormat>('html');
  const [openapiFormat, setOpenapiFormat] = useState<'json' | 'yaml'>('yaml');
  const [openapiVersion, setOpenapiVersion] = useState<'3.0.3' | '3.1.0'>('3.0.3');
  const [variableMode, setVariableMode] = useState<'keep' | 'resolve'>('keep');
  const [snippets, setSnippets] = useState<Set<string>>(new Set());
  const [includeExamples, setIncludeExamples] = useState(true);
  const [theme, setTheme] = useState<DocsTheme>('dark');
  const [renderImages, setRenderImages] = useState(true);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [saving, setSaving] = useState(false);

  // AI descriptions: generated on request, reviewed/edited by the user, then merged into the export.
  const ai = state.ai.settings;
  const aiBusy = state.ai.inFlight.docDescribe === true;
  const [aiRows, setAiRows] = useState<AiDescriptionRow[]>([]);
  const [aiMark, setAiMark] = useState(ai.markAiContent !== false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiNotes, setAiNotes] = useState<string[]>([]);
  const [tab, setTab] = useState<'preview' | 'ai'>('preview');
  const aiDestination = ai.baseUrl || (ai.provider === 'anthropic' ? 'Anthropic' : AI_PROVIDER_DEFAULT_BASE[ai.provider]);
  const aiDescriptions = useMemo(() => rowsToDescriptions(aiRows), [aiRows]);

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
    renderImages,
    descriptions: Object.keys(aiDescriptions).length ? aiDescriptions : undefined,
    markAiContent: aiMark,
  }), [format, openapiFormat, openapiVersion, folder?.id, variableMode, snippets, includeExamples, includeCredentials, theme, renderImages, aiDescriptions, aiMark]);

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

  async function handleGenerateAi() {
    setAiError(null);
    setAiNotes([]);
    dispatch({ type: 'AI_REQUEST_START', payload: 'docDescribe' });
    try {
      const r = await aiDescribeDocs({
        collection: maskCollectionForAi(collection, secretSet),
        folder: folder?.id,
        language: ai.outputLanguage || undefined,
        secretValues: [...secretSet],
      });
      dispatch({ type: 'AI_REQUEST_DONE', payload: 'docDescribe' });
      const rows = buildAiRows(collection, folder?.id, r.descriptions);
      setAiRows(rows);
      setAiNotes(r.warnings);
      if (rows.length) setTab('ai');
      else setAiError(r.requested === 0 ? 'Nothing to describe: every entry already has a description.' : 'The model returned no usable descriptions.');
    } catch (err) {
      const e = toAiApiError(err);
      dispatch({ type: 'AI_REQUEST_FAIL', payload: { feature: 'docDescribe', code: e.code, message: e.message } });
      setAiError(`${e.message} (${e.code})`);
    }
  }

  function updateAiRow(id: string, patch: Partial<AiDescriptionRow>) {
    setAiRows(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));
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
                <label className="mt-2 flex items-start gap-2 text-xs text-slate-300 cursor-pointer">
                  <input type="checkbox" className="mt-0.5 accent-orange-500" checked={renderImages} onChange={e => setRenderImages(e.target.checked)} />
                  <span>Render images <span className="text-slate-500">(loads remote images when the file is opened)</span></span>
                </label>
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
              <span className={sectionLabel}>AI descriptions</span>
              {!ai.enabled ? (
                <p className="text-xs text-slate-500">AI is off. Enable it in Settings → AI to fill in missing descriptions.</p>
              ) : !ai.features.docDescribe ? (
                <p className="text-xs text-slate-500">Turn on “Complete missing documentation descriptions” in Settings → AI.</p>
              ) : (
                <div className="space-y-2">
                  <button
                    onClick={handleGenerateAi}
                    disabled={aiBusy}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs rounded border border-orange-500/60 text-orange-300 hover:bg-orange-500/10 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <IconSparkle className="w-3.5 h-3.5" />
                    {aiBusy ? 'Generating…' : aiRows.length ? 'Regenerate' : 'Generate missing descriptions'}
                  </button>
                  <p className="text-xs text-slate-500">
                    Sends the request structure of undocumented entries to {aiDestination}. Credentials and secret values are redacted first; existing descriptions are never changed.
                  </p>
                  {aiRows.length > 0 && (
                    <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                      <input type="checkbox" className="accent-orange-500" checked={aiMark} onChange={e => setAiMark(e.target.checked)} />
                      Mark AI-written descriptions
                    </label>
                  )}
                  {aiError && <p className="text-xs text-red-400">{aiError}</p>}
                  {aiNotes.length > 0 && (
                    <ul className="text-xs text-amber-400 list-disc pl-4">{aiNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                  )}
                </div>
              )}
            </section>

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
            {aiRows.length > 0 ? (
              <div className="flex gap-1 rounded-md bg-slate-800 p-0.5 mb-2 w-fit">
                <button onClick={() => setTab('preview')} className={`px-3 py-1 rounded text-xs font-medium transition-colors ${tab === 'preview' ? 'bg-orange-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>Preview</button>
                <button onClick={() => setTab('ai')} className={`px-3 py-1 rounded text-xs font-medium transition-colors ${tab === 'ai' ? 'bg-orange-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                  AI descriptions ({aiRows.length})
                </button>
              </div>
            ) : (
              <span className={sectionLabel}>Preview</span>
            )}
            {tab === 'ai' && aiRows.length > 0 ? (
              <div className="flex-1 min-h-[320px] overflow-y-auto space-y-3 pr-1">
                <p className="text-xs text-slate-500">Review and edit before exporting. Unchecked entries are left out.</p>
                {aiRows.map(row => (
                  <div key={row.id} className={`rounded border p-2.5 space-y-2 ${row.included ? 'border-slate-700 bg-slate-800/40' : 'border-slate-800 opacity-50'}`}>
                    <label className="flex items-center gap-2 text-xs font-medium text-slate-200 cursor-pointer">
                      <input type="checkbox" className="accent-orange-500" checked={row.included} onChange={e => updateAiRow(row.id, { included: e.target.checked })} />
                      <span className="truncate">{row.label}</span>
                    </label>
                    {(row.description || row.kind !== 'request') && (
                      <textarea
                        value={row.description}
                        onChange={e => updateAiRow(row.id, { description: e.target.value })}
                        rows={2}
                        aria-label={`Description for ${row.label}`}
                        className="w-full rounded bg-slate-950 border border-slate-700 focus:border-orange-500 outline-none px-2 py-1 text-xs text-slate-200 resize-y"
                      />
                    )}
                    {Object.entries(row.params).map(([name, text]) => (
                      <div key={name} className="flex items-center gap-2">
                        <code className="shrink-0 w-28 truncate text-xs text-slate-400" title={name}>{name}</code>
                        <input
                          value={text}
                          onChange={e => updateAiRow(row.id, { params: { ...row.params, [name]: e.target.value } })}
                          aria-label={`Description for parameter ${name}`}
                          className="flex-1 min-w-0 rounded bg-slate-950 border border-slate-700 focus:border-orange-500 outline-none px-2 py-1 text-xs text-slate-200"
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : error ? (
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
