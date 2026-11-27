// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ConflictPackage, ResponseSchema, WorkspaceData } from '../types';
import { mergeWorkspaces } from '../utils/merge/workspaceMerge';
import ConflictMergeModal from './ConflictMergeModal';

const ws = (schemas: ResponseSchema[]): WorkspaceData => ({
  collections: [], environments: [], activeEnvironmentId: null, collectionVariables: {}, globalVariables: {},
  cookieJar: {}, mockCollections: [], mockRoutes: [], mockPort: 3002, responseSchemas: schemas,
});
const sch = (title: string, version: number): ResponseSchema => ({ id: 'a', name: 'User', schema: { type: 'object', title }, version });

function pkg(): ConflictPackage {
  const baseData = ws([sch('base', 1)]); const localData = ws([sch('local', 2)]); const remoteData = ws([sch('remote', 3)]);
  return { baseData, localData, remoteData, remoteWasEmpty: false, mergeResult: mergeWorkspaces(baseData, localData, remoteData), remoteVersion: null, syncConfig: {} as never };
}

afterEach(cleanup);

describe('ConflictMergeModal: response schema conflicts', () => {
  it('lists the schema under "Response Schemas" and applies the remote choice', () => {
    const onResolved = vi.fn();
    render(<ConflictMergeModal conflictPackage={pkg()} onResolved={onResolved} onKeepLocal={() => {}} onKeepRemote={() => {}} onClose={() => {}} />);
    expect(screen.getByText('Response Schemas')).toBeInTheDocument();
    expect(screen.getByText('User')).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Take Remote/));
    fireEvent.click(screen.getByText(/Apply Merged/i));
    const merged = onResolved.mock.calls[0][0] as WorkspaceData;
    expect(merged.responseSchemas![0].schema).toEqual({ type: 'object', title: 'remote' });
  });

  it('keeps the local schema when Take Local is chosen', () => {
    const onResolved = vi.fn();
    render(<ConflictMergeModal conflictPackage={pkg()} onResolved={onResolved} onKeepLocal={() => {}} onKeepRemote={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByText(/Take Local/));
    fireEvent.click(screen.getByText(/Apply Merged/i));
    expect((onResolved.mock.calls[0][0] as WorkspaceData).responseSchemas![0].schema).toEqual({ type: 'object', title: 'local' });
  });
});
