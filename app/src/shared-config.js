// What every account borrows from the Default account's ~/.claude (no Electron; tested with node --test).
//
// An account other than default runs with its own CLAUDE_CONFIG_DIR, so on its own it would see none of the
// plugins, skills and MCP servers the user installed for plain Claude Code. With the account's "Use Default's
// plugins, skills and MCP servers" setting on (the default), each session start re-syncs them. One mechanism per
// item, each the one Claude Code 2.1.296 loads without touching the user's ~/.claude:
//
// - User MCP servers (~/.claude.json top-level `mcpServers`, headers and tokens included): a `--mcp-config <file>`
//   (scope "dynamic"). Without --strict-mcp-config the account's own servers still load. A dynamic server replaces
//   a user or local one of the same name, so names the account already has (its own user servers, its local servers
//   for the folder) and names in the project's .mcp.json are left out: what the account set up for itself wins, and
//   the project's server wins as it does in Default. The file is 0600 under userData, never on the command line
//   (other processes could read the argv).
// - Plugins (~/.claude/plugins/installed_plugins.json, user scope, enabled in ~/.claude/settings.json): one
//   `--plugin-dir <installPath>` each, loading Default's installed copy directly (no network, no second install in
//   the account, nothing written to the account's plugin registry). A marketplace plugin with `strict: false` has no
//   .claude-plugin/plugin.json (its manifest lives in the marketplace entry, e.g. the LSP plugins) and --plugin-dir
//   would not load it; such a plugin gets a stage folder under userData: plugin.json made from the marketplace
//   entry plus links to the installed copy's files. A plugin the account enabled itself is skipped (--plugin-dir
//   would override it), and so is Agent Office's own plugin (the app passes it already).
//   enabledPlugins + extraKnownMarketplaces in --settings were tried: Claude Code does not install them on its own.
// - Personal skills, agents, commands and output styles (~/.claude/<dir>/<entry>) and ~/.claude/CLAUDE.md: links
//   in the account folder (<config>/<dir>/<entry> → ~/.claude/<dir>/<entry>; Windows: directory junctions, which
//   need no admin rights; files fall back to a hard link, then a copy). Claude Code reads them like its own; edits
//   made through them land in ~/.claude. --add-dir would also load skills, but only skills, and it widens file
//   access. Never linked: skills/synced (each claude.ai account syncs its own skills there) and dot entries. An entry
//   the account already has is never replaced; the links the app made are listed in <config>/MARKER, so a link whose
//   source is gone, or every link when the setting is off, is removed at the next start, and nothing else is.
//
// Never shared: logins (.credentials.json, keychain, oauthAccount and primaryApiKey in .claude.json), the account's
// own synced skills and plugins, history, projects and transcripts, policy and remote settings, settings.json.
const fs = require('fs');
const path = require('path');

const LINK_DIRS = ['skills', 'agents', 'commands', 'output-styles'];
const LINK_FILES = ['CLAUDE.md'];
const SKIP = { skills: new Set(['synced']) };
const MARKER = '.agent-office-shared.json';
const OWN_PLUGIN = 'agent-office';
// Marketplace entry fields that are not plugin.json fields.
const ENTRY_ONLY = new Set(['source', 'category', 'strict', 'tags', '$schema']);

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const keysOf = (v) => (isObj(v) ? Object.keys(v) : []);

/** Does this account get Default's plugins, skills and MCP servers? (default: yes; never for Default itself) */
const shareEnabled = (account) => Boolean(account?.configDir) && account.shareDefault !== false;

/**
 * The --mcp-config object for an account's session in cwd, or null when there is nothing to add.
 * defaultConfig: ~/.claude.json; accountConfig: <config>/.claude.json; projectMcp: <cwd>/.mcp.json.
 * @param {{ defaultConfig: any, accountConfig: any, cwd?: string | null, projectMcp?: any }} o
 */
function sharedMcpServers({ defaultConfig, accountConfig, cwd, projectMcp }) {
  const src = defaultConfig?.mcpServers;
  if (!isObj(src)) return null;
  const local = isObj(accountConfig?.projects) ? accountConfig.projects[cwd]?.mcpServers : undefined;
  const taken = new Set([...keysOf(accountConfig?.mcpServers), ...keysOf(local), ...keysOf(projectMcp?.mcpServers)]);
  const out = {};
  for (const [name, server] of Object.entries(src)) if (isObj(server) && !taken.has(name)) out[name] = server;
  return Object.keys(out).length ? { mcpServers: out } : null;
}

