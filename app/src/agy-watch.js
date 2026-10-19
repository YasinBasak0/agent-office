// Antigravity in the office (contract v3.23): the state of an `agy` tab, read one way from what the app already has.
// No Electron; tested with node --test. The watcher itself is pure; the transcript helpers at the end only read files.
//
// agy does not load the office plugin, and nothing may be passed to it (v3.22: no env, argument or file), so the app
// watches the bytes agy writes to its pty, the keys the person sends to it and, read-only, agy's own conversation
// transcript (`~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`, the
// conversation found in `cache/last_conversations.json` by the tab's folder).
// - A prompt is submitted (Enter after typed text, not inside an approval dialog): a turn starts, the boss works.
// - agy's busy line (a spinner glyph or "esc to cancel"/"esc to interrupt", redrawn while it works) or the transcript
//   growing keeps it busy; either one seen without a submitted prompt (agy started with -i, or carrying on by
//   itself) starts a turn too.
// - An approval dialog on screen ("Allow create this file? [y/n/f]", "Yes, and run in sandbox", "Subagent 12 asks
//   to run …", or Gemini-CLI-style labels: "Allow once", "Allow execution of", …) is an open prompt: stats.waiting,
//   the boss's NEEDS YOU sign, the ✋ on the row and a notification. A key sent to the tab answers it.
// - The turn ends when terminal and transcript have been quiet for QUIET_MS after the last busy sign: the boss
//   stops, one turn is counted and delivered (agy's sub-agents are not shown; the boss's finished turn is its
//   delivery), and attention.js raises 'done' for a project nobody is looking at.
// The result is a session in the plugin's file shape (`session()`), handed to readOffice as an observed session, so
// the office, the agent panel and attention.js need no Antigravity case.

const fs = require('node:fs');
const path = require('node:path');
const { draftAfter } = require('./sleep.js');

const QUIET_MS = 3000; // no output and no busy sign this long after the last one: the turn is over
const SUBMIT_GRACE_MS = 8000; // after Enter, agy may take a while before its first busy line (model start)
const TAIL = 2000; // characters of plain screen text kept to match patterns across chunk borders

// --- patterns (see contract v3.23 for which are documented and which are guessed)
// busy: the spinner frames of a terminal "dots" spinner (Gemini CLI family) or the cancel hint of the busy line
const BUSY_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\besc to (cancel|interrupt|stop)\b/i;
// an approval dialog. agy's documented prompts: "Allow create this file? [y/n/f]" (a `[y/n…]` choice after a
// question), the sandbox choices "Yes, and run in sandbox" / "Yes, and run without sandbox restrictions" and the
// sub-agent notice 'Subagent 12 asks to run "npm test"'. The rest are Gemini CLI's dialog labels (guessed for agy).
const ASK_RE = new RegExp([
  String.raw`\?\s*\[y\/n(\/[a-z])*\]`,
  String.raw`\byes,? and run (in|without) sandbox`,
  String.raw`\bsubagent \S+ asks to\b`,
  String.raw`\b(allow once|allow always|always allow|allow for (this|the|all) (session|conversation|future)|yes,? allow|no,? suggest changes|allow execution of|apply (this|these) changes?\?|waiting for (user |your )?(confirmation|approval))`,
].join('|'), 'i');
// what the dialog is about: a tool name for stats.waiting.tool ('' when unknown)
/** @type {[RegExp, string][]} */
const TOOL_OF = [
  [/\b(command|execut|shell|terminal|asks to run|run (in|without) sandbox)/i, 'Shell'],
  [/\b(create|edit|write|change|file|patch|diff)/i, 'Edit'],
  [/\b(fetch|url|browse|web|http)/i, 'Web'],
  [/\bmcp\b/i, 'MCP'],
];

/** Terminal output → plain text: escape sequences (CSI, OSC, DCS, charset, single-char) removed, \r as a line break. */
function plainText(data) {
  return String(data ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '') // OSC … BEL/ST
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[PX^_][^\x1b]*(\x1b\\)?/g, '') // DCS, SOS, PM, APC … ST
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[()*+][0-9A-Za-z]/g, '') // charset
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-_=>78]/g, '') // other two-byte escapes
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * One agy tab's watcher. Feed it with output(data), input(data) and exit(); tick(now) ends quiet turns;
 * session(project) gives the office its view.
 * @param {number} [startAt]
 */
