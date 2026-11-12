/** Bounds the response text sent to the model. The AI routes accept 2 MB of JSON in total. */

export const MAX_AI_BODY_CHARS = 900_000;
const MAX_AI_BODY_BYTES = 1_800_000;

export function truncateForAi(body: string): { text: string; truncated: boolean } {
  let text = body.length > MAX_AI_BODY_CHARS ? body.slice(0, MAX_AI_BODY_CHARS) : body;
  // Multi-byte text can exceed the byte budget well before the character budget.
  if (text.length > 100_000) {
    const enc = new TextEncoder();
    while (text.length > 1000 && enc.encode(text).length > MAX_AI_BODY_BYTES) text = text.slice(0, Math.floor(text.length * 0.8));
  }
  return { text, truncated: text.length < body.length };
}
