// Key translations and paste helpers for the claude terminal that xterm.js does not do by itself (pure; tested in main.test.cjs).

// Claude Code's send-now key (chat:sendNow) is ctrl+enter, which it reads as the CSI u sequence ESC [13;5u even
// when the kitty keyboard protocol was not negotiated. xterm.js sends a bare CR for Enter whatever the modifiers.
export const CTRL_ENTER = '\x1b[13;5u';

// macOS Option as Meta (macOptionIsMeta) makes xterm send ESC+key, but on TR/DE/… layouts Option is how @ { [ ] } \ | ~
// are typed. An ASCII symbol the layout composes with Option is typed as that character; letters, digits, non-ASCII
// results (US Option+p is π) and keys without a character (arrows, Backspace, Enter) stay Meta for claude's alt+ keys.
const OPTION_SYMBOL = /^[!-/:-@[-`{-~]$/;

/**
 * The bytes to send instead of xterm's own for this keydown, or null to leave it to xterm.
 * Cmd+Enter (macOS) and Ctrl+Enter send ctrl+enter, so a queued message is sent now as in other terminals.
 * macOS Option+key that the layout turns into an ASCII symbol sends that symbol, not ESC+key.
 * An IME composition keeps its keys (Enter there commits the text).
 * @param {{ key?: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, isComposing?: boolean }} ev
 * @param {boolean} isMac
 */
export function translateKey(ev, isMac) {
  if (ev.isComposing) return null;
  if (isMac && ev.altKey && !ev.metaKey && !ev.ctrlKey) return OPTION_SYMBOL.test(ev.key || '') ? ev.key : null;
  if (ev.key !== 'Enter' || ev.altKey || ev.shiftKey) return null;
  const cmd = isMac && ev.metaKey && !ev.ctrlKey;
  const ctrl = ev.ctrlKey && !ev.metaKey;
  return cmd || ctrl ? CTRL_ENTER : null;
}

// Claude Code's image paste key (chat:imagePaste): Ctrl+V on macOS and Linux, Alt+V (ESC v) on Windows.
// The app sends it when the clipboard holds an image, and Claude Code reads the image from the clipboard itself.
/** @param {string} platform process.platform */
export const imagePasteKey = (platform) => (platform === 'win32' ? '\x1bv' : '\x16');

/**
 * A pasted or dropped file path as the terminal gets it. macOS and Linux: shell-style single quotes when the path
 * has spaces or shell characters. Windows: double quotes when it has spaces or such characters ("C:\a b\c.png");
 * a backslash alone needs none there.
 * @param {string} p @param {string} platform process.platform
 */
export function quotePath(p, platform) {
  if (platform === 'win32') return /[\s"'&()^%!;,=`$]/.test(p) ? `"${p.replace(/"/g, '')}"` : p;
  return /[\s'"\\$`!&;()<>|*?]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
}
