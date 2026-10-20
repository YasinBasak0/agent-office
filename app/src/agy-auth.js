// Antigravity login in the Accounts section (contract v3.24). Pure functions (no Electron; tested with node --test).
// What agy's docs say (antigravity.google/docs/install?tab=cli): running `agy` checks the OS keyring for a saved token
// profile and, if there is none, opens the browser for a Google sign-in (over SSH it prints a URL and asks for the
// code); `/logout` at agy's prompt clears the session. There is no `auth status` / login / logout subcommand and no
// config-folder variable, so there is one Antigravity login per user. Other documented ways in: a Gemini API key
// (`"modelProvider": "gemini"` in ~/.gemini/antigravity-cli/settings.json + GEMINI_API_KEY) and ADC (AGY_ADC_AUTH=true).
// The account email: not documented. Guess, after Gemini CLI: a google_accounts.json `{ "active": "<email>" }` next to
// agy's data. Only that one field and settings.json's modelProvider are read; tokens (keyring) never are.
const path = require('node:path');

// macOS (v3.39): agy's saved login is a keychain item, service `gemini`, account `antigravity`. Its mere existence is asked
// with `security find-generic-password -s gemini -a antigravity` (no -w / -g: the attributes only, the token is never read,
// no prompt). Exit 0 = there; 44 (errSecItemNotFound) = not there; anything else = cannot tell.
const AGY_KEYCHAIN = { service: 'gemini', account: 'antigravity' };
/** The exact argv of the keychain query: attributes only, never -w / -g (the secret is not asked for). */
const AGY_KEYCHAIN_ARGS = ['find-generic-password', '-s', AGY_KEYCHAIN.service, '-a', AGY_KEYCHAIN.account];
/** At most this many bytes of a log are read (the OAuth line is written at the start), and at most this many logs. */
const LOG_HEAD_BYTES = 64 * 1024;
const LOG_FILES = 3;
const KEYCHAIN_NOT_FOUND = 44;
/** @param {number | string | null | undefined} code the exit code of the keychain query (0 on success) @returns {true | false | null} */
const keychainResult = (code) => (code === 0 ? true : code === KEYCHAIN_NOT_FOUND ? false : null);

// The official install lines (antigravity.google, CLI quickstart); shown as a hint, never run by the app.
const AGY_INSTALL = {
  unix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  win32: 'irm https://antigravity.google/cli/install.ps1 | iex',
};

// The status check run by the user's login shell with agyEnv (so PATH and rc files apply as for agy itself): where agy
// is, and only whether an API key / ADC is set (never the key's value).
const AGY_STATUS_COMMAND = 'command -v agy; [ -n "$GEMINI_API_KEY" ] && echo "AGY_STATUS_KEY=1"; [ "$AGY_ADC_AUTH" = true ] && echo "AGY_STATUS_ADC=1"; true';

/**
 * The status command's output (rc files may print noise around it).
 * @param {string} stdout @returns {{ path: string | null, apiKey: boolean, adc: boolean }}
 */
function parseAgyStatus(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim());
  const found = lines.find((l) => /^(\/|[A-Za-z]:\\).*[\\/]agy(\.exe|\.cmd)?$/.test(l)) || null;
  return { path: found, apiKey: lines.includes('AGY_STATUS_KEY=1'), adc: lines.includes('AGY_STATUS_ADC=1') };
}

/** agy's data folder (documented): ~/.gemini/antigravity-cli. @param {string} home */
const agyDir = (home) => path.join(home, '.gemini', 'antigravity-cli');

// Where an account file may be (guessed, Gemini CLI's name): agy's folder first, then the shared ~/.gemini.
const accountFiles = (home) => [path.join(agyDir(home), 'google_accounts.json'), path.join(home, '.gemini', 'google_accounts.json')];

const EMAIL = /^[^\s@]{1,200}@[^\s@]{1,200}$/;

