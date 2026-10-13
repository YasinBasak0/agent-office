// Per-project token usage from Claude Code's transcripts (contract v3.13). No Electron; tested with node --test.
//
// Claude Code writes every API response's `usage` into the session transcript:
//   <config>/projects/<slug>/<session>.jsonl                      (the main loop)
//   <config>/projects/<slug>/<session>/subagents/agent-<id>.jsonl (each sub-agent; also `isSidechain: true`)
// One response is written once per content block (thinking, text, tool_use…) with the same message.id and
// requestId, so lines are deduplicated by (message.id, requestId): the copy with the most output tokens wins.
//
// Reading is incremental: per file the byte offset of the last complete line is kept and only new bytes are read
// (in chunks, yielding between them, so the main process never stalls on gigabytes of transcripts). A file that
// shrank or was replaced (another inode) is read again from the start.
//
// Money is an estimate from list prices (PRICES below), not a bill: a Pro/Max plan pays a flat fee, and Claude
// Code's own `cost-state` lines hold only per-session running totals without times (and only in some sessions),
// so they cannot fill hours or days.
const fs = require('fs');
const path = require('path');

// What each kind of token costs relative to the model's input price. Cache reads differ per model (PRICES.read).
const WEIGHTS = { input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 };

// $ per million input tokens and, where it is not 0.1, the cache read multiple. First match wins.
const PRICES = [
  { match: /fable|mythos/, input: 10, read: 0.025 },
  { match: /opus-5-5/, input: 4, read: 0.05 },
  { match: /opus-4-[01]\b|opus-4-2025|opus-3/, input: 15 },
  { match: /opus/, input: 5 },
  { match: /sonnet-5/, input: 2 },
  { match: /sonnet/, input: 3 },
  { match: /haiku-5/, input: 0.1 },
  { match: /haiku-4/, input: 1 },
  { match: /haiku-3-5/, input: 0.8 },
  { match: /haiku/, input: 0.25 },
];
const FALLBACK_PRICE = { input: 5 };

const priceCache = new Map();
/** { input: $/M input tokens, read: cache read multiple } for a model id ('claude-opus-5[1m]' → opus 5). */
function priceOf(model) {
  const id = String(model || '').toLowerCase().replace(/\[.*?\]/g, '');
  let p = priceCache.get(id);
  if (!p) {
    const hit = PRICES.find((x) => x.match.test(id)) || FALLBACK_PRICE;
    p = { input: hit.input, read: hit.read ?? WEIGHTS.read };
    priceCache.set(id, p);
  }
  return p;
}

/**
 * What a request would have cost at the full input price, in tokens (fpt) and in $; `cost` splits the $ by kind.
 */
function weigh(r) {
  const p = priceOf(r.model);
  const k = p.input / 1e6;
  const cost = {
    input: r.input * WEIGHTS.input * k, write5m: r.w5 * WEIGHTS.write5m * k, write1h: r.w1 * WEIGHTS.write1h * k,
    read: r.read * p.read * k, output: r.output * WEIGHTS.output * k,
  };
  const usd = cost.input + cost.write5m + cost.write1h + cost.read + cost.output;
  return { fpt: usd / k, usd, cost };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * One transcript line → { key, t, model, sub, input, w5, w1, read, output }, or null if it is not an assistant
 * response with usage. sub: the file is a sub-agent's, or the line says isSidechain.
 */
function parseLine(line, { sub = false } = {}) {
  let d;
  try { d = JSON.parse(line); } catch { return null; }
  if (!d || d.type !== 'assistant') return null;
  const m = d.message;
  const u = m && m.usage;
  if (!u || typeof u !== 'object') return null;
  const t = Date.parse(d.timestamp);
  if (!Number.isFinite(t)) return null;
  const model = typeof m.model === 'string' ? m.model : '';
  if (model === '<synthetic>') return null;
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const written = num(u.cache_creation_input_tokens);
  let w5 = written;
  let w1 = 0;
  if (cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null)) {
    w5 = num(cc.ephemeral_5m_input_tokens);
    w1 = num(cc.ephemeral_1h_input_tokens);
  }
  const key = m.id || d.requestId ? `${m.id || ''}|${d.requestId || ''}` : `${d.uuid || ''}`;
  return {
    key, t, model, sub: Boolean(sub || d.isSidechain),
    input: num(u.input_tokens), w5, w1, read: num(u.cache_read_input_tokens), output: num(u.output_tokens),
  };
}

