import { useEffect, useMemo, useRef, useState } from 'react';
import { neutralizeAiText } from '@apilix/core/docs';
import type { CollectionAuth, CollectionItem } from '../types';
import type { AiGenerateRequestResult } from '../utils/ai/aiTypes';
import { draftToItem, preservedNotes } from '../utils/ai/draftToItem';
import { effectiveAuth, exfiltrationRisk } from '../utils/ai/hostGuard';
import { diffLines, diffViews, itemToView, type DiffLine, type ItemView } from '../utils/ai/itemDiff';
import { IconSparkle } from './Icons';

export interface AiProposalDialogProps {
  /** `create` adds a new request; `modify` replaces the editor content of `base` (unsaved until the user saves). */
  mode: 'create' | 'modify';
  result: AiGenerateRequestResult;
  /** The request being modified (current editor state). */
  base?: CollectionItem;
  /** Where a created request will go ("folder Users", "collection Shop"). */
  targetLabel?: string;
  busy?: boolean;
  /** Names of the secret variables (never their values), to warn when one is sent to an unfamiliar host. */
  secretNames?: readonly string[];
  /** Hosts the user already works with: `{{baseUrl}}` is always known. */
  knownHosts?: readonly string[];
  /** Auth the request inherits at its destination (folders above, then the collection): see `inheritedAuthFor`. */
  inheritedAuth?: CollectionAuth;
  onApply: (item: CollectionItem) => void;
  onDiscard: () => void;
  onRegenerate: () => void;
}

const EMPTY_VIEW: ItemView = { name: '', method: '', url: '', headers: '', body: '', auth: '', preRequest: '', tests: '' };

function DiffBlock({ title, lines }: { title: string; lines: DiffLine[] }) {
  if (!lines.length) return null;
  return (
    <section>
      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">{title}</h3>
      <pre className="overflow-x-auto rounded bg-slate-950 border border-slate-800 p-2 text-[11px] leading-relaxed">
        {lines.map((l, i) => (
          <div
            key={i}
            className={l.type === 'add' ? 'text-green-300 bg-green-500/10' : l.type === 'del' ? 'text-red-300 bg-red-500/10' : 'text-slate-400'}
          >
            <span aria-hidden="true" className="select-none mr-2">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
            {l.text || ' '}
          </div>
        ))}
      </pre>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div>
      <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{label}</div>
      <pre className="mt-0.5 overflow-x-auto rounded bg-slate-950 border border-slate-800 p-2 text-[11px] text-slate-200 whitespace-pre-wrap break-all">{value}</pre>
    </div>
  );
}

/**
 * Shows what the model proposes and lets the user apply, ignore or regenerate it. Nothing the model
 * wrote is applied or executed before "Apply" is clicked.
 */
