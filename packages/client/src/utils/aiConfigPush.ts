/**
 * Pushes the AI config to the local server reliably:
 *  - calls are serialized, so a PUT and a later DELETE reach the server in that order;
 *  - a newer push supersedes older ones (queued calls and pending retries are dropped);
 *  - failures are retried with a growing delay (the server may still be starting or restarting).
 */
export const AI_PUSH_RETRY_DELAYS_MS = [2000, 5000, 15000, 30000];

export interface AiConfigPusher {
  /** Start a push, superseding earlier ones. Returns a cancel function. */
  push(send: () => Promise<unknown>, delays?: number[]): () => void;
  /** Push now, once, superseding pending retries; resolves when the server has answered (errors propagate). */
  flush(send: () => Promise<unknown>): Promise<void>;
}

export function createAiConfigPusher(): AiConfigPusher {
  let chain: Promise<unknown> = Promise.resolve();
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  return {
    push(send, delays = AI_PUSH_RETRY_DELAYS_MS) {
      const gen = ++generation;
      clearTimer();
      const attempt = (i: number) => {
        chain = chain
          .then(() => (gen === generation ? send() : undefined))
          .then(() => undefined, () => {
            if (gen === generation && i < delays.length) timer = setTimeout(() => attempt(i + 1), delays[i]);
          });
      };
      attempt(0);
      return () => { if (gen === generation) { generation++; clearTimer(); } };
    },
    flush(send) {
      generation++;
      clearTimer();
      const run = chain.then(() => send());
      chain = run.then(() => undefined, () => undefined);
      return run.then(() => undefined);
    },
  };
}
