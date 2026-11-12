/** Bounds the response text sent to the model. The AI routes accept 2 MB of JSON in total. */

export const MAX_AI_BODY_CHARS = 900_000;
const MAX_AI_BODY_BYTES = 1_800_000;

export function truncateForAi(body: string): { text: string; truncated: boolean } {
  let text = body.length > MAX_AI_BODY_CHARS ? body.slice(0, MAX_AI_BODY_CHARS) : body;
  // What counts is the JSON-escaped UTF-8 size: multi-byte text exceeds the byte budget well before the
  // character budget, and quotes / newlines / control characters grow when escaped (a control character is 6 bytes).
  // (Up to 100 000 characters is at most 600 000 bytes once escaped: always under the budget.)
  if (text.length > 100_000) {
    const enc = new TextEncoder();
    while (text.length > 1000 && enc.encode(JSON.stringify(text)).length > MAX_AI_BODY_BYTES) text = text.slice(0, Math.floor(text.length * 0.8));
  }
  // Never end on half of a surrogate pair.
  if (text.length && body.length > text.length && /[\ud800-\udbff]/.test(text[text.length - 1])) text = text.slice(0, -1);
  return { text, truncated: text.length < body.length };
}
