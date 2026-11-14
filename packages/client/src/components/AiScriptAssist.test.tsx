// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { DEFAULT_AI_SETTINGS } from '../utils/aiDefaults';
import { loadCustomSnippets } from '../utils/customSnippets';

const { mockedUseApp, aiScriptAssist } = vi.hoisted(() => ({ mockedUseApp: vi.fn(), aiScriptAssist: vi.fn() }));

vi.mock('../store', () => ({ useApp: mockedUseApp, generateId: () => 'test-id' }));
vi.mock('../api', () => ({
  aiScriptAssist,
  toAiApiError: (e: { code?: string; message?: string }) => Object.assign(new Error(e?.message ?? 'x'), { code: e?.code ?? 'INTERNAL' }),
}));
vi.mock('./AiPreviewDialog', () => ({
  default: ({ onClose, scriptAssist }: { onClose: () => void; scriptAssist?: unknown }) => (
    <div role="dialog" aria-label="preview"><pre data-testid="preview-payload">{JSON.stringify(scriptAssist)}</pre><button onClick={onClose}>close preview</button></div>
  ),
}));

import AiScriptAssist from './AiScriptAssist';

const ready = { enabled: true, consentGiven: true, model: 'm', features: { ...DEFAULT_AI_SETTINGS.features, scriptAssist: true } };
const GOOD = "apx.test('ok', () => { apx.expect(apx.response.code).to.equal(200); });";
const result = (over: object = {}) => ({
  mode: 'generate', explanation: 'Checks the status.', script: GOOD, deterministic: false, usedModel: true,
  validation: { validated: true, executed: true, errors: [], flags: [] }, warnings: [], retried: false, ...over,
});

function mockApp(settings: Partial<typeof DEFAULT_AI_SETTINGS>) {
  const dispatch = vi.fn();
  mockedUseApp.mockReturnValue({
    state: {
      ai: { settings: { ...DEFAULT_AI_SETTINGS, ...settings, features: { ...DEFAULT_AI_SETTINGS.features, ...(settings.features ?? {}) } } },
      activeEnvironmentId: 'e1', activeRequest: { collectionId: 'c1' },
      environments: [{ _id: 'e1', name: 'dev', values: [{ key: 'token', value: 'ENV-SECRET', enabled: true, secret: true }, { key: 'baseUrl', value: 'http://x', enabled: true }] }],
      globalVariables: {}, globalVariableMeta: {}, collectionVariables: { c1: { page: '2' } },
    },
    dispatch,
  });
  return dispatch;
}

function setup(settings: Partial<typeof DEFAULT_AI_SETTINGS> = ready, props: Partial<Parameters<typeof AiScriptAssist>[0]> = {}) {
  const dispatch = mockApp(settings);
  const onApply = vi.fn();
  const utils = render(<AiScriptAssist target="test" value="apx.test('old', () => {});" onApply={onApply} {...props} />);
  return { dispatch, onApply, ...utils };
}

const openPanel = () => userEvent.click(screen.getByRole('button', { name: /^AI$/ }));