function createAgyWatch(startAt = Date.now()) {
  let busy = false;
  let turnOpen = false; // a turn that has not been counted yet
  let turnAt = 0; // when the current turn began
  let lastSign = 0; // last busy sign (or the submit) that keeps the turn going
  let lastOutput = startAt;
  /** @type {{ kind: 'permission', tool: string, since: number } | null} */
  let waiting = null;
  let draft = false;
  let tail = '';
  let turns = 0;
  let updatedAt = startAt;
  /** @type {{ date: string, ids: string[], log: { id: string, type: string, description: string, spawnAt: number, doneAt: number, isOk: boolean, toolCount: number }[] }} */
  let today = { date: dayKey(startAt), ids: [], log: [] };
  let endedAt = 0;
  /** @type {{ size: number, prompts: number } | null} */
  let seen = null; // the transcript as last read
  let muteUntil = 0; // right after a dialog is answered its last frame may still be drawn: not a new dialog

  const startTurn = (now) => {
    busy = true;
    turnOpen = true;
    turnAt = now;
    lastSign = now;
    updatedAt = now;
  };
  const finishTurn = (now) => {
    busy = false;
    updatedAt = now;
    if (!turnOpen) return;
    turnOpen = false;
    turns++;
    const date = dayKey(now);
    if (today.date !== date) today = { date, ids: [], log: [] };
    const id = `turn-${turns}`;
    today.ids.push(id);
    today.log.push({ id, type: 'agy', description: 'Antigravity', spawnAt: turnAt, doneAt: now, isOk: true, toolCount: 0 });
    if (today.log.length > 200) today.log.splice(0, today.log.length - 200);
  };

  return {
    /** Bytes agy wrote to its terminal. */
    output(data, now = Date.now()) {
      if (endedAt) return;
      lastOutput = now;
      updatedAt = now;
      const text = plainText(data);
      if (!text) return;
      tail = (tail + text).slice(-TAIL);
      const ask = now >= muteUntil && (ASK_RE.test(text) || (!waiting && ASK_RE.test(tail.slice(-400))));
      if (ask) {
        if (!waiting) {
          const around = tail.slice(-400);
          const tool = TOOL_OF.find(([re]) => re.test(around))?.[1] ?? '';
          waiting = { kind: 'permission', tool, since: now };
        }
        if (!busy) startTurn(now); // a dialog belongs to a turn
        lastSign = now;
        return;
      }
      if (BUSY_RE.test(text)) {
        if (!busy) startTurn(now);
        lastSign = now;
      }
    },
    /** Keys the person sent to the tab. */
    input(data, now = Date.now()) {
      if (endedAt) return;
      const s = String(data ?? '');
      if (waiting) {
        // any key answers the dialog (a choice, Enter, Esc, Ctrl+C); agy carries on or stops, the busy line tells
        waiting = null;
        tail = '';
        muteUntil = now + 700;
        lastSign = now;
        updatedAt = now;
        draft = false;
        return;
      }
      const hadDraft = draft;
      draft = draftAfter(draft, s);
      if (hadDraft && /\r/.test(s) && !s.includes('\x03')) {
        tail = '';
        if (!busy) startTurn(now);
        else lastSign = now;
      }
    },
    /**
     * agy's transcript, read by the app: its size and how many prompts (USER_INPUT records) it holds. The first call
     * is the baseline; later growth is a busy sign (and a new prompt, or growth while idle, starts a turn).
     * @param {{ size: number, prompts: number } | null} t
     */
    transcript(t, now = Date.now()) {
      if (endedAt || !t) return;
      if (!seen) { seen = { ...t }; return; }
      if (t.size < seen.size) { seen = { ...t }; return; } // another conversation (or rewritten): new baseline
      if (t.size > seen.size || t.prompts > seen.prompts) {
        if (!busy) startTurn(now);
        else lastSign = now;
        lastOutput = Math.max(lastOutput, now);
        updatedAt = now;
      }
      seen = { ...t };
    },
    /** agy ended (the pty exited or was killed). */
    exit(now = Date.now()) {
      if (endedAt) return;
      if (busy) finishTurn(now);
      waiting = null;
      endedAt = now;
      updatedAt = now;
    },
    /** Ends a turn whose terminal went quiet. Returns true when the state changed. */
    tick(now = Date.now()) {
      if (!busy || waiting || endedAt) return false;
      const grace = lastSign === turnAt ? Math.max(QUIET_MS, SUBMIT_GRACE_MS) : QUIET_MS;
      if (now - lastSign < grace || now - lastOutput < QUIET_MS) return false;
      finishTurn(now);
      return true;
    },
    /** Is anything going on that a sleep would cut off? '' = no (src/sleep.js sleepBlocker's words). */
    blocker() {
      if (busy) return 'busy';
      if (waiting) return 'waiting';
      if (draft) return 'draft';
      return '';
    },
    /**
     * The office's view: a session in the plugin's file shape (contract v2/v2.6/v2.9) plus `id` and `engine`.
     * While agy runs the session is live (updatedAt = now), so an idle tab or a long-open dialog stays in the office.
     * @param {string} project @param {string} id @param {number} [now]
     */
    session(project, id, now = Date.now()) {
      return {
        id, project, engine: 'agy', format: 2, updatedAt: endedAt || Math.max(updatedAt, now), ...(endedAt ? { endedAt } : {}),
        workers: [],
        stats: {
          isBossBusy: busy, turns,
          ...(waiting ? { waiting: { ...waiting } } : {}),
          today: { date: today.date, ids: [...today.ids], log: today.log.map((l) => ({ ...l })) },
        },
      };
    },
    get isBusy() { return busy; },
    get waiting() { return waiting; },
    get turns() { return turns; },
  };
}

