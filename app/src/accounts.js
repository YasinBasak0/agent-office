// Claude Code accounts: pure state functions and the pty environment (no Electron; tested with node --test).
//
// How logins are kept apart (Claude Code 2.1.295, macOS; code.claude.com/docs/en/authentication):
// - Credentials live in the macOS Keychain (the "Claude Code-credentials" item); if the keychain refuses
//   the write, they fall back to <config>/.credentials.json (0600).
// - If CLAUDE_CONFIG_DIR is set, .credentials.json goes to that folder AND the keychain item is keyed
//   by that folder: a different CLAUDE_CONFIG_DIR reads a different item. This is the documented multi-account path.
//   Tried: with an empty CLAUDE_CONFIG_DIR, `claude auth status` → loggedIn:false, it doesn't see the default login.
// - Not kept apart: ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_PROFILE
//   in the environment take precedence over the login in every account; a Console login made without an API key
//   (Anthropic profile, ~/.config/anthropic) lives outside the folder, so it isn't kept apart.
// - A new folder starts empty: settings.json and logins in ~/.claude are not in that account. Project auto-memory
//   stays in ~/.claude (see memory.js); plugins, skills, MCP servers and CLAUDE.md are shared by default
//   (see shared-config.js; per account `shareDefault`, absent = on).
const path = require('path');

const DEFAULT_ID = 'default';
const DEFAULT_ACCOUNT = Object.freeze({ id: DEFAULT_ID, label: 'Varsayılan', configDir: null });

// The default account is always first and its configDir is null.
function normalizeAccounts(list) {
  const out = [{ ...DEFAULT_ACCOUNT }];
  const seen = new Set([DEFAULT_ID]);
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a.id !== 'string' || !a.id || seen.has(a.id)) continue;
    if (typeof a.configDir !== 'string' || !a.configDir) continue;
    seen.add(a.id);
    out.push({ id: a.id, label: cleanLabel(a.label, a.id), configDir: a.configDir, ...(a.shareDefault === false ? { shareDefault: false } : {}) });
  }
  return out;
}

const cleanLabel = (label, fallback) => (typeof label === 'string' && label.trim()) || fallback;

// configDir = <root>/<id>; in main, root is userData/accounts. main creates the folder.
function addAccount(state, label, { id, root }) {
  const account = { id, label: cleanLabel(label, `Hesap ${state.accounts.length}`), configDir: path.join(root, id) };
  return { state: { ...state, accounts: [...state.accounts, account] }, account };
}

function renameAccount(state, id, label) {
  const l = typeof label === 'string' ? label.trim() : '';
  if (!l || id === DEFAULT_ID) return state;
  return { ...state, accounts: state.accounts.map((a) => (a.id === id ? { ...a, label: l } : a)) };
}

// "Use Default's plugins, skills and MCP servers": stored only when off; applies at the next session start.
function setAccountShare(state, id, on) {
  if (id === DEFAULT_ID || typeof on !== 'boolean') return state;
  const a = state.accounts.find((x) => x.id === id);
  if (!a || (a.shareDefault !== false) === on) return state;
  return {
    ...state,
    accounts: state.accounts.map((x) => {
      if (x.id !== id) return x;
      const { shareDefault: _, ...rest } = x;
      return on ? rest : { ...rest, shareDefault: false };
    }),
  };
}

// When an account is deleted its projects move to the default; `moved` holds the ids of projects to restart.
function removeAccount(state, id) {
  if (id === DEFAULT_ID || !state.accounts.some((a) => a.id === id)) return { state, moved: [] };
  const moved = state.projects.filter((p) => p.accountId === id).map((p) => p.id);
  return {
    state: {
      ...state,
      accounts: state.accounts.filter((a) => a.id !== id),
      // a backup or home naming the account goes too (v3.17)
      projects: state.projects.map((p) => {
        const { backupAccount, homeAccount, ...rest } = p;
        const accountId = p.accountId === id ? DEFAULT_ID : p.accountId;
        return {
          ...rest, accountId,
          ...(backupAccount !== undefined && backupAccount !== id ? { backupAccount } : {}),
          ...(homeAccount !== undefined && homeAccount !== id && homeAccount !== accountId ? { homeAccount } : {}),
        };
      }),
    },
    moved,
  };
}