describe('AiScriptAssist', () => {
  beforeEach(() => { mockedUseApp.mockReset(); aiScriptAssist.mockReset(); localStorage.clear(); });
  afterEach(() => cleanup());

  it.each([
    ['AI is off', { ...ready, enabled: false }],
    ['no consent', { ...ready, consentGiven: false }],
    ['the feature is off', { ...ready, features: { ...DEFAULT_AI_SETTINGS.features, scriptAssist: false, diagnose: true } }],
  ])('renders nothing when %s', (_l, settings) => {
    setup(settings);
    expect(screen.queryByRole('button', { name: /^AI$/ })).toBeNull();
  });

  it('shows the disclosure, sends nothing on open, and lets the user preview what is sent', async () => {
    setup();
    await openPanel();
    expect(aiScriptAssist).not.toHaveBeenCalled();
    expect(screen.getByText(/never values\) to/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Instruction'), 'check status');
    await userEvent.click(screen.getByRole('button', { name: 'Preview what is sent' }));
    const payload = JSON.parse(screen.getByTestId('preview-payload').textContent!);
    expect(payload).toMatchObject({ mode: 'generate', kind: 'test', instruction: 'check status', script: "apx.test('old', () => {});" });
    expect(aiScriptAssist).not.toHaveBeenCalled();
  });

  it('generate: sends names only, shows a diff, applies nothing until Replace is clicked', async () => {
    aiScriptAssist.mockResolvedValue(result());
    const { onApply, dispatch } = setup();
    await openPanel();
    await userEvent.type(screen.getByLabelText('Instruction'), 'check status');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(aiScriptAssist).toHaveBeenCalledTimes(1));
    const p = aiScriptAssist.mock.calls[0][0];
    expect(p).toMatchObject({ mode: 'generate', kind: 'test', instruction: 'check status', script: "apx.test('old', () => {});" });
    expect(p.variableNames).toEqual(expect.arrayContaining(['token', 'baseUrl', 'page']));
    expect(p.variableNames).not.toContain('ENV-SECRET');
    expect(p.secretValues).toEqual(['ENV-SECRET']);
    expect(aiScriptAssist.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(await screen.findByRole('dialog', { name: 'AI script proposal' })).toBeInTheDocument();
    expect(screen.getByText('AI-generated')).toBeInTheDocument();
    expect(screen.getByText(/Test-run in the sandbox/)).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    expect(dispatch.mock.calls.map(c => c[0].type)).toEqual(expect.arrayContaining(['AI_REQUEST_START', 'AI_REQUEST_DONE']));
    await userEvent.click(screen.getByRole('button', { name: 'Replace script' }));
    expect(onApply).toHaveBeenCalledWith(GOOD);
  });

  it('Ignore and Escape discard the proposal without touching the script', async () => {
    aiScriptAssist.mockResolvedValue(result());
    const { onApply } = setup();
    await openPanel();
    await userEvent.type(screen.getByLabelText('Instruction'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByRole('dialog', { name: 'AI script proposal' });
    await userEvent.click(screen.getByRole('button', { name: 'Ignore' }));
    expect(screen.queryByRole('dialog', { name: 'AI script proposal' })).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('explain: text only, no Replace, no snippet button', async () => {
    aiScriptAssist.mockResolvedValue(result({ mode: 'explain', script: undefined, validation: undefined, explanation: 'It checks the code.' }));
    const { onApply } = setup();
    await openPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Explain' }));
    await userEvent.click(screen.getByRole('button', { name: 'Explain' }));
    expect(await screen.findByText('It checks the code.')).toBeInTheDocument();
    expect(aiScriptAssist.mock.calls[0][0]).toMatchObject({ mode: 'explain' });
    expect(aiScriptAssist.mock.calls[0][0].instruction).toBeUndefined();
    expect(screen.queryByRole('button', { name: /Replace/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save as snippet' })).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('a refused script is shown as refused and cannot be applied; flags are listed', async () => {
    aiScriptAssist.mockResolvedValue(result({ script: undefined, validation: { validated: false, executed: false, errors: [{ reason: '"require" is not allowed in a validated script' }], refused: '"require" is not allowed in a validated script', flags: ['require'] } }));
    setup();
    await openPanel();
    await userEvent.type(screen.getByLabelText('Instruction'), 'read a file');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    const alert = await screen.findByText(/Refused for security/);
    expect(alert).toBeInTheDocument();
    expect(screen.getByText('require', { selector: 'span.font-mono' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Replace/ })).toBeNull();
  });

  it('not validated and not executed are shown differently; an unvalidated script says "Replace anyway"', async () => {
    aiScriptAssist.mockResolvedValueOnce(result({ validation: { validated: false, executed: false, errors: [{ reason: 'syntax error: x' }], flags: [] } }));
    setup();
    await openPanel();
    await userEvent.type(screen.getByLabelText('Instruction'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByText(/Not validated: review it carefully/)).toBeInTheDocument();
    expect(screen.getByText('syntax error: x')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace anyway' })).toBeInTheDocument();
    cleanup();
    aiScriptAssist.mockResolvedValueOnce(result({ validation: { validated: false, executed: false, errors: [], flags: [] } }));
    setup();
    await openPanel();
    await userEvent.type(screen.getByLabelText('Instruction'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByText(/This build cannot run scripts in an isolated process/)).toBeInTheDocument();
  });

  it('convert: a deterministic result says no AI was involved and offers no Regenerate', async () => {
    aiScriptAssist.mockResolvedValue(result({ mode: 'convert', deterministic: true, usedModel: false, explanation: 'Converted automatically: 3 pm references renamed to apx.' }));
    setup(ready, { value: "pm.test('a', () => {});" });
    await openPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Convert from Postman' }));
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(await screen.findByText('Converted without AI')).toBeInTheDocument();
    expect(screen.queryByText('AI-generated')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull();
    expect(aiScriptAssist.mock.calls[0][0]).toMatchObject({ mode: 'convert', script: "pm.test('a', () => {});" });
  });

  it('model text is neutralised and secrets are masked again', async () => {
    aiScriptAssist.mockResolvedValue(result({ explanation: 'See [x](http://evil.test) ![i](http://evil.test/i.png) <b>b</b> ENV-SECRET', warnings: ['leaked ENV-SECRET'] }));
    const { container } = setup();
    await openPanel();
    await userEvent.type(screen.getByLabelText('Instruction'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByRole('dialog', { name: 'AI script proposal' });
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/evil\.test|ENV-SECRET/);
    expect(document.querySelector('[role="dialog"] img, [role="dialog"] a, [role="dialog"] b')).toBeNull();
    expect(container).toBeTruthy();
  });

  it('Save as snippet stores the script in My snippets; Replace is not triggered', async () => {
    aiScriptAssist.mockResolvedValue(result());
    const { onApply } = setup();
    await openPanel();
    await userEvent.type(screen.getByLabelText('Instruction'), 'check status is 200');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save as snippet' }));
    const saved = loadCustomSnippets('test');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: 'check status is 200', code: GOOD, description: 'AI-generated' });
    expect(loadCustomSnippets('prerequest')).toHaveLength(0);
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText('Saved to My snippets in the snippet library.')).toBeInTheDocument();
  });

  it('"Fix with AI" opens the panel in fix mode with the error and sends nothing until Run', async () => {
    aiScriptAssist.mockResolvedValue(result({ mode: 'fix' }));
    const { rerender, onApply } = setup(ready, { fixRequest: null });
    expect(screen.queryByLabelText('Error to fix')).toBeNull();
    rerender(<AiScriptAssist target="test" value="apx.broken()" onApply={onApply} fixRequest={{ nonce: 1, error: 'apx.broken is not a function' }} />);
    expect(await screen.findByLabelText('Error to fix')).toHaveValue('apx.broken is not a function');
    expect(aiScriptAssist).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Fix' }));
    await waitFor(() => expect(aiScriptAssist).toHaveBeenCalledTimes(1));
    expect(aiScriptAssist.mock.calls[0][0]).toMatchObject({ mode: 'fix', script: 'apx.broken()', error: 'apx.broken is not a function' });
    await screen.findByRole('dialog', { name: 'AI script proposal' });
    expect(onApply).not.toHaveBeenCalled();
  });

  it('the same fix request (same nonce, new object) does not overwrite what the user typed; a new nonce does', async () => {
    const { rerender, onApply } = setup(ready, { value: 'apx.broken()', fixRequest: { nonce: 7, error: 'first error' } });
    const box = await screen.findByLabelText('Error to fix');
    await userEvent.clear(box);
    await userEvent.type(box, 'edited');
    rerender(<AiScriptAssist target="test" value="apx.broken()" onApply={onApply} fixRequest={{ nonce: 7, error: 'first error' }} />);
    expect(screen.getByLabelText('Error to fix')).toHaveValue('edited');
    rerender(<AiScriptAssist target="test" value="apx.broken()" onApply={onApply} fixRequest={{ nonce: 8, error: 'second error' }} />);
    expect(screen.getByLabelText('Error to fix')).toHaveValue('second error');
  });

  it('Replace is disabled when the proposal equals the current script', async () => {
    aiScriptAssist.mockResolvedValue(result({ script: "apx.test('old', () => {});" }));
    setup();
    await openPanel();
    await userEvent.type(screen.getByLabelText('Instruction'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByText('The proposal is identical to the current script.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace script' })).toBeDisabled();
  });

  it('a failure is shown, recorded, and a cancellation is not recorded as a failure', async () => {
    aiScriptAssist.mockRejectedValue(Object.assign(new Error('Too large'), { code: 'TOO_LARGE' }));
    const { dispatch } = setup();
    await openPanel();
    await userEvent.type(screen.getByLabelText('Instruction'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too large');
    expect(dispatch.mock.calls.find(c => c[0].type === 'AI_REQUEST_FAIL')![0].payload).toMatchObject({ feature: 'scriptAssist', code: 'TOO_LARGE' });
  });

  it('Run is disabled without an instruction, and for explain/convert on an empty script', async () => {
    setup(ready, { value: '' });
    await openPanel();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled();
    await userEvent.click(screen.getByRole('tab', { name: 'Explain' }));
    expect(screen.getByRole('button', { name: 'Explain' })).toBeDisabled();
    expect(screen.getByText('This script is empty.')).toBeInTheDocument();
  });
});
