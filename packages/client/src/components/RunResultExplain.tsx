import { useMemo } from 'react';
import { useApp } from '../store';
import { aiExplainFailure, toAiApiError } from '../api';
import type { AppCollection, CollectionItem, RunnerIterationResult } from '../types';
import { aiFeatureReady, collectVariableMeta } from '../utils/ai/nlContext';
import { truncateForAi } from '../utils/ai/truncate';
import { buildAllSecretValues } from '../utils/secretMask';
import { AI_PROVIDER_DEFAULT_BASE } from '../utils/aiDefaults';
import { findResultItem, itemTestScript, runResultFailures } from '../utils/ai/runResultExplain';
import ExplainFailurePanel from './ExplainFailurePanel';

/**
 * "Explain with AI" for one failed result of a collection run. Same guarantees as in the response viewer:
 * nothing is sent until the user clicks, the answer is text only. The request is the collection's template
 * (never the resolved URL, headers or body, which carry variable values).
 */
export default function RunResultExplain({ result, collection }: { result: RunnerIterationResult; collection?: AppCollection }) {
  const { state, dispatch } = useApp();
  const settings = state.ai?.settings;
  const failures = useMemo(() => runResultFailures(result), [result]);
  const ready = !!settings && failures.length > 0 && aiFeatureReady(settings, 'diagnose');
  const item = useMemo(() => (ready ? findResultItem(collection, result) : null), [ready, collection, result]);
  const secrets = useMemo(
    () => (ready ? buildAllSecretValues(state.environments, state.globalVariables, state.globalVariableMeta) : new Set<string>()),
    [ready, state.environments, state.globalVariables, state.globalVariableMeta],
  );
  const testScript = useMemo(() => itemTestScript(item), [item]);
  const variableNames = useMemo(() => (!ready ? [] : collectVariableMeta({
    environments: state.environments,
    activeEnvironmentId: state.activeEnvironmentId,
    globalVariables: state.globalVariables,
    globalVariableMeta: state.globalVariableMeta,
    collectionVariables: collection ? state.collectionVariables?.[collection._id] : undefined,
    collection,
  }).map(v => v.name)), [ready, collection, state.environments, state.activeEnvironmentId, state.globalVariables, state.globalVariableMeta, state.collectionVariables]);

  if (!ready || !settings) return null;
  const request: CollectionItem['request'] = item?.request ?? { method: result.method, url: result.url } as CollectionItem['request'];

  const run = async (signal: AbortSignal) => {
    dispatch({ type: 'AI_REQUEST_START', payload: 'diagnose' });
    try {
      const { text: body, truncated } = truncateForAi(result.body ?? '');
      const r = await aiExplainFailure({
        request,
        name: result.name,
        response: { status: result.status, statusText: result.statusText, headers: result.headers ?? {}, body, responseTime: result.responseTime },
        failures,
        testScript,
        variableNames,
        secretValues: Array.from(secrets),
      }, signal);
      dispatch({ type: 'AI_REQUEST_DONE', payload: 'diagnose' });
      return truncated ? { ...r, truncated: true } : r;
    } catch (err) {
      if (signal.aborted) {
        dispatch({ type: 'AI_REQUEST_DONE', payload: 'diagnose' });
        throw err;
      }
      const e = toAiApiError(err);
      dispatch({ type: 'AI_REQUEST_FAIL', payload: { feature: 'diagnose', code: e.code, message: e.message } });
      throw e;
    }
  };

  return (
    <div className="px-4 pb-2 bg-slate-800/30" onClick={e => e.stopPropagation()}>
      <ExplainFailurePanel
        destination={settings.baseUrl || (settings.provider === 'anthropic' ? 'Anthropic' : AI_PROVIDER_DEFAULT_BASE[settings.provider])}
        shapeOnly={settings.sendResponseBodies === false}
        secrets={secrets}
        run={run}
        previewEvidence={{ failures, testScript, variableNames }}
      />
    </div>
  );
}
