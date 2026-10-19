// Engine per project (contract v3.22): how a tab of an Antigravity project starts. Pure functions (no Electron;
// tested with node --test). Google Antigravity CLI (`agy`, 1.3.6 or newer) keeps its own login and data
// (~/.gemini/antigravity-cli), so nothing of Claude Code's setup (account folder, plugin, status line, memory, MCP
// config) nor of the office (directory, journal, savings, tokens) is passed to it.
// Command Code (contract v3.23) is the office's other CLI instead: unlike agy it keeps the office's env (its mod,
// plugin/mods/agent-office.ts, reads AGENT_OFFICE_*) and starts like Claude Code from the login shell with its
// resume arguments; its own login and data live in ~/.commandcode.
const { promptArg } = require('./resume.js');

// macOS/Linux launch line, run by the login shell like claude's (PATH and rc files apply); the arguments come via "$@".
// The env it starts with is agyEnv's allowlist, so the rc files have no carrier (AGENT_OFFICE_CONFIG_DIR and the like)
// to rebuild the app's Claude variables from; any AGENT_OFFICE_* an rc file still sets is dropped before exec. The
// user's own rc variables (theirs, whatever their name) are left alone.
const AGY_COMMAND = 'for v in $(env | sed -n \'s/^\\(AGENT_OFFICE_[A-Za-z0-9_]*\\)=.*/\\1/p\'); do unset "$v"; done; exec agy "$@"';

/**
 * agy's arguments for a start: `--continue` (the most recent conversation of the folder agy starts in: agy keeps one
 * per workspace path) when resuming, then, only when resuming and a prompt is given, `-i <prompt>` (agy's initial
 * prompt, then interactive). A fresh start has no arguments.
 * @param {{ resume?: boolean, prompt?: string }} [o]
 */
function agyArgs({ resume = false, prompt = '' } = {}) {
  const p = resume && prompt ? promptArg(prompt) : '';
  return [...(resume ? ['--continue'] : []), ...(p ? ['-i', p] : [])];
}

// --- agy's environment: an allowlist (contract v3.22). Nothing else of the app's env reaches agy.
// Every platform: what a terminal program needs to find itself, its home, its locale and temp folder, and to open a
// browser for its Google login (Linux display and session bus). Proxies: the user's own network settings.
const AGY_ENV_NAMES = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
];
// Windows' own system variables (names compared without case, as Windows does).
const AGY_ENV_WINDOWS = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'USERNAME',
  'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ALLUSERSPROFILE', 'PUBLIC', 'OS',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'COMPUTERNAME', 'PSModulePath',
];
// Families passed by prefix: the locale, and agy's own Google / Gemini settings when the user has them.
const AGY_ENV_PREFIXES = ['LC_', 'GEMINI_', 'GOOGLE_'];
// Never passed, even when a rule above would match (belt and braces): Claude Code, Anthropic, the office, MCP.
const AGY_ENV_DENY = /^(ANTHROPIC|CLAUDE|AGENT_OFFICE)|MCP/i;

/**
 * The env agy starts with: only the allowlisted variables of base (the app's own env, i.e. the user's), plus the
 * terminal type. platform: process.platform (Windows names only on win32, compared without case there).
 * @param {Record<string, string | undefined>} base @param {string} [platform]
 * @returns {Record<string, string>}
 */
function agyEnv(base, platform = process.platform) {
  const win = platform === 'win32';
  const norm = (/** @type {string} */ n) => (win ? n.toUpperCase() : n);
  const names = new Set([...AGY_ENV_NAMES, ...(win ? AGY_ENV_WINDOWS : [])].map(norm));
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (typeof v !== 'string' || AGY_ENV_DENY.test(k)) continue;
    const key = norm(k);
    if (names.has(key) || AGY_ENV_PREFIXES.some((p) => key.startsWith(p))) out[k] = v;
  }
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  return out;
}

// --- Command Code (contract v3.23): the office's other engine. The launch line keeps the app's env (no rc-file
// rebuild of AGENT_OFFICE_* is needed: unlike agy's allowlist, the mod in the process reads them), so the "$@"
// arguments stand alone: the mod file first (--mod; Command Code has no plugin loader), then the resume arguments,
// then (only with both) the positional prompt — Claude Code's order via resume.js claudeArgs, which works.
const CMD = {
  bin: 'cmd',
  home: '.commandcode', // its own sessions live there (projects/<slug>/<session id>.jsonl, same naming rule)
};

/**
 * Command Code's arguments for a start: the mod (--mod, see plugin/mods/agent-office.ts), then the resume arguments
 * (`--resume <session id>` after a sleep, `--continue` when the folder has one), then (only when resuming and a
 * prompt is given) the prompt as the positional argument, ordered like Claude Code's claudeArgs.
 * @param {string[]} [mod] ['--mod', <file>] @param {string[]} [resumeArgs] @param {string} [prompt]
 */
function cmdArgs(mod = [], resumeArgs = [], prompt = '') {
  const p = resumeArgs.length && prompt ? promptArg(prompt) : '';
  return [...mod, ...resumeArgs, ...(p ? [p] : [])];
}

/** Command Code's launch line: this CLI, its arguments via "$@". Windows: findCommandCode picks the binary. */
const CMD_COMMAND = 'exec cmd "$@"';

module.exports = { AGY_COMMAND, agyArgs, agyEnv, AGY_ENV_NAMES, AGY_ENV_WINDOWS, AGY_ENV_PREFIXES, CMD, cmdArgs, CMD_COMMAND };
