// Restarting a tab without losing its conversation, and reloading tabs whose MCP servers changed (contract v3.11;
// pure functions, no Electron; tested with node --test).
//
// Claude Code loads MCP servers only at start: after `claude mcp add` it says "restart Claude Code". In the app a
// tab's claude restarts when the user presses Enter after it exits (pty:restart); that start resumes the session the
// tab was in. With "Reload sessions when MCP changes" on, main also watches the files a tab's MCP set comes from
// (stat poll, see watchFiles), recomputes each running tab's fingerprint (shared-config.js mcpFingerprint) once a
// change has settled, and restarts a changed tab with --resume <its session> as soon as it is idle.
const path = require('path');

/**
 * How a tab starts again after its claude exited and the user pressed Enter: the session it was in (--resume),
 * else for a tab that continues (main tab, worktree tab) the folder's last session (--continue), else fresh. A
 * failed --resume / --continue falls back to a fresh start in startPty (RESUME_GRACE_MS).
 * @param {{ sessionId?: string | null, continues?: boolean }} o
 */
function restartOptions({ sessionId = null, continues = false } = {}) {
  if (typeof sessionId === 'string' && /^[\w-]+$/.test(sessionId)) return { sessionId };
  return continues ? { resume: true } : {};
}

/**
 * The files whose change can change a tab's MCP set: ~/.claude.json and ~/.claude/settings.json, each account's
 * .claude.json and settings.json, and for each folder (project folders and tab folders) .mcp.json and
 * .claude/settings.local.json (project server approvals). Unique, in a stable order.
 * @param {{ home: string, configDirs?: (string | null)[], dirs?: string[] }} o
 */
function watchFiles({ home, configDirs = [], dirs = [] }) {
  const out = [path.join(home, '.claude.json'), path.join(home, '.claude', 'settings.json')];
  for (const c of configDirs) if (c) out.push(path.join(c, '.claude.json'), path.join(c, 'settings.json'));
  for (const d of dirs) if (d) out.push(path.join(d, '.mcp.json'), path.join(d, '.claude', 'settings.local.json'));
  return [...new Set(out)];
}

/** One string for the files' state: size and mtime each ('-' for a missing file). stat(file) → fs.Stats | null. */
const statKey = (files, stat) => files.map((f) => { const s = stat(f); return s ? `${s.size}:${s.mtimeMs}` : '-'; }).join('|');

/**
 * Debounce for the stat poll: a new key is acted on once it has stayed the same for one more poll.
 * state: { seen, pending } (strings); → { state, settled: boolean }
 */
function settle(state, key) {
  if (key === state.seen) return { state: { seen: state.seen, pending: key }, settled: false };
  if (key === state.pending) return { state: { seen: key, pending: key }, settled: true };
  return { state: { seen: state.seen, pending: key }, settled: false };
}

/**
 * What to do with a running tab now. started: its fingerprint when it started; current: the latest one (null:
 * not computed yet); blocker: why it must not be touched ('' = idle: not mid-turn, no running agents or shells, no
 * permission prompt, no unsent text; transfer.js exportBlocker). → 'none' | 'wait' | 'reload'
 * @param {{ enabled: boolean, running: boolean, started?: string | null, current?: string | null, blocker?: string }} o
 */
function reloadAction({ enabled, running, started = null, current = null, blocker = '' }) {
  if (!enabled || !running || !started || !current || started === current) return 'none';
  return blocker ? 'wait' : 'reload';
}

module.exports = { restartOptions, watchFiles, statKey, settle, reloadAction };
