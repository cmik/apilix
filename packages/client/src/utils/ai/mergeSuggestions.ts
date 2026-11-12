import type { AssertionSuggestion } from '../assertionInference';
import type { AiAssertionSuggestion } from './aiTypes';

const normScript = (s: string) => s.replace(/\s+/g, '');
const normTitle = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Merge model suggestions (already validated on the response by the server) with the local
 * deterministic ones. Model suggestions come first; a local suggestion is dropped only when a model
 * one says the same thing (same code, or same title). Local suggestions are the fallback and are
 * returned unchanged when there is nothing from the model.
 */
export function mergeSuggestions(local: AssertionSuggestion[], ai: AiAssertionSuggestion[]): AssertionSuggestion[] {
  const aiMapped: AssertionSuggestion[] = [];
  const scripts = new Set<string>();
  const titles = new Set<string>();
  for (const s of ai) {
    const script = normScript(s.script);
    const title = normTitle(s.title);
    if (scripts.has(script) || titles.has(title)) continue;
    scripts.add(script);
    titles.add(title);
    aiMapped.push({
      id: `ai-${s.id}`,
      title: s.title,
      kind: s.kind,
      script: s.script,
      confidence: s.confidence,
      ...(s.volatile ? { volatile: true } : {}),
      recommended: s.confidence === 'high' && !s.volatile && s.kind !== 'capture' && s.kind !== 'timing',
      source: 'ai',
    });
  }
  const keptLocal = local.filter(l => !scripts.has(normScript(l.script)) && !titles.has(normTitle(l.title)));
  return [...aiMapped, ...keptLocal];
}
