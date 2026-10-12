// Resuming interrupted work: pure functions (no Electron; tested with node --test).
//
// If the app goes away while a tab's claude is in the middle of a turn (an in-app update, a crash, the user quitting,
// a reboot), `--continue` alone would bring the conversation back but leave it sitting there. So main keeps a
// durable mark per tab in state.json (`interrupted: { <pty id>: <session id or ''> }`), set when the tab's claude
// becomes busy and cleared when its turn ends or its claude exits on its own. At the next launch, with "Continue last
// session" and "Resume interrupted work" on, every marked tab starts right away (even when starts are lazy) with
// `claude --resume <id> "<RESUME_PROMPT>"` (or `--continue "<…>"`), which opens the interactive session and submits
// the prompt.

/** The prompt sent to the resumed session (English: it goes to the model). One line, no quotes or cmd.exe specials. */
const RESUME_PROMPT = 'Agent Office restarted (app update or restart) while you were working, which interrupted your last turn and any sub-agents you had running. Check what was finished (git status, files, your task list), then continue the unfinished work from where it stopped. Restart sub-agents that were cut off.';

const validSid = (s) => (typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(s) ? s : '');

/**
 * The marks as read from state.json: { ptyId: sessionId | '' }; anything odd is dropped. With ptyIds, only tabs
 * that still exist are kept.
 * @param {any} raw @param {Iterable<string>} [ptyIds]
 * @returns {Record<string, string>}
 */
function normalizeInterrupted(raw, ptyIds) {
  const keep = ptyIds ? new Set(ptyIds) : null;
  /** @type {Record<string, string>} */
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, sid] of Object.entries(raw)) {
    if (!id || (keep && !keep.has(id))) continue;
    out[id] = validSid(sid);
  }
  return out;
}

/**
 * Is this claude in the middle of a turn? Claude Code's own pid file (<config>/sessions/<pid>.json, its `status`) is
 * fresh for this process; the office file's stats.isBossBusy (the plugin's hooks) is the fallback when the pid file
 * has no status (older Claude Code). An office file left by a killed claude can still say busy, so it is used only
 * when there is no pid file status.
 * @param {{ claude?: any, office?: any }} o
 */
function isTurnBusy({ claude, office }) {
  const status = claude && typeof claude === 'object' ? claude.status : undefined;
  if (typeof status === 'string' && status) return status !== 'idle';
  if (!office || typeof office !== 'object' || office.endedAt) return false;
  return Boolean(office.stats?.isBossBusy);
}

/**
 * The marks after one look at a tab. Returns the same object when nothing changes (so main saves only on change).
 * busy: mark it (with its session id, which may become known later); not busy: clear it.
 * @param {Record<string, string>} marks @param {string} id @param {{ busy: boolean, sessionId?: string }} o
 */
function nextInterrupted(marks, id, { busy, sessionId = '' }) {
  const has = Object.prototype.hasOwnProperty.call(marks, id);
  if (!busy) {
    if (!has) return marks;
    const { [id]: _, ...rest } = marks;
    return rest;
  }
  const sid = validSid(sessionId) || (has ? marks[id] : '');
  if (has && marks[id] === sid) return marks;
  return { ...marks, [id]: sid };
}

/** The marks without these tabs (same object when none was marked). @param {Record<string, string>} marks @param {string[]} ids */
function clearInterrupted(marks, ids) {
  let out = marks;
  for (const id of ids) out = nextInterrupted(out, id, { busy: false });
  return out;
}

/**
 * Which tabs resume at launch (in the order given): only with both settings on, and only tabs that exist.
 * @param {Record<string, string>} marks @param {string[]} ptyIds @param {{ resume?: boolean, resumeWork?: boolean }} prefs
 */
function resumeTargets(marks, ptyIds, { resume, resumeWork }) {
  if (resume === false || resumeWork === false) return [];
  return ptyIds.filter((id) => Object.prototype.hasOwnProperty.call(marks, id));
}

/**
 * The prompt as one safe command-line argument: one line (control characters and newlines become spaces), and
 * without characters cmd.exe treats specially even inside quotes (`"`, `%`, `!`, `^`; npm's claude.cmd goes through
 * cmd.exe on Windows). It never starts with '-' (claude would read an option).
 * @param {string} text
 */
function promptArg(text) {
  // eslint-disable-next-line no-control-regex
  const s = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/["%!^]/g, '').replace(/\s+/g, ' ').trim();
  return s.replace(/^-+\s*/, '');
}

/**
 * claude's arguments for a start: the start arguments, then the resume arguments, then (only when resuming and a
 * prompt is given) the prompt as the positional argument. Resume arguments come last among the options, so a
 * variadic option (`--mcp-config <configs...>`) cannot swallow the prompt.
 * @param {string[]} base @param {string[]} resumeArgs @param {string} [prompt]
 */
function claudeArgs(base, resumeArgs, prompt) {
  const p = resumeArgs.length && prompt ? promptArg(prompt) : '';
  return [...base, ...resumeArgs, ...(p ? [p] : [])];
}

module.exports = { RESUME_PROMPT, normalizeInterrupted, isTurnBusy, nextInterrupted, clearInterrupted, resumeTargets, promptArg, claudeArgs };
