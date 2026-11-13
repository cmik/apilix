import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { aiPreview, toAiApiError, type AiPreviewResult } from '../api';
import { IconSparkle } from './Icons';
import { buildAllSecretValues } from '../utils/secretMask';

export interface AiPreviewExplain {
  failures: Array<{ name: string; error?: string | null }>;
  testScript?: string;
  variableNames?: string[];
}

interface Props {
  onClose: () => void;
  /** "Explain with AI" only: extra evidence (failed assertions, test script, variable names) to preview. */
  explain?: AiPreviewExplain;
}

/**
 * Shows exactly what an AI feature would send for the active request/response, after
 * redaction. Makes no call to the AI provider (only to the local Apilix server).
 */
export default function AiPreviewDialog({ onClose, explain }: Props) {
  const { state, dispatch } = useApp();
  const [result, setResult] = useState<AiPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const { activeRequest, response, ai, activeEnvironmentId, environments, globalVariables, globalVariableMeta, collectionVariables } = state;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    dispatch({ type: 'AI_REQUEST_START', payload: 'preview' });

    const env = environments.find(e => e._id === activeEnvironmentId);
    const variables = [
      ...(env?.values ?? []).filter(v => v.enabled !== false && v.key).map(v => ({ name: v.key, scope: 'environment', secret: v.secret === true })),
      ...Object.keys(globalVariables).map(k => ({ name: k, scope: 'global', secret: globalVariableMeta?.[k]?.secret === true })),
      ...Object.keys(activeRequest ? collectionVariables[activeRequest.collectionId] ?? {} : {}).map(k => ({ name: k, scope: 'collection', secret: false })),
    ];

    aiPreview({
      item: activeRequest?.item,
      response: response ? { status: response.status, statusText: response.statusText, headers: response.headers, body: response.body } : undefined,
      variables,
      ...(explain ? { explain } : {}),
      secretValues: Array.from(buildAllSecretValues(environments, globalVariables, globalVariableMeta)),
      settings: {
        maxContextTokens: ai.settings.maxContextTokens,
        redactSecrets: ai.settings.redactSecrets,
        sendResponseBodies: ai.settings.sendResponseBodies,
      },
    })
      .then(r => {
        if (cancelled) return;
        setResult(r);
        dispatch({ type: 'AI_REQUEST_DONE', payload: 'preview' });
      })
      .catch(err => {
        if (cancelled) return;
        const e = toAiApiError(err);
        setError(e.message);
        dispatch({ type: 'AI_REQUEST_FAIL', payload: { feature: 'preview', code: e.code, message: e.message } });
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRequest, response, ai.settings.maxContextTokens, ai.settings.redactSecrets, ai.settings.sendResponseBodies]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-[640px] max-w-[94vw] max-h-[80vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2">
            <IconSparkle className="w-4 h-4 text-orange-400" />
            <h3 className="text-sm font-semibold text-slate-200">What will be sent</h3>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 transition-colors text-lg leading-none" aria-label="Close">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <p className="text-xs text-slate-500 leading-relaxed">
            Preview for the active request and its last response, after redaction. Nothing is sent to the AI provider by this preview.
          </p>

          {loading && <p className="text-xs text-slate-400">Building preview…</p>}
          {error && <p className="text-xs text-red-400">{error}</p>}

          {result && (
            <>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-400">
                <span>≈ {result.estimatedTokens.toLocaleString()} tokens <span className="text-slate-600">(estimate)</span></span>
                <span>{result.redactions} value{result.redactions === 1 ? '' : 's'} masked</span>
              </div>
              {result.sections.length === 0 && (
                <p className="text-xs text-slate-500">Open a request in the builder to preview what would be sent for it.</p>
              )}
              {result.sections.map(sec => (
                <div key={sec.label}>
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{sec.label}</h4>
                    {sec.truncated && <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400 border border-orange-500/30">truncated</span>}
                  </div>
                  <pre className="bg-slate-950 border border-slate-800 rounded p-3 text-[11px] leading-relaxed text-slate-300 overflow-x-auto whitespace-pre-wrap break-all">{sec.text}</pre>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
