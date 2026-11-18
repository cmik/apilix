import { useEffect, useMemo, useRef, useState } from 'react';
import { neutralizeAiText } from '@apilix/core/docs';
import { useApp } from '../store';
import { aiScriptAssist, toAiApiError, type AiScriptAssistPayload } from '../api';
import type { AiScriptAssistResult, AiScriptMode } from '../utils/ai/aiTypes';
import { aiFeatureReady, collectVariableMeta } from '../utils/ai/nlContext';
import { buildAllSecretValues, maskSecrets } from '../utils/secretMask';
import { AI_PROVIDER_DEFAULT_BASE } from '../utils/aiDefaults';
import { addCustomSnippet } from '../utils/customSnippets';
import { IconSparkle } from './Icons';
import AiPreviewDialog from './AiPreviewDialog';
import { AiScriptProposalDialog } from './AiProposalDialog';

export interface AiScriptFixRequest {
  /** Changes on every "Fix with AI" click so the same error can be requested twice. */
  nonce: number;
  /** The error text from the console or a failed test. */
  error: string;
}

export interface AiScriptAssistProps {
  target: 'prerequest' | 'test';
  /** The script in the editor. */
  value: string;
  /** Replace the editor content (only ever called after the user clicks Replace in the proposal dialog). */
  onApply: (script: string) => void;
  /** Opens the panel in "fix" mode with this error; nothing is sent until the user clicks Run. */
  fixRequest?: AiScriptFixRequest | null;
}

const MODES: Array<{ mode: AiScriptMode; label: string }> = [
  { mode: 'generate', label: 'Generate' },
  { mode: 'explain', label: 'Explain' },
  { mode: 'fix', label: 'Fix' },
  { mode: 'convert', label: 'Convert from Postman' },
];

