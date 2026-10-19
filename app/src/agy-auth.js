// Antigravity login in the Accounts section (contract v3.24). Pure functions (no Electron; tested with node --test).
// What agy's docs say (antigravity.google/docs/install?tab=cli): running `agy` checks the OS keyring for a saved token
// profile and, if there is none, opens the browser for a Google sign-in (over SSH it prints a URL and asks for the
// code); `/logout` at agy's prompt clears the session. There is no `auth status` / login / logout subcommand and no
// config-folder variable, so there is one Antigravity login per user. Other documented ways in: a Gemini API key
// (`"modelProvider": "gemini"` in ~/.gemini/antigravity-cli/settings.json + GEMINI_API_KEY) and ADC (AGY_ADC_AUTH=true).
// The account email: not documented. Guess, after Gemini CLI: a google_accounts.json `{ "active": "<email>" }` next to
// agy's data. Only that one field and settings.json's modelProvider are read; tokens (keyring) never are.
const path = require('node:path');

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

/**
 * The non-secret files agy's state is read from, reduced to the fields used.
 * @param {string} home @param {(f: string) => string} readFile throws if missing
 * @returns {{ modelProvider: string | null, account: { active: string | null } | null }}
 */
function readAgyFiles(home, readFile) {
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
  return { modelProvider, account };
}

/**
 * @typedef {{ installed: boolean, state: 'in' | 'out' | 'unknown' | 'missing', email?: string, method?: 'google' | 'apikey' | 'adc' }} AgyAuth
 * Antigravity's login state. 'unknown': installed, no account file to read (a keyring login cannot be seen without
 * touching the keyring, which the app does not do).
 * @param {{ path: string | null, apiKey: boolean, adc: boolean }} status
 * @param {{ modelProvider: string | null, account: { active: string | null } | null }} files
 * @returns {AgyAuth}
 */
function agyAuthState(status, files) {
  if (!status.path) return { installed: false, state: 'missing' };
  if (status.adc) return { installed: true, state: 'in', method: 'adc' };
  if (files.modelProvider === 'gemini' && status.apiKey) return { installed: true, state: 'in', method: 'apikey' };
  if (files.account?.active) return { installed: true, state: 'in', email: files.account.active, method: 'google' };
  if (files.account) return { installed: true, state: 'out' };
  return { installed: true, state: 'unknown' };
}

module.exports = { AGY_INSTALL, AGY_STATUS_COMMAND, parseAgyStatus, agyDir, readAgyFiles, agyAuthState };
