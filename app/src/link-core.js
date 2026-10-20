// Device link (contract v3.28): the pure parts. Pairing codes, topics, message schema, command sanitizing, rate
// limits and trust checks. No Electron, no network; src/link.js does the networking, main.js the glue.
'use strict';
const crypto = require('crypto');

const PROTOCOL = 1;
// a trusted session pings every HEARTBEAT_MS; HEARTBEAT_MISSES intervals without any data from the peer close it
// (a quit or crash may never close the stream: UDX alone took ~17 s to notice)
const HEARTBEAT_MS = 5000;
const HEARTBEAT_MISSES = 3;
const PAIR_TTL_MS = 10 * 60 * 1000;      // a pairing code lives 10 minutes
const MAX_FRAME = 64 * 1024;              // one message on the wire (bytes); a longer line closes the connection
const MAX_COMMAND = 8 * 1024;             // a remote command's text (UTF-8 bytes)
const MAX_NAME = 40;                      // device names
const CODE_WORDS = 5;                     // 5 words of 256 = 40 bits, stretched by scrypt (see pairSecrets)
// project handoff (contract v3.29)
const MAX_BUNDLE = 200 * 1024 * 1024;     // a git bundle sent over the link
const MAX_PACK = 100 * 1024 * 1024;       // the session data (transcripts, memory, facts, settings)
const CHUNK = 32 * 1024;                  // bytes per ho-chunk (base64 keeps the line under MAX_FRAME)
const HANDOFF_REASONS = ['declined', 'not-allowed', 'busy', 'engine', 'not-git', 'offline', 'too-large', 'bad-data', 'checksum', 'apply-failed', 'timeout', 'in-progress', 'cancelled', 'unknown-project', 'changed', 'subfolder', 'push-declined', 'push-failed'];
const APPLIED = ['restored', 'branch-only'];

// 256 short, distinct, easy-to-type English words: a code word is one byte.
const WORDS = (
  'acid aged also area army away baby back bake ball band bank barn base bath bead beam bean bear beef bell belt ' +
  'bend best bike bird bite blue boat body bold bone book boot bowl brew bulb bush cake calm camp card care cart ' +
  'case cash cave cell chef chin city clay clip club coal coat code coin cold cook cool copy cord corn cost crab ' +
  'crew crop cube cure dark dart dash data dawn deal deck deep deer desk dial dice dish dock door dove draw drum ' +
  'duck dune dust easy edge epic exit face fact fair farm fast fern film fire fish flag flat flow foam fold folk ' +
  'food fork form fort frog fuel game gate gear gift glow glue goat gold golf good gown grid grin gulf hair half ' +
  'hall hand harp hawk heat herb hero hill hint hive hold hole home hood hook horn host hour huge icon idea inch ' +
  'iron item jade jazz join joke jump keen kelp kept kick kind king kite knee knot lace lady lake lamb lamp land ' +
  'lane lark lava lawn leaf lens life lime line link lion list loaf loft logo loop lord luck lung mail main malt ' +
  'mane mask meal meat menu mild milk mill mint mist mode moon moss moth mule nail navy neck nest news nice node ' +
  'note oath oven pack page palm park path peak pear pine pink pipe plan plum poem pond pony pool port pull pump ' +
  'quiz raft rail rain ramp reed reef rice ring road robe rock roof room rope rose ruby sage sail salt sand seal ' +
  'seed ship silk sink snow soap sock sofa soil song soup star stem swan tail tank team tent tide tile toad tree'
).split(' ').slice(0, 256);
if (WORDS.length !== 256 || new Set(WORDS).size !== 256) throw new Error('link-core: word list must have 256 distinct words');

/** A fresh one-time pairing code: `word-word-word-word-word`. */
function makeCode(rand = crypto.randomBytes) {
  return [...rand(CODE_WORDS)].map((b) => WORDS[b]).join('-');
}

/** A typed code in canonical form, or null when it is not a valid code (any separator, any case). */
function normalizeCode(text) {
  const words = String(text ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.length !== CODE_WORDS || !words.every((w) => WORDS.includes(w))) return null;
  return words.join('-');
}

/**
 * The pairing topic and proof key from a code. scrypt makes guessing a code from the (public) DHT topic
 * cost about 2^40 slow hashes, far longer than the code's 10 minutes.
 */
