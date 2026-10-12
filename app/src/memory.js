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
// worktree), else the git root, else the project folder; the slug replaces every non-alphanumeric character
// with '-' and paths over 200 characters get a hash suffix (not reproduced here: such projects keep the default).
const fs = require('fs');
const path = require('path');

const INDEX = 'MEMORY.md';
const MAX_SLUG = 200;

/** Claude Code's folder name for a project path, or null if it would need the hash suffix. */
function memorySlug(base) {
  const slug = String(base).replace(/[^a-zA-Z0-9]/g, '-');
  return slug.length > MAX_SLUG ? null : slug;
}

/**
 * The folder Claude Code keys the memory by, from `git rev-parse --path-format=absolute --show-toplevel
 * --git-common-dir` output run in cwd (empty or failed: not a repository). A worktree's common dir is the main
 * repository's .git, so every worktree tab shares the main folder's memory.
 */
function memoryBase(cwd, gitOutput) {
  const [top, common] = String(gitOutput || '').split('\n').map((s) => s.trim());
  if (!top) return cwd;
  if (common && path.basename(common) === '.git') return path.dirname(common);
  return top;
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
 * Nothing in the target is overwritten (the existing memory wins); the source is left as it is. Returns the copied names.
 */
function mergeMemory(from, to) {
  let names;
  try { names = fs.readdirSync(from).filter((n) => n.endsWith('.md') && n !== INDEX); } catch { return []; }
  const copied = [];
  for (const n of names) {
    const src = path.join(from, n);
    const dst = path.join(to, n);
    try {
      if (!fs.statSync(src).isFile() || fs.existsSync(dst)) continue;
      fs.mkdirSync(to, { recursive: true });
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
      copied.push(n);
    } catch {}
  }
  if (!copied.length) return copied;
  let lines = [];
  try { lines = fs.readFileSync(path.join(from, INDEX), 'utf8').split('\n'); } catch {}
  const add = lines.filter((l) => copied.some((n) => l.includes(`](${n})`)));
  if (add.length) {
    const idx = path.join(to, INDEX);
    let cur = '';
    try { cur = fs.readFileSync(idx, 'utf8'); } catch {}
    const sep = cur && !cur.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(idx, cur + sep + add.join('\n') + '\n');
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
