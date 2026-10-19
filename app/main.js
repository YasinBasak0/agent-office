// Agent Office shell: window, projects, accounts, one claude pty per project (several with tabs), and office data.
const { app, BrowserWindow, ipcMain, dialog, clipboard, Menu, Notification, nativeImage, shell: eShell } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const P = require('./src/projects.js');
const A = require('./src/accounts.js');
const U = require('./src/usage.js');
const N = require('./src/attention.js');
const OS = require('./src/platform.js');
const L = require('./src/locales.js');
const UP = require('./src/updates.js');
const M = require('./src/memory.js');
const Z = require('./src/sleep.js');
const TR = require('./src/transfer.js');
const TIO = require('./src/transfer-io.js');
const SC = require('./src/shared-config.js');
const OD = require('./src/office-directory.js');
const MR = require('./src/mcp-reload.js');
const R = require('./src/resume.js');
const TU = require('./src/token-usage.js');
const PD = require('./src/project-data.js');
const FB = require('./src/fallback.js');
const EN = require('./src/engine.js');
const IS_MAC = OS.isMac();
const IS_WIN = OS.isWindows();
// Windows: node-pty is loaded from app.asar.unpacked, because its ConPTY output runs in a worker thread whose script
// must be a real file (its own asar fix-up only knows node_modules.asar). macOS and Linux load it as before.
/** @type {typeof import('node-pty')} */
const pty = IS_WIN ? require(require.resolve('node-pty').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')) : require('node-pty');

let win = null;
let poll = null;
let state = null;            // { projects, accounts, activeId }
let isLoaded = false;        // renderer loaded?: ptys start only then (so early output isn't lost)
const terms = new Map();     // pty id → pty: main tab projectId, extra tab `<projectId>:<n>` (see projects.js tabPtyId)
const logins = new Map();    // 'login:<accountId>' → `claude auth login` pty (not part of projects:changed)
const sizes = new Map();     // pty id → { cols, rows } (last pty:resize)
const auths = new Map();     // accountId → AccountAuth (in memory only)
const usages = new Map();    // accountId → AccountUsage (also kept in usage/<accountId>/last.json)
const ptyOf = (id) => terms.get(id) || logins.get(id);
// An Antigravity project (contract v3.22): its tabs run `agy`, so nothing that reads Claude Code's files applies to it.
const isAgy = (project) => P.engineOf(project) === 'agy';
// A Command Code project (contract v3.23): its tabs run `cmd`. The office tracks it through its mod, so unlike agy
// the office's env and directory reach it; but it keeps no Claude Code files (pid files, transcripts, accounts).
const isCmd = (project) => P.engineOf(project) === 'commandcode';
// Sleeping tabs (see src/sleep.js): pty id → how to start it again ({ resume } at launch, { sessionId } after a sleep).
const asleep = new Map();
const activity = new Map(); // pty id → { at: last start/input/output, draft: prompt text typed but unsent }
const lastSid = new Map(); // pty id → the session its claude was last seen in (pid file), for Enter-restart (v3.11)
const mcpPrint = new Map(); // running pty id → { started, current } MCP fingerprints (v3.11, src/mcp-reload.js)
const ptyStart = new Map(); // running pty id → when its claude started (v3.17: older limit entries are not this run's)
const ptyLimit = new Map(); // running pty id → { scan, hitAt } usage-limit words seen in its output (v3.17, a hint only)
let lastSize = { cols: 100, rows: 16 };

// If sessions.js fails to load, the office carries on with empty data.
let sessions = null;
function office() {
  if (!sessions) {
    try { sessions = require('./src/sessions.js'); } catch { return null; }
  }
  return sessions;
}

const statePath = () => path.join(app.getPath('userData'), 'state.json');
const accountsRoot = () => path.join(app.getPath('userData'), 'accounts');
const usageRoot = () => path.join(app.getPath('userData'), 'usage');
function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; }
}
// Unknown keys are kept; the old `lastProject` is dropped after migration.
function saveState() {
  try {
    const { lastProject, ...rest } = loadState();
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ ...rest, ...state }, null, 2));
  } catch {}
}

const send = (ch, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...args); };
const snapshot = () => ({
  projects: state.projects,
  activeId: state.activeId,
  status: state.projects.map((p) => ({
    id: p.id, isRunning: terms.has(p.id), isAsleep: asleep.has(p.id), attention: attention.get(p.id) || null,
    tabs: P.tabsOf(p).map((t) => ({ n: t.n, isRunning: terms.has(P.tabPtyId(p.id, t.n)), isAsleep: asleep.has(P.tabPtyId(p.id, t.n)) })),
  })),
});
const broadcast = () => send('projects:changed', snapshot());

