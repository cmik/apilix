import { useEffect, useRef, useState } from 'react';
import { neutralizeAiText } from '@apilix/core/docs';
import type { AiExplainFailureResult } from '../utils/ai/aiTypes';
import { maskSecrets } from '../utils/secretMask';
import { IconSparkle } from './Icons';
import AiPreviewDialog, { type AiPreviewExplain } from './AiPreviewDialog';

export interface ExplainFailurePanelProps {
  /** Where the data would go ("Anthropic", a local URL...). */
  destination: string;
  /** `sendResponseBodies` is off: only the structure of the body is sent. */
  shapeOnly: boolean;
  /** Secret values to mask again in the displayed text (the model could echo one). */
  secrets: Set<string>;
  /** Runs the model call (explicit user action only). */
  run: (signal: AbortSignal) => Promise<AiExplainFailureResult>;
  /** What the preview should also show: failed assertions, test script, variable names. */
  previewEvidence?: AiPreviewExplain;
}

const CONFIDENCE_TONE = { high: 'text-green-400', medium: 'text-slate-400', low: 'text-amber-400' } as const;
const KIND_LABEL = { assertion: 'Assertion', request: 'Request', environment: 'Environment', other: 'Other' } as const;

/** Model text is shown as plain text: no links, images or HTML, and any secret value is masked again. */
function safe(text: string, secrets: Set<string>): string {
  return maskSecrets(neutralizeAiText(text), secrets);
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable: nothing to do */ }
  }
  return (
    <button type="button" onClick={copy} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 font-medium transition-colors">
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * "Explain with AI" for failed tests. Nothing is sent until the user clicks. The answer is text only:
 * it is never applied or executed, a snippet can only be copied.
 */
export default function ExplainFailurePanel({ destination, shapeOnly, secrets, run, previewEvidence }: ExplainFailurePanelProps) {
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AiExplainFailureResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (!busy) { setElapsed(0); return; }
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  async function explain() {
    if (busy) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setError(null);
    try {
      const r = await run(ac.signal);
      if (ac.signal.aborted) return;
      setResult(r);
    } catch (err) {
      if (ac.signal.aborted) return;
      setError(safe(err instanceof Error ? err.message : 'The AI request failed', secrets));
    } finally {
      if (abortRef.current === ac) setBusy(false);
    }
  }

  function cancel() {
    abortRef.current?.abort();
    setBusy(false);
    setError(null);
  }

  return (
    <div className="rounded border border-slate-700 bg-slate-800/40 px-2.5 py-2 space-y-1.5" data-testid="explain-failure-panel">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={explain}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-orange-500/60 text-orange-300 hover:bg-orange-500/10 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <IconSparkle className="w-3.5 h-3.5" />
          {busy ? `Asking the model… ${elapsed}s` : result ? 'Explain again' : 'Explain with AI'}
        </button>
        {busy && (
          <button type="button" className="text-xs text-slate-400 hover:text-slate-200" onClick={cancel}>Cancel</button>
        )}
      </div>
      <p className="text-[11px] text-slate-500">
        {shapeOnly
          ? `Sends this request (URL without query values, body as structure only) and the response status, header names only (no values, except content-type, content-length, content-encoding and cache-control), the names of the failed assertions (their names and messages with quoted values and numbers masked), the structure of the response (types, no values) and the variable names to ${destination}. The test script is not sent.`
          : `Sends this request, the failed assertions with their messages, the test script, a truncated copy of the response and the variable names to ${destination}.`}
        {' '}Credentials and secret values are redacted first; variable values are never sent.{' '}
        <button type="button" className="underline hover:text-slate-300" onClick={() => setShowPreview(true)}>Preview what is sent</button>
      </p>
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      {result && (
        <div className="space-y-2 pt-1" data-testid="explain-failure-result">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-orange-400 border border-orange-500/40 rounded px-1" title="Written by an AI model: it can be wrong. Nothing is applied automatically.">AI-generated</span>
            {result.truncated && <span className="text-[10px] text-slate-500">The response was truncated before sending</span>}
          </div>
          <p className="text-xs text-slate-200 break-words">{safe(result.summary, secrets)}</p>
          {result.likelyCauses.length > 0 && (
            <section>
              <h4 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Likely causes</h4>
              <ul className="space-y-1">
                {result.likelyCauses.map((c, i) => (
                  <li key={i} className="text-xs text-slate-300 break-words">
                    {safe(c.cause, secrets)}
                    <span className={`ml-2 text-[10px] ${CONFIDENCE_TONE[c.confidence] ?? CONFIDENCE_TONE.low}`}>{c.confidence}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {result.suggestedFixes.length > 0 && (
            <section>
              <h4 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Suggested fixes</h4>
              <ul className="space-y-1.5">
                {result.suggestedFixes.map((f, i) => {
                  const snippet = f.snippet ? maskSecrets(f.snippet, secrets) : '';
                  return (
                    <li key={i} className="text-xs text-slate-300">
                      <span className="break-words">{safe(f.description, secrets)}</span>
                      <span className="ml-2 text-[10px] text-slate-500">{KIND_LABEL[f.kind] ?? KIND_LABEL.other}</span>
                      {snippet && (
                        <div className="mt-1">
                          <div className="flex justify-end mb-0.5"><CopyButton text={snippet} /></div>
                          <pre className="overflow-x-auto rounded bg-slate-950 border border-slate-800 p-2 text-[11px] text-slate-300 whitespace-pre-wrap break-all">{snippet}</pre>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      )}
      {showPreview && <AiPreviewDialog onClose={() => setShowPreview(false)} explain={previewEvidence} />}
    </div>
  );
}
