export type QuickSyncInitialPhase = 'pull-only' | 'merge-before-push';

export interface QuickSyncInitialPhaseInput {
  hasLocalUnpushed: boolean;
  readOnly: boolean;
}

export function getQuickSyncInitialPhase(input: QuickSyncInitialPhaseInput): QuickSyncInitialPhase {
  if (input.readOnly) return 'pull-only';
  return input.hasLocalUnpushed ? 'merge-before-push' : 'pull-only';
}

export type QuickSyncMergeAction = 'open-merge-review' | 'apply-merged-locally' | 'apply-merged-and-push';

export interface QuickSyncMergeActionInput {
  conflictCount: number;
  readOnly: boolean;
}

export function getQuickSyncMergeAction(input: QuickSyncMergeActionInput): QuickSyncMergeAction {
  if (input.conflictCount > 0) return 'open-merge-review';
  return input.readOnly ? 'apply-merged-locally' : 'apply-merged-and-push';
}

export interface QuickSyncSuccessMessageInput {
  readOnly: boolean;
  pulledData: boolean;
  pushed: boolean;
  remoteEmpty: boolean;
  usedMergePath: boolean;
}

export function getQuickSyncSuccessMessage(input: QuickSyncSuccessMessageInput): string {
  if (input.usedMergePath) {
    if (input.readOnly) return 'Synced (auto-merged locally)';
    return 'Synced (pulled + pushed)';
  }

  if (input.pulledData) {
    return input.pushed ? 'Synced (pulled + pushed)' : 'Synced (pulled)';
  }

  if (input.remoteEmpty) {
    return input.pushed ? 'Synced (remote empty, then pushed)' : 'Remote is empty — nothing to pull';
  }

  return 'Synced successfully';
}
