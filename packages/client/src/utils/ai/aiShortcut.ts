/** Ctrl/Cmd+I opens the AI command bar. Pure so the key handling is testable without the request builder. */

export interface AiShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault: () => void;
}

/**
 * @param open opens the bar; returns false when it declined (AI off, request not REST, another panel active)
 * @returns true when the shortcut was handled (the browser default of Ctrl/Cmd+I is then suppressed)
 */
export function handleAiShortcut(e: AiShortcutEvent, open: () => boolean): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'i') return false;
  if (!open()) return false;
  e.preventDefault();
  return true;
}