// agy's own log (undocumented, so only a hint): each start writes "OAuth: authenticated successfully as <email>"
const LOG_EMAIL = /OAuth: authenticated successfully as ([^\s@]+@[^\s@,;.:)]+(?:\.[^\s@,;.:)]+)+)/g;
/** The e-mail agy last logged in with, from a log's text, or null. @param {string} text */
function parseAgyLogEmail(text) {
  let found = null;
  for (const m of String(text || '').matchAll(LOG_EMAIL)) if (EMAIL.test(m[1])) found = m[1];
  return found;
}

/**
 * The non-secret files agy's state is read from, reduced to the fields used.
 * With `readDir` (names in a folder), the newest log in agy's log folder also gives `logEmail` (a hint for the keychain login).
 * @param {string} home @param {(f: string) => string} readFile throws if missing @param {(d: string) => string[]} [readDir]
 * @param {(f: string) => string} [readHead] reads at most LOG_HEAD_BYTES of a log (default: readFile)
 * @returns {{ modelProvider: string | null, account: { active: string | null } | null, logEmail: string | null }}
 */
function readAgyFiles(home, readFile, readDir, readHead = readFile) {
  const json = (f) => { try { const v = JSON.parse(readFile(f)); return v && typeof v === 'object' ? v : null; } catch { return null; } };
  const settings = json(path.join(agyDir(home), 'settings.json'));
  const modelProvider = typeof settings?.modelProvider === 'string' ? settings.modelProvider : null;
  let account = null;
  for (const f of accountFiles(home)) {
    const v = json(f);
    if (!v) continue;
    account = { active: typeof v.active === 'string' && EMAIL.test(v.active) ? v.active : null };
    break;
  }
  let logEmail = null;
  if (readDir) {
    const dir = path.join(agyDir(home), 'log');
    let names = [];
    try { names = readDir(dir); } catch { /* no logs: no hint */ }
    // names carry the start time (cli-YYYYMMDD_HHMMSS.log): the newest log that names an account wins
    for (const name of names.filter((n) => /^cli-\d{8}_\d{6}\.log$/.test(n)).sort().reverse().slice(0, LOG_FILES)) {
      try { logEmail = parseAgyLogEmail(String(readHead(path.join(dir, name))).slice(0, LOG_HEAD_BYTES)); } catch { /* unreadable: try the next */ }
      if (logEmail) break;
    }
  }
  return { modelProvider, account, logEmail };
}

/**
 * @typedef {{ installed: boolean, state: 'in' | 'out' | 'unknown' | 'missing', email?: string, method?: 'google' | 'apikey' | 'adc' }} AgyAuth
 * Antigravity's login state. 'unknown': installed, and neither an account file nor (macOS) the keychain says anything.
 * `status.keychain` (v3.39): true / false when the keychain was asked (false changes nothing), null / absent when it could not be.
 * @param {{ path: string | null, apiKey: boolean, adc: boolean, keychain?: boolean | null }} status
 * @param {{ modelProvider: string | null, account: { active: string | null } | null, logEmail?: string | null }} files
 * @returns {AgyAuth}
 */
function agyAuthState(status, files) {
  if (!status.path) return { installed: false, state: 'missing' };
  if (status.adc) return { installed: true, state: 'in', method: 'adc' };
  if (files.modelProvider === 'gemini' && status.apiKey) return { installed: true, state: 'in', method: 'apikey' };
  if (files.account?.active) return { installed: true, state: 'in', email: files.account.active, method: 'google' };
  // the keychain holds a login only while it is logged in (/logout removes it): its answer beats a stale log
  if (status.keychain === true) return { installed: true, state: 'in', method: 'google', ...(files.logEmail ? { email: files.logEmail } : {}) };
  // keychain === false (item absent) is NOT 'out': the item name is a guess, so a logged-in user must never be shown logged out for it
  if (files.account) return { installed: true, state: 'out' };
  return { installed: true, state: 'unknown' };
}

module.exports = { AGY_KEYCHAIN, AGY_KEYCHAIN_ARGS, LOG_HEAD_BYTES, keychainResult, parseAgyLogEmail, AGY_INSTALL, AGY_STATUS_COMMAND, parseAgyStatus, agyDir, readAgyFiles, agyAuthState };
