/** Dispatched when a test-script snippet should be injected into a request tab's test editor. */
export const INJECT_TEST_SNIPPET = 'apilix:inject-test-snippet' as const;

export interface InjectTestSnippetDetail {
  snippet: string;
  /** ID of the request tab that originated the action. Used to route the snippet
   *  to the correct tab even if the user switches tabs before confirming. */
  tabId?: string | null;
}
