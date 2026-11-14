import { useEffect, useRef } from 'react';
import { AI_FIX_SCRIPT, type AiFixScriptDetail } from '../appEvents';

export type ScriptEditorTab = 'Tests' | 'Pre-request';

/**
 * Which script editor "Fix with AI" opens: the test script when the error comes from it, otherwise (unknown
 * origin) the test script if there is one, else the pre-request script.
 */
export function resolveFixScriptTab(kind: AiFixScriptDetail['kind'], testScript: string | undefined): ScriptEditorTab {
  if (kind === 'test') return 'Tests';
  return testScript && testScript.trim() ? 'Tests' : 'Pre-request';
}

/** Calls `handler` for every "Fix with AI" request raised by the console. The latest handler is always used. */
export function useAiFixScriptListener(handler: (detail: AiFixScriptDetail) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onFix = (e: Event) => {
      const d = (e as CustomEvent<AiFixScriptDetail>).detail;
      if (d && typeof d.tabId === 'string' && typeof d.error === 'string') ref.current(d);
    };
    document.addEventListener(AI_FIX_SCRIPT, onFix);
    return () => document.removeEventListener(AI_FIX_SCRIPT, onFix);
  }, []);
}
