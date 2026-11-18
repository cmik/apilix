// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { DEFAULT_AI_SETTINGS } from '../utils/aiDefaults';
import type { RunnerIteration } from '../types';

const { mockedUseApp, aiSummarizeRun } = vi.hoisted(() => ({ mockedUseApp: vi.fn(), aiSummarizeRun: vi.fn() }));
vi.mock('../store', () => ({ useApp: mockedUseApp }));
vi.mock('../api', () => ({
  aiSummarizeRun,
  toAiApiError: (e: { code?: string; message?: string }) => Object.assign(new Error(e?.message ?? 'x'), { code: e?.code ?? 'INTERNAL' }),
}));
vi.mock('./AiPreviewDialog', () => ({
  default: ({ runSummary }: { runSummary?: unknown }) => <div role="dialog" aria-label="preview"><pre data-testid="preview-payload">{JSON.stringify(runSummary)}</pre></div>,
}));

import RunSummaryPanel from './RunSummaryPanel';

const ready = { enabled: true, consentGiven: true, model: 'm', features: { ...DEFAULT_AI_SETTINGS.features, diagnose: true } };
const r = (over: object = {}) => ({ name: 'r', method: 'GET', url: 'https://api.test/users/12345', status: 401, statusText: '', responseTime: 1, testResults: [{ name: 'Status is 200', passed: false, error: 'expected 401 to equal 200' }], error: null, body: 'SECRET-BODY', ...over });
const results = (list: object[]) => [{ iteration: 1, dataRow: {}, results: list }] as unknown as RunnerIteration[];

function mockApp(settings: Partial<typeof DEFAULT_AI_SETTINGS>) {
  const dispatch = vi.fn();
  mockedUseApp.mockReturnValue({
    state: {
      ai: { settings: { ...DEFAULT_AI_SETTINGS, ...settings, features: { ...DEFAULT_AI_SETTINGS.features, ...(settings.features ?? {}) } } },
      environments: [{ _id: 'e', name: 'dev', values: [{ key: 'k', value: 'ENV-SECRET', enabled: true, secret: true }] }], globalVariables: {}, globalVariableMeta: {},
    },
    dispatch,
  });
  return dispatch;
}

describe('RunSummaryPanel', () => {
  beforeEach(() => { mockedUseApp.mockReset(); aiSummarizeRun.mockReset(); });
  afterEach(() => cleanup());

  it('renders nothing for a clean run', () => {
    mockApp(ready);
    const { container } = render(<RunSummaryPanel results={results([r({ status: 200, testResults: [] })])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the grouped failures without AI, and no AI button when the feature is off', () => {
    mockApp({ ...ready, enabled: false });
    render(<RunSummaryPanel results={results([r(), r({ url: 'https://api.test/users/99999' })])} />);
    expect(screen.getByText(/2 of 2 requests failed, in 1 group/)).toBeInTheDocument();
    expect(screen.getAllByTestId('run-summary-group')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Summarize with AI/ })).toBeNull();
    expect(aiSummarizeRun).not.toHaveBeenCalled();
  });

  it('sends nothing until the click, then only the aggregated groups (no body, no header), and shows notes per group', async () => {
    aiSummarizeRun.mockResolvedValue({ summary: 'Mostly 401. [x](http://evil.test) ENV-SECRET', groups: [{ id: 'g1', cause: 'Expired token', nextStep: 'Refresh it' }], sentGroups: 1, omittedGroups: 2, shapeOnly: false });
    const dispatch = mockApp(ready);
    render(<RunSummaryPanel results={results([r(), r(), r({ method: 'POST', status: 500, testResults: [], error: 'boom' })])} />);
    expect(aiSummarizeRun).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Preview what is sent' }));
    const preview = JSON.parse(screen.getByTestId('preview-payload').textContent!);
    expect(preview.groups).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Summarize with AI' }));
    await waitFor(() => expect(aiSummarizeRun).toHaveBeenCalledTimes(1));
    const p = aiSummarizeRun.mock.calls[0][0];
    expect(p.totals).toEqual({ requests: 3, failedRequests: 3, groups: 2 });
    expect(p.groups[0]).toMatchObject({ count: 2, method: 'GET', url: 'https://api.test/users/:id', status: 401 });
    expect(p.groups[0].examples).toHaveLength(2);
    expect(JSON.stringify(p)).not.toContain('SECRET-BODY');
    expect(p.secretValues).toEqual(['ENV-SECRET']);
    expect(aiSummarizeRun.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(await screen.findByText('AI-generated')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/evil\.test|ENV-SECRET/);
    expect(screen.getByText('Expired token')).toBeInTheDocument();
    expect(screen.getByText(/Next: Refresh it/)).toBeInTheDocument();
    expect(screen.getByText(/2 smaller groups were not sent/)).toBeInTheDocument();
    expect(dispatch.mock.calls.map(c => c[0].type)).toEqual(expect.arrayContaining(['AI_REQUEST_START', 'AI_REQUEST_DONE']));
  });

  it('records a failure, and a new run clears the previous answer', async () => {
    aiSummarizeRun.mockResolvedValueOnce({ summary: 'First answer', groups: [], sentGroups: 1, omittedGroups: 0, shapeOnly: false });
    const dispatch = mockApp(ready);
    const first = results([r()]);
    const { rerender } = render(<RunSummaryPanel results={first} />);
    await userEvent.click(screen.getByRole('button', { name: 'Summarize with AI' }));
    expect(await screen.findByText('First answer')).toBeInTheDocument();
    rerender(<RunSummaryPanel results={results([r(), r()])} />);
    expect(screen.queryByText('First answer')).toBeNull();
    aiSummarizeRun.mockRejectedValueOnce(Object.assign(new Error('Too large'), { code: 'TOO_LARGE' }));
    await userEvent.click(screen.getByRole('button', { name: 'Summarize with AI' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too large');
    expect(dispatch.mock.calls.find(c => c[0].type === 'AI_REQUEST_FAIL')![0].payload).toMatchObject({ feature: 'diagnose', code: 'TOO_LARGE' });
  });

  it('the disclosure says free text is masked, in every mode', () => {
    for (const sendResponseBodies of [true, false]) {
      mockApp({ ...ready, sendResponseBodies });
      const { unmount } = render(<RunSummaryPanel results={results([r()])} />);
      expect(screen.getByText(/quoted values, emails and numbers masked/)).toBeInTheDocument();
      unmount();
    }
  });
});