function snippetName(instruction: string, script: string): string {
  const first = instruction.trim() || (/apx\.test\(\s*(["'`])(.*?)\1/.exec(script)?.[2] ?? '');
  return first.replace(/\s+/g, ' ').slice(0, 60) || 'AI snippet';
}

/**
 * "AI" entry point of a script editor: generate, explain, fix or convert. Nothing is sent until Run is
 * clicked (after the preview of what will be sent is available); the answer opens in a diff dialog and
 * nothing replaces the script without an explicit click. A proposed script is never run by the client.
 */
export default function AiScriptAssist({ target, value, onApply, fixRequest }: AiScriptAssistProps) {
  const { state, dispatch } = useApp();
  const settings = state.ai?.settings;
  const ready = !!settings && aiFeatureReady(settings, 'scriptAssist');
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AiScriptMode>('generate');
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<AiScriptAssistResult | null>(null);
  const [lastPayload, setLastPayload] = useState<AiScriptAssistPayload | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const seenFix = useRef<number | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (!fixRequest || seenFix.current === fixRequest.nonce) return;
    seenFix.current = fixRequest.nonce;
    setOpen(true);
    setMode('fix');
    setError(fixRequest.error);
    setNotice(null);
    setFailure(null);
  }, [fixRequest]);

  const secrets = useMemo(
    () => (ready ? buildAllSecretValues(state.environments, state.globalVariables, state.globalVariableMeta) : new Set<string>()),
    [ready, state.environments, state.globalVariables, state.globalVariableMeta],
  );
  const variableNames = useMemo(() => (ready ? collectVariableMeta({
    environments: state.environments,
    activeEnvironmentId: state.activeEnvironmentId,
    globalVariables: state.globalVariables,
    globalVariableMeta: state.globalVariableMeta,
    collectionVariables: state.activeRequest ? state.collectionVariables?.[state.activeRequest.collectionId] : undefined,
  }).map(v => v.name) : []), [ready, state.environments, state.activeEnvironmentId, state.globalVariables, state.globalVariableMeta, state.activeRequest, state.collectionVariables]);

  if (!ready) return null;

  if (!settings) return null;
  const destination = settings.baseUrl || (settings.provider === 'anthropic' ? 'Anthropic' : AI_PROVIDER_DEFAULT_BASE[settings.provider]);
  const shapeOnly = settings.sendResponseBodies === false;
  const kind = target === 'prerequest' ? 'prerequest' : 'test';
  const needsScript = mode !== 'generate';
  const canRun = !busy && (mode === 'generate' ? instruction.trim().length > 0 : value.trim().length > 0 && (mode !== 'fix' || error.trim().length > 0));

  const payloadFor = (): AiScriptAssistPayload => ({
    mode, kind,
    script: value,
    ...(mode === 'generate' ? { instruction } : {}),
    ...(mode === 'fix' ? { error } : {}),
    variableNames,
  });

  async function run(payload: AiScriptAssistPayload) {
    if (busy) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    setLastPayload(payload);
    dispatch({ type: 'AI_REQUEST_START', payload: 'scriptAssist' });
    try {
      const r = await aiScriptAssist({ ...payload, secretValues: Array.from(secrets) }, ac.signal);
      if (ac.signal.aborted) return;
      dispatch({ type: 'AI_REQUEST_DONE', payload: 'scriptAssist' });
      setResult(r);
    } catch (err) {
      if (ac.signal.aborted) { dispatch({ type: 'AI_REQUEST_DONE', payload: 'scriptAssist' }); return; }
      const e = toAiApiError(err);
      dispatch({ type: 'AI_REQUEST_FAIL', payload: { feature: 'scriptAssist', code: e.code, message: e.message } });
      setFailure(maskSecrets(neutralizeAiText(e.message), secrets));
    } finally {
      if (abortRef.current === ac) setBusy(false);
    }
  }

  function cancel() {
    abortRef.current?.abort();
    setBusy(false);
    dispatch({ type: 'AI_REQUEST_DONE', payload: 'scriptAssist' });
  }

  function saveSnippet(script: string) {
    const r = addCustomSnippet(target, { name: snippetName(lastPayload?.instruction ?? '', script), description: 'AI-generated', code: script });
    setNotice(r.ok ? 'Saved to My snippets in the snippet library.'
      : r.reason === 'limit' ? 'Could not save: the snippet library is full (50 snippets).'
        : r.reason === 'too-long' ? 'Could not save: the script is too long for a snippet.'
          : r.reason === 'empty' ? 'Nothing to save.' : 'Could not save: browser storage is unavailable.');
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="AI scripting assistant"
        aria-expanded={open}
        className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${open ? 'bg-orange-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-slate-100'}`}
      >
        <IconSparkle className="w-3.5 h-3.5" />
        AI
      </button>

      {open && (
        <div role="group" aria-label="AI scripting assistant" className="absolute right-0 top-full mt-1 z-50 w-[26rem] max-w-[90vw] bg-slate-800 border border-slate-600 rounded-lg shadow-2xl p-3 space-y-2">
          <div className="flex gap-1 flex-wrap" role="tablist" aria-label="Assistant mode">
            {MODES.map(m => (
              <button
                key={m.mode}
                type="button"
                role="tab"
                aria-selected={mode === m.mode}
                onClick={() => { setMode(m.mode); setFailure(null); }}
                className={`px-2 py-1 text-xs rounded border transition-colors ${mode === m.mode ? 'border-orange-500/60 text-orange-300 bg-orange-500/10' : 'border-slate-600 text-slate-300 hover:bg-slate-700'}`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode === 'generate' && (
            <textarea
              value={instruction}
              onChange={e => setInstruction(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder={kind === 'test' ? 'What should the test check? e.g. status is 201 and the id is saved to {{userId}}' : 'What should the script do before the request?'}
              aria-label="Instruction"
              className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-orange-500"
            />
          )}
          {mode === 'fix' && (
            <textarea
              value={error}
              onChange={e => setError(e.target.value)}
              rows={3}
              maxLength={800}
              placeholder="Paste the error from the console, or use Fix with AI on a console error"
              aria-label="Error to fix"
              className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-orange-500 font-mono"
            />
          )}
          {needsScript && value.trim().length === 0 && <p className="text-[11px] text-amber-400">This script is empty.</p>}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => run(payloadFor())}
              disabled={!canRun}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-orange-600 hover:bg-orange-500 text-white font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <IconSparkle className="w-3.5 h-3.5" />
              {busy ? 'Asking the model…' : mode === 'convert' ? 'Convert' : MODES.find(m => m.mode === mode)!.label}
            </button>
            {busy && <button type="button" className="text-xs text-slate-400 hover:text-slate-200" onClick={cancel}>Cancel</button>}
          </div>

          <p className="text-[11px] text-slate-500">
            {mode === 'convert'
              ? 'Postman references are converted by built-in rules without AI. Only what apx does not have is sent, to '
              : 'Sends '}
            {mode === 'convert'
              ? `${destination}.`
              : `${mode === 'generate' ? 'your instruction and ' : ''}the current script${mode === 'fix' ? ', the error' : ''} and the variable names (never values) to ${destination}. ${shapeOnly ? 'Shape only: string and number values in the script and quoted values in the error are replaced by placeholders, and comments are dropped.' : ''}`}
            {' '}Credentials and secret values are redacted first.{' '}
            <button type="button" className="underline hover:text-slate-300" onClick={() => setShowPreview(true)}>Preview what is sent</button>
          </p>
          {failure && <p role="alert" className="text-xs text-red-400">{failure}</p>}
          {notice && <p role="status" className="text-xs text-green-400">{notice}</p>}
        </div>
      )}

      {showPreview && (
        <AiPreviewDialog
          onClose={() => setShowPreview(false)}
          scriptAssist={{ ...payloadFor(), ...(mode === 'generate' ? { instruction: instruction.trim() || '(empty)' } : {}), ...(mode === 'fix' && !error.trim() ? { error: '(empty)' } : {}), ...(mode !== 'generate' && !value.trim() ? { script: '(empty)' } : {}) }}
        />
      )}

      {result && (
        <AiScriptProposalDialog
          result={result}
          current={value}
          kind={kind}
          secrets={secrets}
          busy={busy}
          onApply={(script) => { onApply(script); setResult(null); setOpen(false); }}
          onSaveSnippet={saveSnippet}
          onDiscard={() => setResult(null)}
          onRegenerate={result.usedModel && lastPayload ? () => run(lastPayload) : undefined}
        />
      )}
    </div>
  );
}
