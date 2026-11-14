import { useEffect, useMemo, useRef, useState } from 'react';
import { neutralizeAiText } from '@apilix/core/docs';
import type { RequestResponse } from '../types';
import { IconSparkle } from './Icons';
import { mergeSuggestions } from '../utils/ai/mergeSuggestions';
import type { AiSuggestAssertionsResult } from '../utils/ai/aiTypes';
import { INJECT_TEST_SNIPPET } from '../utils/appEvents';
import type { InjectTestSnippetDetail } from '../utils/appEvents';
import {
  inferAssertionsWithNotes,
  isSuggestionPresent,
  presenceNeedles,
  type AssertionSuggestion,
  type SuggestionKind,
} from '../utils/assertionInference';

/** Optional AI layer. Absent = the panel is local-only and never touches the network. */
export interface AiAssistProps {
  /** Feature on, consent given. When false the panel only shows `hint`. */
  enabled: boolean;
  /** Why the AI layer is unavailable (shown instead of the button). */
  hint?: string;
  /** Where the data would go ("Anthropic", a local URL...). */
  destination: string;
  /** `sendResponseBodies` is off: only the structure of the body is sent. */
  shapeOnly: boolean;
  /** Runs the model call (explicit user action only). */
  run: (signal: AbortSignal) => Promise<AiSuggestAssertionsResult>;
}

export interface AssertionSuggestPanelProps {
  response: RequestResponse;
  /** Request tab the tests go to (routing survives a tab switch while the dialog is open). */
  tabId: string | null;
  /** Saved test script, used to mark suggestions that are already there. Insertion re-checks the live editor. */
  existingScript: string;
  onClose: () => void;
  aiAssist?: AiAssistProps;
}

const KIND_LABEL: Record<SuggestionKind, string> = {
  status: 'Status',
  header: 'Header',
  body: 'Body',
  schema: 'Structure',
  timing: 'Timing',
  capture: 'Variable',
};

const SECTIONS: { title: string; kinds: SuggestionKind[] }[] = [
  { title: 'Status and headers', kinds: ['status', 'header'] },
  { title: 'Body', kinds: ['schema', 'body'] },
  { title: 'Save as variable', kinds: ['capture'] },
  { title: 'Performance', kinds: ['timing'] },
];

const CONFIDENCE_TONE: Record<AssertionSuggestion['confidence'], string> = {
  high: 'text-green-400',
  medium: 'text-slate-400',
  low: 'text-amber-400',
};

