// Moving a session to another computer: pure functions (no Electron, no git; tested with node --test).
//
// A `.agentoffice` file is a gzip'd tar (written and read here with zlib only) holding:
//   manifest.json               what it is: format, app and Claude Code versions, source machine, project, session id, git
//   transcript/<id>.jsonl       the Claude Code session (from <config dir>/projects/<slug>/)
//   transcript/<id>/…           what Claude Code keeps next to it: subagents/*.jsonl + *.meta.json, tool-results/*
//   memory/*.md                 the project's auto-memory (MEMORY.md and the memory files)
//   office/<id>.json            the office session file (~/.claude/agent-office/sessions/<id>.json: today's deliveries)
//   git/handoff.bundle          git bundle: the uncommitted work as one commit on top of HEAD (tracked changes and
//                               untracked files, .gitignore respected) plus every commit not on a remote
//   git/changes.patch           the same uncommitted work as a readable diff (the bundle is what import applies)
// Never inside: Claude Code's login (.credentials.json, the keychain, .claude.json), settings files, remote URL
// passwords, untracked files that look like secrets (see isSecretFile).
//
// Reading is defensive: only these names, no "..", no absolute or drive paths, no links, sizes capped; the files are
// never extracted as they are: import writes each one to a path it computes itself.
// transfer-io.js does the file and git work (Node only, no Electron) so a later sync feature can reuse both modules.
const zlib = require('zlib');
const path = require('path');
const { sleepBlocker } = require('./sleep.js');

const FORMAT = 'agent-office-session';
const VERSION = 1;
const EXT = 'agentoffice';
const MAX_UNPACKED = 2 * 1024 * 1024 * 1024 - 1; // 2 GiB: gunzip stops beyond it
const MAX_ENTRIES = 20000;
const BUNDLE_REF_PREFIX = 'refs/agent-office/handoff-';

class TransferError extends Error {
  /** @param {string} code @param {string} [detail] */
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

// ---------- tar (ustar + pax names) ----------
const BLOCK = 512;
function octal(n, width) {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}
function header(name, size, type, mtime) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(type === '5' ? 0o755 : 0o644, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(mtime, 12), 136, 'ascii');
  h.fill(0x20, 148, 156); // checksum counts as spaces
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}
const padding = (size) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
/** A pax record "<len> path=<name>\n" (len counts itself). */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const n = Buffer.byteLength(body);
  let len = n + String(n).length;
  if (String(len).length !== String(n).length) len = n + String(len).length;
  return Buffer.from(`${len}${body}`, 'utf8');
}

