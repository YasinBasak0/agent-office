// Project memory for accounts other than default (no Electron; tested with node --test).
//
// Claude Code keeps a project's auto-memory in <config>/projects/<slug>/memory/. An account with its own
// CLAUDE_CONFIG_DIR would get a separate, empty memory, so the rules the user built up in plain Claude Code
// (~/.claude/projects/<slug>/memory/) would not apply in Agent Office. Rule: every session uses the
// ~/.claude memory, as if the user had continued in plain Claude Code. The account's own memory, if any, is
// merged into it first without overwriting anything, and the session gets `autoMemoryDirectory` (a Claude Code
// setting, passed in the --settings JSON) pointing there, so new memories land in ~/.claude too.
//
// Claude Code 2.1.296 keys the memory by the repository's main working copy (the same folder for every
// worktree), else the git root, else the project folder, all on the real path (symlinks resolved, NFC); the slug
// replaces every non-alphanumeric character with '-' and paths over 200 characters get a hash suffix (not
// reproduced here: such projects keep the default). It finds the root on disk (no git process), and so does this file.
const fs = require('fs');
const path = require('path');

const INDEX = 'MEMORY.md';
// In the account's memory folder: the names already merged, so a memory deleted from ~/.claude is not copied back.
const MERGED = '.agent-office-merged.json';
const MAX_SLUG = 200;

/** Claude Code's folder name for a project path, or null if it would need the hash suffix. */
function memorySlug(base) {
  const slug = String(base).normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-');
  return slug.length > MAX_SLUG ? null : slug;
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
}

/** The nearest folder at or above dir with a .git entry (folder or file), or null. */
function gitRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

/**
 * The main working copy of a linked worktree (its .git file says `gitdir: <repo>/.git/worktrees/<name>`), else
 * root itself. A worktree of a bare repository maps to the bare repository folder, as in Claude Code.
 */
function mainWorkingCopy(root) {
  const link = readText(path.join(root, '.git'));
  if (!link || !link.startsWith('gitdir:')) return root;
  const gitDir = path.resolve(root, link.slice(7).trim());
  const commonRel = readText(path.join(gitDir, 'commondir'));
  if (!commonRel) return root;
  const common = path.resolve(gitDir, commonRel);
  if (path.dirname(gitDir) !== path.join(common, 'worktrees')) return root;
  if (path.basename(common) !== '.git') return fs.existsSync(path.join(common, '.git')) ? root : common;
  return path.dirname(common);
}

/** The folder Claude Code keys the memory by for a session started in cwd. */
function memoryBase(cwd) {
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch {}
  const root = gitRoot(real);
  return (root ? mainWorkingCopy(root) : real).normalize('NFC');
}

/** The memory folder a session of this account uses, or null to leave Claude Code's default (default account). */
function sharedMemoryDir({ configDir, home, base }) {
  if (!configDir || !base) return null;
  const slug = memorySlug(base);
  return slug ? path.join(home, '.claude', 'projects', slug, 'memory') : null;
}

/** The account's own memory folder for the same project (what Claude Code would use without the setting). */
function accountMemoryDir({ configDir, base }) {
  const slug = configDir && base ? memorySlug(base) : null;
  return slug ? path.join(configDir, 'projects', slug, 'memory') : null;
}

/**
 * Copies the account's memories that ~/.claude does not have into it, and appends their MEMORY.md index lines.
 * Nothing in the target is overwritten (the existing memory wins); the source files are left as they are. Each
 * name is merged once (recorded in MERGED): a memory the user later deletes from ~/.claude stays deleted.
 * Returns the copied names.
 */
function mergeMemory(from, to) {
  let names;
  try { names = fs.readdirSync(from).filter((n) => n.endsWith('.md') && n !== INDEX); } catch { return []; }
  let done = [];
  try { done = JSON.parse(fs.readFileSync(path.join(from, MERGED), 'utf8')); } catch {}
  if (!Array.isArray(done)) done = [];
  const todo = names.filter((n) => !done.includes(n));
  if (!todo.length) return [];
  const copied = [];
  const settled = [];
  for (const n of todo) {
    const src = path.join(from, n);
    const dst = path.join(to, n);
    try {
      if (!fs.statSync(src).isFile()) continue;
      if (fs.existsSync(dst)) { settled.push(n); continue; }
      fs.mkdirSync(to, { recursive: true });
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
      copied.push(n);
      settled.push(n);
    } catch {}
  }
  if (copied.length) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(from, INDEX), 'utf8').split('\n'); } catch {}
    const add = lines.filter((l) => copied.some((n) => l.includes(`](${n})`)));
    if (add.length) {
      const idx = path.join(to, INDEX);
      let cur = '';
      try { cur = fs.readFileSync(idx, 'utf8'); } catch {}
      const sep = cur && !cur.endsWith('\n') ? '\n' : '';
      // appended, not rewritten: a running session may be writing the index at the same moment
      fs.appendFileSync(idx, sep + add.join('\n') + '\n');
    }
  }
  if (settled.length) {
    try { fs.writeFileSync(path.join(from, MERGED), JSON.stringify([...done, ...settled])); } catch {}
  }
  return copied;
}

/** The --settings JSON with autoMemoryDirectory added (json may be null); null if there is nothing to pass. */
function withMemorySetting(json, dir) {
  if (!dir) return json || null;
  let obj = {};
  try { obj = json ? JSON.parse(json) : {}; } catch {}
  return JSON.stringify({ ...obj, autoMemoryDirectory: dir });
}

module.exports = { memorySlug, memoryBase, sharedMemoryDir, accountMemoryDir, mergeMemory, withMemorySetting };