const pluginName = (key) => (key.lastIndexOf('@') > 0 ? key.slice(0, key.lastIndexOf('@')) : key);
const pluginMarketplace = (key) => (key.lastIndexOf('@') > 0 ? key.slice(key.lastIndexOf('@') + 1) : '');
const enabled = (v) => Boolean(v) && v !== false;

/**
 * Default's user-scope plugins that are enabled, minus Agent Office's own and those the account enabled itself
 * (by name, as --plugin-dir overrides by name). installed: installed_plugins.json; settings: settings.json.
 * syncedDir: Default's claude.ai-synced plugins folder, never shared. → [{ key, name, marketplace, installPath }]
 * @param {{ installed: any, settings: any, accountInstalled?: any, accountSettings?: any, syncedDir?: string | null }} o
 */
function sharedPlugins({ installed, settings, accountInstalled, accountSettings, syncedDir = null }) {
  const on = isObj(settings?.enabledPlugins) ? settings.enabledPlugins : {};
  const accOn = isObj(accountSettings?.enabledPlugins) ? accountSettings.enabledPlugins : {};
  const accInstalled = isObj(accountInstalled?.plugins) ? accountInstalled.plugins : {};
  const own = new Set(Object.keys(accInstalled).filter((k) => enabled(accOn[k])).map(pluginName));
  const inSynced = (p) => syncedDir && (p === syncedDir || p.startsWith(syncedDir + path.sep) || p.startsWith(syncedDir + '/'));
  const out = [];
  const seen = new Set();
  for (const [key, list] of Object.entries(isObj(installed?.plugins) ? installed.plugins : {})) {
    if (!enabled(on[key]) || !Array.isArray(list)) continue;
    const rec = list.find((r) => isObj(r) && r.scope === 'user' && typeof r.installPath === 'string' && r.installPath);
    const name = pluginName(key);
    if (!rec || name === OWN_PLUGIN || own.has(name) || seen.has(name) || inSynced(rec.installPath)) continue;
    seen.add(name);
    out.push({ key, name, marketplace: pluginMarketplace(key), installPath: rec.installPath });
  }
  return out;
}

/** plugin.json for a `strict: false` marketplace entry (its manifest is the entry itself). */
function pluginManifest(entry) {
  const out = {};
  for (const [k, v] of Object.entries(isObj(entry) ? entry : {})) if (!ENTRY_ONLY.has(k)) out[k] = v;
  return out;
}

/** Stage folder name for a plugin key: safe on every file system. */
const stageName = (key) => String(key).replace(/[^A-Za-z0-9._@-]/g, '-');

/**
 * Links to make in the account folder. listing: { skills: string[], agents: string[], commands: string[],
 * 'output-styles': string[], files: string[] } (entry names present in ~/.claude). → [{ rel, target }], rel with '/'.
 */
function linkPlan(listing, claudeDir) {
  const out = [];
  for (const dir of LINK_DIRS) {
    for (const name of Array.isArray(listing?.[dir]) ? listing[dir] : []) {
      if (typeof name !== 'string' || !name || name.startsWith('.') || SKIP[dir]?.has(name)) continue;
      out.push({ rel: `${dir}/${name}`, target: path.join(claudeDir, dir, name) });
    }
  }
  for (const f of LINK_FILES) if (listing?.files?.includes(f)) out.push({ rel: f, target: path.join(claudeDir, f) });
  return out;
}

// ---- file system

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
const names = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
// Windows reports junction targets as \\?\C:\… on some versions.
const samePath = (a, b) => path.resolve(String(a).replace(/^\\\\\?\\/, '')) === path.resolve(String(b).replace(/^\\\\\?\\/, ''));

/** What linkPlan needs from ~/.claude. */
function listClaudeDir(claudeDir) {
  const listing = { files: LINK_FILES.filter((f) => lstat(path.join(claudeDir, f))) };
  for (const dir of LINK_DIRS) listing[dir] = names(path.join(claudeDir, dir));
  return listing;
}

/** Link (or, for a Windows file without symlink rights, hard link, then copy) abs → target. */
function makeLink(target, abs, platform = process.platform) {
  if (platform !== 'win32') return fs.symlinkSync(target, abs);
  let isDir = false;
  try { isDir = fs.statSync(target).isDirectory(); } catch {}
  if (isDir) return fs.symlinkSync(target, abs, 'junction');
  try { fs.symlinkSync(target, abs, 'file'); } catch {
    try { fs.linkSync(target, abs); } catch { fs.copyFileSync(target, abs); }
  }
}

