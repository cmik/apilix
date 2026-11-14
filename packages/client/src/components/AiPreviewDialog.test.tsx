// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DEFAULT_AI_SETTINGS } from '../utils/aiDefaults';

const { aiPreview } = vi.hoisted(() => ({ aiPreview: vi.fn() }));
vi.mock('../store', () => ({
  useApp: () => ({
    state: {
      activeRequest: { collectionId: 'c', item: { name: 'r', request: { method: 'GET', url: 'http://x' } } },
      response: { status: 200, statusText: 'OK', headers: {}, body: '{}' },
      ai: { settings: DEFAULT_AI_SETTINGS }, activeEnvironmentId: null, environments: [],
      globalVariables: {}, globalVariableMeta: {}, collectionVariables: {},
    },
    dispatch: vi.fn(),
  }),
}));
vi.mock('../api', () => ({ aiPreview, toAiApiError: (e: Error) => e }));

import AiPreviewDialog from './AiPreviewDialog';

describe('AiPreviewDialog', () => {
  afterEach(() => { cleanup(); aiPreview.mockReset(); });

  it('sends the explain evidence only when given, and shows the returned sections', async () => {
    aiPreview.mockResolvedValue({ sections: [{ label: 'Failed assertions', text: '[{"name":"n"}]', truncated: false }], estimatedTokens: 5, redactions: 0 });
    const explain = { failures: [{ name: 'n', error: 'boom' }], testScript: 's', variableNames: ['token'] };
    render(<AiPreviewDialog onClose={() => {}} explain={explain} />);
    expect(await screen.findByText('Failed assertions')).toBeInTheDocument();
    expect(aiPreview.mock.calls[0][0].explain).toEqual(explain);
  });

  it('does not add explain to the payload for other callers', async () => {
    aiPreview.mockResolvedValue({ sections: [], estimatedTokens: 0, redactions: 0 });
    render(<AiPreviewDialog onClose={() => {}} />);
    await waitFor(() => expect(aiPreview).toHaveBeenCalled());
    expect('explain' in aiPreview.mock.calls[0][0]).toBe(false);
  });

  it('scripting assistant: previews the script payload only, never the active request or response', async () => {
    aiPreview.mockResolvedValue({ sections: [{ label: 'Script, error and variable names (as sent)', text: '{}', truncated: false }], estimatedTokens: 1, redactions: 0 });
    const scriptAssist = { mode: 'fix' as const, kind: 'test' as const, script: 'apx.broken()', error: 'boom' };
    render(<AiPreviewDialog onClose={() => {}} scriptAssist={scriptAssist} />);
    expect(await screen.findByText('Script, error and variable names (as sent)')).toBeInTheDocument();
    const sent = aiPreview.mock.calls[0][0];
    expect(sent.scriptAssist).toEqual(scriptAssist);
    expect('item' in sent || 'response' in sent || 'variables' in sent || 'explain' in sent).toBe(false);
    expect(screen.getByText(/scripting assistant would send/)).toBeInTheDocument();
  });
});