/** @param {{ name: string, data: Buffer }[]} entries @param {number} [mtime] seconds → tar bytes */
function tarPack(entries, mtime = 0) {
  const parts = [];
  for (const { name, data } of entries) {
    if (!safeEntryName(name)) throw new TransferError('unsafeEntry', name);
    // names over 100 bytes or not plain ASCII go in a pax header; the ustar field gets a short ASCII stand-in
    if (Buffer.byteLength(name) > 100 || /[^\x20-\x7e]/.test(name)) {
      const pax = paxRecord('path', name);
      parts.push(header('PaxHeader', pax.length, 'x', mtime), pax, padding(pax.length));
      parts.push(header(`long-${parts.length}`, data.length, '0', mtime));
    } else {
      parts.push(header(name, data.length, '0', mtime));
    }
    parts.push(data, padding(data.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

const cstr = (buf, start, len) => {
  const s = buf.subarray(start, start + len);
  const z = s.indexOf(0);
  return (z < 0 ? s : s.subarray(0, z)).toString('utf8');
};
function readOctal(buf, start, len) {
  const s = cstr(buf, start, len).trim();
  if (!/^[0-7]*$/.test(s)) throw new TransferError('notArchive', 'bad number in a tar header');
  return s ? parseInt(s, 8) : 0;
}

/** tar bytes → [{ name, data }]. Only regular files (and pax path headers); anything else is refused. */
function tarUnpack(buf) {
  const out = [];
  let off = 0;
  let paxPath = null;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== readOctal(h, 148, 8)) throw new TransferError('notArchive', 'tar checksum');
    const size = readOctal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    const start = off + BLOCK;
    if (start + size > buf.length) throw new TransferError('notArchive', 'truncated');
    const data = buf.subarray(start, start + size);
    off = start + size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (type === 'x') {
      for (const m of data.toString('utf8').matchAll(/(\d+) ([^=\n]+)=([^\n]*)\n/g)) if (m[2] === 'path') paxPath = m[3];
      continue;
    }
    if (type === 'g') continue;
    if (type !== '0') throw new TransferError('unsafeEntry', `entry type ${JSON.stringify(type)}`);
    const prefix = cstr(h, 257, 6) === 'ustar' ? cstr(h, 345, 155) : '';
    const name = paxPath ?? (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100));
    paxPath = null;
    out.push({ name, data: Buffer.from(data) });
    if (out.length > MAX_ENTRIES) throw new TransferError('notArchive', 'too many entries');
  }
  return out;
}

/** entries → .agentoffice bytes */
const packArchive = (entries, mtime) => zlib.gzipSync(tarPack(entries, mtime));
/** .agentoffice bytes → entries (not validated yet: see readArchive) */
function unpackArchive(buf, maxBytes = MAX_UNPACKED) {
  let tar;
  try { tar = zlib.gunzipSync(buf, { maxOutputLength: maxBytes }); } catch (e) {
    throw new TransferError(e && e.code === 'ERR_BUFFER_TOO_LARGE' ? 'tooLarge' : 'notArchive', String(e?.message || e));
  }
  return tarUnpack(tar);
}

// ---------- names and secrets ----------
const hasControl = (s) => [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
/** A relative, forward-slash name with no empty, "." or ".." parts, no drive letter, no backslash or control character. */
function safeEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > 1024) return false;
  if (hasControl(name) || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return name.split('/').every((s) => s && s !== '.' && s !== '..');
}

// Claude Code's own login and account files: never packed, refused when found in a file.
const CLAUDE_SECRETS = new Set(['.credentials.json', 'credentials.json', '.claude.json', 'auth.json']);
const isClaudeSecret = (name) => {
  const base = String(name).split(/[\\/]/).pop().toLowerCase();
  return CLAUDE_SECRETS.has(base) || /\.keychain(-db)?$/.test(base);
};
/**
 * Untracked project files that look like secrets: left out of the bundle (the user is told which).
 * Tracked files are already in the repository and travel with it.
 */
function isSecretFile(rel) {
  const p = String(rel).replace(/\\/g, '/');
  const base = p.split('/').pop().toLowerCase();
  if (isClaudeSecret(base)) return true;
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/i.test(p)) return true;
  if (['.netrc', '.git-credentials', '.pgpass', '.npmrc', '.pypirc'].includes(base)) return true;
  if (base === '.env' || (base.startsWith('.env.') && !/\.(example|sample|template|dist)$/.test(base))) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(base)) return !base.endsWith('.pub');
  return /\.(pem|key|p12|pfx|keystore|jks)$/.test(base);
}

// ---------- manifest ----------
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const isStr = (s) => typeof s === 'string' && s.length > 0 && s.length < 4096;
/** A branch name that is safe to pass to git as an argument (git check-ref-format still has the last word). */
const isBranch = (b) => isStr(b) && b.length < 256 && /^[\w./+@-]+$/.test(b) && !b.startsWith('-') && !b.includes('..') && !b.endsWith('.lock') && !b.endsWith('/');