function pairSecrets(code) {
  const out = crypto.scryptSync(code, 'agent-office/link/pair/v1', 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { topic: out.subarray(0, 32), key: out.subarray(32) };
}

/** Proves knowledge of the code, bound to both Noise keys of this connection (so it cannot be replayed elsewhere). */
function pairProof(key, role, fromPub, toPub) {
  return crypto.createHmac('sha256', key).update(`${role}\n${hex(fromPub)}\n${hex(toPub)}`).digest('hex');
}
function proofOk(key, role, fromPub, toPub, proof) {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return crypto.timingSafeEqual(Buffer.from(pairProof(key, role, fromPub, toPub), 'hex'), Buffer.from(proof, 'hex'));
}

/** The discovery topic of one pair: from the secret only the two devices hold. */
function pairTopic(secretHex) {
  return crypto.createHash('sha256').update('agent-office/link/topic/v1\n').update(Buffer.from(secretHex, 'hex')).digest();
}

const hex = (b) => (typeof b === 'string' ? b : Buffer.from(b).toString('hex'));
const isHex = (s, bytes) => typeof s === 'string' && s.length === bytes * 2 && /^[0-9a-f]+$/.test(s);

// --- text hygiene

// ESC sequences (CSI, OSC, DCS/APC/PM/SOS strings, two-byte escapes) and C1 CSI, then every other control char
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** One display line: no escapes or control characters, collapsed spaces, at most `max` characters. */
function cleanLine(s, max) {
  const t = String(s ?? '').replace(ESCAPES, '').replace(CONTROLS, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * A remote command's text, made safe to type into the claude prompt: escapes and control characters removed (tabs
 * and newlines kept as spaces later by R.typedPrompt). Refused, never cut, when it is empty or too long.
 * @returns {{ ok: boolean, text?: string, reason?: 'empty' | 'too-large' | 'not-text' }}
 */
function sanitizeCommand(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'not-text' };
  if (Buffer.byteLength(text, 'utf8') > MAX_COMMAND) return { ok: false, reason: 'too-large' };
  const clean = text.replace(ESCAPES, '').replace(CONTROLS, '').replace(/[\t\r\n]+/g, ' ').trim();
  if (!clean) return { ok: false, reason: 'empty' };
  return { ok: true, text: clean };
}

/** What the owning device types: marked with the sender's name so the person sees where it came from. */
const markedCommand = (deviceName, text) => `[Agent Office: remote command from "${cleanLine(deviceName, MAX_NAME).replace(/"/g, "'")}"] ${text}`;

/** A device name: one clean line, 1-40 chars, else the fallback. */
const deviceName = (s, fallback = 'Device') => cleanLine(s, MAX_NAME) || fallback;

// --- rate limit: a token bucket per device (burst 3, one more every 10 s: about 6 a minute)

class RateLimiter {
  constructor({ burst = 3, everyMs = 10000, now = Date.now } = {}) { this.burst = burst; this.everyMs = everyMs; this.now = now; this.b = new Map(); }
  take(key) {
    const t = this.now();
    const s = this.b.get(key) || { tokens: this.burst, at: t };
    s.tokens = Math.min(this.burst, s.tokens + (t - s.at) / this.everyMs);
    s.at = t;
    const ok = s.tokens >= 1;
    if (ok) s.tokens -= 1;
    this.b.set(key, s);
    return ok;
  }
}

// --- message schema: every message is one JSON object per line; anything else is dropped

const STATUS = ['working', 'idle', 'approval'];
const CMD_STATUS = ['queued', 'delivered', 'rejected'];
const REASONS = ['not-allowed', 'unknown-project', 'engine', 'not-running', 'too-large', 'empty', 'not-text', 'rate-limited', 'queue-full', 'expired', 'removed'];
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const isInt = (v, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(v) && v >= 0 && v <= max;
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v);

/** A received snapshot reduced to the known fields (strings cleaned and cut); null when malformed. */
function cleanSnapshot(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.projects) || s.projects.length > 50) return null;
  const projects = [];
  for (const p of s.projects) {
    if (!p || !isId(p.id) || !STATUS.includes(p.status)) return null;
    projects.push({
      id: p.id, name: cleanLine(p.name, 60) || '?', engine: ['claude', 'agy', 'commandcode'].includes(p.engine) ? p.engine : 'claude',
      status: p.status, working: isInt(p.working, 999) ? p.working : 0, delivered: isInt(p.delivered, 99999) ? p.delivered : 0,
      attention: p.attention === 'permission' || p.attention === 'done' ? p.attention : null,
      ...(isStr(p.tool, 200) && p.tool ? { tool: cleanLine(p.tool, 60) } : {}),
    });
  }
  const ids = new Set(projects.map((p) => p.id));
  const workers = [];
  for (const w of Array.isArray(s.workers) ? s.workers.slice(0, 120) : []) {
    if (!w || !isId(w.id) || !ids.has(w.project)) continue;
    workers.push({
      id: w.id, project: w.project, type: cleanLine(w.type, 40) || 'agent', description: cleanLine(w.description, 120),
      ...(w.tool ? { tool: cleanLine(w.tool, 40) } : {}), ...(isInt(w.spawnAt) ? { spawnAt: w.spawnAt } : {}),
      ...(isInt(w.doneAt) ? { doneAt: w.doneAt, isOk: w.isOk !== false } : {}),
    });
  }
  return { projects, workers, delivered: isInt(s.delivered, 999999) ? s.delivered : 0 };
}

