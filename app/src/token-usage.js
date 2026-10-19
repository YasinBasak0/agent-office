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
 * A record that carries its own $ (Command Code's costUsd, contract v3.23) keeps it: the breakdown is scaled to
 * that total, and the full-price estimate uses the fallback price (only the % share of the panel depends on it).
 */
function weigh(r) {
  const p = priceOf(r.model);
  const k = p.input / 1e6;
  const cost = {
    input: r.input * WEIGHTS.input * k, write5m: r.w5 * WEIGHTS.write5m * k, write1h: r.w1 * WEIGHTS.write1h * k,
    read: r.read * p.read * k, output: r.output * WEIGHTS.output * k,
  };
  const usd = cost.input + cost.write5m + cost.write1h + cost.read + cost.output;
  if (Number.isFinite(r.usd) && r.usd > 0 && usd > 0) {
    const f = r.usd / usd;
    return { fpt: r.usd / k, usd: r.usd, cost: { input: cost.input * f, write5m: cost.write5m * f, write1h: cost.write1h * f, read: cost.read * f, output: cost.output * f } };
  }
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
  return parseEntry(d, { sub });
}

/** parseLine on an already parsed line. */
function parseEntry(d, { sub = false } = {}) {
  if (!d) return null;
  if (d.type === 'message') return parseEntryCC(d, { sub }); // Command Code's tree store (contract v3.23)
  if (d.type !== 'assistant') return null;
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

/**
 * A Command Code session entry (contract v3.23, tree store): {"type":"message","id","timestamp","
 * message":{"role":"assistant",…},"usage":{"inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens",
 * "costUsd"},"model"}. One line per API response (no per-block copies). Its costUsd is authoritative — the PRICES
 * table is Claude's — so the record carries it and weigh scales to it.
 */
function parseEntryCC(d, { sub = false } = {}) {
  if (!d || d.type !== 'message' || !d.message || d.message.role !== 'assistant') return null;
  const u = d.usage;
  if (!u || typeof u !== 'object') return null;
  const t = Date.parse(d.timestamp);
  if (!Number.isFinite(t)) return null;
  const model = typeof d.model === 'string' ? d.model : '';
  if (!model) return null;
  return {
    key: `${d.id || ''}|${d.requestId || ''}`,
    t, model, sub: Boolean(sub),
    input: num(u.inputTokens), w5: num(u.cacheWriteTokens), w1: 0, read: num(u.cacheReadTokens), output: num(u.outputTokens),
    usd: num(u.costUsd) || 0,
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
/** Command Code names its session folders lower-case without the leading dash: '/tmp' → 'tmp', '/Users/a/x' →
 * 'users-a-x' (Claude Code keeps '-Users-a-x'). */
const ccSlugOf = (dir) => slugOf(String(dir).toLowerCase()).replace(/^-+/, '');

/**
 * Folder names (under <config>/projects) of a project: its folder and its tabs' folders, plus worktrees of its
 * folder made elsewhere (`<dir>-wt-…` next to it, Claude Code's `<dir>/.claude/worktrees/…`). A name that is
 * exactly another project's folder belongs to that project. `slug`: the folder naming (Command Code strips the
 * leading dash, contract v3.23); default Claude Code's.
 */
function projectFolders(names, dirs, otherDirs = [], slug = slugOf) {
  const exact = new Set(dirs.map(slug));
  const others = new Set(otherDirs.map(slug));
  const base = dirs.length ? slug(dirs[0]) : null;
  return names.filter((n) => exact.has(n) || (base && !others.has(n) && (n.startsWith(base + '-wt-') || n.startsWith(base + '--claude-worktrees-'))));
}

// ---- incremental reader
const NL = 10;
const USAGE = Buffer.from('"usage"');
const ASSISTANT = Buffer.from('"assistant"');
const MESSAGE = Buffer.from('"message"'); // Command Code's tree store (contract v3.23)
const USER = Buffer.from('"user"');
const TOOL_USE = Buffer.from('"tool_use"');
const LABEL_MAX = 160;

/** The first line of a prompt (string or [{ type: 'text', text }]), trimmed and cut to LABEL_MAX characters. */
function firstLine(content) {
  let text = typeof content === 'string' ? content : '';
  if (Array.isArray(content)) {
    const b = content.find((x) => x && x.type === 'text' && typeof x.text === 'string');
    text = b ? b.text : '';
  }
  const line = text.split('\n').map((x) => x.trim()).find(Boolean) || '';
  return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1)}…` : line;
}

/** tool_use block ids of an assistant line. */
function toolIds(d) {
  const c = d && d.message && d.message.content;
  if (!Array.isArray(c)) return [];
  return c.filter((b) => b && b.type === 'tool_use').map((b) => String(b.id || ''));
}
const tick = () => new Promise((r) => setImmediate(r));

class UsageScanner {
  /** @param {{ chunkSize?: number, fsp?: typeof fs.promises }} [opts] */
  constructor({ chunkSize = 1 << 20, fsp = fs.promises } = {}) {
    this.chunkSize = chunkSize;
    this.fsp = fsp;
    /**
     * Per file: where reading stopped and its records; a sub-agent's file also its tool_use ids, first prompt line
     * and `<agent>.meta.json` (description, agentType). `sum` is the cached fileSummary, dropped when bytes are read.
     * @type {Map<string, { ino: number, size: number, mtimeMs: number, offset: number, recs: Map<string, any>,
     *   sub?: boolean, tools?: Set<string>, prompt?: string, meta?: { description?: string, agentType?: string } | null, sum?: any }>}
     */
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
    const sub = file.includes(`${path.sep}subagents${path.sep}`);
    if (!c) {
      c = { ino: st.ino, size: 0, mtimeMs: 0, offset: 0, recs: new Map(), sub, sum: null };
      if (sub) { c.tools = new Set(); c.prompt = ''; c.meta = await this.readMeta(file); }
      this.files.set(file, c);
    }
    if (c.size === st.size && c.mtimeMs === st.mtimeMs) return c.recs;
    c.sum = null;
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
          if (line.indexOf(USAGE) !== -1 && (line.indexOf(ASSISTANT) !== -1 || line.indexOf(MESSAGE) !== -1)) {
            let d = null;
            try { d = JSON.parse(line.toString('utf8')); } catch { /* a broken line */ }
            const r = parseEntry(d, { sub });
            if (r) {
              keep(c.recs, r);
              if (sub && line.indexOf(TOOL_USE) !== -1) for (const id of toolIds(d)) c.tools.add(id);
            }
          } else if (sub && !c.prompt && line.indexOf(USER) !== -1) {
            // the sub-agent's task: its first user line (only until one is found)
            try {
              const d = JSON.parse(line.toString('utf8'));
              if (d && d.type === 'user' && d.message) c.prompt = firstLine(d.message.content);
            } catch { /* a broken line */ }
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

  /** `<dir>/agent-x.meta.json` next to `agent-x.jsonl`: { description, agentType } or null. Read once per file. */
  async readMeta(file) {
    try {
      const m = JSON.parse(await this.fsp.readFile(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      if (!m || typeof m !== 'object') return null;
      const str = (v) => (typeof v === 'string' ? v.slice(0, LABEL_MAX) : '');
      return { description: str(m.description), agentType: str(m.agentType) };
    } catch { return null; }
  }

  /**
   * One summary per transcript (session or sub-agent run) under the folders, from what was read already (call after
   * scanFolders). Cached per file until new bytes arrive.
   */
  sessions(folders) {
    const prefixes = folders.map((d) => d + path.sep);
    const out = [];
    for (const [file, c] of this.files) {
      if (!c.recs.size || !prefixes.some((p) => file.startsWith(p))) continue;
      if (!c.sum) c.sum = fileSummary(file, c);
      out.push(c.sum);
    }
    return out;
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

// ---- per transcript: sub-agent runs and the fixed prefix (contract v3.21)
/** Steps above which a sub-agent run counts as long (the step budget being tuned). */
const LONG_STEPS = 40;
const TOP_AGENTS = 10;

/**
 * A transcript's totals: steps (deduplicated requests), tokens and $ by kind, its main model (most requests), first
 * and last request, and its fixed prefix: the first request's input + cache write + cache read (system prompt,
 * tools and the opening prompt, which every later step reads again).
 */
function fileSummary(file, c) {
  const tokens = emptyTokens();
  let usd = 0;
  let start = Infinity;
  let last = -Infinity;
  let prefix = 0;
  const models = new Map();
  for (const r of c.recs.values()) {
    const w = weigh(r);
    usd += w.usd;
    tokens.input += r.input; tokens.write5m += r.w5; tokens.write1h += r.w1; tokens.read += r.read; tokens.output += r.output;
    if (r.t < start) { start = r.t; prefix = r.input + r.w5 + r.w1 + r.read; }
    if (r.t > last) last = r.t;
    models.set(r.model, (models.get(r.model) || 0) + 1);
  }
  let model = '';
  let most = 0;
  for (const [m, n] of models) if (n > most) { most = n; model = m; }
  const base = path.basename(file, '.jsonl');
  const sub = Boolean(c.sub);
  return {
    file, sub,
    session: sub ? path.basename(path.dirname(path.dirname(file))) : base,
    id: sub ? base.replace(/^agent-/, '') : base,
    label: sub ? (c.meta && c.meta.description) || c.prompt || '' : '',
    agentType: sub ? (c.meta && c.meta.agentType) || '' : '',
    model: model.replace(/\[.*?\]/g, ''),
    steps: c.recs.size, tools: sub ? c.tools.size : 0,
    tokens, usd, start, last, prefix, recs: c.recs,
  };
}

/** Sub-agent runs that started in [from, to]: the costliest TOP_AGENTS, average steps, the share of long runs. */
function agentStats(sessions, from, to) {
  const runs = sessions.filter((s) => s.sub && s.start >= from && s.start <= to);
  const usd = runs.reduce((n, s) => n + s.usd, 0);
  const steps = runs.reduce((n, s) => n + s.steps, 0);
  const long = runs.filter((s) => s.steps > LONG_STEPS);
  const longUsd = long.reduce((n, s) => n + s.usd, 0);
  const top = [...runs].sort((a, b) => b.usd - a.usd).slice(0, TOP_AGENTS).map((s) => ({
    id: s.id, session: s.session, label: s.label, agentType: s.agentType, model: s.model,
    steps: s.steps, tools: s.tools, tokens: { ...s.tokens }, usd: s.usd, at: s.start,
  }));
  return {
    count: runs.length, usd, steps, avgSteps: runs.length ? steps / runs.length : 0,
    long: { limit: LONG_STEPS, count: long.length, usd: longUsd, share: usd ? longUsd / usd : 0 },
    top,
  };
}

/**
 * The fixed prefix over [from, to]: every transcript with requests in it, its prefix and its requests and cache
 * reads in the window. prefixReads = Σ min(prefix × requests, cache reads) per transcript (a prefix cannot be read
 * more than was read); share = prefixReads / reads.
 */
function prefixStats(sessions, from, to) {
  const part = () => ({ sessions: 0, prefix: 0, avg: 0, requests: 0, reads: 0, prefixReads: 0, share: 0 });
  const out = { ...part(), main: part(), sub: part() };
  for (const s of sessions) {
    if (s.last < from || s.start > to) continue;
    let n = 0;
    let reads = 0;
    if (s.start >= from && s.last <= to) { n = s.steps; reads = s.tokens.read; }
    else for (const r of s.recs.values()) if (r.t >= from && r.t <= to) { n++; reads += r.read; }
    if (!n) continue;
    const pr = Math.min(s.prefix * n, reads);
    for (const p of [out, s.sub ? out.sub : out.main]) {
      p.sessions++; p.prefix += s.prefix; p.requests += n; p.reads += reads; p.prefixReads += pr;
    }
  }
  for (const p of [out, out.main, out.sub]) {
    p.avg = p.sessions ? p.prefix / p.sessions : 0;
    p.share = p.reads ? p.prefixReads / p.reads : 0;
    delete p.prefix;
  }
  return out;
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
function summarize(records, { now = Date.now(), since = null, sessions = null } = {}) {
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
  const rep = { now, since: Number.isFinite(since) ? since : null, firstAt, today: finish(today), week: finish(week), all: finish(all), hours };
  if (sessions) {
    // sub-agent runs and the fixed prefix per period (contract v3.21)
    const to = now + 60e3;
    const periods = { today: midnight, week: weekFrom, all: from };
    rep.agents = {};
    rep.prefix = {};
    for (const [k, f] of Object.entries(periods)) {
      rep.agents[k] = agentStats(sessions, f, to);
      rep.prefix[k] = prefixStats(sessions, f, to);
    }
  }
  return rep;
}

/** The sidebar line's numbers: today's $ and its full-price-equivalent share. */
const brief = (rep) => ({ usd: rep.today.usd, total: rep.today.total, pct: rep.today.total ? rep.today.fpt / rep.today.total : 0 });

module.exports = {
  WEIGHTS, PRICES, priceOf, weigh, parseLine, parseEntry, keep, mergeRecords, slugOf, ccSlugOf, projectFolders,
  UsageScanner, summarize, startOfDay, brief, firstLine, fileSummary, agentStats, prefixStats, LONG_STEPS,
};