/** Throws TransferError unless the manifest has the expected shape. */
function validateManifest(m) {
  if (!m || typeof m !== 'object' || m.format !== FORMAT) throw new TransferError('unknownFormat');
  if (!Number.isInteger(m.version) || m.version < 1) throw new TransferError('unknownFormat');
  if (m.version > VERSION) throw new TransferError('newerFormat', String(m.version));
  const bad = (what) => { throw new TransferError('badManifest', what); };
  if (!m.session || !SESSION_ID.test(m.session.id)) bad('session.id');
  const s = m.source;
  if (!s || !isStr(s.platform) || !isStr(s.projectDir)) bad('source');
  for (const k of ['realDir', 'gitTop', 'historyDir', 'memoryDir', 'hostname']) if (s[k] != null && !isStr(s[k])) bad(`source.${k}`);
  if (m.git != null) {
    const g = m.git;
    if (typeof g !== 'object' || !SHA.test(g.head)) bad('git.head');
    if (g.branch != null && !isBranch(g.branch)) bad('git.branch');
    if (g.handoff != null && !SHA.test(g.handoff)) bad('git.handoff');
    if (g.bundleRef != null && !(isStr(g.bundleRef) && g.bundleRef.startsWith(BUNDLE_REF_PREFIX) && isBranch(g.bundleRef))) bad('git.bundleRef');
    if (g.subdir != null && (typeof g.subdir !== 'string' || (g.subdir && !safeEntryName(g.subdir)))) bad('git.subdir');
    if (g.remotes != null && !Array.isArray(g.remotes)) bad('git.remotes');
  }
  return m;
}

/**
 * Entries → the archive's parts, after checking every name. Throws TransferError: notArchive, unknownFormat,
 * newerFormat, badManifest, unsafeEntry (traversal, absolute, odd name), secret, duplicate, unexpectedEntry,
 * missingTranscript.
 */
function readArchive(entries) {
  const seen = new Set();
  for (const e of entries) {
    if (!safeEntryName(e.name)) throw new TransferError('unsafeEntry', String(e.name));
    if (isClaudeSecret(e.name)) throw new TransferError('secret', e.name);
    if (seen.has(e.name)) throw new TransferError('duplicate', e.name);
    seen.add(e.name);
  }
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const raw = byName.get('manifest.json');
  if (!raw) throw new TransferError('notArchive', 'no manifest.json');
  let manifest;
  try { manifest = JSON.parse(raw.toString('utf8')); } catch { throw new TransferError('unknownFormat'); }
  validateManifest(manifest);
  const id = manifest.session.id;
  const out = { manifest, transcript: null, sidecar: [], memory: [], office: null, bundle: null, patch: null };
  for (const { name, data } of entries) {
    if (name === 'manifest.json') continue;
    if (name === `transcript/${id}.jsonl`) out.transcript = data;
    else if (name.startsWith(`transcript/${id}/`) && name.split('/').length <= 6) out.sidecar.push({ rel: name.slice(`transcript/${id}/`.length), data });
    else if (/^memory\/[^/]+\.md$/.test(name)) out.memory.push({ name: name.slice(7), data });
    else if (name === `office/${id}.json`) out.office = data;
    else if (name === 'git/handoff.bundle') out.bundle = data;
    else if (name === 'git/changes.patch') out.patch = data;
    else throw new TransferError('unexpectedEntry', name);
  }
  if (!out.transcript) throw new TransferError('missingTranscript');
  return out;
}

// ---------- paths ----------
const pathStyle = (platform) => (platform === 'win32' ? 'win32' : 'posix');
const pathLib = (style) => (style === 'win32' ? path.win32 : path.posix);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex source matching a folder path: Windows paths case-insensitively, with \, \\ (JSON-escaped text) or / between parts. */
function prefixSource(prefix, style) {
  if (style !== 'win32') return escapeRe(prefix.replace(/\/+$/, '') || '/');
  const parts = prefix.replace(/[\\/]+$/, '').split(/[\\/]+/);
  const ci = (s) => [...s].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : escapeRe(c))).join('');
  return parts.map(ci).join('(?:\\\\{1,2}|/)');
}

// Keys whose whole value is one path: the rest after the prefix is converted entirely, spaces included.
const PATH_KEYS = new Set(['cwd', 'file_path', 'filePath', 'path', 'notebook_path', 'workingDirectory', 'directory', 'dir']);
const BOUNDARY = '(?=$|[\\\\/\\s"\'`)\\]},;:!?]|\\.(?![\\w-]))';
const TAIL = '((?:(?:\\\\{1,2}|/)[^\\s"\'`<>|*?\\\\/:;,()\\[\\]{}]*)*)';

/**
 * A rewriter for path prefixes. maps: [{ from, fromStyle, to }] (to is in toStyle). The longest prefix wins; a prefix
 * matches only as a whole folder (not /a/proj inside /a/project or /x/a/proj). The path parts that follow are
 * converted to toStyle's separator when the styles differ.
 * @param {{ from: string, fromStyle: 'posix' | 'win32', to: string }[]} maps @param {'posix' | 'win32'} toStyle
 */
