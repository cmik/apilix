/** Dispatched when a test-script snippet should be injected into a request tab's test editor. */
export const INJECT_TEST_SNIPPET = 'apilix:inject-test-snippet' as const;

export interface InjectTestSnippetDetail {
  snippet: string;
  /** ID of the request tab that originated the action. Used to route the snippet
   *  to the correct tab even if the user switches tabs before confirming. */
  tabId?: string | null;
  /** When set, the snippet is skipped if the test script already contains any of these substrings. */
  skipIfPresent?: string[];
}

/** Dispatched by the console ("Fix with AI") to open the AI scripting panel on a request tab's script, with the error. */
export const AI_FIX_SCRIPT = 'apilix:ai-fix-script' as const;

export interface AiFixScriptDetail {
  tabId: string;
  /** The script error as shown in the console. */
  error: string;
  /** `test` when the error comes from the test script; `auto` when unknown (the editor picks the script that exists). */
  kind: 'test' | 'auto';
}