/** Keeps the copy with the most output tokens; sub-agent if either copy says so. */
function keep(map, r) {
  const old = map.get(r.key);
  if (!old) { map.set(r.key, r); return; }
  if (r.output >= old.output) map.set(r.key, old.sub && !r.sub ? { ...r, sub: true } : r);
  else if (r.sub && !old.sub) map.set(r.key, { ...old, sub: true });
}

/** Records from several files, deduplicated across them. */
function mergeRecords(maps) {
  const out = new Map();
  for (const m of maps) for (const r of m.values()) keep(out, r);
  return out;
}

// ---- which transcript folders belong to a project
const slugOf = (dir) => String(dir).replace(/[^a-zA-Z0-9]/g, '-');

/**
 * Folder names (under <config>/projects) of a project: its folder and its tabs' folders, plus worktrees of its
 * folder made elsewhere (`<dir>-wt-…` next to it, Claude Code's `<dir>/.claude/worktrees/…`). A name that is
 * exactly another project's folder belongs to that project.
 */
function projectFolders(names, dirs, otherDirs = []) {
  const exact = new Set(dirs.map(slugOf));
  const others = new Set(otherDirs.map(slugOf));
  const base = dirs.length ? slugOf(dirs[0]) : null;
  return names.filter((n) => exact.has(n) || (base && !others.has(n) && (n.startsWith(base + '-wt-') || n.startsWith(base + '--claude-worktrees-'))));
}

// ---- incremental reader
const NL = 10;
const USAGE = Buffer.from('"usage"');
const ASSISTANT = Buffer.from('"assistant"');
const tick = () => new Promise((r) => setImmediate(r));

class UsageScanner {
  /** @param {{ chunkSize?: number, fsp?: typeof fs.promises }} [opts] */
  constructor({ chunkSize = 1 << 20, fsp = fs.promises } = {}) {
    this.chunkSize = chunkSize;
    this.fsp = fsp;
    /** @type {Map<string, { ino: number, size: number, mtimeMs: number, offset: number, recs: Map<string, any> }>} */
    this.files = new Map();
    this.bytesRead = 0;
    this.queue = Promise.resolve();
  }

  /** Runs scans one after another (two callers never read the same file at once). */
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Every .jsonl under a folder (subagents/ included). */
  async listJsonl(dir, out = []) {
    let ents;
    try { ents = await this.fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'memory' && e.name !== 'tool-results') await this.listJsonl(p, out); }
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
    return out;
  }

  /** Reads what is new in one file; returns its records. A file older than `since` (mtime) is not read. */
  async scanFile(file, since = 0) {
    let st;
    try { st = await this.fsp.stat(file); } catch { this.files.delete(file); return null; }
    let c = this.files.get(file);
    if (!c && st.mtimeMs < since) return null;
    if (c && (c.ino !== st.ino || st.size < c.offset)) c = null; // replaced or truncated: from the start
    if (!c) { c = { ino: st.ino, size: 0, mtimeMs: 0, offset: 0, recs: new Map() }; this.files.set(file, c); }
    if (c.size === st.size && c.mtimeMs === st.mtimeMs) return c.recs;
    const sub = file.includes(`${path.sep}subagents${path.sep}`);
    let fh;
    try { fh = await this.fsp.open(file, 'r'); } catch { return c.recs; }
    try {
      let pos = c.offset;
      let pending = [];
      let lineStart = pos; // file offset where the unfinished line begins
      const end = st.size;
      while (pos < end) {
        const want = Math.min(this.chunkSize, end - pos);
        const buf = Buffer.allocUnsafe(want);
        const { bytesRead } = await fh.read(buf, 0, want, pos);
        if (!bytesRead) break;
        this.bytesRead += bytesRead;
        const chunk = buf.subarray(0, bytesRead);
        let start = 0;
        let nl = chunk.indexOf(NL, start);
        while (nl !== -1) {
          const line = pending.length ? Buffer.concat([...pending, chunk.subarray(start, nl)]) : chunk.subarray(start, nl);
          pending = [];
          if (line.indexOf(USAGE) !== -1 && line.indexOf(ASSISTANT) !== -1) {
            const r = parseLine(line.toString('utf8'), { sub });
            if (r) keep(c.recs, r);
          }
          start = nl + 1;
          lineStart = pos + start;
          nl = chunk.indexOf(NL, start);
        }
        if (start < chunk.length) pending.push(chunk.subarray(start));
        pos += bytesRead;
        await tick();
      }
      c.offset = lineStart; // an unfinished last line is read again next time
      c.size = st.size;
      c.mtimeMs = st.mtimeMs;
    } finally {
      await fh.close().catch(() => {});
    }
    return c.recs;
  }

  /** Scans the folders (serially with other scans) and returns their deduplicated records. */
  scanFolders(folders, { since = 0 } = {}) {
    return this.serial(async () => {
      const maps = [];
      for (const dir of folders) {
        const listed = new Set(await this.listJsonl(dir));
        for (const f of listed) {
          const recs = await this.scanFile(f, since);
          if (recs) maps.push(recs);
        }
        // a deleted transcript is forgotten
        const prefix = dir + path.sep;
        for (const f of this.files.keys()) if (f.startsWith(prefix) && !listed.has(f)) this.files.delete(f);
      }
      return mergeRecords(maps);
    });
  }
}