// --- waiting for you (see src/attention.js): notification, Dock badge, marker on the project row
let attnState = N.emptyAttention();
let attention = new Map();    // projectId → 'permission' | 'done'
let lastOffice = null;        // last readOffice().projects
const alerted = new Map();    // quota thresholds: "<account>:<window>:<reset>" → percent
const seenId = () => (win && !win.isDestroyed() && win.isFocused() ? state.activeId : null);
function notify(title, body, projectId) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on('click', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (projectId && P.findProject(state, projectId)) commit(P.setActive(state, projectId));
  });
  n.show();
}
function updateAttention() {
  if (!lastOffice) return;
  const r = N.nextAttention(attnState, state.projects, lastOffice, seenId(), sessionAliases());
  attnState = r.state;
  for (const ev of r.events) {
    const p = P.findProject(state, ev.id);
    if (!p) continue;
    notify(p.name, ev.kind === 'permission' ? (ev.tool ? T('main.notifyPermissionTool', { tool: ev.tool }) : T('main.notifyPermission')) : T('main.notifyDone'), p.id);
    // Windows: the taskbar button flashes until the window is focused
    if (IS_WIN && win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
  }
  const key = (m) => JSON.stringify([...m]);
  if (key(r.attention) === key(attention)) return;
  attention = r.attention;
  // macOS: Dock badge; Linux: app counter on desktops that support it (Unity launcher); Windows: a dot on the
  // taskbar button (overlay icon)
  try {
    if (app.dock) app.dock.setBadge(attention.size ? String(attention.size) : '');
    else if (IS_WIN) win?.setOverlayIcon(attention.size ? badgeDot() : null, attention.size ? T('main.badge', { count: attention.size }) : '');
    else app.setBadgeCount(attention.size);
  } catch {}
  broadcast();
}
/** @type {Electron.NativeImage | null} */
let badge = null;
const badgeDot = () => badge || (badge = nativeImage.createFromBuffer(OS.dotPng(32, 0xe5484d)));
function alertUsage(account, usage, seed = false) {
  for (const a of N.usageAlerts(account.id, usage, alerted, { seed })) {
    const when = a.resetsAt ? new Date(a.resetsAt).toLocaleString(uiLang(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const label = account.id === A.DEFAULT_ID ? T('main.defaultAccount') : account.label;
    notify(label, T(a.window === 'fiveHour' ? 'main.usageFiveHour' : 'main.usageWeek', { pct: a.pct }) + (when ? T('main.usageResets', { when }) : ''));
  }
}

// Change the state, save it, notify the renderer.
// The default account's name and known login errors are sent in the current language.
const accountList = () => A.withAuth(state.accounts, (id) => A.localizeAuth(auths.get(id), T), (id) => usages.get(id))
  .map((a) => (a.id === A.DEFAULT_ID ? { ...a, label: T('main.defaultAccount') } : a));
const sendAccounts = () => send('accounts:changed', accountList());
function commit(next, { accounts = false } = {}) {
  state = next;
  saveState();
  broadcast();
  if (accounts) sendAccounts();
}

// --- language: the setting is 'auto' or a code that has a locales/<code>.json (state.json); 'auto' is the system language.
// Strings live in locales/*.json; T('main.key', { var }) gives the current language (formatter src/i18n.mjs, loaded at startup).
const LOCALES = L.loadLocales();
const LANGUAGES = L.languagesOf(LOCALES);
const LANG_SETTINGS = ['auto', ...LANGUAGES.map((l) => l.code)];
const langSetting = () => (LANG_SETTINGS.includes(state?.language) ? state.language : 'auto');
function systemLang() {
  let l = '';
  try { l = app.getPreferredSystemLanguages()[0] || app.getLocale(); } catch {}
  return L.resolveLang(l, Object.keys(LOCALES));
}
const uiLang = () => (langSetting() === 'auto' ? systemLang() : langSetting());
/** @typedef {(key: string, vars?: Record<string, unknown>) => string} Translate */
/** @type {((lang: string) => Translate) | null} */
let makeTranslator = null;
async function loadI18n() {
  const { translator } = await import('./src/i18n.mjs');
  makeTranslator = (lang) => translator(LOCALES[lang], LOCALES[L.FALLBACK], lang);
}
/** @type {Map<string, Translate>} */
const translators = new Map();
/** @param {string} key @param {Record<string, unknown>} [vars] */
function T(key, vars) {
  if (!makeTranslator) return key;
  const lang = uiLang();
  let tr = translators.get(lang);
  if (!tr) translators.set(lang, (tr = makeTranslator(lang)));
  return tr(key, vars);
}
T.has = (key) => T(key) !== key;
const languageInfo = () => ({ setting: langSetting(), lang: uiLang(), languages: LANGUAGES });

const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };

function argProject() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  const i = args.indexOf('--');
  const cands = i >= 0 ? args.slice(i + 1) : args.filter((a) => !a.startsWith('-') && a !== '.');
  const dir = cands.find((a) => isDir(path.resolve(a)));
  return dir ? path.resolve(dir) : null;
}

async function pickFolder() {
  const r = await dialog.showOpenDialog(win, {
    title: T('main.pickFolder'),
    buttonLabel: T('main.pickButton'),
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: P.findProject(state, state.activeId)?.dir,
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

// The node-pty 1.1 prebuilt spawn-helper sometimes ships without the executable bit (macOS only;
// on Linux node-pty is built from source and has no spawn-helper).
function fixSpawnHelper() {
  if (!IS_MAC) return;
  const dir = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds', `darwin-${process.arch}`);
  const helper = path.join(dir, 'spawn-helper').replace('app.asar', 'app.asar.unpacked');
  try { fs.chmodSync(helper, 0o755); } catch {}
}

// Plugin: the repo's plugin/ folder in development, Resources/plugin in the packaged app. It is copied to
// userData: claude generates type files in the plugin folder and must not write inside the signed .app bundle.
// Copied once at startup: running claudes share the same folder, later ptys must not delete it.
let plugin;
function pluginDir() {
  if (plugin !== undefined) return plugin;
  const bundled = app.isPackaged ? path.join(process.resourcesPath, 'plugin') : path.join(__dirname, '..', 'plugin');
  const dest = path.join(app.getPath('userData'), 'plugin', 'agent-office');
  try {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(bundled, dest, { recursive: true });
    plugin = dest;
  } catch (e) {
    console.error('eklenti kopyalanamadı:', e.message);
    plugin = null;
  }
  return plugin;
}

// A tab's MCP file (Default's servers with their tokens, see shared-config.js) lives only while its claude runs.
// Its office directory (contract v3.9, src/office-directory.js) lives as long, in userData/directory/<tab>.json.
const mcpDir = () => path.join(app.getPath('userData'), 'mcp');
const directoryDir = () => path.join(app.getPath('userData'), 'directory');
function removeMcpFile(id) {
  try { fs.rmSync(path.join(mcpDir(), SC.mcpFileName(usageKey(id))), { force: true }); } catch {}
  try { fs.rmSync(path.join(directoryDir(), SC.mcpFileName(usageKey(id))), { force: true }); } catch {}
}

// Killed on purpose (restart, removal, sleep, account change): its interrupted mark goes too, except while quitting.
function killPty(id) {
  if (terms.has(id)) removeMcpFile(id);
  if (!quitting) setMarks(R.clearInterrupted(marks(), [id]));
  const map = terms.has(id) ? terms : logins;
  const t = map.get(id);
  if (!t) return;
  map.delete(id);
  activity.delete(id);
  mcpPrint.delete(id);
  ptyStart.delete(id);
  ptyLimit.delete(id);
  try { t.kill(); } catch {}
}
// Quitting (window closed, Quit, the updater's quitAndInstall): one last look at which tabs are mid-turn, so they
// resume at the next launch; then the ptys go without clearing their marks.
function killAll() {
  if (!quitting && state) checkTurns();
  quitting = true;
  for (const id of [...terms.keys(), ...logins.keys()]) killPty(id);
}

// --- interrupted work (see src/resume.js): state.interrupted = { ptyId: sessionId | '' } for tabs mid-turn
let quitting = false;
const marks = () => state?.interrupted || {};
// saved at once (no broadcast: the renderer does not show it), so an ungraceful end still finds it
function setMarks(next) {
  if (!state || next === marks()) return;
  state = { ...state, interrupted: next };
  saveState();
}
// Every running tab: is its claude mid-turn? (Claude Code's pid file status, else the office file's isBossBusy.)
function checkTurns() {
  if (quitting || !state) return;
  let next = marks();
  const home = app.getPath('home');
  for (const [id, t] of terms) {
    const r = P.resolvePty(state, id);
    if (!r || P.engineOf(r.project) !== 'claude') continue; // agy and Command Code keep no Claude Code pid file (v3.22, v3.23)
    const { configDir } = A.accountOf(state, r.project);
    const claude = readJson(Z.claudePidFile(configDir, home, t.pid));
    const sid = validSid(claude?.sessionId);
    const busy = R.isTurnBusy({ claude, office: sid ? office()?.readSession(sid) : undefined });
    if (sid) lastSid.set(id, sid);
    next = R.nextInterrupted(next, id, { busy, sessionId: sid });
  }
  setMarks(next);
  checkMcp();
  checkLimits();
}

// --- reload tabs whose MCP servers changed (contract v3.11, src/mcp-reload.js)
/** The tab's MCP fingerprint now (shared-config.js mcpPlan, reading only); read: a memo for one pass over all tabs. */
function mcpFingerprintOf(account, project, cwd, read) {
  try {
    return SC.mcpFingerprint(SC.mcpPlan({ account, home: app.getPath('home'), cwd: isDir(cwd) ? cwd : null, office: officeInput(project), ...(read ? { read } : {}) }));
  } catch { return null; }
}
const statOrNull = (f) => { try { return fs.statSync(f); } catch { return null; } };
let mcpWatch = { seen: '', pending: '' };
/** The state of everything a tab's MCP set comes from: the watched files and the office's projects and settings. */
function mcpInputsKey() {
  const files = MR.watchFiles({
    home: app.getPath('home'),
    configDirs: state.accounts.map((a) => a.configDir),
    dirs: P.projectPlaces(state.projects).map((p) => p.dir),
  });
  const office = [state.shareMcp !== false, state.projects.map((p) => [p.dir, p.accountId]), state.accounts.map((a) => [a.id, a.shareDefault !== false])];
  return `${MR.statKey(files, statOrNull)}#${JSON.stringify(office)}`;
}
function refreshMcpPrints() {
  const memo = new Map();
  const read = (f) => { if (!memo.has(f)) memo.set(f, readJson(f)); return memo.get(f); };
  for (const [id, pr] of mcpPrint) {
    const r = P.resolvePty(state, id);
    if (r) pr.current = mcpFingerprintOf(A.accountOf(state, r.project), r.project, r.dir, read);
  }
}
/** Every 1.5 s (checkTurns): once a change has settled, recompute; restart each changed tab when it is idle. */
function checkMcp() {
  if (state.reloadMcp === false || !win || win.isDestroyed()) return;
  const { state: next, settled } = MR.settle(mcpWatch, mcpInputsKey());
  mcpWatch = next;
  if (settled) refreshMcpPrints();
  for (const [id, pr] of [...mcpPrint]) {
    if (pr.started === pr.current) continue;
    const r = P.resolvePty(state, id);
    if (!r) continue;
    const { configDir } = A.accountOf(state, r.project);
    const action = MR.reloadAction({ enabled: true, running: terms.has(id), started: pr.started, current: pr.current, blocker: tabBlocker(id, configDir) });
    if (action !== 'reload') continue;
    const sid = liveSession(id, configDir)?.sessionId;
    if (!sid) continue;
    send('pty:reloaded', id);
    startPty(id, { sessionId: sid });
  }
}

// --- account login
const shell = () => OS.defaultShell();
const accountById = (id) => state.accounts.find((a) => a.id === id) || null;
function accountEnv(account) {
  if (account.configDir) try { fs.mkdirSync(account.configDir, { recursive: true }); } catch {}
  return A.ptyEnv(process.env, account.configDir);
}

// --- Windows: no login shell; claude is found on PATH and started directly (see src/platform.js)
const CLAUDE_INSTALL_URL = 'https://code.claude.com/docs/en/setup';
const COMMANDCODE_URL = 'https://commandcode.ai/docs';
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
/** How to start claude with these arguments in this environment; null when Claude Code is not installed. */
function windowsClaude(args, env) {
  const claude = OS.findClaude(env, isFile);
  return claude ? OS.windowsCommand(claude, args, env) : null;
}
// Claude Code is missing: say so in the tab's terminal, then exit (Enter there tries again).
function sendNoClaude(id) {
  send('pty:data', id, `\r\n\x1b[31m${T('main.noClaude')}\x1b[0m\r\n${T('main.noClaudeHelp', { url: CLAUDE_INSTALL_URL })}\r\n`);
  send('pty:exit', id, 127);
}
/** How to start agy (contract v3.22) with these arguments; null when Antigravity is not installed. */
function windowsAgy(args, env) {
  const agy = OS.findAgy(env, isFile);
  return agy ? OS.windowsCommand(agy, args, env) : null;
}
/** How to start Command Code's CLI (contract v3.23) with these arguments; null when it is not installed. */
function windowsCommandCode(args, env) {
  const cmd = OS.findCommandCode(env, isFile);
  return cmd ? OS.windowsCommand(cmd, args, env) : null;
}
// Antigravity is missing: the same as for Claude Code (Enter there tries again).
function sendNoAgy(id) {
  send('pty:data', id, `\r\n\x1b[31m${T('main.noAgy')}\x1b[0m\r\n${T('main.noAgyHelp')}\r\n`);
  send('pty:exit', id, 127);
}
// Command Code is missing: the same as for Claude Code (Enter there tries again).
function sendNoCommandCode(id) {
  send('pty:data', id, `\r\n\x1b[31m${T('main.noCli')}\x1b[0m\r\n${T('main.noCliHelp', { url: COMMANDCODE_URL })}\r\n`);
  send('pty:exit', id, 127);
}
/** Agent Office as a Command Code mod (plugin/mods/agent-office.ts): tells the office about the `cmd` session and
 *  carries the manager brief. Passed as `--mod` when the file is there; '' otherwise. */
function commandCodeMod() {
  const dir = pluginDir();
  const f = dir ? path.join(dir, 'mods', 'agent-office.ts') : '';
  return f && isFile(f) ? f : '';
}
/** node-pty arguments: a verbatim cmd.exe line is passed as one pre-quoted string. */
const ptyArgs = (cmd) => (cmd.verbatim ? cmd.args.join(' ') : cmd.args);

// Non-interactive claude command, run from the login shell like the projects' ptys (PATH and rc files apply).
// Windows: claude itself (an exit code of 127 when it is missing, shown as "claude not found").
function runClaude(account, args, timeout) {
  return new Promise((resolve) => {
    let child;
    try {
      if (IS_WIN) {
        const env = accountEnv(account);
        const cmd = windowsClaude(args.split(' '), env);
        if (!cmd) return resolve({ err: Object.assign(new Error('claude not found'), { code: 127 }), stdout: '', stderr: '' });
        child = execFile(cmd.file, cmd.args, {
          env, cwd: app.getPath('home'), timeout, maxBuffer: 1 << 20, windowsVerbatimArguments: cmd.verbatim, windowsHide: true,
        }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
      } else {
        child = execFile(shell(), ['-l', '-i', '-c', A.claudeCommand(args)], {
          env: accountEnv(account), cwd: app.getPath('home'), timeout, maxBuffer: 1 << 20, killSignal: 'SIGKILL',
        }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
      }
    } catch (err) {
      return resolve({ err, stdout: '', stderr: '' });
    }
    // stdin is closed: so it doesn't hang if rc files or claude wait for input (there is a timeout too)
    try { child.stdin?.end(); } catch {}
  });
}

// One check per account; if a new request arrives while it runs, it runs once more when it finishes.
const checking = new Map();  // accountId → Promise
const again = new Set();
function checkAuth(id, { showChecking = false } = {}) {
  const account = accountById(id);
  if (!account) return Promise.resolve();
  if (showChecking && auths.get(id)?.state !== 'checking') { auths.set(id, { state: 'checking' }); sendAccounts(); }
  if (checking.has(id)) { again.add(id); return checking.get(id); }
  const run = (async () => {
    do {
      again.delete(id);
      const acc = accountById(id);
      if (!acc) break;
      const { err, stdout, stderr } = await runClaude(acc, 'auth status --json', 20000);
      if (!accountById(id)) break;
      auths.set(id, A.authFromRun(err, stdout, stderr));
      if (err && auths.get(id).state === 'error') console.error(`auth status (${id}):`, err.message);
      sendAccounts();
    } while (again.has(id));
    checking.delete(id);
  })();
  checking.set(id, run);
  return run;
}
const checkAllAuth = (opts) => Promise.all(state.accounts.map((a) => checkAuth(a.id, opts)));

let lastFocusCheck = 0;
function onFocus() {
  updateAttention();
  checkUpdatesOnFocus();
  if (Date.now() - lastFocusCheck < 60000) return;
  lastFocusCheck = Date.now();
  checkAllAuth();
}

// `claude auth login` pty: same channel as the project ptys, id 'login:<accountId>'. One per account;
// if reopened, the previous one (left from a closed window) is killed silently so its exit doesn't mix into the new window.
function startLogin(accountId) {
  const id = A.loginPtyId(accountId);
  const account = accountById(accountId);
  if (!account || !win) return;
  const old = logins.get(id);
  if (old) { logins.delete(id); try { old.kill(); } catch {} }
  const { cols, rows } = sizes.get(id) || lastSize;
  let t;
  try {
    if (IS_WIN) {
      const env = accountEnv(account);
      const cmd = windowsClaude(['auth', 'login'], env);
      if (!cmd) return sendNoClaude(id);
      t = pty.spawn(cmd.file, ptyArgs(cmd), { name: 'xterm-256color', cols, rows, cwd: app.getPath('home'), env });
    } else {
      t = pty.spawn(shell(), ['-l', '-i', '-c', A.claudeCommand('auth login')], {
        name: 'xterm-256color',
        cols, rows,
        cwd: app.getPath('home'),
        env: accountEnv(account),
      });
    }
  } catch (e) {
    console.error('giriş pty\'si başlatılamadı:', e.message);
    send('pty:exit', id, -1);
    return;
  }
  logins.set(id, t);
  t.onData((d) => { if (logins.get(id) === t) send('pty:data', id, d); });
  t.onExit(({ exitCode }) => {
    if (logins.get(id) !== t) return; // killed on purpose: silent
    logins.delete(id);
    send('pty:exit', id, exitCode);
    checkAuth(accountId, { showChecking: true });
  });
}

// --- account quota (see src/usage.js)
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };

// The script is written to userData/usage at startup (it is not run from inside the signed .app bundle).
// Windows: statusline.js and agent-office-statusline.cmd, which runs this executable as Node on it (see usage.js).
let usageScript;
function ensureUsageScript() {
  if (usageScript !== undefined) return usageScript;
  const f = path.join(usageRoot(), IS_WIN ? U.WIN_CMD : 'statusline.sh');
  try {
    fs.mkdirSync(usageRoot(), { recursive: true });
    if (IS_WIN) {
      fs.writeFileSync(path.join(usageRoot(), U.WIN_SCRIPT_NAME), U.WIN_SCRIPT);
      fs.writeFileSync(f, U.windowsCmdFile(process.execPath));
    } else {
      fs.writeFileSync(f, U.SCRIPT, { mode: 0o755 });
    }
    usageScript = f;
  } catch (e) {
    console.error('status line betiği yazılamadı:', e.message);
    usageScript = null;
  }
  return usageScript;
}

// Name of the tab's quota file: main tab `<projectId>`, extra tab `<projectId>-<n>` (.json).
const usageKey = (ptyId) => String(ptyId).replace(':', '-');
// The project's --settings and the user's own status line command (from the tab's folder). The tab's files under
// previous accounts are deleted: a project whose account changed must not look like it still writes the old account's quota.
function usageStatusLine(project, configDir, dir = project.dir, key = project.id) {
  const script = ensureUsageScript();
  if (!script) return null;
  const accDir = path.join(usageRoot(), project.accountId);
  try {
    for (const a of state.accounts) {
      if (a.id !== project.accountId) fs.rmSync(path.join(usageRoot(), a.id, `${key}.json`), { force: true });
    }
    fs.mkdirSync(accDir, { recursive: true });
  } catch (e) {
    console.error('kota klasörü:', e.message);
    return null;
  }
  const user = U.userStatusLine(U.settingsPaths(dir, configDir, app.getPath('home')).map(readJson));
  const out = path.join(accDir, `${key}.json`);
  if (IS_WIN) return { settings: U.windowsStatusLineSettings(user), userCommand: user?.command, out };
  return { settings: U.statusLineSettings(script, out, user), userCommand: user?.command };
}

// Windows: the --settings JSON goes in a file (userData/settings/<tab>.json; claude accepts a path), so no JSON has
// to survive cmd.exe's quoting when claude is npm's claude.cmd. If it cannot be written, the JSON itself is passed.
function settingsFile(key, json) {
  const f = path.join(app.getPath('userData'), 'settings', `${key}.json`);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, json);
    return f;
  } catch (e) {
    console.error('ayar dosyası yazılamadı:', e.message);
    return json;
  }
}

// Windows: what claude's environment needs for the status line (see usage.js): the tab's quota file, the folder of
// agent-office-statusline.cmd on PATH, and the shell Claude Code would run the user's own status line with.
let gitBash;
function windowsStatusLineEnv(env, sl) {
  delete env.AGENT_OFFICE_USAGE_OUT;
  delete env.AGENT_OFFICE_STATUSLINE_SHELL;
  if (!sl?.out) return env;
  if (gitBash === undefined) gitBash = OS.findGitBash(process.env, isFile);
  return { ...OS.withPathDir(env, usageRoot()), AGENT_OFFICE_USAGE_OUT: sl.out, AGENT_OFFICE_STATUSLINE_SHELL: gitBash || '' };
}

// The newest of the project files in the account folders; a changed account is written to last.json and sent.
const usageSeen = new Map(); // file → mtimeMs
function loadUsageCache() {
  for (const a of state.accounts) {
    const u = U.usageFromCache(readJson(path.join(usageRoot(), a.id, U.LAST)));
    if (u) { usages.set(a.id, u); alertUsage(a, u, true); }
  }
}
function scanUsage() {
  let changed = false;
  for (const a of state.accounts) {
    const dir = path.join(usageRoot(), a.id);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (n === U.LAST || !n.endsWith('.json')) continue;
      const f = path.join(dir, n);
      let mtime;
      try { mtime = fs.statSync(f).mtimeMs; } catch { continue; }
      if (usageSeen.get(f) === mtime) continue;
      usageSeen.set(f, mtime);
      const u = U.usageFromStatus(readJson(f), Math.round(mtime));
      if (!u || u.updatedAt <= (usages.get(a.id)?.updatedAt || 0)) continue;
      usages.set(a.id, u);
      alertUsage(a, u);
      try { fs.writeFileSync(path.join(dir, U.LAST), JSON.stringify(u)); } catch {}
      changed = true;
    }
  }
  if (changed) sendAccounts();
}

// --- token usage per project (contract v3.13, src/token-usage.js): read from the transcripts incrementally
const tokenScanner = new TU.UsageScanner();
/** The project's transcript folders: Claude Code's (its account's config folder) or Command Code's own
 * (~/.commandcode/projects, contract v3.23). Antigravity writes no transcripts. */
function tokenFolders(p) {
  const engine = P.engineOf(p);
  const root = engine === 'commandcode'
    ? path.join(app.getPath('home'), EN.CMD.home, 'projects')
    : path.join(A.accountOf(state, p).configDir || path.join(app.getPath('home'), '.claude'), 'projects');
  let names = [];
  try { names = fs.readdirSync(root); } catch {}
  const dirs = [p.dir, ...P.tabsOf(p).map((t) => t.dir).filter(Boolean)];
  const others = state.projects.filter((x) => x.id !== p.id).map((x) => x.dir);
  return TU.projectFolders(names, dirs, others, engine === 'commandcode' ? TU.ccSlugOf : undefined);
}
/** detail: also the costliest sub-agent runs and the fixed prefix (contract v3.21; the panel, not the row). */
async function tokenReport(id, { detail = false } = {}) {
  const p = P.findProject(state, id);
  if (!p || P.engineOf(p) === 'agy') return null; // Antigravity writes no transcripts (v3.22)
  const since = Number.isFinite(p.addedAt) ? p.addedAt : null;
  const folders = tokenFolders(p);
  const recs = await tokenScanner.scanFolders(folders, { since: since ?? 0 });
  const sessions = detail ? tokenScanner.sessions(folders) : null;
  return { projectId: p.id, name: p.name, ...TU.summarize(recs, { since, sessions }) };
}
/** Today's line for every project's row: [{ id, usd, total, pct }]. */
async function tokenBriefs() {
  const out = [];
  for (const p of state.projects) {
    try { const r = await tokenReport(p.id); if (r) out.push({ id: p.id, ...TU.brief(r) }); } catch (e) { console.error('token usage:', e.message); }
  }
  return out;
}
let tokenBusy = false;
async function pushTokenBriefs() {
  if (tokenBusy || !win || win.isDestroyed()) return;
  tokenBusy = true;
  try { send('tokens:brief', await tokenBriefs()); } finally { tokenBusy = false; }
}
ipcMain.handle('tokens:report', (_e, id) => tokenReport(id, { detail: true }));
ipcMain.handle('tokens:brief', () => tokenBriefs());

// Accounts other than default use the project's ~/.claude memory (see src/memory.js): the account's own memories
// are merged into it first, then the session gets autoMemoryDirectory pointing there. null: Claude Code's default.
function projectMemoryDir(cwd, configDir) {
  if (!configDir) return null;
  const base = M.memoryBase(cwd);
  const shared = M.sharedMemoryDir({ configDir, home: app.getPath('home'), base });
  if (!shared) return null;
  try { M.mergeMemory(M.accountMemoryDir({ configDir, base }), shared); } catch (e) { console.error('hafıza birleştirilemedi:', e.message); }
  return shared;
}

// Default's plugins, skills, MCP servers and CLAUDE.md for an account's session, and the other office projects' MCP
// servers for every session (see src/shared-config.js, contract v3.6 and v3.9): links in the account folder, plugin
// stages in userData/shared-plugins, the tab's MCP file in userData/mcp/<tab>.json.
const officeInput = (project) => ({
  share: state.shareMcp !== false,
  current: project.dir,
  projects: state.projects.map((p) => {
    const a = A.accountOf(state, p);
    return { name: p.name, dir: p.dir, configDir: a.configDir || null, share: SC.shareEnabled(a) };
  }),
});
function sharedConfig(account, project, cwd, key) {
  const office = officeInput(project);
  try {
    return SC.prepareShared({
      account, home: app.getPath('home'), cwd: isDir(cwd) ? cwd : null, office,
      stageRoot: path.join(app.getPath('userData'), 'shared-plugins'),
      mcpFile: path.join(mcpDir(), SC.mcpFileName(key)),
    });
  } catch (e) {
    console.error('varsayılan hesabın ayarları paylaşılamadı:', e.message);
    return { pluginDirs: [], mcpConfig: null, mcpNames: {} };
  }
}

// The tab's office directory (contract v3.9): the projects, their folders and accounts and the MCP servers this
// session sees for each. → the file for AGENT_OFFICE_DIRECTORY, or null.
function officeDirectoryFile(project, key, mcpNames) {
  const data = OD.officeDirectory({
    projects: state.projects.map((p) => ({ name: p.name, dir: p.dir, account: OD.accountName(A.accountOf(state, p)) })),
    current: project.dir,
    mcp: mcpNames || {},
  });
  return OD.writeDirectory(path.join(directoryDir(), SC.mcpFileName(key)), data);
}

// Is there a Claude session in the folder to resume with this account (see projects.js historyDir).
function hasHistory(dir, configDir) {
  try { return fs.readdirSync(P.historyDir(dir, configDir, app.getPath('home'))).some((f) => f.endsWith('.jsonl')); } catch { return false; }
}
// Is there a Command Code session in the folder (contract v3.23): its own `projects` folder at ~/.commandcode keeps
// the same file naming as Claude Code's (P.historyDir's dotDir), so a `.jsonl` says `--continue` has a conversation.
function hasCmdHistory(dir) {
  try { return fs.readdirSync(P.historyDir(dir, null, app.getPath('home'), EN.CMD.home)).some((f) => f.endsWith('.jsonl')); } catch { return false; }
}
const RESUME_GRACE_MS = 8000; // if --continue ends with an error within this time, claude restarts fresh

// (Re)starts a tab's claude; the id is projectId for the main tab, `<projectId>:<n>` for an extra tab.
// The size is that tab's last pty:resize. resume: continue the last session (--continue). The tab starts in its own
// folder (worktree) with the same account, plugin and status line rules. An extra tab in the same folder gets no
// --continue: so a second claude doesn't open the session the main tab is resuming. sessionId: wake from sleep with
// --resume <id>, the tab's own session. imported: a session just moved here from another computer (contract v3.4):
// if --resume fails it does not fall back to a fresh session; the user is told and the imported files stay.
// prompt: submitted as claude's positional prompt, only when the start resumes a session (interrupted work).
// A tab of an Antigravity project starts `agy` instead (startAgy, contract v3.22); a Command Code project starts
// `cmd` instead, with the office as its mod (startCommandCode, contract v3.23).
function startPty(id, { resume = false, sessionId = null, imported = false, prompt = '' } = {}) {
  killPty(id);
  const r = P.resolvePty(state, id);
  if (!r || !win || !isLoaded) return broadcast();
  asleep.delete(id);
  if (isAgy(r.project)) return startAgy(id, r, { resume, prompt });
  if (isCmd(r.project)) return startCommandCode(id, r, { resume, sessionId, prompt });
  const { project, tab, dir: cwd } = r;
  const account = A.accountOf(state, project);
  const { configDir } = account;
  if (configDir) try { fs.mkdirSync(configDir, { recursive: true }); } catch {}
  const { cols, rows } = sizes.get(id) || lastSize;
  // the plugin path is passed as $1: paths with spaces (Application Support) cause no quoting trouble.
  // The account folder is set again after the rc files (see accounts.js ptyEnv).
  // claude's arguments are passed via "$@": the plugin path and the settings JSON (status line for the quota, see
  // usage.js; the project memory folder, see memory.js).
  const dir = pluginDir();
  const sl = usageStatusLine(project, configDir, cwd, usageKey(id));
  const settings = M.withMemorySetting(sl?.settings, isDir(cwd) ? projectMemoryDir(cwd, configDir) : null);
  const isResume = Boolean(sessionId) || (resume && (!tab || Boolean(tab.worktree)) && hasHistory(cwd, configDir));
  const resumeArgs = sessionId ? ['--resume', sessionId] : isResume ? ['--continue'] : [];
  const settingsArg = IS_WIN && settings ? settingsFile(usageKey(id), settings) : settings;
  // Default's plugins and MCP servers for other accounts, other projects' MCP servers (--plugin-dir each,
  // --mcp-config <file>; see shared-config.js) and the office directory naming them (contract v3.9)
  const prepared = sharedConfig(account, project, cwd, usageKey(id));
  const shared = SC.sharedArgs(prepared);
  const directory = officeDirectoryFile(project, usageKey(id), prepared.mcpNames);
  const print = mcpFingerprintOf(account, project, cwd);
  const args = R.claudeArgs([...(dir ? ['--plugin-dir', dir] : []), ...shared, ...(settingsArg ? ['--settings', settingsArg] : [])], resumeArgs, prompt);
  const startedAt = Date.now();
  // after the rc files: the account's folder, the project's pinned subagent model (contract v3.14), its context
  // cap (v3.15) and its savings' tool output caps (v3.20; accounts.js sessionEnv)
  const cmd = '[ -n "$AGENT_OFFICE_CONFIG_DIR" ] && export CLAUDE_CONFIG_DIR="$AGENT_OFFICE_CONFIG_DIR"; '
    + '[ -n "$AGENT_OFFICE_AGENT_MODEL" ] && export CLAUDE_CODE_SUBAGENT_MODEL="$AGENT_OFFICE_AGENT_MODEL" CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1; '
    + '[ -n "$AGENT_OFFICE_CONTEXT_CAP" ] && export CLAUDE_CODE_AUTO_COMPACT_WINDOW="$AGENT_OFFICE_CONTEXT_CAP"; '
    + '[ -n "$AGENT_OFFICE_BASH_OUTPUT" ] && export BASH_MAX_OUTPUT_LENGTH="$AGENT_OFFICE_BASH_OUTPUT"; '
    + '[ -n "$AGENT_OFFICE_MCP_OUTPUT" ] && export MAX_MCP_OUTPUT_TOKENS="$AGENT_OFFICE_MCP_OUTPUT"; exec claude "$@"';
  let env = A.sessionEnv(A.ptyEnv(process.env, configDir), {
    manager: P.managerOf(state, project), agentModel: P.agentModelOf(project), contextCap: P.contextCapOf(project),
    savings: P.savingsOf(project),
  });
  delete env.AGENT_OFFICE_STATUSLINE;
  delete env.AGENT_OFFICE_DIRECTORY;
  if (directory) env.AGENT_OFFICE_DIRECTORY = directory;
  if (sl?.userCommand) env.AGENT_OFFICE_STATUSLINE = sl.userCommand;
  if (IS_WIN) env = windowsStatusLineEnv(env, sl);
  let t;
  try {
    // Windows: claude starts directly in a ConPTY (CLAUDE_CONFIG_DIR is already in env: no rc files to override it)
    const win32 = IS_WIN ? windowsClaude(args, env) : null;
    if (IS_WIN && !win32) { sendNoClaude(id); return broadcast(); }
    t = pty.spawn(win32 ? win32.file : shell(), win32 ? ptyArgs(win32) : ['-l', '-i', '-c', cmd, 'claude', ...args], {
      name: 'xterm-256color',
      cols, rows,
      cwd: isDir(cwd) ? cwd : app.getPath('home'),
      env,
    });
  } catch (e) {
    console.error('pty başlatılamadı:', e.message);
    send('pty:exit', id, -1);
    return broadcast();
  }
  terms.set(id, t);
  activity.set(id, { at: startedAt, draft: false });
  mcpPrint.set(id, { started: print, current: print });
  ptyStart.set(id, startedAt);
  ptyLimit.set(id, { scan: { tail: '' }, hitAt: 0 });
  if (sessionId) lastSid.set(id, sessionId); else lastSid.delete(id);
  t.onData((d) => {
    if (terms.get(id) !== t) return;
    const a = activity.get(id);
    if (a) a.at = Date.now();
    watchLimit(id, d, startedAt);
    send('pty:data', id, d);
  });
  t.onExit(({ exitCode }) => {
    if (terms.get(id) !== t) return; // killed on purpose (restart/removal): silent
    terms.delete(id);
    mcpPrint.delete(id);
    ptyStart.delete(id);
    ptyLimit.delete(id);
    // the session it was in, for Enter-restart: the pid file may still be there, else the last poll's
    const last = validSid(readJson(Z.claudePidFile(configDir, app.getPath('home'), t.pid))?.sessionId);
    if (last) lastSid.set(id, last);
    setMarks(R.clearInterrupted(marks(), [id])); // claude ended while the app runs: nothing to resume later
    removeMcpFile(id);
    // the session to resume was not found or could not be opened: start fresh without showing the exit to the user
    if (isResume && exitCode !== 0 && Date.now() - startedAt < RESUME_GRACE_MS) {
      if (!imported) return startPty(id);
      importResumeFailed(sessionId, configDir);
    }
    activity.delete(id);
    send('pty:exit', id, exitCode);
    broadcast();
  });
  broadcast();
}

// A tab of an Antigravity project (contract v3.22): `agy` from the same login shell, with none of Claude Code's setup
// (plugin, status line, memory, shared config and MCP fingerprint, history check, usage-limit watch) and an env built
// from an allowlist (agy keeps its own Google login and data). resume: --continue, only for a tab
// that continues (main tab, worktree tab); if it ends with an error within RESUME_GRACE_MS the tab starts fresh.
// prompt: agy's -i, only when resuming. There is no session id: a sleeping or restarted tab continues the same way.
function startAgy(id, { tab, dir: cwd }, { resume = false, prompt = '' } = {}) {
  removeMcpFile(id); // no MCP or office directory file of an earlier Claude Code start stays behind for this tab
  const { cols, rows } = sizes.get(id) || lastSize;
  const isResume = resume && (!tab || Boolean(tab.worktree));
  const args = EN.agyArgs({ resume: isResume, prompt });
  const startedAt = Date.now();
  // an allowlist of the user's env (engine.js agyEnv): no Claude, Anthropic, office (AGENT_OFFICE_*) or MCP variable,
  // no sessionEnv; no office directory file is written for it
  const env = EN.agyEnv(process.env);
  let t;
  try {
    const win32 = IS_WIN ? windowsAgy(args, env) : null;
    if (IS_WIN && !win32) { sendNoAgy(id); return broadcast(); }
    t = pty.spawn(win32 ? win32.file : shell(), win32 ? ptyArgs(win32) : ['-l', '-i', '-c', EN.AGY_COMMAND, 'agy', ...args], {
      name: 'xterm-256color',
      cols, rows,
      cwd: isDir(cwd) ? cwd : app.getPath('home'),
      env,
    });
  } catch (e) {
    console.error('pty başlatılamadı:', e.message);
    send('pty:exit', id, -1);
    return broadcast();
  }
  terms.set(id, t);
  activity.set(id, { at: startedAt, draft: false });
  lastSid.delete(id);
  t.onData((d) => {
    if (terms.get(id) !== t) return;
    const a = activity.get(id);
    if (a) a.at = Date.now();
    send('pty:data', id, d);
  });
  t.onExit(({ exitCode }) => {
    if (terms.get(id) !== t) return; // killed on purpose (restart/removal): silent
    terms.delete(id);
    setMarks(R.clearInterrupted(marks(), [id]));
    removeMcpFile(id);
    // no conversation to continue: start fresh without showing the exit to the user
    if (isResume && exitCode !== 0 && Date.now() - startedAt < RESUME_GRACE_MS) return startPty(id);
    activity.delete(id);
    send('pty:exit', id, exitCode);
    broadcast();
  });
  broadcast();
}

// A tab of a Command Code project (contract v3.23): `cmd` from the same login shell, with the office as its mod
// (plugin/mods/agent-office.ts) and the office's env (AGENT_OFFICE_*; the mod reads them) and directory file, the
// projects it sees. None of Claude Code's own setup: accounts (one `cmd login` per machine), plugin, --settings
// status line, memory, shared config and MCP fingerprint, usage-limit watch. sessionId: wake from sleep with
// --resume <id>, the tab's own session; a tab that continues (main tab, worktree tab) starts with --continue when
// the folder has a Command Code session (hasCmdHistory). A failed resume starts fresh after RESUME_GRACE_MS.
function startCommandCode(id, { project, tab, dir: cwd }, { resume = false, sessionId = null, prompt = '' } = {}) {
  removeMcpFile(id); // no MCP or office directory file of an earlier Claude Code start stays behind for this tab
  const { cols, rows } = sizes.get(id) || lastSize;
  const mod = commandCodeMod();
  const directory = officeDirectoryFile(project, usageKey(id), {});
  const isResume = Boolean(sessionId) || (resume && (!tab || Boolean(tab.worktree)) && hasCmdHistory(cwd));
  const resumeArgs = sessionId ? ['--resume', sessionId] : isResume ? ['--continue'] : [];
  const args = EN.cmdArgs(mod ? ['--mod', mod] : [], resumeArgs, prompt);
  const startedAt = Date.now();
  const cmd = EN.CMD_COMMAND;
  let env = A.sessionEnv(A.ptyEnv(process.env, null), { manager: P.managerOf(state, project) });
  delete env.AGENT_OFFICE_STATUSLINE;
  delete env.AGENT_OFFICE_DIRECTORY;
  env.AGENT_OFFICE_DIRECTORY = directory;
  let t;
  try {
    const win32 = IS_WIN ? windowsCommandCode(args, env) : null;
    if (IS_WIN && !win32) { sendNoCommandCode(id); return broadcast(); }
    t = pty.spawn(win32 ? win32.file : shell(), win32 ? ptyArgs(win32) : ['-l', '-i', '-c', cmd, EN.CMD.bin, ...args], {
      name: 'xterm-256color',
      cols, rows,
      cwd: isDir(cwd) ? cwd : app.getPath('home'),
      env,
    });
  } catch (e) {
    console.error('pty başlatılamadı:', e.message);
    send('pty:exit', id, -1);
    return broadcast();
  }
  terms.set(id, t);
  activity.set(id, { at: startedAt, draft: false });
  if (sessionId) lastSid.set(id, sessionId); else lastSid.delete(id);
  t.onData((d) => {
    if (terms.get(id) !== t) return;
    const a = activity.get(id);
    if (a) a.at = Date.now();
    send('pty:data', id, d);
  });
  t.onExit(({ exitCode }) => {
    if (terms.get(id) !== t) return; // killed on purpose (restart/removal): silent
    terms.delete(id);
    setMarks(R.clearInterrupted(marks(), [id]));
    removeMcpFile(id);
    // the session to resume was not found or could not be opened: start fresh without showing the exit to the user
    if (isResume && exitCode !== 0 && Date.now() - startedAt < RESUME_GRACE_MS) return startPty(id);
    activity.delete(id);
    send('pty:exit', id, exitCode);
    broadcast();
  });
  broadcast();
}

// After loading, start the claude of every project that isn't running (on reload, leave running ones alone).
// At startup (if the setting is on) every project continues from its last session. With sleeping on, a tab is only
// marked asleep: it starts when the renderer first shows it (pty:wake).
// Tabs whose claude was mid-turn when the app went away start right away and are told to carry on (src/resume.js),
// once per launch; marks left over (a setting off, a tab that cannot resume) are dropped.
let launched = false;
function startMissing() {
  if (!launched) {
    launched = true;
    const ids = state.projects.flatMap((p) => P.ptyIdsOf(p));
    const at = marks();
    for (const id of R.resumeTargets(at, ids, { resume: state.resume !== false, resumeWork: state.resumeWork !== false })) {
      if (!terms.has(id)) startPty(id, { sessionId: at[id] || null, resume: true, prompt: R.RESUME_PROMPT });
    }
    setMarks(R.clearInterrupted(marks(), Object.keys(at)));
  }
  for (const p of state.projects) {
    for (const id of P.ptyIdsOf(p)) {
      if (terms.has(id) || asleep.has(id)) continue;
      if (sleepMinutes()) asleep.set(id, { resume: true });
      else startPty(id, { resume: state.resume !== false });
    }
  }
  broadcast();
}
function wake(id) {
  const how = asleep.get(id);
  if (how && !terms.has(id)) startPty(id, Z.wakeOptions(how, state.resume !== false));
}

// --- "Resume unfinished work" (contract v3.8, src/resume.js): every tab that is marked or whose last conversation
// ends mid-turn is told to carry on. The conversation looked at is the one the tab would resume: a running tab's own
// session (its pid file), a sleeping tab's session, else the folder's newest one (what --continue opens; only for
// tabs that would --continue: the main tab and worktree tabs).
const ENTER_DELAY_MS = 300; // Enter after the pasted prompt, once Claude Code has taken the paste
/** The tab's name in the result: the project, plus the tab's branch or number for an extra tab. */
function tabName(r) {
  if (!r.tab) return r.project.name;
  return `${r.project.name} · ${r.tab.worktree ? r.tab.worktree.branch : `#${r.tab.n}`}`;
}
function unfinishedTabs() {
  const home = app.getPath('home');
  const at = marks();
  const tabs = [];
  for (const p of state.projects) {
    if (P.engineOf(p) !== 'claude') continue; // no Claude Code pid file or transcript for it (v3.22, v3.23)
    for (const id of P.ptyIdsOf(p)) {
      const r = P.resolvePty(state, id);
      if (!r) continue;
      const { configDir } = A.accountOf(state, p);
      const t = terms.get(id);
      const continues = !r.tab || Boolean(r.tab.worktree);
      let sid = '';
      let busy = false;
      if (t) {
        const claude = readJson(Z.claudePidFile(configDir, home, t.pid));
        sid = validSid(claude?.sessionId);
        busy = R.isTurnBusy({ claude, office: sid ? office()?.readSession(sid) : undefined });
      } else {
        const how = asleep.get(id);
        // asleep {} = start fresh
        if (how?.sessionId) sid = validSid(how.sessionId);
        else if (continues && (!how || how.resume)) sid = validSid(TIO.newestSession(r.dir, configDir, home));
      }
      const marked = Object.prototype.hasOwnProperty.call(at, id);
      const look = validSid(at[id]) || sid;
      const transcript = busy || !look ? 'none' : R.transcriptFileState(TIO.findTranscript(r.dir, look, configDir, home)?.file);
      tabs.push({ id, name: tabName(r), running: Boolean(t), busy, draft: Boolean(activity.get(id)?.draft), marked, markSid: at[id] || '', sessionId: sid, continues, transcript });
    }
  }
  return tabs;
}
/** Types the prompt into a running claude's input box and submits it. */
function typePrompt(id, text) {
  const t = terms.get(id);
  if (!t) return;
  t.write(R.typedPrompt(text));
  setTimeout(() => { if (terms.get(id) === t) t.write('\r'); }, ENTER_DELAY_MS);
  const a = activity.get(id);
  if (a) { a.at = Date.now(); a.draft = false; }
}
/** @returns {{ resumed: { id: string, name: string }[], skipped: { id: string, name: string }[] }} */
function resumeUnfinished() {
  if (!state || !win || !isLoaded) return { resumed: [], skipped: [] };
  const tabs = unfinishedTabs();
  const nameOf = (id) => ({ id, name: tabs.find((x) => x.id === id)?.name || id });
  const { actions, skipped } = R.unfinishedActions(tabs);
  for (const a of actions) {
    if (a.how === 'type') typePrompt(a.id, R.UNFINISHED_PROMPT);
    else startPty(a.id, { sessionId: a.sessionId || null, resume: true, prompt: R.UNFINISHED_PROMPT });
  }
  setMarks(R.clearInterrupted(marks(), actions.map((a) => a.id)));
  return { resumed: actions.map((a) => nameOf(a.id)), skipped: skipped.map(nameOf) };
}

// --- sleeping idle background tabs (see src/sleep.js)
const sleepMinutes = () => Z.normalizeSleep(state.sleepMinutes);
const scheduleSeen = new Map(); // transcript path → { key: "size|mtime", has }
function hasSchedule(file) {
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  const key = `${st.size}|${st.mtimeMs}`;
  const old = scheduleSeen.get(file);
  if (old?.key === key) return old.has;
  let has = false;
  try { has = Z.hasScheduleTool(fs.readFileSync(file, 'utf8')); } catch {}
  scheduleSeen.set(file, { key, has });
  return has;
}
function sleepIdle() {
  const minutes = sleepMinutes();
  if (!minutes || !win || win.isDestroyed()) return;
  const now = Date.now();
  const home = app.getPath('home');
  let slept = false;
  for (const [id, t] of [...terms]) {
    const r = P.resolvePty(state, id);
    if (!r) continue;
    const { configDir } = A.accountOf(state, r.project);
    const a = activity.get(id) || { at: now, draft: false };
    const base = { now, idleMs: minutes * 60000, lastActivityAt: a.at, hasDraft: a.draft, isActive: r.project.id === state.activeId };
    // cheap checks first: files are read only for a tab that is otherwise ready to sleep
    if (Z.sleepBlocker({ ...base, claude: { sessionId: '-', status: 'idle' }, office: {} })) continue;
    const claude = readJson(Z.claudePidFile(configDir, home, t.pid));
    const sid = typeof claude?.sessionId === 'string' && /^[\w-]+$/.test(claude.sessionId) ? claude.sessionId : '';
    const session = sid ? office()?.readSession(sid) : undefined;
    const schedule = sid ? hasSchedule(path.join(P.historyDir(r.dir, configDir, home), `${sid}.jsonl`)) : false;
    if (Z.sleepBlocker({ ...base, claude, office: session, hasSchedule: schedule })) continue;
    killPty(id);
    asleep.set(id, { sessionId: sid });
    send('pty:sleep', id);
    slept = true;
  }
  if (slept) broadcast();
}
// A project moved to another account (contract v3.16): its tabs stop, its Claude Code data (transcripts, file
// history, prompt history, the .claude.json projects entry; src/project-data.js) is copied into the new account's
// folder and merged there, and each tab starts again in the conversation it was in (--resume <its session>, else
// --continue for a tab that continues), like an MCP reload. A tab cut off mid-turn is told to carry on. A sleeping
// tab stays asleep and wakes into its own session. from: the project's account before the change.
// carryOn (v3.17): tabs that stopped at the usage limit; they are told to carry on like a tab cut off mid-turn.
// An Antigravity project (v3.22) ignores accounts: nothing moves and its tabs keep running.
function moveProject(projectId, from, { carryOn = [] } = {}) {
  const p = P.findProject(state, projectId);
  if (!p || P.engineOf(p) !== 'claude') return; // accounts change nothing for agy or Command Code (v3.22, v3.23)
  const home = app.getPath('home');
  const plan = [];
  for (const id of P.ptyIdsOf(p)) {
    const r = P.resolvePty(state, id);
    if (asleep.has(id)) continue;
    let sid = lastSid.get(id) || '';
    let busy = false;
    if (terms.has(id)) {
      const live = liveSession(id, from.configDir);
      if (live?.sessionId) sid = live.sessionId;
      busy = Boolean(sid) && (carryOn.includes(id) || R.isTurnBusy({ claude: live?.claude, office: office()?.readSession(sid) }));
      killPty(id);
    }
    plan.push({ id, opts: PD.restartAfterMove({ sessionId: validSid(sid) || null, continues: !r?.tab || Boolean(r.tab.worktree), busy }, R.UNFINISHED_PROMPT) });
  }
  const to = A.accountOf(state, p);
  try {
    PD.moveProjectData({
      from: from.configDir || null, to: to.configDir || null, home,
      dirs: [p.dir, ...P.tabsOf(p).map((t) => t.dir).filter(Boolean)],
      otherDirs: state.projects.filter((x) => x.id !== p.id).map((x) => x.dir),
    });
  } catch (e) { console.error('proje verisi taşınamadı:', e.message); }
  for (const { id, opts } of plan) startPty(id, opts);
}

// --- backup account at the usage limit (contract v3.17, src/fallback.js)
// A tab whose session ends on Claude Code's usage-limit error (its transcript; the terminal's words only with the
// account's quota at 100 %) moves its project to the project's backup account with moveProject: every tab resumes its
// own conversation there and the tabs stopped by the limit are told to carry on. The account it left is its home; once
// the home's limit resets and every tab is idle, the project goes back. Each account's limit is remembered until its
// reset (state.accountLimits), so no project moves onto an account at its limit and none ping-pongs.
const fallbackOn = () => state.fallback !== false;
const limitMarks = () => state.accountLimits || {};
const switches = new Map();   // projectId → times of its automatic moves (FB.switchAllowed)
const limitDone = new Set();  // "<pty id>|<limit time>": a limit already acted on
const stuckSaid = new Set();  // "<project>|<account>|<reason>|<until>": a "no backup" notice already shown
let returnTick = 0;
/** The tab's output: usage-limit words after the first seconds of its start are a hint (FB.scanPty). */
function watchLimit(id, d, startedAt) {
  const w = ptyLimit.get(id);
  if (!w) return;
  const r = FB.scanPty(w.scan, d);
  w.scan = r.scan;
  if (r.hit && Date.now() - startedAt > FB.PTY_GRACE_MS) w.hitAt = Date.now();
}
/** The end of a file (FB.TAIL_BYTES), or ''. */
function readTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, FB.TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
const tailSeen = new Map(); // transcript → { key: "size|mtime|since", hit }
/** Does the tab's session end on a usage limit written since the tab started? → FB.limitFromTranscript result | null */
function transcriptLimit(id, dir, configDir) {
  const sid = lastSid.get(id);
  if (!sid) return null;
  const file = TIO.findTranscript(dir, sid, configDir, app.getPath('home'))?.file;
  const st = file ? statOrNull(file) : null;
  if (!st) return null;
  const since = ptyStart.get(id) || 0;
  const key = `${st.size}|${st.mtimeMs}|${since}`;
  const old = tailSeen.get(file);
  if (old?.key === key) return old.hit;
  const hit = FB.limitFromTranscript(readTail(file), { since });
  tailSeen.set(file, { key, hit });
  return hit;
}
const accountName = (a) => (a.id === A.DEFAULT_ID ? T('main.defaultAccount') : a.label);
/** Accounts as FB.pickBackup reads them: login state and quota. */
const fallbackAccounts = () => state.accounts.map((a) => ({ id: a.id, auth: auths.get(a.id), usage: usages.get(a.id) }));
function setLimitMark(accountId, mark) {
  const old = limitMarks()[accountId];
  if (old && old.until >= mark.until) return;
  state = { ...state, accountLimits: { ...FB.normalizeMarks(limitMarks(), state.accounts.map((a) => a.id)), [accountId]: mark } };
  saveState();
}
/** Tells the renderer (a hint over the project's terminals) and the system (a notification). */
function fallbackNotice(p, kind, text, extra = {}) {
  send('account:fallback', { projectId: p.id, kind, text, ...extra });
  notify(p.name, text, p.id);
}
/** Every 1.5 s (checkTurns): a limit in any running tab; every ~15 s, projects on a backup that may go home. */
function checkLimits() {
  if (!fallbackOn() || !win || win.isDestroyed()) return;
  const now = Date.now();
  const returning = returnTick++ % 10 === 0;
  for (const p of state.projects) {
    if (P.engineOf(p) !== 'claude') continue; // no Claude Code account or transcript for it (v3.22, v3.23)
    const account = A.accountOf(state, p);
    const usageFull = () => FB.limitedUntil({ usage: usages.get(account.id), now }) > 0;
    const hits = [];
    for (const id of P.ptyIdsOf(p)) {
      if (!terms.has(id)) continue;
      const r = P.resolvePty(state, id);
      if (!r) continue;
      let hit = transcriptLimit(id, r.dir, account.configDir);
      const w = ptyLimit.get(id);
      if (!hit && w?.hitAt && now - w.hitAt < 60000 && usageFull()) hit = { at: w.hitAt, resetsAt: null, type: null, text: '' };
      if (hit && !limitDone.has(`${id}|${hit.at}`)) hits.push({ id, hit });
    }
    if (hits.length) onLimit(p, account, hits, now);
    else if (returning && p.homeAccount) maybeReturn(p, account, now);
  }
}
function onLimit(p, account, hits, now) {
  const resets = hits.map((h) => h.hit.resetsAt).filter(Number.isFinite);
  const mark = FB.markFor(resets.length ? Math.max(...resets) : null, now);
  setLimitMark(account.id, mark);
  const done = () => { for (const h of hits) limitDone.add(`${h.id}|${h.hit.at}`); };
  const choice = P.backupOf(p);
  if (!choice) return done(); // no backup set: Claude Code's own limit message stands
  const pick = FB.pickBackup({ choice, current: account.id, home: p.homeAccount || null, accounts: fallbackAccounts(), marks: limitMarks(), now });
  const allowed = FB.switchAllowed(switches.get(p.id), now);
  switches.set(p.id, allowed.history);
  const stuck = !pick.id ? (pick.reason === 'none' ? '' : pick.reason) : !allowed.ok ? allowed.reason : '';
  if (!pick.id || !allowed.ok) {
    const key = `${p.id}|${account.id}|${stuck}|${mark.until}`;
    if (stuck && !stuckSaid.has(key)) {
      stuckSaid.add(key);
      fallbackNotice(p, 'stuck', T(stuck === 'loop' || stuck === 'soon' ? 'main.fallbackLoop' : 'main.fallbackStuck', { from: accountName(account) }), { reason: stuck });
    }
    return; // looked at again every 1.5 s: a backup that logs in or resets is used then (the notice is not repeated)
  }
  const to = accountById(pick.id);
  if (!to) return;
  done();
  switches.set(p.id, [...allowed.history, now]);
  const next = P.fallbackTo(state, p.id, to.id);
  if (next === state) return;
  fallbackNotice(p, 'switched', T('main.fallbackSwitched', { from: accountName(account), to: accountName(to) }), { from: account.id, to: to.id, ptyIds: P.ptyIdsOf(p) });
  commit(next);
  moveProject(p.id, account, { carryOn: hits.map((h) => h.id) });
}
/** A running tab that can restart without losing anything: no turn, no unsent text, no agent or shell of its session working. */
function tabIdle(pid, configDir) {
  const t = terms.get(pid);
  if (!t) return true;
  if (activity.get(pid)?.draft) return false;
  const claude = readJson(Z.claudePidFile(configDir, app.getPath('home'), t.pid));
  const sid = validSid(claude?.sessionId);
  const session = sid ? office()?.readSession(sid) : undefined;
  if (R.isTurnBusy({ claude, office: session })) return false;
  return !(session?.workers || []).some((w) => w && w.doneAt === undefined) && !(session?.shells || []).some((x) => x && x.endAt === undefined);
}
function maybeReturn(p, account, now) {
  const home = accountById(p.homeAccount);
  if (!home) return;
  const hist = switches.get(p.id) || [];
  const idle = P.ptyIdsOf(p).every((pid) => tabIdle(pid, account.configDir));
  const ok = FB.shouldReturn({
    home: { id: home.id, auth: auths.get(home.id), usage: usages.get(home.id) }, current: account.id,
    mark: limitMarks()[home.id], idle, lastSwitch: hist.length ? Math.max(...hist) : 0, now,
  });
  if (!ok) return;
  const next = P.returnHome(state, p.id);
  if (next === state) return;
  switches.set(p.id, [...hist, now]);
  fallbackNotice(p, 'returned', T('main.fallbackReturned', { to: accountName(home), from: accountName(account) }), { from: account.id, to: home.id, ptyIds: P.ptyIdsOf(p) });
  commit(next);
  moveProject(p.id, account);
}
// Per-project backup account (v3.17): null (none) | 'auto' | an account id. Nothing restarts.
ipcMain.handle('projects:setBackup', (_e, id, value) => { commit(P.setProjectBackup(state, id, value)); });

// Worktree session names → project name (see projects.js sessionAliases): the office and notifications count them toward the project.
const sessionAliases = () => P.sessionAliases(state.projects);

let usagePoll = null;
let tokenPoll = null;
let sleepPoll = null;
let turnPoll = null;
function startPolling() {
  clearInterval(poll);
  clearInterval(usagePoll);
  clearInterval(tokenPoll);
  clearInterval(sleepPoll);
  clearInterval(turnPoll);
  usagePoll = setInterval(scanUsage, 3000);
  tokenPoll = setInterval(pushTokenBriefs, 60000);
  setTimeout(pushTokenBriefs, 8000); // the first full read waits until the window has settled
  sleepPoll = setInterval(sleepIdle, 30000);
  turnPoll = setInterval(checkTurns, 1500);
  let tick = 0;
  poll = setInterval(() => {
    const s = office();
    if (!s || !win || win.isDestroyed()) return;
    // while the window is unfocused, read every two seconds instead of twice a second (battery); notifications still come
    if (!win.isFocused() && tick++ % 4 !== 0) return;
    try {
      const d = s.readOffice(state.projects.map((p) => p.name), undefined, undefined, sessionAliases(), P.projectPlaces(state.projects));
      send('office:data', d);
      lastOffice = d.projects;
      updateAttention();
    } catch (e) { console.error('readOffice:', e.message); }
  }, 500);
}

// A folder already in the list is only activated (its claude starts if it is stopped).
function addDir(dir) {
  const r = P.addProject(state, dir);
  commit(r.state);
  if (!terms.has(r.project.id)) startPty(r.project.id);
  return r.project;
}

// --- projects
ipcMain.handle('projects:list', () => snapshot());
ipcMain.handle('projects:add', async () => {
  const dir = await pickFolder();
  return dir ? addDir(dir) : null;
});
// Removing a project closes all its tabs; worktree folders are left untouched (like the project folder).
ipcMain.handle('projects:remove', (_e, id) => {
  const p = P.findProject(state, id);
  for (const pid of p ? P.ptyIdsOf(p) : [id]) {
    killPty(pid);
    asleep.delete(pid);
    sizes.delete(pid);
    if (p) try { fs.rmSync(path.join(usageRoot(), p.accountId, `${usageKey(pid)}.json`), { force: true }); } catch {}
  }
  commit(P.removeProject(state, id));
});
// the project left in the background starts its idle time now: it was in view until this moment (src/sleep.js)
ipcMain.handle('projects:setActive', (_e, id) => {
  const left = P.findProject(state, state.activeId);
  if (left && left.id !== id) for (const pid of P.ptyIdsOf(left)) { const a = activity.get(pid); if (a) a.at = Date.now(); }
  commit(P.setActive(state, id));
  updateAttention();
});
ipcMain.handle('projects:setAccount', (_e, id, accountId) => {
  const p = P.findProject(state, id);
  if (!p || p.accountId === accountId) return;
  const from = A.accountOf(state, p);
  const next = P.setProjectAccount(state, id, accountId);
  if (next === state) return;
  commit(next);
  moveProject(id, from);
});
// Per-project manager mode (contract v3.10): true delegates, false does it itself, null follows the global setting.
// It applies when a tab's claude starts next; a running tab that sits idle (no turn, no prompt typed, no agent or
// shell of its session still working) restarts at once, resuming its own session. Returns the restarted pty ids.
ipcMain.handle('projects:setManager', (_e, id, value) => {
  const next = P.setProjectManager(state, id, value);
  if (next === state) return { restarted: [] };
  const was = P.managerOf(state, P.findProject(state, id));
  commit(next);
  const p = P.findProject(state, id);
  if (!p || P.managerOf(state, p) === was) return { restarted: [] };
  return { restarted: restartIdle(p) };
});
// Per-project subagent model (contract v3.14): 'sonnet' | 'haiku' | 'opus' pins every subagent, null = Auto (the
// boss picks per agent). Applies like the manager setting: next start, idle tabs at once. Returns the restarted pty ids.
ipcMain.handle('projects:setAgentModel', (_e, id, value) => {
  const next = P.setProjectAgentModel(state, id, value);
  if (next === state) return { restarted: [] };
  commit(next);
  const p = P.findProject(state, id);
  return { restarted: p ? restartIdle(p) : [] };
});
// Per-project context cap (contract v3.15): 200000 | 400000 tokens (CLAUDE_CODE_AUTO_COMPACT_WINDOW), null = Auto.
// Applies like the agent model: next start, idle tabs at once. Returns the restarted pty ids.
ipcMain.handle('projects:setContextCap', (_e, id, value) => {
  const next = P.setProjectContextCap(state, id, value);
  if (next === state) return { restarted: [] };
  commit(next);
  const p = P.findProject(state, id);
  return { restarted: p ? restartIdle(p) : [] };
});
// Per-project savings (contract v3.20): 'off' | 'normal' | 'strict' (accounts.js SAVINGS). Applies like the context
// cap: next start, idle tabs at once. Returns the restarted pty ids.
ipcMain.handle('projects:setSavings', (_e, id, value) => {
  const next = P.setProjectSavings(state, id, value);
  if (next === state) return { restarted: [] };
  commit(next);
  const p = P.findProject(state, id);
  return { restarted: p ? restartIdle(p) : [] };
});
// Per-project engine (contract v3.22): 'agy' runs Google Antigravity CLI, 'commandcode' (v3.23) runs Command Code,
// null (or 'claude') Claude Code. Engines share no conversation, so every tab of the project starts again at once,
// fresh (sleeping and stopped tabs too). Work is never cut off silently: leaving Claude Code is refused while a tab
// of it is not idle (tabBlocker, as for a session move), and leaving agy or Command Code, whose busy state the app
// cannot track per tab, asks first while any of its tabs runs.
// Returns the restarted pty ids, plus refused: the blocker or 'cancelled' when nothing changed for that reason.
ipcMain.handle('projects:setEngine', async (_e, id, value) => {
  const p = P.findProject(state, id);
  if (!p || P.setProjectEngine(state, id, value) === state) return { restarted: [] };
  const running = P.ptyIdsOf(p).filter((pid) => terms.has(pid));
  if (P.engineOf(p) === 'claude') {
    const { configDir } = A.accountOf(state, p);
    const blocker = running.map((pid) => tabBlocker(pid, configDir)).find(Boolean);
    if (blocker) {
      if (win) await warnBox(T('main.engineBlocked'), T(`main.moveBlocker.${blocker}`));
      return { restarted: [], refused: blocker };
    }
  } else if (running.length) {
    if (!win) return { restarted: [], refused: 'cancelled' };
    const choice = isCmd(p)
      ? await ask(T('main.engineCcConfirm', { name: p.name }), T('main.engineCcDetail'), [T('main.engineSwitch'), T('main.cancel')], 'warning')
      : await ask(T('main.engineAgyConfirm', { name: p.name }), T('main.engineAgyDetail'), [T('main.engineSwitch'), T('main.cancel')], 'warning');
    if (choice !== 0) return { restarted: [], refused: 'cancelled' };
  }
  const next = P.setProjectEngine(state, id, value); // again: the state may have changed while the dialog was open
  if (next === state) return { restarted: [] };
  commit(next);
  const now = P.findProject(state, id);
  if (!now) return { restarted: [] };
  const ids = P.ptyIdsOf(now);
  for (const pid of ids) startPty(pid);
  return { restarted: ids };
});
/** Restarts the project's idle tabs, each resuming its own session; returns their pty ids. */
function restartIdle(p) {
  const restarted = [];
  for (const pid of P.ptyIdsOf(p)) {
    const sid = idleSession(pid);
    if (!sid) continue;
    startPty(pid, { sessionId: sid, resume: true });
    restarted.push(pid);
  }
  return restarted;
}
/** A running tab's session id when its claude can restart without losing anything, else ''. */
function idleSession(pid) {
  const t = terms.get(pid);
  const r = P.resolvePty(state, pid);
  if (!t || !r || P.engineOf(r.project) !== 'claude' || activity.get(pid)?.draft) return ''; // claude-engine tabs only (v3.22, v3.23)
  const { configDir } = A.accountOf(state, r.project);
  const claude = readJson(Z.claudePidFile(configDir, app.getPath('home'), t.pid));
  const sid = validSid(claude?.sessionId);
  const session = sid ? office()?.readSession(sid) : undefined;
  if (!sid || R.isTurnBusy({ claude, office: session })) return '';
  const working = (session?.workers || []).some((w) => w && w.doneAt === undefined) || (session?.shells || []).some((x) => x && x.endAt === undefined);
  return working ? '' : sid;
}

// --- accounts
ipcMain.handle('accounts:list', () => accountList());
ipcMain.handle('accounts:add', (_e, label) => {
  const r = A.addAccount(state, label, { id: crypto.randomBytes(6).toString('hex'), root: accountsRoot() });
  try { fs.mkdirSync(r.account.configDir, { recursive: true }); } catch (e) { console.error('hesap klasörü:', e.message); }
  commit(r.state, { accounts: true });
  checkAuth(r.account.id);
  return A.withAuth([r.account], (id) => auths.get(id))[0];
});
ipcMain.handle('accounts:rename', (_e, id, label) => { commit(A.renameAccount(state, id, label), { accounts: true }); });
// "Use Default's plugins, skills and MCP servers": applies when the account's sessions start next (nothing restarts).
ipcMain.handle('accounts:setShare', (_e, id, on) => { commit(A.setAccountShare(state, id, on), { accounts: true }); });
// The folder is not deleted: its login and history are not lost if an account is deleted by mistake.
ipcMain.handle('accounts:remove', (_e, id) => {
  const from = accountById(id);
  const r = A.removeAccount(state, id);
  if (r.state === state || !from) return;
  killPty(A.loginPtyId(id));
  auths.delete(id);
  usages.delete(id);
  try { fs.rmSync(path.join(usageRoot(), id), { recursive: true, force: true }); } catch {}
  commit(r.state, { accounts: true });
  for (const pid of r.moved) moveProject(pid, from);
});

ipcMain.handle('accounts:refreshAuth', async (_e, id) => {
  await (id ? checkAuth(id, { showChecking: true }) : checkAllAuth({ showChecking: true }));
  return accountList();
});
ipcMain.handle('accounts:login', (_e, id) => { startLogin(id); });
ipcMain.handle('accounts:logout', async (_e, id) => {
  const account = accountById(id);
  // the default account is the user's normal Claude Code login: the app does not log out of it
  if (!account || !account.configDir) return;
  auths.set(id, { state: 'checking' });
  sendAccounts();
  const { err, stderr } = await runClaude(account, 'auth logout', 20000);
  if (err) console.error(`auth logout (${id}):`, err.message, stderr);
  await checkAuth(id);
});

// --- tabs (contract v3.0): several claudes per project; the first tab is the main terminal and cannot be closed
// git runs with the app's environment (/usr/bin/git is on PATH even when launched from Finder); it never asks for a password.
function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: app.getPath('home'), timeout: 30000, maxBuffer: 1 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '').trim() || (err ? err.message : '') }));
  });
}
// If the folder is inside a git repo, the repo root (the real path git reports), otherwise null.
async function gitTop(dir) {
  if (!isDir(dir)) return null;
  const r = await git(['-C', dir, 'rev-parse', '--show-toplevel']);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

// "+" menu: same folder or new worktree (asked only in a git repo). null if nothing is chosen.
function pickTabMode() {
  return new Promise((resolve) => {
    const menu = Menu.buildFromTemplate([
      { label: T('main.tabSame'), click: () => resolve('same') },
      { label: T('main.tabWorktree'), click: () => resolve('worktree') },
    ]);
    // the click arrives shortly after the menu closes; if it doesn't, the user cancelled
    menu.popup({ window: win, callback: () => setTimeout(() => resolve(null), 300) });
  });
}

function openTab(projectId, tab) {
  commit(P.addTab(state, projectId, tab));
  startPty(P.tabPtyId(projectId, tab.n));
  return tab;
}

// Creates a worktree in a `<repo>-wt-<n>` folder next to the repo, on branch `agent-office/<n>` (from HEAD).
// The number skips numbers whose folder or branch already exists.
async function addWorktreeTab(project) {
  const repo = await gitTop(project.dir);
  if (!repo) { await dialog.showMessageBox(win, { type: 'info', message: T('main.notGit') }); return null; }
  const list = await git(['-C', repo, 'branch', '--list', 'agent-office/*', '--format=%(refname:short)']);
  const branches = new Set(list.stdout.split('\n').map((b) => b.trim()).filter(Boolean));
  const n = P.nextTabNumber(project, (k) => fs.existsSync(P.worktreeRoot(repo, k)) || branches.has(P.worktreeBranch(k)));
  const root = P.worktreeRoot(repo, n);
  const branch = P.worktreeBranch(n);
  const r = await git(['-C', repo, 'worktree', 'add', '-b', branch, root]);
  if (!r.ok) { await dialog.showMessageBox(win, { type: 'warning', message: T('main.worktreeFailed'), detail: r.stderr }); return null; }
  let real = project.dir;
  try { real = fs.realpathSync(project.dir); } catch {}
  // the project may have been removed while waiting for the menu/git
  if (!P.findProject(state, project.id)) return null;
  return openTab(project.id, { n, dir: P.worktreeDir(repo, root, real), worktree: { root, repo, branch } });
}

// Removes the tab from the state (along with its pty, size and quota file).
function dropTab(project, n) {
  const id = P.tabPtyId(project.id, n);
  killPty(id);
  asleep.delete(id);
  sizes.delete(id);
  try { fs.rmSync(path.join(usageRoot(), project.accountId, `${usageKey(id)}.json`), { force: true }); } catch {}
  commit(P.removeTab(state, project.id, n));
}

// mode: 'same' | 'worktree'; if not given, a git repo asks via the menu, otherwise the same folder. → Tab | null
ipcMain.handle('tabs:add', async (_e, projectId, mode) => {
  const p = P.findProject(state, projectId);
  if (!p || !win) return null;
  let m = mode === 'same' || mode === 'worktree' ? mode : null;
  if (!m) m = (await gitTop(p.dir)) ? await pickTabMode() : 'same';
  if (m === 'worktree') return addWorktreeTab(p);
  const now = P.findProject(state, projectId);
  if (m === 'same' && now) return openTab(now.id, { n: P.nextTabNumber(now) });
  return null;
});
// Asks before closing. A worktree tab also asks whether to remove the worktree; if git refuses (there are changes)
// the tab stays and its claude continues from its last session. → { closed, restarted? }
ipcMain.handle('tabs:close', async (_e, projectId, n) => {
  const p = P.findProject(state, projectId);
  const tab = P.tabsOf(p).find((t) => t.n === n);
  if (!p || !tab || !win) return { closed: false };
  if (!tab.worktree) {
    const r = await dialog.showMessageBox(win, {
      type: 'question', buttons: [T('main.closeTab'), T('main.cancel')], defaultId: 0, cancelId: 1,
      message: T('main.closeTabConfirm'), detail: T('main.closeTabDetail'),
    });
    if (r.response !== 0) return { closed: false };
    dropTab(p, n);
    return { closed: true };
  }
  const w = tab.worktree;
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: [T('main.removeWorktree'), T('main.keepWorktree'), T('main.cancel')], defaultId: 0, cancelId: 2,
    message: T('main.closeWorktreeConfirm', { branch: w.branch }), detail: T('main.closeWorktreeDetail', { root: w.root }),
  });
  if (r.response === 2) return { closed: false };
  if (r.response === 1) { dropTab(p, n); return { closed: true }; }
  const id = P.tabPtyId(p.id, n);
  killPty(id); // so it isn't deleted while claude is writing in the folder
  const g = await git(['-C', w.repo, 'worktree', 'remove', w.root]);
  if (g.ok) { dropTab(p, n); return { closed: true }; }
  await dialog.showMessageBox(win, { type: 'warning', message: T('main.worktreeKept'), detail: T('main.worktreeKeptDetail', { error: g.stderr }) });
  startPty(id, { resume: true });
  return { closed: false, restarted: true };
});