/** Removes a link or file the app made; never follows a link into its target, never removes a real folder. */
function removeOwned(abs) {
  const st = lstat(abs);
  if (!st) return true;
  if (!st.isSymbolicLink() && st.isDirectory()) return false;
  try { fs.unlinkSync(abs); return true; } catch {}
  try { fs.rmdirSync(abs); return true; } catch { return false; } // a Windows junction
}

/**
 * Brings dir's links in line with plan ([{ rel, target }]); the links made here are listed in dir/marker.
 * An entry not made here is never touched. Returns the rels that are now links made here.
 */
function syncLinks(dir, plan, { marker = MARKER, platform = process.platform } = {}) {
  const markerFile = path.join(dir, marker);
  const prev = readJson(markerFile);
  const owned = new Set(Array.isArray(prev) ? prev.filter((r) => typeof r === 'string') : []);
  const abs = (rel) => path.join(dir, ...rel.split('/'));
  const want = new Map(plan.map((p) => [p.rel, p.target]));
  for (const rel of [...owned]) {
    if (want.has(rel)) continue;
    removeOwned(abs(rel)); // false: a real folder now, the user's, left alone
    owned.delete(rel);
  }
  for (const [rel, target] of want) {
    const p = abs(rel);
    const st = lstat(p);
    if (st && !owned.has(rel)) continue; // the account's own entry wins
    if (st) {
      if (st.isSymbolicLink()) {
        let cur = null;
        try { cur = fs.readlinkSync(p); } catch {}
        if (cur && samePath(path.resolve(path.dirname(p), cur), target)) continue;
      } else if (st.isDirectory()) { owned.delete(rel); continue; }
      if (!removeOwned(p)) continue;
    }
    if (!lstat(target)) { owned.delete(rel); continue; }
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      makeLink(target, p, platform);
      owned.add(rel);
    } catch { owned.delete(rel); }
  }
  const list = [...owned].sort();
  if (list.length || Array.isArray(prev)) {
    try {
      if (list.length) fs.writeFileSync(markerFile, JSON.stringify(list));
      else fs.rmSync(markerFile, { force: true });
    } catch {}
  }
  return list;
}

const hasManifest = (dir) => Boolean(lstat(path.join(dir, '.claude-plugin', 'plugin.json')));

/** The marketplace entry of a plugin, from the marketplace Default installed it from. */
function marketplaceEntry(pluginsDir, marketplace, name) {
  const known = readJson(path.join(pluginsDir, 'known_marketplaces.json'));
  const loc = known?.[marketplace]?.installLocation;
  if (typeof loc !== 'string') return null;
  const m = readJson(path.join(loc, '.claude-plugin', 'marketplace.json'));
  return Array.isArray(m?.plugins) ? m.plugins.find((p) => p?.name === name) || null : null;
}

/** Stage folder for a plugin without its own plugin.json: the manifest plus links to its files. */
function stagePlugin(stageRoot, plugin, entry, platform = process.platform) {
  const dir = path.join(stageRoot, stageName(plugin.key));
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  const json = JSON.stringify(pluginManifest(entry), null, 2);
  const mf = path.join(dir, '.claude-plugin', 'plugin.json');
  let cur = null;
  try { cur = fs.readFileSync(mf, 'utf8'); } catch {}
  if (cur !== json) fs.writeFileSync(mf, json);
  const plan = names(plugin.installPath)
    .filter((n) => n !== '.claude-plugin' && n !== '.git' && n !== MARKER)
    .map((n) => ({ rel: n, target: path.join(plugin.installPath, n) }));
  syncLinks(dir, plan, { platform });
  return dir;
}

/** Removes stage folders no longer needed (only what the app made: links, the manifest, the marker). */
function pruneStages(stageRoot, keep) {
  for (const n of names(stageRoot)) {
    if (keep.has(n)) continue;
    const dir = path.join(stageRoot, n);
    if (lstat(dir)?.isSymbolicLink()) continue;
    syncLinks(dir, []);
    try { fs.rmSync(path.join(dir, '.claude-plugin', 'plugin.json'), { force: true }); } catch {}
    try { fs.rmdirSync(path.join(dir, '.claude-plugin')); } catch {}
    try { fs.rmdirSync(dir); } catch {}
  }
}