const accountOf = (state, project) =>
  state.accounts.find((a) => a.id === project?.accountId) || state.accounts.find((a) => a.id === DEFAULT_ID) || DEFAULT_ACCOUNT;

// If the app was opened from inside a claude session, clear the nested-session markers; don't take the parent
// process's CLAUDE_CONFIG_DIR either (the default account is the system's ~/.claude). If the account has a folder, pass it.
function ptyEnv(base, configDir = null) {
  const env = { ...base, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  for (const k of Object.keys(env)) {
    if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_CONFIG_DIR$|AGENT_OFFICE_CONFIG_DIR$)/.test(k)) delete env[k];
  }
  if (configDir) {
    env.CLAUDE_CONFIG_DIR = configDir;
    // the login shell's rc files may override CLAUDE_CONFIG_DIR; the command sets it again at the last moment
    env.AGENT_OFFICE_CONFIG_DIR = configDir;
  }
  return env;
}

// The env of a project's claude in the app, on top of ptyEnv: AGENT_OFFICE_APP marks the app (the plugin's /office
// then gives the summary only); AGENT_OFFICE_MANAGER=1 turns on the plugin's manager mode (sidebar setting, default
// on: the boss delegates to agents; per project since v3.10). Off, the variable is left out, even when the app itself
// was started with it, and AGENT_OFFICE_FINISH=1 is set instead: the boss does the work itself, but the plugin's
// finish guard still keeps it from stopping on a list of work it could do (manager mode has the guard built in).
//
// agentModel (contract v3.14): the project's pinned subagent model ('sonnet' | 'haiku' | 'opus'), or null for Auto.
// Pinned, AGENT_OFFICE_AGENT_MODEL carries it to the launch line, which exports CLAUDE_CODE_SUBAGENT_MODEL=<model>
// and CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 after the shell's rc files (they cannot undo it; Windows gets both directly).
// Claude Code 2.1.296 then drops the Agent tool's model parameter and runs every subagent, agent definitions with
// a model included, on that model. Auto leaves the user's own CLAUDE_CODE_SUBAGENT_MODEL* alone.
//
// contextCap (contract v3.15): the project's auto-compact window in tokens (200000 | 400000), or null for Auto.
// Capped, AGENT_OFFICE_CONTEXT_CAP carries it to the launch line, which exports CLAUDE_CODE_AUTO_COMPACT_WINDOW=<n>
// after the rc files. Claude Code 2.1.300 then compacts when the context nears min(n, model window) − ~33k, in the
// main session and in every subagent (same process). Auto leaves the user's own CLAUDE_CODE_AUTO_COMPACT_WINDOW alone.
function sessionEnv(env, { manager = true, agentModel = null, contextCap = null } = {}) {
  const out = { ...env, AGENT_OFFICE_APP: '1' };
  delete out.AGENT_OFFICE_AGENT_MODEL;
  delete out.AGENT_OFFICE_CONTEXT_CAP;
  if (agentModel) {
    out.AGENT_OFFICE_AGENT_MODEL = agentModel;
    out.CLAUDE_CODE_SUBAGENT_MODEL = agentModel;
    out.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1';
  }
  if (contextCap) {
    out.AGENT_OFFICE_CONTEXT_CAP = String(contextCap);
    out.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(contextCap);
  }
  if (manager) {
    out.AGENT_OFFICE_MANAGER = '1';
    delete out.AGENT_OFFICE_FINISH;
  } else {
    delete out.AGENT_OFFICE_MANAGER;
    out.AGENT_OFFICE_FINISH = '1';
  }
  return out;
}

// --- login status (`claude auth status --json`)