/**
 * Validates one decoded message from a trusted device. Unknown types, missing or oversized fields → null.
 * Pairing messages are validated separately (validatePair), before trust exists.
 * @returns {any}
 */
function validateMessage(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  switch (m.t) {
    case 'ping':
      return { t: 'ping' };
    case 'hello':
      return isInt(m.v, 1000) && isStr(m.name, 200) ? { t: 'hello', v: m.v, name: deviceName(m.name) } : null;
    case 'state': {
      const snap = cleanSnapshot(m.snap);
      return isInt(m.seq) && snap ? { t: 'state', seq: m.seq, snap } : null;
    }
    case 'cmd':
      return isId(m.id) && isId(m.project) && typeof m.text === 'string' && m.text.length <= MAX_COMMAND * 4 ? { t: 'cmd', id: m.id, project: m.project, text: m.text } : null;
    case 'cmd-status':
      return isId(m.id) && CMD_STATUS.includes(m.status) && (m.reason == null || REASONS.includes(m.reason))
        ? { t: 'cmd-status', id: m.id, status: m.status, ...(m.reason ? { reason: m.reason } : {}) } : null;
    case 'ho-offer': {
      const g = m.git;
      const sum = (x) => x && isInt(x.size) && isHex(x.sha, 32) ? { size: x.size, sha: x.sha } : null;
      const pack = sum(m.pack);
      const bundle = m.bundle == null ? null : sum(m.bundle);
      if (!isId(m.id) || !isStr(m.name, 200) || !isStr(m.dir, 1024) || !m.dir || m.engine !== 'claude' || !g || typeof g !== 'object') return null;
      if (!['remote', 'bundle'].includes(g.mode) || !isStr(g.wip, 80) || !/^agent-office\/handoff-[0-9]{8,17}$/.test(g.wip)) return null;
      if (!(g.base === '' || isHex(g.base, 20)) || !(g.root === '' || isHex(g.root, 20)) || !isStr(g.remote, 1000) || /[\s\0]/.test(g.remote)) return null;
      if (!isStr(g.branch, 200) || !/^[A-Za-z0-9._/-]*$/.test(g.branch) || g.branch.includes('..') || g.branch.startsWith('-')) return null;
      if (g.remote.startsWith('-') || (g.mode === 'remote' && !g.remote)) return null;
      if (!pack || pack.size > MAX_PACK || (m.bundle != null && !bundle) || (bundle && bundle.size > MAX_BUNDLE) || (g.mode === 'bundle') !== Boolean(bundle)) return null;
      return { t: 'ho-offer', id: m.id, name: cleanLine(m.name, 60) || '?', dir: m.dir, engine: 'claude', git: { mode: g.mode, wip: g.wip, base: g.base, root: g.root, branch: g.branch, remote: g.remote }, pack, bundle };
    }
    case 'ho-answer':
      return isId(m.id) && typeof m.ok === 'boolean' && (m.reason == null || HANDOFF_REASONS.includes(m.reason)) ? { t: 'ho-answer', id: m.id, ok: m.ok, ...(m.reason ? { reason: m.reason } : {}) } : null;
    case 'ho-chunk':
      return isId(m.id) && (m.part === 'pack' || m.part === 'bundle') && isInt(m.seq, 1e6) && isStr(m.data, Math.ceil(CHUNK / 3) * 4) && /^[A-Za-z0-9+/]*={0,2}$/.test(m.data)
        ? { t: 'ho-chunk', id: m.id, part: m.part, seq: m.seq, data: m.data } : null;
    case 'ho-result':
      return isId(m.id) && typeof m.ok === 'boolean' && (m.reason == null || HANDOFF_REASONS.includes(m.reason)) && (m.applied == null || APPLIED.includes(m.applied))
        ? { t: 'ho-result', id: m.id, ok: m.ok, ...(m.reason ? { reason: m.reason } : {}), ...(m.applied ? { applied: m.applied } : {}) } : null;
    default:
      return null;
  }
}

function validatePair(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.t === 'pair-hello' && isStr(m.name, 200) && typeof m.proof === 'string') return { t: 'pair-hello', name: deviceName(m.name), proof: m.proof };
  if (m.t === 'pair-ok' && isStr(m.name, 200) && typeof m.proof === 'string' && isHex(m.secret, 32)) return { t: 'pair-ok', name: deviceName(m.name), proof: m.proof, secret: m.secret };
  return null;
}