// --- agy's transcript (read-only). Documented: the file's path (antigravity.google/docs/hooks) and
// last_conversations.json, a map from the absolute workspace path to its newest conversation id
// (antigravity.google/docs/cli/commands/resume). Not documented: the records; "USER_INPUT" as a prompt record's type
// comes from a third-party write-up, so only its occurrences are counted and the file's growth is what matters.
const agyDataDir = (home) => path.join(home, '.gemini', 'antigravity-cli');

/**
 * The transcript of the newest conversation of a folder, or null (no map, no entry, odd id).
 * @param {string} home @param {string} dir @param {(file: string) => string} [read]
 */
function agyTranscriptPath(home, dir, read = (f) => fs.readFileSync(f, 'utf8')) {
  let map;
  try { map = JSON.parse(read(path.join(agyDataDir(home), 'cache', 'last_conversations.json'))); } catch { return null; }
  if (!map || typeof map !== 'object') return null;
  const strip = (/** @type {string} */ p) => String(p).replace(/[\\/]+$/, '');
  const key = Object.keys(map).find((k) => strip(k) === strip(dir));
  const id = key ? map[key] : null;
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) return null;
  return path.join(agyDataDir(home), 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
}

/**
 * Reads what was appended to a transcript since `from` (a cursor { file, size, prompts }); returns the new cursor, or
 * null when the file is missing. Only the new bytes are read.
 * @param {string} file @param {{ file: string, size: number, prompts: number } | null} from
 */
function readTranscript(file, from) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const start = from && from.file === file && from.size <= st.size ? from.size : 0;
  let prompts = start ? from?.prompts ?? 0 : 0;
  if (st.size > start) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const n = Math.min(st.size - start, 4 * 1024 * 1024);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, st.size - n);
      prompts += (buf.toString('utf8').match(/"USER_INPUT"/g) || []).length;
    } catch { /* unreadable: size only */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }
  return { file, size: st.size, prompts };
}

module.exports = { createAgyWatch, dayKey, plainText, agyTranscriptPath, readTranscript, BUSY_RE, ASK_RE, QUIET_MS, SUBMIT_GRACE_MS };
