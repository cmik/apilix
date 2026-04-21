/** Default timeout for sync requests to remote providers (15 s). */
export const SYNC_TIMEOUT_MS = 15_000;

/**
 * Longer timeout for the git adapter's calls to the local Express server,
 * which itself performs git network I/O before responding.
 */
export const GIT_SYNC_TIMEOUT_MS = 30_000;

/** Returns an AbortSignal that fires after `ms` milliseconds. */
export function syncSignal(ms: number = SYNC_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(ms);
}

/**
 * Call inside a `catch` block on any sync `fetch` call.
 * Converts a `TimeoutError` / `AbortError` into a human-readable message,
 * and re-throws all other errors unchanged.
 */
export function handleSyncFetchError(err: unknown, providerLabel: string): never {
  if (
    err instanceof DOMException &&
    (err.name === 'TimeoutError' || err.name === 'AbortError')
  ) {
    throw new Error(
      `${providerLabel} sync request timed out — server did not respond in time`,
    );
  }
  throw err instanceof Error ? err : new Error(String(err));
}
