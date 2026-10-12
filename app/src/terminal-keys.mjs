// Key translations for the claude terminal that xterm.js does not encode by itself (pure; tested in main.test.cjs).

// Claude Code's send-now key (chat:sendNow) is ctrl+enter, which it reads as the CSI u sequence ESC [13;5u even
// when the kitty keyboard protocol was not negotiated. xterm.js sends a bare CR for Enter whatever the modifiers.
export const CTRL_ENTER = '\x1b[13;5u';

/**
 * The bytes to send instead of xterm's own for this keydown, or null to leave it to xterm.
 * Cmd+Enter (macOS) and Ctrl+Enter send ctrl+enter, so a queued message is sent now as in other terminals.
 * An IME composition keeps its keys (Enter there commits the text).
 * @param {{ key?: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, isComposing?: boolean }} ev
 * @param {boolean} isMac
 */
export function translateKey(ev, isMac) {
  if (ev.key !== 'Enter' || ev.isComposing || ev.altKey || ev.shiftKey) return null;
  const cmd = isMac && ev.metaKey && !ev.ctrlKey;
  const ctrl = ev.ctrlKey && !ev.metaKey;
  return cmd || ctrl ? CTRL_ENTER : null;
}