// --- moving a session to another computer (contract v3.4; src/transfer.js, src/transfer-io.js)
// Export: the project's main tab session, only when idle, into one .agentoffice file. Import: File > Open session
// file…, or opening/double-clicking a .agentoffice file. Every step asks with a native dialog.
const OS_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const osName = (p) => OS_NAMES[p] || String(p || '?');
const validSid = (s) => (typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(s) ? s : '');
const shortSha = (s) => String(s || '').slice(0, 10);
/** @param {any} e */
const transferErrorText = (e) => (e?.code && T.has(`main.transferError.${e.code}`) ? T(`main.transferError.${e.code}`) : String(e?.message || e));
/** @param {string} message @param {string} [detail] */
const warnBox = (message, detail) => dialog.showMessageBox(win, { type: 'warning', message, detail });
/**
 * A question with buttons; resolves to the chosen index (the last button cancels).
 * @param {string} message @param {string} detail @param {string[]} buttons
 * @param {'none' | 'info' | 'error' | 'question' | 'warning'} [type]
 */
async function ask(message, detail, buttons, type = 'question') {
  const r = await dialog.showMessageBox(win, { type, message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true });
  return r.response;
}
async function claudeVersion(account) {
  const { err, stdout } = await runClaude(account, '--version', 20000);
  return err ? null : (TR.parseVersion(stdout) || []).join('.') || null;
}
/** The running claude of a tab: { sessionId, claude (its pid file) } or null when the tab is not running. */
function liveSession(ptyId, configDir) {
  const t = terms.get(ptyId);
  if (!t) return null;
  const claude = readJson(Z.claudePidFile(configDir, app.getPath('home'), t.pid));
  return { claude, sessionId: validSid(claude?.sessionId) };
}
/** Why the tab's claude must not be touched now ('' = it may): the export rules (transfer.js exportBlocker). */
function tabBlocker(ptyId, configDir) {
  const live = liveSession(ptyId, configDir);
  if (!live) return '';
  return TR.exportBlocker({ running: true, claude: live.claude, office: live.sessionId ? office()?.readSession(live.sessionId) : undefined, hasDraft: activity.get(ptyId)?.draft });
}

