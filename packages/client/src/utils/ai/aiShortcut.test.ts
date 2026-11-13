// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { handleAiShortcut } from './aiShortcut';

const ev = (over: Record<string, unknown> = {}) => ({ key: 'i', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, preventDefault: vi.fn(), ...over });

describe('handleAiShortcut', () => {
  it('opens the bar and prevents the browser default (Ctrl+I and Cmd+I)', () => {
    for (const mods of [{ ctrlKey: true }, { metaKey: true, ctrlKey: false }, { key: 'I' }]) {
      const e = ev(mods);
      const open = vi.fn(() => true);
      expect(handleAiShortcut(e, open)).toBe(true);
      expect(open).toHaveBeenCalledTimes(1);
      expect(e.preventDefault).toHaveBeenCalledTimes(1);
    }
  });
  it('leaves the key alone when the bar declines (AI off, non-REST, another view)', () => {
    const e = ev();
    expect(handleAiShortcut(e, () => false)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
  it('ignores other keys and modifier combinations without even asking', () => {
    for (const mods of [{ key: 'k' }, { ctrlKey: false }, { shiftKey: true }, { altKey: true }]) {
      const e = ev(mods);
      const open = vi.fn(() => true);
      expect(handleAiShortcut(e, open)).toBe(false);
      expect(open).not.toHaveBeenCalled();
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });
  it('works with a real KeyboardEvent: defaultPrevented is set only when handled', () => {
    const handled = new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, cancelable: true });
    handleAiShortcut(handled, () => true);
    expect(handled.defaultPrevented).toBe(true);
    const declined = new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, cancelable: true });
    handleAiShortcut(declined, () => false);
    expect(declined.defaultPrevented).toBe(false);
  });
});
