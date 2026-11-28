import type { AppCollection, CollectionItem, RunnerIterationResult } from '../../types';

/** What "Explain with AI" explains for one runner result: the failed tests, or the failed request itself. */
export function runResultFailures(result: RunnerIterationResult): Array<{ name: string; error: string | null }> {
  if (result.protocol && result.protocol !== 'http') return [];
  if ((result as { skipped?: boolean }).skipped) return [];
  const failedTests = result.testResults.filter(t => t.passed === false).map(t => ({ name: t.name, error: t.error ?? null }));
  if (failedTests.length) return failedTests;
  if (result.error || (result.status >= 400 && result.testResults.length === 0)) {
    return [{ name: 'Request failed', error: result.error ?? `HTTP ${result.status} ${result.statusText}` }];
  }
  return [];
}

function collectLeaves(items: CollectionItem[], out: CollectionItem[] = []): CollectionItem[] {
  for (const it of items) {
    if (it.item) collectLeaves(it.item, out);
    else if (it.request) out.push(it);
  }
  return out;
}

/**
 * The collection item behind a result, only when it is unambiguous (same name, method and URL template).
 * A run result only keeps the names, so an ambiguous match is not guessed: the caller then sends the method and
 * URL template alone.
 */
export function findResultItem(collection: AppCollection | undefined, result: RunnerIterationResult): CollectionItem | null {
  if (!collection) return null;
  const urlOf = (it: CollectionItem) => (typeof it.request?.url === 'string' ? it.request.url : it.request?.url?.raw ?? '');
  const matches = collectLeaves(collection.item).filter(it =>
    it.name === result.name && String(it.request?.method ?? 'GET') === result.method && urlOf(it) === result.url);
  return matches.length === 1 ? matches[0] : null;
}

export function itemTestScript(item: CollectionItem | null): string {
  const exec = item?.event?.find(e => e.listen === 'test')?.script.exec;
  return Array.isArray(exec) ? exec.join('\n') : typeof exec === 'string' ? exec : '';
}