/** Splits a byte stream into lines; a line longer than MAX_FRAME makes `push` return false (close the stream). */
class LineReader {
  constructor(onLine, max = MAX_FRAME) { this.buf = ''; this.onLine = onLine; this.max = max; }
  push(chunk) {
    this.buf += chunk.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (Buffer.byteLength(line) > this.max) return false;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      this.onLine(m);
    }
    return Buffer.byteLength(this.buf) <= this.max;
  }
}
/** One message as a wire line, or null when it would exceed MAX_FRAME. */
function encode(m) {
  const s = `${JSON.stringify(m)}\n`;
  return Buffer.byteLength(s) > MAX_FRAME ? null : s;
}

// --- the trust list (devices.json; the secrets live apart, encrypted)

/** @typedef {{ pub: string, name: string, addedAt: number, allowCommands: boolean, allowHandoff: boolean }} Device */
function normalizeDevices(raw) {
  const out = [];
  for (const d of Array.isArray(raw) ? raw : []) {
    if (!d || !isHex(d.pub, 32) || out.some((o) => o.pub === d.pub)) continue;
    out.push({ pub: d.pub, name: deviceName(d.name), addedAt: isInt(d.addedAt) ? d.addedAt : 0, allowCommands: d.allowCommands === true, allowHandoff: d.allowHandoff === true });
  }
  return out;
}
/** The trusted device for a remote Noise key, or null. A device without a stored secret is not trusted. */
function trusted(devices, secrets, remotePub) {
  const k = hex(remotePub || '');
  return (secrets && isHex(secrets[k], 32) && devices.find((d) => d.pub === k)) || null;
}
/** May this device type into our tabs? Only a trusted device with the toggle on. */
const mayCommand = (devices, secrets, remotePub) => Boolean(trusted(devices, secrets, remotePub)?.allowCommands);
/** May this device hand us a project? Only a trusted device with "Accept handoffs" on (v3.29). */
const mayHandoff = (devices, secrets, remotePub) => Boolean(trusted(devices, secrets, remotePub)?.allowHandoff);

// --- what this device publishes: from the same OfficeData the office renders, nothing else

/**
 * @param {{ id: string, name: string, engine?: string }[]} projects state.projects (with engineOf applied)
 * @param {any} office readOffice's result
 * @param {Map<string, string>} attention projectId → 'permission' | 'done'
 */
function snapshotOf(projects, office, attention = new Map()) {
  const byName = new Map((office?.projects || []).map((p) => [p.name, p]));
  const idOf = new Map(projects.map((p) => [p.name, p.id]));
  const list = projects.slice(0, 50).map((p) => {
    const o = byName.get(p.name) || {};
    const status = o.waiting ? 'approval' : (o.isBossBusy || o.working > 0) ? 'working' : 'idle';
    return { id: p.id, name: p.name, engine: p.engine || 'claude', status, working: o.working || 0, delivered: o.delivered || 0, attention: attention.get(p.id) || null, ...(o.waiting?.tool ? { tool: o.waiting.tool } : {}) };
  });
  const workers = (office?.workers || []).filter((w) => idOf.has(w.project)).slice(0, 120).map((w) => ({
    id: String(w.id).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64) || 'w', project: idOf.get(w.project), type: w.type, description: w.description,
    ...(w.tool ? { tool: w.tool } : {}), ...(w.spawnAt ? { spawnAt: w.spawnAt } : {}), ...(w.doneAt ? { doneAt: w.doneAt, isOk: w.isOk !== false } : {}),
  }));
  return cleanSnapshot({ projects: list, workers, delivered: office?.delivered || 0 });
}

/** One log line for a received command (first line only, never the whole text). */
const logEntry = (at, device, project, text, outcome) => ({ at: new Date(at).toISOString(), device, project, firstLine: cleanLine(String(text).split(/\r?\n/)[0], 120), outcome });

module.exports = {
  PROTOCOL, HEARTBEAT_MS, HEARTBEAT_MISSES, PAIR_TTL_MS, MAX_FRAME, MAX_COMMAND, WORDS, CODE_WORDS, REASONS,
  MAX_BUNDLE, MAX_PACK, CHUNK, HANDOFF_REASONS,
  makeCode, normalizeCode, pairSecrets, pairProof, proofOk, pairTopic, hex, isHex,
  cleanLine, sanitizeCommand, markedCommand, deviceName, RateLimiter,
  cleanSnapshot, validateMessage, validatePair, LineReader, encode,
  normalizeDevices, trusted, mayCommand, mayHandoff, snapshotOf, logEntry,
};
