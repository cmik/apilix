import { useEffect, useMemo, useRef, useState } from 'react';
import { neutralizeAiText } from '@apilix/core/docs';
import { useApp } from '../store';
import { aiSummarizeRun, toAiApiError, type AiRunSummaryResult } from '../api';
import type { RunnerIteration } from '../types';
import { buildRunSummary } from '../utils/runSummary';
import { aiFeatureReady } from '../utils/ai/nlContext';
import { buildAllSecretValues, maskSecrets } from '../utils/secretMask';
import { AI_PROVIDER_DEFAULT_BASE } from '../utils/aiDefaults';
import { IconSparkle } from './Icons';
import AiPreviewDialog from './AiPreviewDialog';

/**
 * Summary of a finished run: failures grouped by root cause, shown without any AI. "Summarize with AI"
 * (feature flag `diagnose`) sends only the aggregated groups (counts, URL templates, statuses, messages and
 * at most 3 examples per group; never a body, header or variable value) after an explicit click, and shows
 * the answer as text next to the groups. Nothing is applied or executed.
 */
export default function RunSummaryPanel({ results }: { results: RunnerIteration[] }) {
  const { state, dispatch } = useApp();
  const settings = state.ai?.settings;
  const ready = !!settings && aiFeatureReady(settings, 'diagnose');
  const summary = useMemo(() => buildRunSummary(results), [results]);
  const secrets = useMemo(
    () => (ready ? buildAllSecretValues(state.environments, state.globalVariables, state.globalVariableMeta) : new Set<string>()),
    [ready, state.environments, state.globalVariables, state.globalVariableMeta],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AiRunSummaryResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // A new run (new results) clears the previous answer and aborts a call in flight.
  useEffect(() => {
    setAnswer(null);
    setError(null);
    abortRef.current?.abort();
    setBusy(false);
  }, [results]);
  useEffect(() => () => abortRef.current?.abort(), []);

  if (summary.totals.failedRequests === 0) return null;
  const safe = (t: string) => maskSecrets(neutralizeAiText(t), secrets);
  const payload = { totals: summary.totals, groups: summary.groups.map(g => ({ key: g.key, count: g.count, method: g.method, url: g.url, status: g.status, message: g.message, examples: g.examples })) };

  async function summarize() {
    if (busy) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setError(null);
    dispatch({ type: 'AI_REQUEST_START', payload: 'diagnose' });
    try {
      const r = await aiSummarizeRun({ ...payload, secretValues: Array.from(secrets) }, ac.signal);
      if (ac.signal.aborted) return;
      dispatch({ type: 'AI_REQUEST_DONE', payload: 'diagnose' });
      setAnswer(r);
    } catch (err) {
      if (ac.signal.aborted) { dispatch({ type: 'AI_REQUEST_DONE', payload: 'diagnose' }); return; }
      const e = toAiApiError(err);
      dispatch({ type: 'AI_REQUEST_FAIL', payload: { feature: 'diagnose', code: e.code, message: e.message } });
      setError(safe(e.message));
    } finally {
      if (abortRef.current === ac) setBusy(false);
    }
  }

  const destination = settings?.baseUrl || (settings?.provider === 'anthropic' ? 'Anthropic' : settings ? AI_PROVIDER_DEFAULT_BASE[settings.provider] : '');
  const noteFor = (index: number) => answer?.groups.find(g => g.id === `g${index + 1}`);

  return (
    <div className="rounded border border-slate-700 bg-slate-800/40 px-3 py-2 space-y-2" data-testid="run-summary">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Run summary</h3>
        {ready && (
          <button
            type="button"
            onClick={summarize}
            disabled={busy}
            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-orange-500/60 text-orange-300 hover:bg-orange-500/10 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <IconSparkle className="w-3.5 h-3.5" />
            {busy ? 'Asking the model…' : answer ? 'Summarize again' : 'Summarize with AI'}
          </button>
        )}
        {busy && <button type="button" className="text-xs text-slate-400 hover:text-slate-200" onClick={() => { abortRef.current?.abort(); setBusy(false); dispatch({ type: 'AI_REQUEST_DONE', payload: 'diagnose' }); }}>Cancel</button>}
      </div>
      <p className="text-xs text-slate-300 whitespace-pre-line">{summary.local}</p>
      {ready && (
        <p className="text-[11px] text-slate-500">
          Sends only the grouped failures (counts, URL templates without ids or query values, statuses, messages{state.ai.settings.sendResponseBodies === false ? ' with quoted values and numbers masked' : ''}, and up to 3 examples per group) to {destination}. No body, header or variable value is sent.{' '}
          <button type="button" className="underline hover:text-slate-300" onClick={() => setShowPreview(true)}>Preview what is sent</button>
        </p>
      )}
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      {answer && (
        <div className="space-y-1.5 pt-1" data-testid="run-summary-answer">
          <span className="text-[10px] text-orange-400 border border-orange-500/40 rounded px-1" title="Written by an AI model: it can be wrong. Nothing is applied automatically.">AI-generated</span>
          <p className="text-xs text-slate-200 break-words">{safe(answer.summary)}</p>
          {answer.omittedGroups > 0 && <p className="text-[11px] text-slate-500">{answer.omittedGroups} smaller group{answer.omittedGroups === 1 ? ' was' : 's were'} not sent.</p>}
        </div>
      )}
      <ul className="space-y-1">
        {summary.groups.map((g, i) => {
          const note = noteFor(i);
          return (
            <li key={g.key} className="text-xs text-slate-300 break-words" data-testid="run-summary-group">
              <span className="font-mono text-slate-400">{g.count}x {g.method} {g.url}</span>
              <span className="ml-2 text-slate-500">{g.status ? g.status : 'no response'}</span>
              <span className="block text-[11px] text-slate-500">{g.message}</span>
              {note && (
                <span className="block text-[11px] text-slate-200">
                  {safe(note.cause)}{note.nextStep ? <span className="text-slate-400"> Next: {safe(note.nextStep)}</span> : null}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {showPreview && <AiPreviewDialog onClose={() => setShowPreview(false)} runSummary={payload} />}
    </div>
  );
}