export default function AssertionSuggestPanel({ response, tabId, existingScript, onClose, aiAssist }: AssertionSuggestPanelProps) {
  const { suggestions: localSuggestions, notes } = useMemo(() => inferAssertionsWithNotes({
    status: response.status,
    headers: response.headers ?? {},
    body: response.body ?? '',
    bodyBase64: response.bodyBase64,
    responseTime: response.responseTime,
  }), [response]);

  const [aiResult, setAiResult] = useState<AiSuggestAssertionsResult | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  // The local suggestions are always there; the model's are merged in once (and only if) the user asks.
  const suggestions = useMemo(
    () => (aiResult ? mergeSuggestions(localSuggestions, aiResult.suggestions) : localSuggestions),
    [localSuggestions, aiResult],
  );

  const present = useMemo(
    () => new Set(suggestions.filter(s => isSuggestionPresent(existingScript, s)).map(s => s.id)),
    [suggestions, existingScript],
  );
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(suggestions.filter(s => s.recommended && !present.has(s.id)).map(s => s.id)),
  );
  const closeRef = useRef<HTMLButtonElement>(null);

  async function improveWithAi() {
    if (!aiAssist || !aiAssist.enabled || aiBusy) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setAiBusy(true);
    setAiError(null);
    try {
      const result = await aiAssist.run(ac.signal);
      if (ac.signal.aborted) return;
      setAiResult(result);
      const fresh = mergeSuggestions(localSuggestions, result.suggestions);
      setChecked(prev => {
        const next = new Set(prev);
        for (const s of fresh) if (s.source === 'ai' && s.recommended && !isSuggestionPresent(existingScript, s)) next.add(s.id);
        return next;
      });
    } catch (err) {
      if (ac.signal.aborted) return;
      setAiError(neutralizeAiText(err instanceof Error ? err.message : 'The AI request failed'));
    } finally {
      if (abortRef.current === ac) setAiBusy(false);
    }
  }
  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const selectable = suggestions.filter(s => !present.has(s.id));
  const selected = selectable.filter(s => checked.has(s.id));

  function toggle(id: string) {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function add() {
    for (const s of selected) {
      document.dispatchEvent(new CustomEvent<InjectTestSnippetDetail>(INJECT_TEST_SNIPPET, {
        detail: { snippet: s.script, tabId, skipIfPresent: presenceNeedles(s) },
      }));
    }
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div role="dialog" aria-label="Suggest tests" className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full max-w-2xl mx-4 max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between px-4 py-3 border-b border-slate-700 shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Suggest tests</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {aiResult
                ? (aiResult.executed === false ? 'Local inference plus AI suggestions that were not run on this response. ' : 'Local inference plus AI suggestions that passed on this response. ')
                : 'Inferred from this response, locally. '}
              Nothing is added until you click Add; tests already in the script are never duplicated.
            </p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {aiAssist && !aiAssist.enabled && aiAssist.hint && (
            <p className="text-xs text-slate-500">{aiAssist.hint}</p>
          )}
          {aiAssist && aiAssist.enabled && (
            <div className="rounded border border-slate-700 bg-slate-800/40 px-2.5 py-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={improveWithAi}
                  disabled={aiBusy}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-orange-500/60 text-orange-300 hover:bg-orange-500/10 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <IconSparkle className="w-3.5 h-3.5" />
                  {aiBusy ? 'Asking the model…' : aiResult ? 'Ask again' : 'Improve with AI'}
                </button>
                {aiBusy && (
                  <button type="button" className="text-xs text-slate-400 hover:text-slate-200" onClick={() => { abortRef.current?.abort(); setAiBusy(false); }}>Cancel</button>
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                {aiAssist.shapeOnly
                  ? `Sends this request without its values (URL without query values, body as structure only) and the structure of the response (types, no values), header names only (plus a few protocol values such as content-type) and the titles of your existing tests to ${aiAssist.destination}.`
                  : `Sends this request and a truncated copy of the response to ${aiAssist.destination}.`}
                {' '}Credentials and secret values are redacted first. Suggestions are test-run on this response and the ones that fail are dropped; when this build cannot run them in isolation they are only syntax-checked and marked "not executed".
              </p>
              {aiError && <p role="alert" className="text-xs text-red-400">{aiError}</p>}
              {aiResult && aiResult.executed === false && (
                <p role="alert" className="text-xs text-amber-300 border border-amber-500/30 bg-amber-500/5 rounded px-2 py-1.5">
                  Not executed: this build cannot run model-written scripts in an isolated process, so these suggestions only passed the security screen and a syntax check. They may fail on this response. Review each one; none is pre-selected.
                </p>
              )}
              {aiResult && (
                <p role="status" className="text-[11px] text-slate-400">
                  {aiResult.suggestions.length} AI suggestion{aiResult.suggestions.length === 1 ? '' : 's'} kept
                  {aiResult.discardedCount > 0 && `, ${aiResult.discardedCount} dropped because they failed on this response`}
                  {aiResult.truncated && '. The response was truncated before sending'}.
                </p>
              )}
            </div>
          )}
          {notes.map(n => (
            <p key={n} role="note" className="text-xs text-amber-400 border border-amber-500/30 bg-amber-500/5 rounded px-2 py-1.5">{n}</p>
          ))}
          {suggestions.length === 0 && <p className="text-xs text-slate-500">No suggestions for this response.</p>}
          {SECTIONS.map(section => {
            const items = suggestions.filter(s => section.kinds.includes(s.kind));
            if (!items.length) return null;
            return (
              <section key={section.title}>
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1.5">{section.title}</h3>
                <ul className="space-y-1">
                  {items.map(s => {
                    const isPresent = present.has(s.id);
                    return (
                      <li key={s.id} className={`rounded border px-2.5 py-1.5 ${isPresent ? 'border-slate-800 opacity-50' : 'border-slate-700 bg-slate-800/40'}`}>
                        <label className="flex items-start gap-2 text-xs text-slate-200 cursor-pointer">
                          <input
                            type="checkbox"
                            className="mt-0.5 accent-orange-500"
                            checked={!isPresent && checked.has(s.id)}
                            disabled={isPresent}
                            onChange={() => toggle(s.id)}
                          />
                          <span className="flex-1 min-w-0">
                            <span className="break-words">{s.source === 'ai' ? neutralizeAiText(s.title) : s.title}</span>
                            <span className="ml-2 text-[10px] text-slate-500">{KIND_LABEL[s.kind]}</span>
                            {s.source === 'ai' && <span className="ml-2 text-[10px] text-orange-400 border border-orange-500/40 rounded px-1" title={s.executed === false ? 'Suggested by the AI model; not run on this response' : 'Suggested by the AI model and verified on this response'}>AI</span>}
                            {s.source === 'ai' && s.executed === false && <span className="ml-2 text-[10px] text-amber-300 border border-amber-500/40 rounded px-1" title="Checked for safety and syntax only: this script was never run">not executed</span>}
                            <span className={`ml-2 text-[10px] ${CONFIDENCE_TONE[s.confidence]}`}>{s.confidence}</span>
                            {s.volatile && <span className="ml-2 text-[10px] text-amber-400" title="This value can change between runs; only its shape is checked">may change</span>}
                            {isPresent && <span className="ml-2 text-[10px] text-slate-400">already in tests</span>}
                          </span>
                        </label>
                        <details className="ml-6 mt-1">
                          <summary className="text-[10px] text-slate-500 cursor-pointer hover:text-slate-300">Code</summary>
                          <pre className="mt-1 overflow-x-auto rounded bg-slate-950 border border-slate-800 p-2 text-[11px] text-slate-300">{s.script}</pre>
                        </details>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>

        <div className="px-4 py-3 border-t border-slate-700 flex items-center justify-between gap-2 shrink-0">
          <div className="flex gap-3 text-xs">
            <button type="button" className="text-slate-400 hover:text-slate-200" onClick={() => setChecked(new Set(selectable.map(s => s.id)))}>Select all</button>
            <button type="button" className="text-slate-400 hover:text-slate-200" onClick={() => setChecked(new Set())}>Select none</button>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 font-medium transition-colors">
              Cancel
            </button>
            <button
              type="button"
              onClick={add}
              disabled={selected.length === 0}
              className="px-3 py-1.5 text-xs rounded bg-orange-600 hover:bg-orange-500 text-white font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {selected.length === 0 ? 'Add' : `Add ${selected.length} test${selected.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
