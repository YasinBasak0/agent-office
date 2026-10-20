// Command Code's mod and its spool (contract v3.37). Pure functions (no Electron; tested with node --test).
// The app ships a static mod (src/cmd-mod/agent-office.ts) and passes it per run with `--mod <path>` and
// `--mod-option name=value` (commandcode.ai/docs/mods). The mod appends JSON lines to <spool>/events.jsonl, a folder
// the app made for the tab (userData/cmd-spool/<tab>); the app reads them one way here and gives them to the tab's
// watcher (agy-watch.js spool()): workers (subagent_*), the tool of a permission prompt, and token counts (turn_end,
// subagent_stop). Nothing goes back from the app to the mod but the arguments below.
const fs = require('node:fs');
const path = require('node:path');

const SPOOL_FILE = 'events.jsonl';
const READ_MAX = 256 * 1024; // bytes read per tick at most
const LINE_MAX = 4096;

/** The mod file. appDir: the app's folder (main.js __dirname); inside app.asar the unpacked copy (asarUnpack). */
const cmdModPath = (appDir) => path.join(appDir, 'src', 'cmd-mod', 'agent-office.ts').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
/** The tab's spool folder: userData/cmd-spool/<tab id, file-safe>. */
const spoolDirOf = (userData, ptyId) => path.join(userData, 'cmd-spool', String(ptyId).replace(/[^\w-]/g, '_').slice(0, 80));

/**
 * The mod's arguments: the mod, its spool folder, the manager brief switch and the Savings numbers (accounts.js
 * SAVINGS level: stepBudget, stepCap; null = off). Nothing of the user's or the office's data.
 * @param {{ modPath: string, spoolDir: string, manager?: boolean, saving?: { stepBudget: number, stepCap: boolean } | null }} o
 */
function cmdModArgs({ modPath, spoolDir, manager = false, saving = null }) {
  const opt = (/** @type {string} */ v) => ['--mod-option', v];
  return [
    '--mod', modPath,
    ...opt(`ao-spool=${spoolDir}`),
    ...(manager ? opt('ao-manager=true') : []),
    ...(saving && Number.isInteger(saving.stepBudget) && saving.stepBudget > 0 ? opt(`ao-step-budget=${saving.stepBudget}`) : []),
    ...(saving && saving.stepCap ? opt('ao-step-cap=true') : []),
  ];
}

// strings without control characters (code points below 32 and 127), clipped
const str = (v, n = 64) => (typeof v === 'string' ? [...v].filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127).join('').slice(0, n) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);

/**
 * One spool line → a clean event, or null (unknown, malformed, too long).
 * @param {string} line
 * @returns {{ t: string, at: number, id?: string, type?: string, tool?: string, tokens?: number, turn?: number, usage?: Record<string, number> } | null}
 */
function parseSpoolLine(line) {
  if (!line || line.length > LINE_MAX) return null;
  let e;
  try { e = JSON.parse(line); } catch { return null; }
  if (!e || typeof e !== 'object') return null;
  const at = num(e.at) ?? 0;
  switch (e.t) {
    case 'subagent_start': case 'subagent_progress': case 'subagent_stop': {
      const id = str(e.id, 128);
      if (!id) return null;
      return { t: e.t, at, id, type: str(e.type), tool: str(e.tool), ...(num(e.tokens) !== undefined ? { tokens: num(e.tokens) } : {}) };
    }
    case 'turn_end': {
      /** @type {Record<string, number>} */
      const usage = {};
      if (e.usage && typeof e.usage === 'object') {
        for (const [k, v] of Object.entries(e.usage).slice(0, 16)) if (/^[A-Za-z_]{1,40}$/.test(k) && num(v) !== undefined) usage[k] = /** @type {number} */ (num(v));
      }
      return { t: 'turn_end', at, turn: num(e.turn) ?? 0, usage };
    }
    case 'permission': return { t: 'permission', at, tool: str(e.tool) };
    case 'cap': return { t: 'cap', at };
    default: return null;
  }
}

/**
 * New lines of the spool since cursor ({ offset, rest }): reads at most READ_MAX bytes; a partial last line waits.
 * A shorter file (rewritten) starts over. Missing file: no events.
 * @param {string} file @param {{ offset: number, rest: string } | null} cursor
 */
function readSpool(file, cursor) {
  const c = cursor || { offset: 0, rest: '' };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const from = size < c.offset ? 0 : c.offset;
    const len = Math.min(READ_MAX, size - from);
    if (len <= 0) return { cursor: { offset: from, rest: from === c.offset ? c.rest : '' }, events: [] };
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    const text = (from === c.offset ? c.rest : '') + buf.toString('utf8');
    const lines = text.split('\n');
    const rest = lines.pop() || '';
    const events = lines.map(parseSpoolLine).filter((e) => e !== null);
    return { cursor: { offset: from + len, rest: rest.length > LINE_MAX ? '' : rest }, events };
  } catch {
    return { cursor: c, events: [] };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

/** Sum of a turn's token counts: `total`-like field when there is one, else every input/output field. */
function usageTokens(usage) {
  const u = usage || {};
  const total = Object.entries(u).find(([k]) => /^total(_?tokens)?$/i.test(k));
  if (total) return total[1];
  return Object.entries(u).filter(([k]) => /input|output/i.test(k)).reduce((s, [, v]) => s + v, 0);
}

module.exports = { SPOOL_FILE, cmdModPath, spoolDirOf, cmdModArgs, parseSpoolLine, readSpool, usageTokens };