let transferBusy = false;
async function exportSession(projectId) {
  const p = P.findProject(state, projectId || state.activeId);
  if (!p || !win || transferBusy) return;
  if (isAgy(p) || isCmd(p)) { // v3.22, v3.23: neither engine's sessions move between computers
    const msg = isAgy(p) ? T('main.moveAgy') : T('main.moveCc');
    return dialog.showMessageBox(win, { type: 'info', message: msg });
  }
  transferBusy = true;
  try {
    const home = app.getPath('home');
    const account = A.accountOf(state, p);
    const { configDir } = account;
    const live = liveSession(p.id, configDir);
    const blocker = tabBlocker(p.id, configDir);
    if (blocker) return await warnBox(T('main.moveBlocked'), T(`main.moveBlocker.${blocker}`));
    const sessionId = live ? live.sessionId : validSid(asleep.get(p.id)?.sessionId) || TIO.newestSession(p.dir, configDir, home);
    if (!sessionId) return await dialog.showMessageBox(win, { type: 'info', message: T('main.moveNoSession') });
    const label = account.id === A.DEFAULT_ID ? T('main.defaultAccount') : account.label;
    let ex;
    try {
      ex = await TIO.collectExport({ dir: p.dir, sessionId, configDir, home, appVersion: app.getVersion(), claudeVersion: await claudeVersion(account), accountLabel: label });
    } catch (e) { return await warnBox(T('main.moveFailed'), transferErrorText(e)); }
    const g = ex.manifest.git;
    const lines = [T('main.moveWarning'), ''];
    if (g) {
      lines.push(g.branch ? T('main.moveCode', { branch: g.branch, commit: shortSha(g.head) }) : T('main.moveCodeDetached', { commit: shortSha(g.head) }));
      if (g.changed) lines.push(T('main.moveChanges', { n: g.changed }));
      if (g.unpushed) lines.push(T('main.moveUnpushed', { n: g.unpushed }));
    } else lines.push(T(ex.notes.noCommits ? 'main.moveNoCommits' : 'main.moveNoGit'));
    if (ex.notes.skipped.length) lines.push(T('main.moveSkipped', { files: ex.notes.skipped.slice(0, 10).join(', ') + (ex.notes.skipped.length > 10 ? ', …' : '') }));
    lines.push(ex.notes.memorySkipped ? T('main.moveMemorySkipped') : T('main.moveMemory', { n: ex.manifest.contents.memoryFiles }));
    if (await ask(T('main.moveConfirm', { name: p.name }), lines.join('\n'), [T('main.moveSave'), T('main.cancel')], 'warning') !== 0) return;
    const r = await dialog.showSaveDialog(win, {
      title: T('main.moveSaveTitle'),
      defaultPath: path.join(app.getPath('downloads'), TR.archiveName(p.name)),
      filters: [{ name: T('main.sessionFileType'), extensions: [TR.EXT] }],
    });
    if (r.canceled || !r.filePath) return;
    try { TIO.writeArchive(r.filePath, ex.entries); } catch (e) { return await warnBox(T('main.moveFailed'), String(e?.message || e)); }
    if (await ask(T('main.moveSaved', { file: path.basename(r.filePath) }), T('main.moveSavedDetail'), [T('main.showInFolder'), T('main.ok')], 'info') === 0) eShell.showItemInFolder(r.filePath);
  } finally { transferBusy = false; }
}

