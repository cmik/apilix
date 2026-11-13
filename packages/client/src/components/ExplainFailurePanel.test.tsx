// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

vi.mock('./AiPreviewDialog', () => ({ default: ({ onClose }: { onClose: () => void }) => <div role="dialog" aria-label="preview"><button onClick={onClose}>close preview</button></div> }));

import ExplainFailurePanel from './ExplainFailurePanel';

const result = {
  summary: 'Token rejected. See ![x](http://evil.test/p.png) and [click](http://evil.test) <b>bold</b> ENV-SECRET',
  likelyCauses: [{ cause: 'Expired token', confidence: 'high' as const }],
  suggestedFixes: [{ description: 'Refresh it', kind: 'environment' as const, snippet: 'apx.environment.set("token", "ENV-SECRET")' }],
  truncated: false,
  shapeOnly: false,
};
const base = { destination: 'Anthropic', shapeOnly: false, secrets: new Set(['ENV-SECRET']) };

describe('ExplainFailurePanel', () => {
  afterEach(() => cleanup());

  it('sends nothing until the click, then shows the badge and neutralised, re-masked text', async () => {
    const run = vi.fn().mockResolvedValue(result);
    const { container } = render(<ExplainFailurePanel {...base} run={run} />);
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByText(/to Anthropic/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Explain with AI/ }));
    await waitFor(() => expect(screen.getByText('AI-generated')).toBeInTheDocument());
    expect(run.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/evil\.test|ENV-SECRET/);
    expect(container.querySelector('img, a, b')).toBeNull();
    expect(screen.getByText('Expired token')).toBeInTheDocument();
    const pre = container.querySelector('pre')!;
    expect(pre.textContent).toContain('apx.environment.set');
    expect(pre.textContent).not.toContain('ENV-SECRET');
  });

  it('Cancel aborts the call, shows elapsed seconds while waiting and leaves no error', async () => {
    let signal!: AbortSignal;
    const run = vi.fn((s: AbortSignal) => { signal = s; return new Promise<never>(() => { /* never settles */ }); });
    render(<ExplainFailurePanel {...base} run={run} />);
    await userEvent.click(screen.getByRole('button', { name: /Explain with AI/ }));
    expect(screen.getByRole('button', { name: /Asking the model… 0s/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: /Explain with AI/ })).toBeEnabled();
  });

  it('shows an error without secrets', async () => {
    const run = vi.fn().mockRejectedValue(new Error('provider said ENV-SECRET <i>x</i>'));
    render(<ExplainFailurePanel {...base} run={run} />);
    await userEvent.click(screen.getByRole('button', { name: /Explain with AI/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('ENV-SECRET');
  });

  it('the Copy button copies the (masked) snippet only', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ExplainFailurePanel {...base} run={vi.fn().mockResolvedValue(result)} />);
    await userEvent.click(screen.getByRole('button', { name: /Explain with AI/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('apx.environment.set');
    expect(writeText.mock.calls[0][0]).not.toContain('ENV-SECRET');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('describes the shape-only mode and opens the preview dialog', async () => {
    render(<ExplainFailurePanel {...base} shapeOnly run={vi.fn()} />);
    expect(screen.getByText(/structure of the response/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Preview what is sent' }));
    expect(screen.getByRole('dialog', { name: 'preview' })).toBeInTheDocument();
  });
});