function makeRewriter(maps, toStyle) {
  const list = maps.filter((m) => isStr(m.from) && isStr(m.to)).sort((a, b) => b.from.length - a.from.length);
  const seen = new Set();
  const uniq = list.filter((m) => { const k = `${m.fromStyle}|${m.fromStyle === 'win32' ? m.from.toLowerCase() : m.from}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!uniq.length) return { text: (s) => s, whole: (s) => s, isEmpty: true };
  const alts = uniq.map((m) => `(${prefixSource(m.from, m.fromStyle)})`).join('|');
  const sep = toStyle === 'win32' ? '\\' : '/';
  const convert = (m, rest) => (m.fromStyle === toStyle ? rest : rest.replace(/(?:\\{1,2}|\/)+/g, sep));
  const pick = (groups) => uniq[groups.findIndex((g) => g !== undefined)];
  const textRe = new RegExp(`(?<![\\w.~\\\\/-])(?:${alts})${BOUNDARY}${TAIL}`, 'g');
  const wholeRe = new RegExp(`^(?:${alts})${BOUNDARY}`);
  return {
    isEmpty: false,
    /** free text: every path that starts with a prefix */
    text: (s) => s.replace(textRe, (...a) => {
      const groups = a.slice(1, uniq.length + 1);
      const m = pick(groups);
      return m.to + convert(m, a[uniq.length + 1] || '');
    }),
    /** a value that is one path: the whole rest is converted */
    whole: (s) => {
      const r = wholeRe.exec(s);
      if (!r) return null;
      const m = pick(r.slice(1));
      return m.to + convert(m, s.slice(r[0].length));
    },
  };
}

/**
 * Rewrites one value of a transcript line (deep). ids: { from, to } renames the session (sessionId / session_id).
 * Returns the same object when nothing changed.
 */
function rewriteValue(v, rw, ids, key = '') {
  if (typeof v === 'string') {
    if (ids && ids.from !== ids.to && (key === 'sessionId' || key === 'session_id') && v === ids.from) return ids.to;
    if (PATH_KEYS.has(key)) { const w = rw.whole(v); if (w !== null) return w; }
    return rw.text(v);
  }
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => { const y = rewriteValue(x, rw, ids); if (y !== x) changed = true; return y; });
    return changed ? out : v;
  }
  if (v && typeof v === 'object') {
    let changed = false;
    const out = {};
    for (const [k, x] of Object.entries(v)) { const y = rewriteValue(x, rw, ids, k); if (y !== x) changed = true; out[k] = y; }
    return changed ? out : v;
  }
  return v;
}

/** JSONL text → rewritten text; lines that do not change (or are not JSON) stay byte for byte. */
function rewriteJsonl(text, rw, ids = null) {
  if (rw.isEmpty && (!ids || ids.from === ids.to)) return text;
  return String(text).split('\n').map((line) => {
    if (!line.trim()) return line;
    let obj;
    try { obj = JSON.parse(line); } catch { return line; }
    const next = rewriteValue(obj, rw, ids);
    return next === obj ? line : JSON.stringify(next);
  }).join('\n');
}

/**
 * The prefix maps for a move: the session's own folder (by id, so tool-results paths follow a renamed session) before
 * its project folder in Claude Code's config, the memory folder, the git root and the project folder.
 * src: manifest.source; dst: { projectDir, historyDir, memoryDir, gitTop }; ids: { from, to }
 */
function moveMaps(src, dst, ids) {
  const fromStyle = pathStyle(src.platform);
  const L = pathLib(fromStyle);
  const maps = [];
  const add = (from, to) => { if (isStr(from) && isStr(to)) maps.push({ from, fromStyle, to }); };
  if (src.historyDir && dst.historyDir) {
    add(L.join(src.historyDir, ids.from), path.join(dst.historyDir, ids.to));
    add(src.historyDir, dst.historyDir);
  }
  add(src.memoryDir, dst.memoryDir);
  for (const d of new Set([src.projectDir, src.realDir].filter(isStr))) add(d, dst.projectDir);
  if (src.gitTop && dst.gitTop && src.gitTop !== src.projectDir) add(src.gitTop, dst.gitTop);
  return maps;
}

// ---------- git ----------
/** A remote URL without its password or token (user@ stays: git@github.com is not a secret). */
function redactRemote(url) {
  const s = String(url || '').trim();
  return s.replace(/^([a-z][\w+.-]*:\/\/)([^/@]*)@/i, (all, scheme, user) => {
    const name = user.split(':')[0];
    return name && !user.includes(':') && !/^(x-access-token|oauth2?|gh[pousr]_)/i.test(name) && name.length < 40 ? all : scheme;
  });
}
/** host/path of a remote, the same for ssh, scp-like and https forms (case-insensitive, no .git): for comparing. */
function normalizeRemote(url) {
  let s = String(url || '').trim();
  if (!s) return '';
  let m = /^[a-z][\w+.-]*:\/\/(?:[^/@]*@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(s);
  if (!m) m = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.*)$/.exec(s);
  if (m) s = `${m[1]}/${m[2]}`;
  return s.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
}
/** Does any of the target's remotes point at the same repository as one of the source's? */
function remotesMatch(source, target) {
  const a = new Set((source || []).map(normalizeRemote).filter(Boolean));
  return (target || []).some((u) => a.has(normalizeRemote(u)));
}

/**
 * How to bring the target repository to the session's code (contract v3.4):
 * - 'dirty': uncommitted changes to tracked files: refuse (nothing is touched).
 * - 'apply': HEAD is the recorded commit: apply the uncommitted work on top.
 * - 'branch': offer a new branch at the recorded commit (the source branch name if this repository does not have it,
 *   else agent-office/handoff-<id>), then apply. Existing branches and the user's remote are never changed.
 */
function planCheckout({ head, base, isClean, branches, sourceBranch, sessionId }) {
  if (!isClean) return { action: 'dirty' };
  if (head === base) return { action: 'apply' };
  const have = new Set(branches || []);
  let branch = sourceBranch && isBranch(sourceBranch) && !have.has(sourceBranch) ? sourceBranch : `agent-office/handoff-${String(sessionId).slice(0, 8)}`;
  for (let i = 2; have.has(branch) && i < 100; i++) branch = `agent-office/handoff-${String(sessionId).slice(0, 8)}-${i}`;
  return { action: 'branch', branch };
}

// ---------- the rest ----------
/**
 * Why the session cannot be exported now ('' = it can). A running claude must be idle with nothing open (the
 * sleep rules of sleep.js: no busy boss, no open permission prompt, no running agent or background shell, no typed
 * but unsent prompt). A session whose claude is not running cannot change: it can always go.
 */
function exportBlocker({ running, claude, office, hasDraft = false }) {
  if (!running) return '';
  return sleepBlocker({ now: 1, idleMs: 1, lastActivityAt: 0, hasDraft, isActive: false, claude, office, hasSchedule: false });
}

/** "<project>-<yyyy-mm-dd>.agentoffice", safe as a file name on every system. */
function archiveName(projectName, date = new Date()) {
  const name = [...String(projectName || 'session')].map((c) => (hasControl(c) || '<>:"/\\|?*'.includes(c) ? '-' : c)).join('').replace(/^\.+/, '').slice(0, 80) || 'session';
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `${name}-${d}.${EXT}`;
}

/** "2.1.296 (Claude Code)" → [2, 1, 296] or null */
const parseVersion = (v) => { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? m.slice(1).map(Number) : null; };
/** < 0 if a is older than b, 0 if equal or unknown, > 0 if newer */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

module.exports = {
  FORMAT, VERSION, EXT, BUNDLE_REF_PREFIX, TransferError,
  tarPack, tarUnpack, packArchive, unpackArchive, safeEntryName, isClaudeSecret, isSecretFile,
  validateManifest, readArchive, isBranch,
  pathStyle, makeRewriter, rewriteValue, rewriteJsonl, moveMaps,
  redactRemote, normalizeRemote, remotesMatch, planCheckout,
  exportBlocker, archiveName, parseVersion, compareVersions,
};