export default function AiProposalDialog({ mode, result, base, targetLabel, busy, secretNames, knownHosts, inheritedAuth, onApply, onDiscard, onRegenerate }: AiProposalDialogProps) {
  const [ackRisk, setAckRisk] = useState(false);
  const applyRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { applyRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onDiscard(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onDiscard]);

  const item = useMemo(() => {
    // Modifying keeps the request's name: renaming is a separate, explicit action.
    let draft = mode === 'modify' && base ? { ...result.draft, name: base.name } : result.draft;
    // A script the security screen refused is never applicable, even if a server left it in the draft.
    for (const r of result.validation.removed ?? []) draft = { ...draft, [r.field]: '' };
    return draftToItem(draft, { base: mode === 'modify' ? base : undefined });
  }, [mode, base, result.draft, result.validation.removed]);

  const before = useMemo(() => (mode === 'modify' && base ? itemToView(base) : EMPTY_VIEW), [mode, base]);
  const after = useMemo(() => itemToView(item), [item]);
  const changes = useMemo(() => diffViews(before, after), [before, after]);
  const scriptChanged = (field: 'tests' | 'preRequest') => changes.some(c => c.field === field);
  const testsDiff = useMemo(() => diffLines(before.tests, after.tests), [before, after]);
  const preDiff = useMemo(() => diffLines(before.preRequest, after.preRequest), [before, after]);
  const unchanged = mode === 'modify' && changes.length === 0;
  const validated = result.validation.validated;
  const notExecuted = result.validation.executed === false;
  const removed = result.validation.removed ?? [];
  const kept = useMemo(() => (mode === 'modify' ? preservedNotes(base, item) : []), [mode, base, item]);
  const risk = useMemo(
    // The merged request's effective auth counts too: a modified request keeps its auth and a new one inherits its parent's.
    () => exfiltrationRisk(result.draft, {
      secretNames: new Set(secretNames ?? []),
      knownHosts: [...(knownHosts ?? [])],
      auth: effectiveAuth(item.request?.auth, inheritedAuth),
    }),
    [result.draft, item, secretNames, knownHosts, inheritedAuth],
  );
  const blocked = !!risk && !ackRisk;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60"
      onClick={e => { if (e.target === e.currentTarget) onDiscard(); }}
    >
      <div role="dialog" aria-label="AI proposal" className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full max-w-3xl mx-4 max-h-[88vh] flex flex-col">
        <div className="flex items-start justify-between px-4 py-3 border-b border-slate-700 shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <IconSparkle className="w-4 h-4 text-orange-400" />
              <h2 className="text-sm font-semibold text-slate-100">{mode === 'modify' ? 'Proposed changes' : 'Proposed request'}</h2>
              <span className="text-[10px] text-orange-400 border border-orange-500/40 rounded px-1.5 py-0.5" title="Written by an AI model: review before applying">AI-generated</span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              {mode === 'modify'
                ? 'Applying updates the editor only; your saved request changes when you save.'
                : `Nothing is created until you click Apply${targetLabel ? `. It will be added to ${targetLabel}` : ''}.`}
            </p>
          </div>
          <button type="button" onClick={onDiscard} aria-label="Close" className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {risk && (
            <div role="alert" className="text-xs text-red-300 border border-red-500/40 bg-red-500/10 rounded px-2 py-1.5 space-y-1.5">
              <p className="font-medium">This request would send secrets to an unfamiliar host.</p>
              <p>
                It targets <span className="font-mono break-all">{neutralizeAiText(risk.host)}</span>, which is neither <span className="font-mono">{'{{baseUrl}}'}</span> nor
                the host of a neighbouring request, and it uses {risk.variables.length > 0 && <>{risk.variables.map((v, i) => (
                  <span key={v}>{i > 0 ? ', ' : ''}<span className="font-mono">{`{{${neutralizeAiText(v)}}}`}</span></span>
                ))}, marked secret</>}{risk.variables.length > 0 && risk.literalCredential && ' and '}{risk.literalCredential && 'a credential written in its (own or inherited) authentication'}.
              </p>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="checkbox" checked={ackRisk} onChange={e => setAckRisk(e.target.checked)} className="mt-0.5 accent-orange-500" />
                <span>I checked the URL: sending these secrets to this host is intended.</span>
              </label>
            </div>
          )}
          {removed.map((r, i) => (
            <p key={`removed-${i}`} role="alert" className="text-xs text-amber-300 border border-amber-500/30 bg-amber-500/5 rounded px-2 py-1.5">
              Script refused for security: the {r.field === 'tests' ? 'tests' : 'pre-request'} script the model wrote was removed from this proposal ({neutralizeAiText(r.reason)}). Nothing was run.
            </p>
          ))}
          {kept.length > 0 && (
            <p role="note" className="text-xs text-slate-400">Kept as they are (the model cannot edit them): {kept.join(', ')}.</p>
          )}
          {notExecuted && result.validation.errors.length === 0 ? (
            <p role="alert" className="text-xs text-amber-300 border border-amber-500/30 bg-amber-500/5 rounded px-2 py-1.5">
              <span className="font-medium">Not executed.</span> This build cannot run model-written scripts in an isolated process, so these scripts only passed the security screen and a syntax check. Nothing was run. Review them carefully before applying.
            </p>
          ) : validated ? (
            <p role="status" className="text-xs text-green-400 border border-green-600/30 bg-green-500/5 rounded px-2 py-1.5">
              Scripts were test-run in the sandbox on a stand-in response: they parse and use only known APIs. They have not run against your API.
            </p>
          ) : (
            <div role="alert" className="text-xs text-amber-300 border border-amber-500/30 bg-amber-500/5 rounded px-2 py-1.5 space-y-1">
              <p className="font-medium">Not validated: these scripts passed the security screen but failed their test run. Review them carefully before applying.</p>
              <ul className="list-disc ml-4 space-y-0.5">
                {result.validation.errors.map((e, i) => (
                  <li key={i}>{e.field === 'tests' ? 'Tests' : 'Pre-request'}: {neutralizeAiText(e.reason)}</li>
                ))}
              </ul>
            </div>
          )}
          {result.warnings.map((w, i) => (
            <p key={i} role="note" className="text-xs text-amber-400">{neutralizeAiText(w)}</p>
          ))}

          {mode === 'create' ? (
            <div className="space-y-2">
              <div className="text-sm text-slate-100 font-medium break-words">{neutralizeAiText(item.name)}</div>
              <div className="flex items-start gap-2 text-xs">
                <span className="font-mono font-semibold text-orange-400 shrink-0">{after.method}</span>
                <span className="font-mono text-slate-200 break-all">{after.url || '(no URL: set it after applying)'}</span>
              </div>
              <Field label="Headers" value={after.headers} />
              <Field label="Body" value={after.body} />
              <Field label="Auth" value={after.auth} />
            </div>
          ) : unchanged ? (
            <p className="text-xs text-slate-400">The model proposes no change to this request.</p>
          ) : (
            <div className="space-y-2">
              {changes.filter(c => c.field !== 'tests' && c.field !== 'preRequest' && c.field !== 'name').map(c => (
                <div key={c.field}>
                  <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">{c.label}</div>
                  <pre className="mt-0.5 overflow-x-auto rounded bg-slate-950 border border-slate-800 p-2 text-[11px] whitespace-pre-wrap break-all">
                    {c.before && <div className="text-red-300 bg-red-500/10">- {c.before}</div>}
                    {c.after && <div className="text-green-300 bg-green-500/10">+ {c.after}</div>}
                  </pre>
                </div>
              ))}
            </div>
          )}

          {(mode === 'create' ? !!after.preRequest : scriptChanged('preRequest')) && <DiffBlock title="Pre-request script" lines={preDiff} />}
          {(mode === 'create' ? !!after.tests : scriptChanged('tests')) && <DiffBlock title="Tests" lines={testsDiff} />}
          {mode === 'create' && !after.tests && !after.preRequest && <p className="text-xs text-slate-500">No scripts proposed.</p>}
        </div>

        <div className="px-4 py-3 border-t border-slate-700 flex items-center justify-end gap-2 shrink-0">
          <button type="button" onClick={onDiscard} className="px-3 py-1.5 text-xs rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 font-medium transition-colors">
            Ignore
          </button>
          <button
            type="button"
            onClick={onRegenerate}
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {busy ? 'Regenerating…' : 'Regenerate'}
          </button>
          <button
            ref={applyRef}
            type="button"
            onClick={() => onApply(item)}
            disabled={busy || unchanged || blocked}
            className="px-3 py-1.5 text-xs rounded bg-orange-600 hover:bg-orange-500 text-white font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {validated ? 'Apply' : 'Apply anyway'}
          </button>
        </div>
      </div>
    </div>
  );
}
