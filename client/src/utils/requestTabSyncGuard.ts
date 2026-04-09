import type { AppCollection } from '../types';

export interface UnsavedRequestTabSummary {
  dirtyTabIds: string[];
  existingDirtyTabIds: string[];
  draftDirtyTabIds: string[];
}

export interface SaveExistingRequestTabsResult {
  savedTabIds: string[];
  skippedTabIds: string[];
  updatedCollections: AppCollection[];
}

export async function getUnsavedRequestTabSummary(): Promise<UnsavedRequestTabSummary> {
  return new Promise(resolve => {
    document.dispatchEvent(new CustomEvent('apilix:request-tab-sync-summary', { detail: { resolve } }));
  });
}

export async function saveExistingRequestTabs(tabIds?: string[]): Promise<SaveExistingRequestTabsResult> {
  return new Promise(resolve => {
    document.dispatchEvent(new CustomEvent('apilix:request-tab-sync-save-existing', { detail: { resolve, tabIds } }));
  });
}

export type WorkspaceSwitchDecision = 'save-and-switch' | 'switch-anyway' | 'cancel';

/**
 * Checks for dirty non-draft tabs and, if any exist, dispatches an event so the
 * app-level WorkspaceSwitchGuardModal can show the three-button dialog.
 * Resolves immediately with 'switch-anyway' when there are no dirty tabs.
 */
export async function requestWorkspaceSwitchGuard(): Promise<{
  decision: WorkspaceSwitchDecision;
  summary: UnsavedRequestTabSummary;
}> {
  const summary = await getUnsavedRequestTabSummary();
  if (summary.dirtyTabIds.length === 0) {
    return { decision: 'switch-anyway', summary };
  }
  return new Promise(resolve => {
    document.dispatchEvent(new CustomEvent('apilix:workspace-switch-guard', {
      detail: {
        summary,
        resolve: (decision: WorkspaceSwitchDecision) => resolve({ decision, summary }),
      },
    }));
  });
}

export function buildUnsavedRequestTabsConfirmMessage(actionLabel: 'sync' | 'push', summary: UnsavedRequestTabSummary): string {
  const parts: string[] = [];
  const dirtyCount = summary.dirtyTabIds.length;
  const existingCount = summary.existingDirtyTabIds.length;
  const draftCount = summary.draftDirtyTabIds.length;

  parts.push(
    `You have ${dirtyCount} unsaved request tab${dirtyCount === 1 ? '' : 's'}.`,
  );

  if (existingCount > 0) {
    parts.push(
      `Confirm to save ${existingCount} existing request${existingCount === 1 ? '' : 's'} before ${actionLabel}.`,
    );
  }

  if (draftCount > 0) {
    parts.push(
      `${draftCount} draft request tab${draftCount === 1 ? '' : 's'} will stay unsaved.`,
    );
  }

  parts.push('Cancel will stop this action.');

  return parts.join(' ');
}