// The last JSON object in the output: rc files may print noise before/after it. A brace-counting scan
// that skips braces inside strings finds the outermost objects; the last one that parses is returned.
function lastJsonObject(text) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  let found = null;
  let i = s.indexOf('{');
  while (i >= 0) {
    const end = matchBrace(s, i);
    if (end < 0) break;
    let obj;
    try { obj = JSON.parse(s.slice(i, end + 1)); } catch { obj = undefined; }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      found = obj;
      i = s.indexOf('{', end + 1);
    } else {
      i = s.indexOf('{', i + 1);
    }
  }
  return found;
}

// Position of the '}' matching s[start] === '{'; -1 if none.
function matchBrace(s, start) {
  let depth = 0;
  let inStr = false;
  for (let k = start; k < s.length; k++) {
    const c = s[k];
    if (inStr) {
      if (c === '\\') k++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return k;
  }
  return -1;
}

const shortError = (msg) => {
  const line = String(msg ?? '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'bilinmeyen hata';
  return line.length > 120 ? line.slice(0, 117) + '…' : line;
};

// `auth status --json` object → AccountAuth (see CONTRACT.md).
function authFromStatus(obj) {
  if (!obj || typeof obj !== 'object' || typeof obj.loggedIn !== 'boolean') {
    return { state: 'error', errorKey: 'unreadable' };
  }
  if (!obj.loggedIn) return { state: 'out' };
  const auth = { state: 'in' };
  if (typeof obj.email === 'string' && obj.email) auth.email = obj.email;
  if (typeof obj.authMethod === 'string' && obj.authMethod) auth.method = obj.authMethod;
  return auth;
}

// execFile result → AccountAuth. Even with a non-zero exit code, JSON on stdout is what counts.
function authFromRun(err, stdout, stderr) {
  const obj = lastJsonObject(stdout);
  if (obj && typeof obj.loggedIn === 'boolean') return authFromStatus(obj);
  if (err && (err.killed || err.signal) && !err.code) return { state: 'error', errorKey: 'timeout' };
  if (err && err.code === 127) return { state: 'error', errorKey: 'noClaude' };
  if (err && err.code === 'ENOENT') return { state: 'error', errorKey: 'noShell' };
  if (err) return { state: 'error', error: shortError(stderr || err.message) };
  return { state: 'error', errorKey: 'unreadable' };
}

// Known errors are stored as keys and reach the renderer in the current language (the language may change later).
// Strings are under "auth" in locales/<code>.json; t: main's translator (src/i18n.mjs translator, with t.has).
/** @param {any} auth @param {{ (key: string): string, has: (key: string) => boolean }} t */
function localizeAuth(auth, t) {
  if (!auth?.errorKey) return auth;
  const { errorKey, ...rest } = auth;
  return { ...rest, error: t.has(`auth.${errorKey}`) ? t(`auth.${errorKey}`) : errorKey };
}

// claude command run via the login shell (`$SHELL -l -i -c`); the account folder is set again after the rc files.
const claudeCommand = (args) =>
  '[ -n "$AGENT_OFFICE_CONFIG_DIR" ] && export CLAUDE_CONFIG_DIR="$AGENT_OFFICE_CONFIG_DIR"; exec claude ' + args;

// Accounts sent to the renderer: auth is kept in memory, not written to state.json; no field if the quota is unknown.
const withAuth = (accounts, authOf, usageOf = (_id) => undefined) =>
  accounts.map((a) => {
    const usage = usageOf(a.id);
    return { ...a, auth: authOf(a.id) || { state: 'checking' }, ...(usage ? { usage } : {}) };
  });

const LOGIN_PREFIX = 'login:';
const loginPtyId = (accountId) => LOGIN_PREFIX + accountId;
const loginAccountId = (ptyId) =>
  typeof ptyId === 'string' && ptyId.startsWith(LOGIN_PREFIX) ? ptyId.slice(LOGIN_PREFIX.length) : null;

module.exports = {
  DEFAULT_ID, DEFAULT_ACCOUNT, normalizeAccounts, addAccount, renameAccount, setAccountShare, removeAccount, accountOf, ptyEnv, sessionEnv,
  lastJsonObject, authFromStatus, authFromRun, localizeAuth, claudeCommand, withAuth, loginPtyId, loginAccountId,
};