/**
 * Prepares one session of an account (call at every pty start): syncs the links, the plugin stages and the MCP
 * file. home: the user's home; configDir: the account folder; cwd: the session's folder; stageRoot: userData
 * folder for plugin stages; mcpFile: where this tab's --mcp-config goes. Off (or Default): removes what the app
 * made in the account folder and the MCP file. → { pluginDirs: string[], mcpConfig: string | null }
 */
function prepareShared({ account, home, cwd, stageRoot, mcpFile, platform = process.platform }) {
  const none = { pluginDirs: [], mcpConfig: null };
  const configDir = account?.configDir;
  const claudeDir = path.join(home, '.claude');
  if (!configDir || samePath(configDir, claudeDir)) {
    try { fs.rmSync(mcpFile, { force: true }); } catch {}
    return none;
  }
  const on = shareEnabled(account);
  syncLinks(configDir, on ? linkPlan(listClaudeDir(claudeDir), claudeDir) : [], { platform });
  if (!on) {
    try { fs.rmSync(mcpFile, { force: true }); } catch {}
    return none;
  }
  // plugins
  const pluginsDir = path.join(claudeDir, 'plugins');
  const base = {
    installed: readJson(path.join(pluginsDir, 'installed_plugins.json')),
    settings: readJson(path.join(claudeDir, 'settings.json')),
    syncedDir: path.join(pluginsDir, 'synced'),
  };
  const all = sharedPlugins(base);
  const mine = new Set(sharedPlugins({
    ...base,
    accountInstalled: readJson(path.join(configDir, 'plugins', 'installed_plugins.json')),
    accountSettings: readJson(path.join(configDir, 'settings.json')),
  }).map((p) => p.key));
  const pluginDirs = [];
  const stages = new Set();
  for (const p of all) {
    if (!lstat(p.installPath)) continue;
    if (hasManifest(p.installPath)) { if (mine.has(p.key)) pluginDirs.push(p.installPath); continue; }
    const entry = marketplaceEntry(pluginsDir, p.marketplace, p.name);
    if (!entry) continue;
    stages.add(stageName(p.key));
    try {
      const dir = stagePlugin(stageRoot, p, entry, platform);
      if (mine.has(p.key)) pluginDirs.push(dir);
    } catch {}
  }
  pruneStages(stageRoot, stages);
  // MCP servers
  const servers = sharedMcpServers({
    defaultConfig: readJson(path.join(home, '.claude.json')),
    accountConfig: readJson(path.join(configDir, '.claude.json')),
    cwd,
    projectMcp: cwd ? readJson(path.join(cwd, '.mcp.json')) : null,
  });
  let mcpConfig = null;
  try {
    if (servers) {
      fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
      const tmp = `${mcpFile}.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(servers), { mode: 0o600 });
      fs.renameSync(tmp, mcpFile);
      mcpConfig = mcpFile;
    } else fs.rmSync(mcpFile, { force: true });
  } catch {}
  return { pluginDirs, mcpConfig };
}

// ---- the per-tab MCP files hold tokens: each lives only while its tab's claude runs

const mcpFileName = (key) => `${key}.json`;

/** The files in the MCP folder that belong to no running tab (names: the folder's entries; liveKeys: tab keys). */
const staleMcpFiles = (names, liveKeys) => {
  const live = new Set([...liveKeys].map(mcpFileName));
  return names.filter((n) => !live.has(n));
};

/** Removes the MCP files of tabs that are not running (at app start: all of them). Returns the removed names. */
function pruneMcpFiles(dir, liveKeys = []) {
  const gone = [];
  for (const n of staleMcpFiles(names(dir), liveKeys)) {
    try { fs.rmSync(path.join(dir, n), { force: true }); gone.push(n); } catch {}
  }
  return gone;
}

/** The claude arguments for prepareShared's result. */
const sharedArgs = ({ pluginDirs, mcpConfig }) => [
  ...pluginDirs.flatMap((d) => ['--plugin-dir', d]),
  ...(mcpConfig ? ['--mcp-config', mcpConfig] : []),
];

module.exports = {
  MARKER, shareEnabled, sharedMcpServers, sharedPlugins, pluginManifest, stageName, linkPlan, listClaudeDir,
  syncLinks, stagePlugin, prepareShared, sharedArgs, mcpFileName, staleMcpFiles, pruneMcpFiles,
};
