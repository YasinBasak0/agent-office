// Command Code login in the Accounts section (contract v3.30). Pure functions (no Electron; tested with node --test).
// What Command Code's docs say: install with `npm i -g command-code` (commandcode.ai/docs; the quickstart adds
// `@latest`), log in with `cmd login`, which opens a browser to authorize and then reports "API key stored in
// ~/.commandcode/auth.json" (commandcode.ai/docs/quickstart). The app runs the same subcommand through the name
// `commandcode` (engine.js CMD.bin; `cmd` is System32\cmd.exe on Windows). Logged in = only that the file exists:
// it holds the API key, so its contents are never read.
const path = require('node:path');

// The documented install line; shown as a hint, never run by the app.
const CMD_INSTALL = 'npm i -g command-code';

// The login subcommand (`cmd login` in the docs).
const CMD_LOGIN_ARGS = ['login'];

// The status check run by the user's login shell with cmdEnv (so PATH and rc files apply as for a Command Code tab).
const CMD_STATUS_COMMAND = 'command -v commandcode; true';

/**
 * The status command's output (rc files may print noise around it): where commandcode is.
 * @param {string} stdout @returns {{ path: string | null }}
 */
function parseCmdStatus(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim());
  return { path: lines.find((l) => /^(\/|[A-Za-z]:\\).*[\\/]commandcode(\.exe|\.cmd)?$/.test(l)) || null };
}

/** Command Code's credentials file (documented): ~/.commandcode/auth.json. @param {string} home */
const cmdAuthFile = (home) => path.join(home, '.commandcode', 'auth.json');

/**
 * @typedef {{ installed: boolean, state: 'in' | 'out' | 'missing' }} CmdAuth
 * Command Code's login state from where commandcode is and whether auth.json exists (never its contents).
 * @param {{ path: string | null }} status @param {string} home @param {(f: string) => boolean} exists
 * @returns {CmdAuth}
 */
function cmdAuthState(status, home, exists) {
  if (!status.path) return { installed: false, state: 'missing' };
  let has = false;
  try { has = Boolean(exists(cmdAuthFile(home))); } catch {}
  return { installed: true, state: has ? 'in' : 'out' };
}

module.exports = { CMD_INSTALL, CMD_LOGIN_ARGS, CMD_STATUS_COMMAND, parseCmdStatus, cmdAuthFile, cmdAuthState };
