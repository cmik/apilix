import { useEffect, useRef, useState } from 'react';
import { neutralizeAiText } from '@apilix/core/docs';
import { useApp } from '../store';
import { aiGenerateRequest, toAiApiError } from '../api';
import type { AiGenerateRequestResult } from '../utils/ai/aiTypes';
import type { CollectionItem } from '../types';
import { aiFeatureReady, collectNeighbors, collectVariableMeta, isHttpRestItem } from '../utils/ai/nlContext';
import { buildAllSecretValues } from '../utils/secretMask';
import { AI_PROVIDER_DEFAULT_BASE } from '../utils/aiDefaults';
import { IconSparkle } from './Icons';
import AiProposalDialog from './AiProposalDialog';

export interface AiCommandBarProps {
  collectionId: string;
  /** Folder the new request goes to (null = collection root). Also the source of style examples. */
  folderId: string | null;
  /** Human label of the destination, shown in the proposal. */
  targetLabel?: string;
  /** Current request (live editor state). Enables "modify this request". */
  current?: CollectionItem | null;
  /** Start in modify mode (the builder shortcut does when a request is open). */
  initialMode?: 'create' | 'modify';
  /** Create a new request / replace the editor content. Called only after the user clicks Apply. */
  onApply: (item: CollectionItem, mode: 'create' | 'modify') => void;
  onClose: () => void;
}

/**
 * Command bar for natural-language requests. Collects the instruction, asks the local server (which
 * redacts and calls the configured model), then hands the draft to AiProposalDialog. Nothing is
 * applied without an explicit click on Apply.
 */
export default function AiCommandBar({ collectionId, folderId, targetLabel, current, initialMode, onApply, onClose }: AiCommandBarProps) {
  const { state, dispatch } = useApp();
  const ai = state.ai.settings;
  const ready = aiFeatureReady(ai, 'nlGenerate');
  const canModify = !!current && isHttpRestItem(current);
  const [mode, setMode] = useState<'create' | 'modify'>(canModify && initialMode === 'modify' ? 'modify' : 'create');
  const [instruction, setInstruction] = useState('');
  const [phase, setPhase] = useState<'input' | 'loading' | 'proposal'>('input');
  const [result, setResult] = useState<AiGenerateRequestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ instruction: string; mode: 'create' | 'modify' } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const destination = ai.baseUrl || (ai.provider === 'anthropic' ? 'Anthropic' : AI_PROVIDER_DEFAULT_BASE[ai.provider]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (phase === 'proposal') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { abortRef.current?.abort(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [phase, onClose]);

  const collection = state.collections.find(c => c._id === collectionId);

  async function generate(text: string, m: 'create' | 'modify') {
    if (!ready || !text.trim()) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase('loading');
    setError(null);
    setSubmitted({ instruction: text, mode: m });
    dispatch({ type: 'AI_REQUEST_START', payload: 'nlGenerate' });
    try {
      const r = await aiGenerateRequest({
        instruction: text.trim(),
        ...(m === 'modify' && current ? { current } : {}),
        // Style examples: neighbours only, redacted again by the server. Names of variables, never values.
        neighbors: collection ? collectNeighbors(collection.item, folderId, current?.id) : [],
        variables: collectVariableMeta({
          environments: state.environments,
          activeEnvironmentId: state.activeEnvironmentId,
          globalVariables: state.globalVariables,
          globalVariableMeta: state.globalVariableMeta,
          collectionVariables: state.collectionVariables[collectionId],
          collection,
        }),
        secretValues: Array.from(buildAllSecretValues(state.environments, state.globalVariables, state.globalVariableMeta)),
      }, ac.signal);
      if (ac.signal.aborted) return;
      dispatch({ type: 'AI_REQUEST_DONE', payload: 'nlGenerate' });
      setResult(r);
      setPhase('proposal');
    } catch (err) {
      if (ac.signal.aborted) { dispatch({ type: 'AI_REQUEST_DONE', payload: 'nlGenerate' }); return; }
      const e = toAiApiError(err);
      dispatch({ type: 'AI_REQUEST_FAIL', payload: { feature: 'nlGenerate', code: e.code, message: e.message } });
      setError(neutralizeAiText(e.message));
      setPhase('input');
    }
  }

  if (phase === 'proposal' && result && submitted) {
    return (
      <AiProposalDialog
        mode={submitted.mode}
        result={result}
        base={submitted.mode === 'modify' ? current ?? undefined : undefined}
        targetLabel={targetLabel}
        onApply={item => { onApply(item, submitted.mode); onClose(); }}
        onDiscard={onClose}
        onRegenerate={() => { setResult(null); void generate(submitted.instruction, submitted.mode); }}
      />
    );
  }

  const loading = phase === 'loading';
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh] bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) { abortRef.current?.abort(); onClose(); } }}
    >
      <div role="dialog" aria-label="Generate request with AI" className="bg-slate-900 border border-slate-700 rounded-lg shadow-2xl w-full max-w-xl mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <IconSparkle className="w-4 h-4 text-orange-400" />
            <h2 className="text-sm font-semibold text-slate-100">{mode === 'modify' ? 'Modify this request' : 'Generate a request'}</h2>
          </div>
          <button type="button" onClick={() => { abortRef.current?.abort(); onClose(); }} aria-label="Close" className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
        </div>

        <div className="px-4 py-3 space-y-2.5">
          {!ready ? (
            <p className="text-xs text-slate-400">
              {ai.enabled
                ? 'Turn on “Generate requests and tests from a description” in Settings → AI to use this.'
                : 'AI features are off. Enable them in Settings → AI to generate requests from a description.'}
            </p>
          ) : (
            <>
              {canModify && (
                <div className="flex gap-1 text-xs" role="radiogroup" aria-label="Mode">
                  {(['create', 'modify'] as const).map(m => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={mode === m}
                      disabled={loading}
                      onClick={() => setMode(m)}
                      className={`px-2 py-1 rounded border transition-colors ${mode === m ? 'border-orange-500/60 text-orange-300 bg-orange-500/10' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}
                    >
                      {m === 'create' ? 'New request' : 'Modify selected request'}
                    </button>
                  ))}
                </div>
              )}
              <textarea
                ref={inputRef}
                value={instruction}
                onChange={e => setInstruction(e.target.value)}
                disabled={loading}
                rows={3}
                maxLength={1000}
                placeholder={mode === 'modify'
                  ? 'e.g. add an X-Tenant header and paginate with page and limit'
                  : 'e.g. POST /users with name and email, check 201 and that the id is a UUID'}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void generate(instruction, mode); }
                }}
                className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-orange-500/60 resize-none"
              />
              <p className="text-[11px] text-slate-500">
                Sends your description, the names (not values) of your variables and a few neighbouring requests to {destination}. Credentials and secret values are redacted first. Nothing is added until you review and apply it.
              </p>
              {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
            </>
          )}
        </div>

        <div className="px-4 py-3 border-t border-slate-700 flex items-center justify-end gap-2">
          <button type="button" onClick={() => { abortRef.current?.abort(); onClose(); }} className="px-3 py-1.5 text-xs rounded bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-300 hover:text-slate-100 font-medium transition-colors">
            Cancel
          </button>
          {ready && (
            <button
              type="button"
              onClick={() => void generate(instruction, mode)}
              disabled={loading || !instruction.trim()}
              className="px-3 py-1.5 text-xs rounded bg-orange-600 hover:bg-orange-500 text-white font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {loading ? 'Generating…' : 'Generate'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
