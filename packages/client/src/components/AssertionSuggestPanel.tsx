import { useEffect, useMemo, useRef, useState } from 'react';
import type { RequestResponse } from '../types';
import { INJECT_TEST_SNIPPET } from '../utils/appEvents';
import type { InjectTestSnippetDetail } from '../utils/appEvents';
import {
  inferAssertionsWithNotes,
  isSuggestionPresent,
  presenceNeedles,
  type AssertionSuggestion,
  type SuggestionKind,
} from '../utils/assertionInference';

export interface AssertionSuggestPanelProps {
  response: RequestResponse;
  /** Request tab the tests go to (routing survives a tab switch while the dialog is open). */
  tabId: string | null;
  /** Saved test script, used to mark suggestions that are already there. Insertion re-checks the live editor. */
  existingScript: string;
  onClose: () => void;
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

export default function AssertionSuggestPanel({ response, tabId, existingScript, onClose }: AssertionSuggestPanelProps) {
  const { suggestions, notes } = useMemo(() => inferAssertionsWithNotes({
    status: response.status,
    headers: response.headers ?? {},
    body: response.body ?? '',
    bodyBase64: response.bodyBase64,
    responseTime: response.responseTime,
  }), [response]);

  const present = useMemo(
    () => new Set(suggestions.filter(s => isSuggestionPresent(existingScript, s)).map(s => s.id)),
    [suggestions, existingScript],
  );
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(suggestions.filter(s => s.recommended && !present.has(s.id)).map(s => s.id)),
  );
  const closeRef = useRef<HTMLButtonElement>(null);
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
              Inferred from this response, locally. Nothing is added until you click Add; tests already in the script are never duplicated.
            </p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
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
                            <span className="break-words">{s.title}</span>
                            <span className="ml-2 text-[10px] text-slate-500">{KIND_LABEL[s.kind]}</span>
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