// ---- totals
const emptyTokens = () => ({ input: 0, write5m: 0, write1h: 0, read: 0, output: 0 });
const emptyPart = () => ({ total: 0, fpt: 0, usd: 0, requests: 0 });
const emptyTotals = () => ({ tokens: emptyTokens(), cost: emptyTokens(), total: 0, fpt: 0, usd: 0, requests: 0, main: emptyPart(), sub: emptyPart(), models: {} });

function add(tot, r, w) {
  const total = r.input + r.w5 + r.w1 + r.read + r.output;
  tot.tokens.input += r.input;
  tot.tokens.write5m += r.w5;
  tot.tokens.write1h += r.w1;
  tot.tokens.read += r.read;
  tot.tokens.output += r.output;
  for (const k in w.cost) tot.cost[k] += w.cost[k];
  tot.total += total;
  tot.fpt += w.fpt;
  tot.usd += w.usd;
  tot.requests++;
  const part = r.sub ? tot.sub : tot.main;
  part.total += total; part.fpt += w.fpt; part.usd += w.usd; part.requests++;
  const name = String(r.model || '?').replace(/\[.*?\]/g, '');
  const m = tot.models[name] || (tot.models[name] = emptyPart());
  m.total += total; m.fpt += w.fpt; m.usd += w.usd; m.requests++;
}

/** Local midnight of `now`. */
function startOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const HOUR = 3600e3;
/**
 * Records → TokenReport (CONTRACT v3.13): totals for today (since local midnight), the last 7 days and since the
 * project was added (`since`; null = everything in the transcripts), and 24 hourly buckets ending with this hour.
 */
function summarize(records, { now = Date.now(), since = null } = {}) {
  const today = emptyTotals();
  const week = emptyTotals();
  const all = emptyTotals();
  const top = new Date(now);
  top.setMinutes(0, 0, 0);
  const first = top.getTime() - 23 * HOUR;
  const hours = Array.from({ length: 24 }, (_, i) => ({ at: first + i * HOUR, total: 0, fpt: 0, usd: 0 }));
  const midnight = startOfDay(now);
  const weekFrom = now - 7 * 24 * HOUR;
  const from = Number.isFinite(since) ? since : -Infinity;
  let firstAt = null;
  for (const r of records.values ? records.values() : records) {
    if (r.t < from || r.t > now + 60e3) continue;
    const w = weigh(r);
    add(all, r, w);
    if (firstAt == null || r.t < firstAt) firstAt = r.t;
    if (r.t >= weekFrom) add(week, r, w);
    if (r.t >= midnight) add(today, r, w);
    if (r.t >= first) {
      const h = hours[Math.min(23, Math.floor((r.t - first) / HOUR))];
      h.total += r.input + r.w5 + r.w1 + r.read + r.output;
      h.fpt += w.fpt;
      h.usd += w.usd;
    }
  }
  const finish = (tot) => ({
    ...tot,
    models: Object.entries(tot.models).map(([model, v]) => ({ model, ...v })).sort((a, b) => b.usd - a.usd),
  });
  return { now, since: Number.isFinite(since) ? since : null, firstAt, today: finish(today), week: finish(week), all: finish(all), hours };
}

/** The sidebar line's numbers: today's $ and its full-price-equivalent share. */
const brief = (rep) => ({ usd: rep.today.usd, total: rep.today.total, pct: rep.today.total ? rep.today.fpt / rep.today.total : 0 });

module.exports = {
  WEIGHTS, PRICES, priceOf, weigh, parseLine, keep, mergeRecords, slugOf, projectFolders,
  UsageScanner, summarize, startOfDay, brief,
};