// .agentoffice files opened before the window could show them (macOS open-file at launch, argv on Windows/Linux)
/** @type {string[]} */
const pendingImports = [];
const sessionFileArgs = (argv, cwd = process.cwd()) =>
  argv.filter((a) => typeof a === 'string' && a.toLowerCase().endsWith(`.${TR.EXT}`)).map((a) => path.resolve(cwd, a)).filter(isFile);
function openSessionFile(file) {
  if (!win || win.isDestroyed() || !isLoaded) { pendingImports.push(file); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  importSession(file);
}
function flushImports() {
  const files = pendingImports.splice(0);
  if (files.length) setTimeout(() => { for (const f of files) openSessionFile(f); }, 300);
}

/** A sidebar project that looks like the session's: same git remote first, then the same folder name. */
async function importCandidate(m) {
  const urls = (m.git?.remotes || []).map((r) => r.url).concat(m.git?.remote || []);
  if (urls.length) {
    for (const p of state.projects) {
      if (!isDir(p.dir)) continue;
      const r = await TIO.runGit(['remote', '-v'], { cwd: p.dir, timeout: 10000 });
      const theirs = r.ok ? r.text.split('\n').map((l) => l.split(/\s+/)[1]).filter(Boolean) : [];
      if (TR.remotesMatch(urls, theirs)) return p;
    }
  }
  return state.projects.find((p) => p.name === m.source.projectName && isDir(p.dir)) || null;
}

async function pickImportDir(m) {
  const r = await dialog.showOpenDialog(win, {
    title: T('main.importPick', { name: m.source.projectName || '' }),
    buttonLabel: T('main.importPickButton'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

async function importSession(file) {
  if (!win || transferBusy) return;
  transferBusy = true;
  try { await runImport(file); } catch (e) { await warnBox(T('main.importFailed'), transferErrorText(e)); } finally { transferBusy = false; }
}

async function runImport(file) {
  if (!file) {
    const r = await dialog.showOpenDialog(win, { title: T('main.importPickFile'), properties: ['openFile'], filters: [{ name: T('main.sessionFileType'), extensions: [TR.EXT] }] });
    if (r.canceled || !r.filePaths[0]) return;
    file = r.filePaths[0];
  }
  let parsed;
  try { parsed = TIO.loadArchive(file); } catch (e) { return warnBox(T('main.importBad'), transferErrorText(e)); }
  const m = parsed.manifest;
  const g = m.git;
  const home = app.getPath('home');
  const name = m.source.projectName || path.basename(m.source.projectDir);

  // 1. what is inside
  const info = [T('main.importFrom', { date: new Date(m.createdAt).toLocaleString(uiLang()), machine: m.source.hostname || '?', os: osName(m.source.platform) })];
  if (g) {
    info.push(g.branch ? T('main.moveCode', { branch: g.branch, commit: shortSha(g.head) }) : T('main.moveCodeDetached', { commit: shortSha(g.head) }));
    if (g.changed || g.unpushed) info.push(T('main.importChanges', { n: g.changed || 0, u: g.unpushed || 0 }));
  } else info.push(T('main.importNoCode'));
  if (await ask(T('main.importInfo', { name }), info.join('\n'), [T('main.continue'), T('main.cancel')]) !== 0) return;

  // 2. the folder on this computer
  let dir = null;
  const cand = await importCandidate(m);
  if (cand) {
    const c = await ask(T('main.importInto', { dir: cand.dir }), T('main.importIntoDetail', { name: cand.name }), [T('main.useFolder'), T('main.otherFolder'), T('main.cancel')]);
    if (c === 2) return;
    dir = c === 0 ? cand.dir : await pickImportDir(m);
  } else dir = await pickImportDir(m);
  if (!dir) return;

  // 3. the code: same repository, clean tree, the recorded commits present
  let target = null;
  if (g) {
    target = await TIO.inspectTarget(parsed, dir);
    if (!target.isRepo) {
      let empty = false;
      try { empty = fs.readdirSync(dir).length === 0; } catch {}
      if (!empty || !g.remote) return warnBox(T('main.importNotGit'), T('main.importNotGitDetail', { url: g.remote || '—' }));
      if (await ask(T('main.importClone', { url: g.remote }), '', [T('main.clone'), T('main.cancel')]) !== 0) return;
      const cl = await TIO.cloneInto(g.remote, dir);
      if (!cl.ok) return warnBox(T('main.importCloneFailed'), cl.stderr);
      target = await TIO.inspectTarget(parsed, dir);
      if (!target.isRepo) return warnBox(T('main.importNotGit'), T('main.importNotGitDetail', { url: g.remote }));
    }
    if (!target.remoteMatches && (g.remotes || []).length) {
      const theirs = target.remotes.map((r) => r.url).join(', ') || '—';
      if (await ask(T('main.importRemote', { url: g.remote || '' }), T('main.importRemoteDetail', { here: theirs }), [T('main.continue'), T('main.cancel')], 'warning') !== 0) return;
    }
    if (target.plan?.action === 'dirty') return warnBox(T('main.importDirty'), T('main.importDirtyDetail'));
    const prep = await TIO.prepareGit(parsed, target.top);
    if (!prep.ok) return warnBox(T('main.importFetchFailed'), prep.error);
  }

  // 4. the project and account it goes to; its tab must be idle
  const real = (d) => { try { return fs.realpathSync(d); } catch { return d; } };
  const existing = P.findByDir(state, dir) || state.projects.find((p) => real(p.dir) === real(dir)) || null;
  if (existing && (isAgy(existing) || isCmd(existing))) {
    const msg = isAgy(existing) ? T('main.moveAgy') : T('main.moveCc');
    return warnBox(msg);
  }
  const account = existing ? A.accountOf(state, existing) : accountById(A.DEFAULT_ID) || A.DEFAULT_ACCOUNT;
  if (existing && tabBlocker(existing.id, account.configDir)) return warnBox(T('main.importTargetBusy'), T(`main.moveBlocker.${tabBlocker(existing.id, account.configDir)}`));
  let newId = null;
  if (TIO.findSessionFiles(m.session.id, account.configDir, home).length) {
    if (await ask(T('main.importExists'), T('main.importExistsDetail'), [T('main.importAsNew'), T('main.cancel')]) !== 0) return;
    newId = crypto.randomUUID();
  }

  // 5. last look, then do it
  const steps = [];
  if (target?.plan?.action === 'branch') steps.push(T('main.importWillBranch', { branch: target.plan.branch, commit: shortSha(g.head) }));
  if (g?.handoff) steps.push(T('main.importWillApply'));
  steps.push(existing && (terms.has(existing.id) || asleep.has(existing.id)) ? T('main.importWillRestart') : T('main.importWillStart'));
  const here = await claudeVersion(account);
  if (TR.compareVersions(here, m.claude?.version) < 0) steps.push(T('main.importOlderClaude', { here, there: m.claude.version }));
  if (await ask(T('main.importConfirm', { dir }), steps.join('\n'), [T('main.import'), T('main.cancel')]) !== 0) return;
  if (g && target) {
    const a = await TIO.applyGit(parsed, target.top, target.plan);
    if (!a.ok) return warnBox(T('main.importFailed'), a.error === 'dirty' ? T('main.importDirtyDetail') : a.error);
  }
  const placed = TIO.placeSession(parsed, { targetDir: dir, configDir: account.configDir, home, gitTop: target?.top || null, newId });
  // the project is still there? (it may have been removed while the dialogs were open)
  let projectId;
  if (existing && P.findProject(state, existing.id)) {
    projectId = existing.id;
    commit(P.setActive(state, projectId));
  } else {
    const r = P.addProject(state, dir);
    projectId = r.project.id;
    commit(r.state);
  }
  startPty(projectId, { sessionId: placed.sessionId, imported: true });
  if (placed.memorySkipped) await dialog.showMessageBox(win, { type: 'info', message: T('main.importMemorySkipped') });
}

// --resume of an imported session failed (contract v3.4: no silent fresh start)
function importResumeFailed(sessionId, configDir) {
  const file = TIO.findSessionFiles(sessionId, configDir, app.getPath('home'))[0] || sessionId;
  if (win && !win.isDestroyed()) warnBox(T('main.importResumeFailed'), T('main.importResumeFailedDetail', { file, id: sessionId }));
}

// the sidebar's "Resume unfinished work" button (v3.8); the menu item sends the result as work:resumed
ipcMain.handle('work:resumeUnfinished', () => resumeUnfinished());

// right click on a project in the sidebar
ipcMain.handle('projects:menu', (_e, id) => {
  const p = P.findProject(state, id);
  if (!p || !win) return;
  Menu.buildFromTemplate([
    { label: T('main.moveSession'), enabled: P.engineOf(p) === 'claude', click: () => exportSession(p.id) },
    { type: 'separator' },
    { label: T('main.openSessionFile'), click: () => importSession(null) },
  ]).popup({ window: win });
});

// --- pty (each message carries a tab's pty id — projectId or `<projectId>:<n>` — or 'login:<accountId>')

ipcMain.on('pty:write', (_e, id, d) => {
  if (!terms.has(id)) wake(id);
  const a = activity.get(id);
  if (a) { a.at = Date.now(); a.draft = Z.draftAfter(a.draft, d); }
  ptyOf(id)?.write(d);
});
// the renderer shows a tab: a sleeping one starts (lazy start, wake from sleep)
ipcMain.on('pty:wake', (_e, id) => wake(id));
ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  if (!(cols > 0 && rows > 0)) return;
  // the login window's size must not change the projects' default size
  if (A.loginAccountId(id) === null) lastSize = { cols, rows };
  sizes.set(id, { cols, rows });
  try { ptyOf(id)?.resize(cols, rows); } catch {}
});
// Enter after claude exited: the tab starts again in the session it was in (v3.11, mcp-reload.js restartOptions)
ipcMain.on('pty:restart', (_e, id) => {
  const acc = A.loginAccountId(id);
  if (acc === null) {
    const r = P.resolvePty(state, id);
    return startPty(id, MR.restartOptions({ sessionId: terms.has(id) ? null : lastSid.get(id), continues: !r?.tab || Boolean(r.tab.worktree) }));
  }
  killPty(id);
  startLogin(acc);
});

// Files copied in Finder: one file is public.file-url, several are NSFilenamesPboardType (plist).
// Electron 44 clipboard API: has() and readText() return Promises, there is no availableFormats/readImage.
// It doesn't see files copied in Finder; macOS's own clipboard (osascript, furl) provides them.
function macClipboardFiles() {
  // first check whether the clipboard really holds a file (furl): otherwise macOS turns plain text into a path too
  const script = 'repeat with c in (clipboard info)\n if item 1 of c is «class furl» then return POSIX path of (the clipboard as «class furl»)\nend repeat\nreturn ""';
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 3000 }, (err, stdout) => {
      const p = String(stdout || '').trim();
      resolve(!err && p.startsWith('/') ? [p] : []);
    });
  });
}
// Linux: file managers put files as text/uri-list (or x-special/gnome-copied-files).
// Electron's clipboard first, else wl-paste (Wayland) / xclip (X11); if neither exists, there are no files.
async function linuxClipboardFiles() {
  try {
    for (const item of await clipboard.read()) {
      const type = ['x-special/gnome-copied-files', 'text/uri-list'].find((t) => item.types.includes(t));
      if (!type) continue;
      const blob = await item.getType(type);
      const files = OS.filesFromUriList(blob instanceof Blob ? await blob.text() : '');
      if (files.length) return files;
    }
  } catch {}
  for (const { cmd, args } of OS.linuxClipboardCommands()) {
    const out = await new Promise((resolve) => {
      execFile(cmd, args, { timeout: 2000 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
    });
    const files = OS.filesFromUriList(out);
    if (files.length) return files;
  }
  return [];
}
// Windows: Explorer puts CF_HDROP (every file) and FileNameW (the first) on the clipboard; Electron 44 shows such
// formats as 'electron application/osclipboard;format="…"' items, in no set order, so every kind is read and
// pickWindowsFiles prefers the full list (v3.19). If that gives no full list and the clipboard holds no text (a file
// copy has none) and no image, PowerShell's Get-Clipboard reads the file list (slower, so only then). The same pass
// notes an image (a screenshot is CF_DIB/PNG, which has('image/png') may not report).
/** @param {string} text the clipboard's text, already read */
async function windowsClipboard(text) {
  /** @type {{ drop?: string[], uri?: string[], name?: string[] }} */
  const found = {};
  let image = false;
  try {
    for (const item of await clipboard.read()) {
      for (const type of item.types) {
        if (OS.windowsImageType(type)) image = true;
        const kind = OS.windowsClipboardKind(type);
        if (!kind || found[kind]?.length) continue;
        const blob = await item.getType(type).catch(() => null);
        if (!(blob instanceof Blob)) continue;
        const buf = Buffer.from(await blob.arrayBuffer());
        found[kind] = kind === 'drop' ? OS.filesFromDropFiles(buf)
          : kind === 'name' ? OS.filesFromFileNameW(buf) : OS.filesFromUriList(buf.toString('utf8'), 'win32');
      }
    }
  } catch {}
  const picked = OS.pickWindowsFiles(found);
  if (picked.complete && picked.files.length) return { files: picked.files, image };
  if (!picked.files.length && (text || image)) return { files: [], image };
  const out = await new Promise((resolve) => {
    execFile('powershell.exe', OS.POWERSHELL_FILES, { timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
  const listed = OS.filesFromLines(out);
  return { files: listed.length ? listed : picked.files, image };
}
const clipboardFiles = () => (IS_MAC ? macClipboardFiles() : linuxClipboardFiles());
const IMAGE_TYPES = ['image/png', 'image/tiff', 'image/jpeg', 'image/gif', 'image/heic'];
async function clipboardHasImage() {
  for (const t of IMAGE_TYPES) if (await clipboard.has(t)) return true;
  return false;
}
ipcMain.handle('clipboard:read', async () => {
  if (IS_WIN) {
    const text = await clipboard.readText().catch(() => '');
    const { files, image } = await windowsClipboard(text);
    return { files, hasImage: !files.length && (image || await clipboardHasImage().catch(() => false)), text };
  }
  const files = await clipboardFiles();
  return { files, hasImage: !files.length && await clipboardHasImage(), text: await clipboard.readText() };
});
ipcMain.on('edit:nativePaste', (e) => e.sender.paste());
ipcMain.handle('clipboard:hasImage', () => clipboardHasImage());
ipcMain.handle('office:today', () => {
  const s = office();
  return s ? s.readToday(state.projects.map((p) => p.name), undefined, undefined, sessionAliases()) : { date: '', deliveries: [], untracked: 0 };
});
// --- themes (contract v3.1): the gallery (repo themes/*.json, Resources/themes when packaged) under the user's
// ~/.claude/agent-office/themes.json. Gallery themes lose their `match` (src/themes.mjs): they apply only when picked.
/** @typedef {{ galleryThemes(files: unknown[]): Record<string, any>, mergeThemes(gallery: Record<string, any>, user: unknown): Record<string, any>, normalizeThemeSetting(v: unknown): string }} ThemesLib */
/** @type {ThemesLib | null} */
let TH = null; // loaded at startup, like src/i18n.mjs
async function loadThemesLib() {
  try { TH = await import('./src/themes.mjs'); } catch {}
}
/** @type {unknown[] | null} */
let galleryFiles = null; // read once: the gallery ships with the app and does not change while it runs
function readGalleryFiles() {
  if (galleryFiles) return galleryFiles;
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'themes') : path.join(__dirname, '..', 'themes');
  galleryFiles = [];
  try {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      try { galleryFiles.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch {}
    }
  } catch {}
  return galleryFiles;
}
ipcMain.handle('office:themes', () => {
  const s = office();
  let user = {};
  try { user = s ? s.readThemes() : {}; } catch {}
  try { return TH ? TH.mergeThemes(TH.galleryThemes(readGalleryFiles()), user) : user; } catch { return user; }
});

// On Linux under npm start the window icon is the repo's build/icon.png; when packaged it comes from the .desktop file
// (Windows: from the executable).
function devIcon() {
  const icon = path.join(__dirname, 'build', 'icon.png');
  return !app.isPackaged && fs.existsSync(icon) ? { icon } : {};
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 950,
    minWidth: 900, minHeight: 640,
    backgroundColor: '#2b1d1a',
    // macOS: title bar inside the page, traffic lights above it; Linux and Windows: the system's normal frame
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 10 } } : devIcon()),
    title: 'Agent Office',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--agent-office-home=${app.getPath('home')}`],   // preload's agentOffice.home (v3.18)
    },
  });
  // The window shows only its own page: no new windows, no navigating elsewhere; web links open in the browser.
  const openOutside = (url) => { if (/^https?:\/\//i.test(url)) eShell.openExternal(url).catch(() => {}); };
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) { e.preventDefault(); openOutside(url); } });
  isLoaded = false;
  win.once('ready-to-show', () => win.show());
  win.on('focus', onFocus);
  if (IS_WIN) win.on('focus', () => win?.flashFrame(false));
  win.on('closed', () => { killAll(); asleep.clear(); clearInterval(poll); clearInterval(usagePoll); clearInterval(sleepPoll); clearInterval(turnPoll); isLoaded = false; win = null; });

  // The folder from the command line is added/activated; if there are no projects, ask for a folder.
  const arg = argProject();
  if (arg) commit(P.addProject(state, arg).state);
  for (const f of sessionFileArgs(process.argv.slice(app.isPackaged ? 1 : 2))) if (!pendingImports.includes(f)) pendingImports.push(f);
  if (!state.projects.length && !pendingImports.length) {
    const dir = await pickFolder();
    if (dir) commit(P.addProject(state, dir).state);
  }

  // If the pty starts before the renderer sets up its size and listeners, output is lost; wait for the load.
  win.webContents.on('did-finish-load', () => { isLoaded = true; startMissing(); flushImports(); });
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  startPolling();
}

fixSpawnHelper();
// Windows: notifications are shown under this id; the installer's Start menu shortcut carries the same one (appId)
if (IS_WIN) app.setAppUserModelId('io.github.isisever.agentoffice');
// App menu: Paste (⌘V) goes to the renderer; if focus is in the terminal, the clipboard image/file/text
// is passed to Claude Code in a suitable form, otherwise a normal paste happens.
// ---- Updates: from GitHub Releases (electron-updater). A new version downloads in the background; the title bar
// button or quitting the app installs it. Runs only in the packaged (signed) app. On Linux only the AppImage
// updates itself (latest-linux.yml); a .deb install is the package manager's job, the updater is off. Windows: the
// NSIS installer (latest.yml; the app is not code-signed, so nothing checks a publisher signature).
const noSelfUpdate = () => !OS.canSelfUpdate();
let updater = null;
let updateReady = null; // downloaded version
let updateDownloading = null; // version being downloaded
let updateCheck = null; // the check in flight (checks never overlap)
let lastUpdateCheck = 0;
function setupUpdates() {
  if (!app.isPackaged || noSelfUpdate()) return;
  try { ({ autoUpdater: updater } = require('electron-updater')); } catch (e) { console.error('electron-updater yok:', e.message); return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-available', (info) => { if (info?.version !== updateReady) updateDownloading = info?.version || null; });
  updater.on('update-not-available', () => { updateDownloading = null; });
  updater.on('update-downloaded', (info) => { updateDownloading = null; updateReady = info.version; send('update:ready', info.version); });
  updater.on('error', (e) => { updateDownloading = null; console.error('güncelleme:', e?.message || e); });
  setTimeout(backgroundCheck, UP.FIRST_CHECK_MS);
  setInterval(backgroundCheck, UP.UPDATE_EVERY_MS);
}
/** one check at a time: a second caller gets the check already in flight */
function runUpdateCheck() {
  if (!updater) return Promise.resolve(null);
  if (updateCheck) return updateCheck;
  lastUpdateCheck = Date.now();
  updateCheck = updater.checkForUpdates().finally(() => { updateCheck = null; });
  return updateCheck;
}
function backgroundCheck() {
  if (!updater || updateDownloading) return;
  runUpdateCheck().catch((e) => console.error('güncelleme denetimi:', e?.message || e));
}
function checkUpdatesOnFocus() {
  if (updater && UP.shouldCheckOnFocus(lastUpdateCheck)) backgroundCheck();
}
// manual check from the menu: the result is shown in a short dialog
async function checkUpdatesNow() {
  if (!updater) return dialog.showMessageBox(win, { message: app.isPackaged && noSelfUpdate() ? T('main.updatesManual') : T('main.updatesOnlyInstalled') });
  const current = app.getVersion();
  let latest = null;
  if (!updateReady && !updateDownloading) {
    try {
      const r = await runUpdateCheck();
      latest = r?.updateInfo?.version || null;
    } catch (e) {
      return dialog.showMessageBox(win, { type: 'warning', message: T('main.updateFailed'), detail: String(e?.message || e) });
    }
  }
  const m = UP.updateMessage({ current, ready: updateReady, downloading: updateDownloading, latest });
  if (m.kind === 'ready') return send('update:ready', m.version);
  if (m.kind === 'downloading') return dialog.showMessageBox(win, { message: T('main.downloading', { version: m.version }) });
  if (m.kind === 'upToDate') return dialog.showMessageBox(win, { message: T('main.upToDate', { version: m.version }) });
  dialog.showMessageBox(win, { type: 'warning', message: T('main.updateFailed'), detail: T('main.updateNoAnswer', { version: m.version }) });
}
ipcMain.handle('update:state', () => ({ version: app.getVersion(), ready: updateReady }));
ipcMain.on('update:install', () => { if (updateReady && updater) { killAll(); updater.quitAndInstall(); } });

function buildMenu() {
  const name = app.getName();
  // Linux and Windows: no hide/show roles; cut/copy/paste use Ctrl+Shift (Ctrl+C/V in the terminal go to claude,
  // Chromium's own Ctrl+C/V works in text boxes).
  const keys = OS.shortcuts();
  const hideRoles = IS_MAC ? [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }] : [];
  /** @param {any} item @param {string | null} accelerator */
  const withKey = (item, accelerator) => (accelerator ? { ...item, accelerator } : item);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: name, submenu: [{ role: 'about' }, { label: T('main.checkUpdates'), click: () => checkUpdatesNow() }, { type: 'separator' }, ...hideRoles, { role: 'quit' }] },
    { label: T('main.file'), submenu: [
      { label: T('main.openSessionFile'), click: () => importSession(null) },
      { label: T('main.moveSession'), click: () => exportSession(state.activeId) },
      { type: 'separator' },
      { label: T('main.resumeUnfinished'), click: () => send('work:resumed', resumeUnfinished()) },
    ] },
    { label: T('main.edit'), submenu: [
      { role: 'undo', label: T('main.undo') }, { role: 'redo', label: T('main.redo') }, { type: 'separator' },
      withKey({ role: 'cut', label: T('main.cut') }, keys.cut), withKey({ role: 'copy', label: T('main.copy') }, keys.copy),
      { label: T('main.paste'), accelerator: keys.paste, click: () => send('edit:paste') },
      { role: 'selectAll', label: T('main.selectAll') },
    ] },
    { label: T('main.view'), submenu: [{ role: 'reload', label: T('main.reload') }, { role: 'toggleDevTools', label: T('main.devTools') }, { type: 'separator' }, { role: 'togglefullscreen', label: T('main.fullscreen') }] },
    { role: 'windowMenu', label: T('main.window') },
  ]));
}

// --- preferences: resume = continue from the last session at startup; theme = 'auto' or a theme name (v3.1);
// manager = the boss delegates to agents (plugin manager mode, AGENT_OFFICE_MANAGER), for sessions started afterwards;
// sleepMinutes = end idle background claudes after this long (0 = off, see src/sleep.js);
// resumeWork = at startup, tabs interrupted mid-turn carry on by themselves (needs resume; see src/resume.js);
// shareMcp = each session also gets the other office projects' MCP servers (contract v3.9), for sessions started afterwards;
// reloadMcp = an idle running tab whose MCP servers changed restarts in its session (contract v3.11);
// fallback = a project at the usage limit moves to its backup account and back after the reset (contract v3.17)
const themeSetting = (v) => (TH ? TH.normalizeThemeSetting(v) : 'auto');
const prefs = () => ({ resume: state.resume !== false, resumeWork: state.resumeWork !== false, theme: themeSetting(state.theme), manager: state.manager !== false, shareMcp: state.shareMcp !== false, reloadMcp: state.reloadMcp !== false, fallback: state.fallback !== false, sleepMinutes: sleepMinutes() });
ipcMain.handle('prefs:get', () => prefs());
ipcMain.handle('prefs:set', (_e, p) => {
  if (p && typeof p.resume === 'boolean' && p.resume !== prefs().resume) commit({ ...state, resume: p.resume });
  if (p && typeof p.resumeWork === 'boolean' && p.resumeWork !== prefs().resumeWork) commit({ ...state, resumeWork: p.resumeWork });
  if (p && typeof p.manager === 'boolean' && p.manager !== prefs().manager) commit({ ...state, manager: p.manager });
  if (p && typeof p.shareMcp === 'boolean' && p.shareMcp !== prefs().shareMcp) commit({ ...state, shareMcp: p.shareMcp });
  if (p && typeof p.reloadMcp === 'boolean' && p.reloadMcp !== prefs().reloadMcp) commit({ ...state, reloadMcp: p.reloadMcp });
  if (p && typeof p.fallback === 'boolean' && p.fallback !== prefs().fallback) commit({ ...state, fallback: p.fallback });
  if (p && typeof p.theme === 'string' && themeSetting(p.theme) !== prefs().theme) commit({ ...state, theme: themeSetting(p.theme) });
  if (p && Z.SLEEP_CHOICES.includes(p.sleepMinutes) && p.sleepMinutes !== prefs().sleepMinutes) {
    commit({ ...state, sleepMinutes: p.sleepMinutes });
    // turned off: every sleeping tab starts again, as if the app had started without sleeping
    if (!p.sleepMinutes) for (const id of [...asleep.keys()]) wake(id);
  }
  return prefs();
});

// --- language
ipcMain.handle('language:get', () => languageInfo());
ipcMain.handle('language:set', (_e, setting) => {
  if (!LANG_SETTINGS.includes(setting) || setting === langSetting()) return languageInfo();
  commit({ ...state, language: setting }, { accounts: true });
  buildMenu();
  send('language:changed', languageInfo());
  return languageInfo();
});

// One app at a time (packaged app only: under npm start a second copy may run beside the installed one). A second
// launch passes its folder or .agentoffice file to this one. macOS opens files with open-file, also at launch.
const isSecondInstance = app.isPackaged && !app.requestSingleInstanceLock();
if (isSecondInstance) app.exit(0);
app.on('second-instance', (_e, argv, cwd) => {
  if (!state) return;
  const files = sessionFileArgs(argv.slice(1), cwd);
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  for (const f of files) openSessionFile(f);
  if (files.length) return;
  const dir = argv.slice(1).filter((a) => !a.startsWith('-')).map((a) => path.resolve(cwd, a)).find((d) => isDir(d) && d !== path.resolve(cwd));
  if (dir && win) addDir(dir);
});
app.on('open-file', (e, file) => {
  e.preventDefault();
  if (file.toLowerCase().endsWith(`.${TR.EXT}`)) openSessionFile(file);
});

if (!isSecondInstance) app.whenReady().then(async () => {
  await loadI18n();
  await loadThemesLib();
  const raw = loadState();
  const base = P.normalizeState(raw);
  state = { ...base, interrupted: R.normalizeInterrupted(raw.interrupted, base.projects.flatMap((p) => P.ptyIdsOf(p))), language: LANG_SETTINGS.includes(raw.language) ? raw.language : 'auto', resume: raw.resume !== false, resumeWork: raw.resumeWork !== false, manager: raw.manager !== false, shareMcp: raw.shareMcp !== false, reloadMcp: raw.reloadMcp !== false, fallback: raw.fallback !== false, accountLimits: FB.normalizeMarks(raw.accountLimits, base.accounts.map((a) => a.id)), theme: themeSetting(raw.theme), sleepMinutes: Z.normalizeSleep(raw.sleepMinutes) };
  app.setAboutPanelOptions({ applicationName: app.getName(), applicationVersion: app.getVersion() });
  buildMenu();
  setupUpdates();
  saveState();
  // MCP files left by an earlier run (a crash, a forced quit): no tab is running yet, so none belongs to one
  SC.pruneMcpFiles(mcpDir(), [...terms.keys()].map(usageKey));
  SC.pruneMcpFiles(directoryDir(), [...terms.keys()].map(usageKey));
  loadUsageCache();
  lastFocusCheck = Date.now();
  checkAllAuth();
  // in the packaged app the icon comes from the .icns; under npm start set it on the Dock by hand (Linux has no app.dock)
  if (!app.isPackaged) try { app.dock?.setIcon(path.join(__dirname, 'build', 'icon.png')); } catch {}
  return createWindow();
});
app.on('activate', () => { if (!win && state) createWindow(); });
app.on('window-all-closed', () => { killAll(); app.quit(); });
app.on('before-quit', killAll);
