// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { resolveFixScriptTab, useAiFixScriptListener, clearConsumedFix } from './fixScript';
import { AI_FIX_SCRIPT } from '../appEvents';

describe('resolveFixScriptTab', () => {
  it.each([
    ['test', undefined, 'Tests'],
    ['test', '', 'Tests'],
    ['auto', 'apx.test("x", () => {})', 'Tests'],
    ['auto', '   \n', 'Pre-request'],
    ['auto', undefined, 'Pre-request'],
  ] as const)('%s with test script %j opens %s', (kind, script, expected) => {
    expect(resolveFixScriptTab(kind, script)).toBe(expected);
  });
});

describe('useAiFixScriptListener', () => {
  const fire = (detail: unknown) => document.dispatchEvent(new CustomEvent(AI_FIX_SCRIPT, { detail }));

  it('calls the latest handler for a well-formed request and ignores malformed ones', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ h }) => useAiFixScriptListener(h), { initialProps: { h: first } });
    fire({ tabId: 't1', error: 'boom', kind: 'test' });
    expect(first).toHaveBeenCalledWith({ tabId: 't1', error: 'boom', kind: 'test' });
    rerender({ h: second });
    fire({ tabId: 't2', error: 'bang', kind: 'auto' });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    fire(undefined);
    fire({ tabId: 5, error: 'x' });
    fire({ tabId: 't', error: 3 });
    expect(second).toHaveBeenCalledTimes(1);
    unmount();
    fire({ tabId: 't3', error: 'late', kind: 'test' });
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('clearConsumedFix', () => {
  it('forgets the consumed request, keeps a newer one, tolerates null', () => {
    expect(clearConsumedFix({ nonce: 1, error: 'a' }, 1)).toBeNull();
    expect(clearConsumedFix({ nonce: 2, error: 'b' }, 1)).toEqual({ nonce: 2, error: 'b' });
    expect(clearConsumedFix(null, 1)).toBeNull();
  });
});
