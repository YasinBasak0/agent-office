// Device link (contract v3.28, v3.31/v3.32 capabilities and machine data): Hyperswarm networking between this user's Agent Offices. No Electron: main.js
// gives it the key pair, the trust list and callbacks; tests run two of these on a local DHT testnet.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const C = require('./link-core.js');

class Link extends EventEmitter {
  /**
   * @param {{ keyPair: { publicKey: Buffer, secretKey: Buffer }, name: string, devices?: C.Device[], secrets?: Record<string, string>,
   *   bootstrap?: any[], now?: () => number, swarmFactory?: (opts: any) => any, heartbeatMs?: number,
   *   handoffAskMs?: number, handoffIdleMs?: number, resultsFile?: string | null, reportsFile?: string | null, app?: string }} o
   */
  constructor(o) {
    super();
    this.keyPair = o.keyPair;
    this.pub = C.hex(o.keyPair.publicKey);
    this.name = C.deviceName(o.name);
    this.devices = C.normalizeDevices(o.devices);
    this.secrets = { ...(o.secrets || {}) };
    this.bootstrap = o.bootstrap;
    this.now = o.now || Date.now;
    this.heartbeatMs = o.heartbeatMs || C.HEARTBEAT_MS;
    this.swarmFactory = o.swarmFactory || ((opts) => new (require('hyperswarm'))(opts));
    this.swarm = null;
    this.conns = new Map();      // device pub → conn (trusted sessions)
    this.remotes = new Map();    // device pub → { snap, at }
    this.pairing = null;         // { role, code, key, topic, expiresAt, timer, resolve?, reject? }
    this.limiter = new C.RateLimiter({ now: this.now });
    this.outgoing = [];          // commands this device sent: { id, pub, project, projectName, firstLine, status, reason?, at }
    this.snap = null;            // what we publish
    this.snapJson = '';
    this.sentJson = new Map();   // pub → last snapshot json sent to it
    this.seq = 0;
    this.pubTimer = null;
    this.lastPub = 0;
    this.handoffsOut = new Map(); // v3.29 projects this device hands off: id → record
    this.handoffsIn = new Map();  // projects offered to this device: id → record
    this.handoffAskMs = o.handoffAskMs || 10 * 60 * 1000;   // an offer nobody answers is dropped after this
    this.handoffIdleMs = o.handoffIdleMs || 2 * 60 * 1000;  // an accepted transfer with no chunk for this long is dropped
    // v3.29 the receiver's record of each handoff it applied (or tried to): id → { pub, status, applied?, reason?, sent, at }.
    // Kept in resultsFile (userData/link/handoff-results.json, no secrets) so a result survives a restart: one not yet
    // delivered is sent when the sender is back, and the sender can ask again (ho-query) at any time.
    this.resultsFile = o.resultsFile || null;
    this.results = this.loadResults();
    // v3.31/v3.32: what each connected peer said in its hello, and the machine data exchanged by capability
    this.appVersion = /^[0-9A-Za-z.+-]{1,20}$/.test(String(o.app || '')) ? String(o.app) : '';
    this.peers = new Map();       // pub → { v, app, caps: string[] } (from its hello on this connection)
    this.res = null;              // this machine's resources (publishRes)
    this.catalog = null;          // this machine's project catalog (publishCatalog)
    this.sentRes = new Map();     // pub → json of the res last sent
    this.sentCatalog = new Map(); // pub → json of the catalog last sent ('off' after a "not shared any more")
    this.peerRes = new Map();     // pub → res received
    this.peerCatalog = new Map(); // pub → catalog received
    // v3.35 reports of dispatched tasks this device ran: id → { pub, report: null (still running) | Report, sent, at }.
    // Kept in reportsFile (userData/link/reports-out.json, 0600, newest 50) so one not yet delivered is sent on reconnect.
    this.reportsFile = o.reportsFile || null;
    this.reportsOut = this.loadReports();
    this.destroyed = false;
  }

  // --- swarm

  ensureSwarm() {
    if (this.swarm || this.destroyed) return this.swarm;
    this.swarm = this.swarmFactory({
      keyPair: this.keyPair,
      ...(this.bootstrap ? { bootstrap: this.bootstrap } : {}),
      // true = refuse: only trusted keys, plus anyone while a pairing code is open (they still need the code's proof)
      firewall: (remotePub) => !(C.trusted(this.devices, this.secrets, remotePub) || this.pairing),
    });
    this.swarm.on('connection', (conn) => this.onConnection(conn));
    for (const d of this.devices) if (this.secrets[d.pub]) this.swarm.join(C.pairTopic(this.secrets[d.pub]), { server: true, client: true });
    return this.swarm;
  }
  async maybeStopSwarm() {
    if (!this.swarm || this.devices.length || this.pairing) return;
    const s = this.swarm;
    this.swarm = null;
    await s.destroy().catch(() => {});
  }

  onConnection(conn) {
    conn.on('error', () => {});
    const remote = C.hex(conn.remotePublicKey);
    const device = C.trusted(this.devices, this.secrets, remote);
    if (device) return this.session(conn, device, null);
    if (this.pairing) return this.pairSession(conn, remote);
    conn.destroy();
  }

  /** Reads lines from a connection; `handle` gets each JSON value. Oversized frames close it. */
  reader(conn, handle) {
    const r = new C.LineReader(handle);
    conn.on('data', (chunk) => { if (!r.push(chunk)) conn.destroy(); });
  }
  write(conn, m) {
    const line = C.encode(m);
    if (line && !conn.destroyed) conn.write(line);
  }

  // --- pairing

  /** Shows a one-time code (this device invites). Resolves at once; 'paired' fires when the other side joins. */
  async invite() {
    await this.cancelPairing();
    const code = C.makeCode();
    const d = this.startPairing('inviter', code);
    await d.flushed().catch(() => {});   // announced on the DHT before the code is shown
    return { code, expiresAt: this.pairing?.expiresAt || 0 };
  }
  /** Enters a code shown on the other device. Resolves with the new device, rejects on a bad code or timeout. */
  join(text) {
    const code = C.normalizeCode(text);
    if (!code) return Promise.reject(new Error('bad-code'));
    return this.cancelPairing().then(() => new Promise((resolve, reject) => this.startPairing('joiner', code, resolve, reject)));
  }
  startPairing(role, code, resolve, reject) {
    const { topic, key } = C.pairSecrets(code);
    const expiresAt = this.now() + C.PAIR_TTL_MS;
    const timer = setTimeout(() => this.cancelPairing(new Error('expired')), C.PAIR_TTL_MS);
    timer.unref?.();
    // the joiner looks the topic up again every few seconds: the inviter may announce after its first lookup
    const retry = role === 'joiner' ? setInterval(() => discovery.refresh().catch(() => {}), 3000) : null;
    retry?.unref?.();
    this.pairing = { role, code, key, topic, expiresAt, timer, retry, resolve, reject };
    const discovery = this.ensureSwarm().join(topic, { server: role === 'inviter', client: role === 'joiner' });
    this.emit('change');
    return discovery;
  }
  async cancelPairing(err) {
    const p = this.pairing;
    if (!p) return;
    this.pairing = null;
    clearTimeout(p.timer);
    clearInterval(p.retry);
    p.reject?.(err || new Error('cancelled'));
    await this.swarm?.leave(p.topic).catch(() => {});
    this.emit('change');
    await this.maybeStopSwarm();
  }

  pairSession(conn, remote) {
    const p = this.pairing;
    let done = false;
    const fail = () => { if (!done) conn.destroy(); };
    const t = setTimeout(fail, 20000);
    t.unref?.();
    this.write(conn, { t: 'pair-hello', name: this.name, proof: C.pairProof(p.key, p.role, this.pub, remote) });
    let device = null;
    this.reader(conn, (raw) => {
      if (device) return this.handle(conn, device, raw);    // the same stream carries the session once paired
      const m = C.validatePair(raw);
      if (!m || this.pairing !== p) return fail();
      if (m.t === 'pair-hello') {
        const theirs = p.role === 'inviter' ? 'joiner' : 'inviter';
        if (!C.proofOk(p.key, theirs, remote, this.pub, m.proof)) return fail();
        if (p.role !== 'inviter') return;                     // the joiner waits for pair-ok
        const secret = crypto.randomBytes(32).toString('hex');
        device = this.addDevice(remote, m.name, secret);
        this.write(conn, { t: 'pair-ok', name: this.name, secret, proof: C.pairProof(p.key, 'ok', this.pub, remote) });
      } else if (m.t === 'pair-ok' && p.role === 'joiner') {
        if (!C.proofOk(p.key, 'ok', remote, this.pub, m.proof)) return fail();
        device = this.addDevice(remote, m.name, m.secret);
      } else return fail();
      done = true;
      clearTimeout(t);
      const resolve = p.resolve;
      this.pairing = null;
      clearTimeout(p.timer);
      clearInterval(p.retry);
      this.swarm?.leave(p.topic).catch(() => {});
      resolve?.(device);
      this.session(conn, device, 'paired');
    });
    conn.on('close', () => clearTimeout(t));
  }

  addDevice(pub, name, secret) {
    const device = { pub, name: C.deviceName(name), addedAt: this.now(), allowCommands: false, allowHandoff: false, allowManage: false, allowAccounts: false };   // all OFF by default
    this.devices = [...this.devices.filter((d) => d.pub !== pub), device];
    this.secrets[pub] = secret;
    this.swarm?.join(C.pairTopic(secret), { server: true, client: true });
    this.persist();
    this.emit('paired', device);
    return device;
  }

  // --- trusted sessions

  session(conn, device, _why) {
    const old = this.conns.get(device.pub);
    if (old && old !== conn) old.destroy();
    this.conns.set(device.pub, conn);
    this.sentJson.delete(device.pub);
    this.forgetPeer(device.pub);   // a new connection: no capability is known until its hello
    let invalid = 0;
    if (_why !== 'paired') this.reader(conn, (raw) => this.handle(conn, device, raw, () => { if (++invalid > 20) conn.destroy(); }));
    // heartbeat: ping every heartbeatMs; no data at all for HEARTBEAT_MISSES of them = the peer is gone
    const beat = setInterval(() => this.write(conn, { t: 'ping' }), this.heartbeatMs);
    beat.unref?.();
    const silence = setTimeout(() => conn.destroy(), this.heartbeatMs * C.HEARTBEAT_MISSES);
    silence.unref?.();
    conn.on('data', () => silence.refresh());
    conn.on('close', () => {
      clearInterval(beat);
      clearTimeout(silence);
      if (this.conns.get(device.pub) !== conn) return;
      this.conns.delete(device.pub);
      this.remotes.delete(device.pub);
      this.forgetPeer(device.pub);
      // its answers came on this connection: a command still sent or queued will never hear its outcome
      for (const o of this.outgoing) if (o.pub === device.pub && (o.status === 'sent' || o.status === 'queued')) o.status = 'unknown';
      for (const h of this.handoffsOut.values()) if (h.pub === device.pub) h.finish?.({ ok: false, reason: 'offline' });
      // an offer or transfer dies with the connection; one being applied finishes and reports on the next connection
      for (const h of [...this.handoffsIn.values()]) if (h.pub === device.pub && h.stage !== 'applying') this.dropIn(h, 'offline', false);
      this.emit('change');
    });
    this.write(conn, this.helloMsg());
    let sent = false;
    for (const [id, r] of this.results) if (r.pub === device.pub && !r.sent && (r.status === 'applied' || r.status === 'not-applied')) {
      this.write(conn, this.resultMsg(id, r));
      r.sent = sent = true;
    }
    if (sent) this.saveResults();
    this.flushTo(device.pub, conn);
    this.emit('change');
  }

  handle(conn, device, raw, onInvalid = () => {}) {
    const d = C.trusted(this.devices, this.secrets, device.pub);   // checked on every message: removal revokes at once
    if (!d) return conn.destroy();
    const m = C.validateMessage(raw);
    if (!m) return onInvalid();
    if (m.t === 'hello') {
      // the local name wins; the remote name is only a default at pairing. Its caps decide what it is sent (v3.31).
      this.peers.set(d.pub, { v: m.v, app: m.app || '', caps: m.caps || [] });
      this.flushRes(d.pub, conn);
      this.flushCatalog(d.pub, conn);
      this.flushReports(d.pub, conn);
      this.emit('change');
    } else if (m.t === 'res') {
      this.peerRes.set(d.pub, m.res);
      this.emit('change');
    } else if (m.t === 'catalog') {
      if (m.catalog.shared) this.peerCatalog.set(d.pub, m.catalog.projects); else this.peerCatalog.delete(d.pub);
      this.emit('change');
    } else if (m.t === 'state') {
      const prev = this.remotes.get(d.pub)?.snap || null;
      this.remotes.set(d.pub, { snap: m.snap, at: this.now() });
      this.emit('remote', d, m.snap, prev);
      this.emit('change');
    } else if (m.t === 'cmd') {
      this.receiveCommand(conn, d, m);
    } else if (m.t === 'cmd-status') {
      const o = this.outgoing.find((x) => x.id === m.id && x.pub === d.pub);
      if (o) { o.status = m.status; o.reason = m.reason; this.emit('change'); }
    } else if (m.t === 'cmd-report') {
      // v3.35 the report of a task we dispatched there; the host keeps only ids it dispatched
      const o = this.outgoing.find((x) => x.id === m.id && x.pub === d.pub);
      if (o) { o.status = 'reported'; }
      const { t: _t, id, ...report } = m;
      // acknowledged every time (the sender resends until it hears this); a repeat is dropped by the host (main)
      if (this.peerHas(d.pub, 'report')) this.write(conn, { t: 'cmd-report-ack', id });
      this.emit('report', { device: d, id, report });
      this.emit('change');
    } else if (m.t === 'cmd-report-ack') {
      // v3.35 the dispatcher has the report: it is no longer resent
      const r = this.reportsOut.get(m.id);
      if (r && r.pub === d.pub && r.report && !r.sent) { r.sent = true; this.saveReports(); }
    } else if (m.t === 'ho-offer') {
      this.receiveOffer(conn, d, m);
    } else if (m.t === 'ho-chunk') {
      this.receiveChunk(d, m);
    } else if (m.t === 'ho-answer' || m.t === 'ho-result') {
      const h = this.handoffsOut.get(m.id);
      const hin = m.t === 'ho-result' ? this.handoffsIn.get(m.id) : null;
      if (h && h.pub === d.pub && !h.done) (m.t === 'ho-answer' ? h.onAnswer : h.onResult)?.(m);
      else if (hin && hin.pub === d.pub) {
        // the sender gave up (timeout, changed): drop the offer; one being applied must not be adopted any more
        if (hin.stage === 'applying') hin.cancelled = true;
        else this.dropIn(hin, m.reason || 'cancelled', false);
      } else if (m.t === 'ho-result' && (!h || h.pub === d.pub)) this.emit('handoff-late-result', { device: d, id: m.id, ok: m.ok, applied: m.applied, reason: m.reason });
    } else if (m.t === 'ho-query') {
      this.write(conn, { t: 'ho-status', id: m.id, ...this.statusOf(d.pub, m.id) });
    } else if (m.t === 'ho-status') {
      this.emit('handoff-status', { device: d, id: m.id, status: m.status, applied: m.applied, reason: m.reason });
    }
  }

  // --- persisted handoff results (receiver) and the sender's "ask again"

  loadResults() {
    const out = new Map();
    if (!this.resultsFile) return out;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(this.resultsFile, 'utf8')); } catch { return out; }
    for (const [id, r] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (!r || typeof r !== 'object' || typeof r.pub !== 'string') continue;
      // an apply cut off by a restart: what landed on disk is not known
      const status = r.status === 'applying' ? 'unknown' : r.status;
      if (['applied', 'not-applied', 'unknown'].includes(status)) out.set(id, { pub: r.pub, status, applied: r.applied, reason: r.reason, sent: r.sent === true, at: Number(r.at) || 0 });
    }
    return out;
  }
  saveResults() {
    if (!this.resultsFile) return;
    const keep = [...this.results].sort((x, y) => y[1].at - x[1].at).slice(0, 50);   // the newest 50 are plenty
    this.results = new Map(keep);
    try {
      fs.mkdirSync(path.dirname(this.resultsFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.resultsFile, JSON.stringify(Object.fromEntries(keep), null, 2), { mode: 0o600 });
    } catch { /* best effort */ }
  }
  setResult(id, pub, status, extra = {}) {
    this.results.set(id, { pub, status, sent: false, at: this.now(), ...extra });
    this.saveResults();
  }
  resultMsg(id, r) {
    return { t: 'ho-result', id, ok: r.status === 'applied', ...(r.reason ? { reason: r.reason } : {}), ...(r.applied ? { applied: r.applied } : {}) };
  }
  /** The answer to ho-query: from the record, else still applying = unknown, else it never got that far = not-applied. */
  statusOf(pub, id) {
    const r = this.results.get(id);
    if (r && r.pub === pub) return { status: r.status, ...(r.applied ? { applied: r.applied } : {}), ...(r.reason ? { reason: r.reason } : {}) };
    const h = this.handoffsIn.get(id);
    if (h && h.pub === pub && h.stage === 'applying') return { status: 'unknown' };
    return { status: 'not-applied' };
  }
  /** Sender: asks a device again for the outcome of a handoff ('handoff-status' answers). False when it is offline. */
  queryHandoff(pub, id) {
    const conn = this.conns.get(pub);
    if (!conn || conn.destroyed || !C.validateMessage({ t: 'ho-query', id })) return false;
    this.write(conn, { t: 'ho-query', id });
    return true;
  }

  // --- project handoff (v3.29): offer → answer → chunks (pack, then bundle) → result

  /**
   * Offers a project to a paired device and, once accepted, sends its data. Resolves with the receiver's result.
   * A failure decided here (timeout, beforeSend) is also told to the receiver so it drops the offer. A failure after
   * all data was sent (timeout or connection lost while the receiver applies) is `unknown: true` with the id: the
   * receiver may still apply it and reports through 'handoff-late-result'.
   * @param {string} pub @param {{ name: string, dir: string, git: any }} offer @param {{ pack: Buffer, bundle?: Buffer | null }} parts
   * @param {{ answerMs?: number, resultMs?: number, beforeSend?: () => Promise<string | null> | string | null }} [o]
   * @returns {Promise<{ ok: boolean, reason?: string, applied?: string, unknown?: boolean, id?: string }>}
   */
  offerHandoff(pub, offer, parts, { answerMs = 10 * 60 * 1000, resultMs = 60 * 60 * 1000, beforeSend } = {}) {
    const conn = this.conns.get(pub);
    if (!conn) return Promise.resolve({ ok: false, reason: 'offline' });
    const id = crypto.randomBytes(8).toString('hex');
    const sum = (b) => (b ? { size: b.length, sha: crypto.createHash('sha256').update(b).digest('hex') } : null);
    const h = { id, pub, name: C.cleanLine(offer.name, 60), stage: 'asking', sent: 0, total: parts.pack.length + (parts.bundle?.length || 0), at: this.now() };
    this.handoffsOut.set(id, h);
    return new Promise((resolve) => {
      let timer = setTimeout(() => h.finish({ ok: false, reason: 'timeout' }), answerMs);
      h.finish = (r, fromPeer = false) => {
        if (h.done) return;
        h.done = true;
        clearTimeout(timer);
        if (!r.ok && !fromPeer) {
          if (!conn.destroyed) this.write(conn, { t: 'ho-result', id, ok: false, reason: r.reason });
          if (h.stage === 'applying') r = { ...r, unknown: true, id };
        }
        Object.assign(h, { stage: r.ok ? 'done' : r.unknown ? 'unknown' : 'failed', reason: r.reason, applied: r.applied });
        this.emit('change');
        resolve(r);
      };
      h.onAnswer = async (m) => {
        if (!m.ok) return h.finish({ ok: false, reason: m.reason || 'declined' }, true);
        if (h.stage !== 'asking') return;
        clearTimeout(timer);
        timer = setTimeout(() => h.finish({ ok: false, reason: 'timeout' }), resultMs);
        h.stage = 'sending';
        this.emit('change');
        try {
          const why = beforeSend ? await beforeSend() : null;
          if (why) return h.finish({ ok: false, reason: why });
          await this.stream(conn, h, 'pack', parts.pack);
          if (parts.bundle) await this.stream(conn, h, 'bundle', parts.bundle);
          if (!h.done) { h.stage = 'applying'; this.emit('change'); }
        } catch { h.finish({ ok: false, reason: 'offline' }); }
      };
      h.onResult = (m) => h.finish({ ok: m.ok, ...(m.reason ? { reason: m.reason } : {}), ...(m.applied ? { applied: m.applied } : {}) }, true);
      this.write(conn, { t: 'ho-offer', id, name: offer.name, dir: offer.dir, engine: 'claude', git: offer.git, pack: sum(parts.pack), bundle: sum(parts.bundle) });
      this.emit('change');
    });
  }
  async stream(conn, h, part, buf) {
    let last = 0;
    for (let off = 0, seq = 0; off < buf.length; off += C.CHUNK, seq++) {
      if (conn.destroyed || h.done) throw new Error('closed');
      const line = C.encode({ t: 'ho-chunk', id: h.id, part, seq, data: buf.subarray(off, off + C.CHUNK).toString('base64') });
      if (!conn.write(line)) await new Promise((r) => { const go = () => { conn.off('drain', go); conn.off('close', go); r(); }; conn.on('drain', go); conn.on('close', go); });
      h.sent += Math.min(C.CHUNK, buf.length - off);
      if (this.now() - last > 250) { last = this.now(); this.emit('change'); }
    }
  }

  receiveOffer(conn, d, m) {
    const answer = (ok, reason) => this.write(conn, { t: 'ho-answer', id: m.id, ok, ...(reason ? { reason } : {}) });
    if (!C.mayHandoff(this.devices, this.secrets, d.pub)) { this.emit('handoff-refused', { device: d, offer: m, reason: 'not-allowed' }); return answer(false, 'not-allowed'); }
    if (this.handoffsIn.size) return answer(false, 'in-progress');
    const h = { id: m.id, pub: d.pub, conn, offer: m, stage: 'asking', parts: { pack: [], bundle: [] }, bytes: { pack: 0, bundle: 0 }, seq: { pack: 0, bundle: 0 }, at: this.now() };
    this.handoffsIn.set(m.id, h);
    h.timer = setTimeout(() => { if (this.handoffsIn.get(m.id) === h && h.stage === 'asking') { answer(false, 'timeout'); this.dropIn(h, 'timeout', false); } }, this.handoffAskMs);
    h.timer.unref?.();
    this.emit('handoff-offer', { device: d, offer: m });
    this.emit('change');
  }
  /** The person's answer to an offer. Returns false when there is no such open offer. */
  answerHandoff(id, accept, reason = 'declined') {
    const h = this.handoffsIn.get(id);
    if (!h || h.stage !== 'asking') return false;
    clearTimeout(h.timer);
    if (!accept) { this.write(h.conn, { t: 'ho-answer', id, ok: false, reason }); this.handoffsIn.delete(id); }
    else {
      h.stage = 'receiving';
      h.timer = setTimeout(() => { if (this.handoffsIn.get(id) === h && h.stage === 'receiving') this.dropIn(h, 'timeout'); }, this.handoffIdleMs);
      h.timer.unref?.();
      this.write(h.conn, { t: 'ho-answer', id, ok: true });
    }
    this.emit('change');
    return true;
  }
  dropIn(h, reason, tell = true) {
    clearTimeout(h.timer);
    if (tell) this.write(h.conn, { t: 'ho-result', id: h.id, ok: false, reason });
    this.handoffsIn.delete(h.id);
    this.emit('handoff-failed', { offer: h.offer, reason });
    this.emit('change');
  }
  receiveChunk(d, m) {
    const h = this.handoffsIn.get(m.id);
    if (!h || h.pub !== d.pub || h.stage !== 'receiving') return;
    const want = h.offer[m.part];
    if (!want || m.seq !== h.seq[m.part] || (m.part === 'bundle' && h.bytes.pack < h.offer.pack.size)) return this.dropIn(h, 'bad-data');
    const buf = Buffer.from(m.data, 'base64');
    if (h.bytes[m.part] + buf.length > want.size) return this.dropIn(h, 'too-large');
    h.timer?.refresh?.();
    h.parts[m.part].push(buf);
    h.bytes[m.part] += buf.length;
    h.seq[m.part]++;
    if (h.bytes.pack < h.offer.pack.size || (h.offer.bundle && h.bytes.bundle < h.offer.bundle.size)) return;
    const parts = { pack: Buffer.concat(h.parts.pack), bundle: h.offer.bundle ? Buffer.concat(h.parts.bundle) : null };
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    if (sha(parts.pack) !== h.offer.pack.sha || (parts.bundle && sha(parts.bundle) !== h.offer.bundle.sha)) return this.dropIn(h, 'checksum');
    clearTimeout(h.timer);
    h.stage = 'applying';
    h.parts = null;
    this.setResult(h.id, h.pub, 'applying');   // a restart from here on answers ho-query with 'unknown'
    this.emit('change');
    const done = (/** @type {{ ok: boolean, reason?: string, applied?: string }} */ r) => {
      if (this.handoffsIn.get(h.id) !== h) return;
      const msg = { t: 'ho-result', id: h.id, ok: r.ok === true, ...(r.reason ? { reason: r.reason } : {}), ...(r.applied ? { applied: r.applied } : {}) };
      const conn = this.conns.get(h.pub);
      const live = Boolean(conn && !conn.destroyed);
      if (live) this.write(conn, msg);
      // kept on disk: sent when the sender is back (also after a restart) and the answer to its ho-query
      this.setResult(h.id, h.pub, msg.ok ? 'applied' : 'not-applied', { ...(msg.reason ? { reason: msg.reason } : {}), ...(msg.applied ? { applied: msg.applied } : {}) });
      if (live) { this.results.get(h.id).sent = true; this.saveResults(); }
      this.handoffsIn.delete(h.id);
      this.emit('change');
    };
    // alive() turns false when the sender gave up meanwhile: the receiver must then not adopt the project
    const alive = () => this.handoffsIn.get(h.id) === h && !h.cancelled;
    this.emit('handoff-data', { device: d, offer: h.offer, parts, done, alive });
  }

  receiveCommand(conn, d, m) {
    const reply = (status, reason) => this.write(conn, { t: 'cmd-status', id: m.id, status, ...(reason ? { reason } : {}) });
    if (!C.mayCommand(this.devices, this.secrets, d.pub)) return reply('rejected', 'not-allowed');
    if (!this.limiter.take(d.pub)) return reply('rejected', 'rate-limited');
    const s = C.sanitizeCommand(m.text);
    if (!s.ok) return reply('rejected', s.reason);
    // main decides (project, engine, busy tab) and answers through reply()
    this.emit('command', { device: d, id: m.id, project: m.project, text: s.text, reply, report: m.report === true && this.peerHas(d.pub, 'report') });
  }

  /** Sends a prompt to a remote project's boss tab. Returns the command's local record. */
  sendCommand(pub, project, text, { report = false } = {}) {
    const conn = this.conns.get(pub);
    const s = C.sanitizeCommand(text);
    const snap = this.remotes.get(pub)?.snap;
    const rec = { id: crypto.randomBytes(8).toString('hex'), pub, project, projectName: snap?.projects.find((p) => p.id === project)?.name || project, firstLine: C.cleanLine(String(text).split('\n')[0], 80), status: 'sent', at: this.now() };
    if (!s.ok) Object.assign(rec, { status: 'rejected', reason: s.reason });
    else if (!conn) Object.assign(rec, { status: 'rejected', reason: report ? 'offline' : 'not-running' });
    else if (report && !this.peerHas(pub, 'report')) Object.assign(rec, { status: 'rejected', reason: 'no-report' });
    else this.write(conn, { t: 'cmd', id: rec.id, project, text: s.text, ...(report ? { report: true } : {}) });
    if (report) rec.report = true;
    this.outgoing = [rec, ...this.outgoing].slice(0, 20);
    this.emit('change');
    return rec;
  }

  // --- v3.35 reports of dispatched tasks (this device ran them)

  loadReports() {
    const out = new Map();
    let raw = null;
    try { raw = this.reportsFile && JSON.parse(fs.readFileSync(this.reportsFile, 'utf8')); } catch { return out; }
    for (const [id, r] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (r && typeof r.pub === 'string' && (r.report === null || C.cleanReport(r.report))) out.set(id, { pub: r.pub, report: r.report && C.cleanReport(r.report), sent: r.sent === true, at: Number(r.at) || 0 });
    }
    return out;
  }
  saveReports() {
    const keep = [...this.reportsOut].sort((x, y) => y[1].at - x[1].at).slice(0, 50);
    this.reportsOut = new Map(keep);
    if (!this.reportsFile) return;
    try {
      fs.mkdirSync(path.dirname(this.reportsFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.reportsFile, JSON.stringify(Object.fromEntries(keep.map(([id, r]) => [id, { pub: r.pub, report: r.report, sent: r.sent, at: r.at }]))), { mode: 0o600 });
    } catch { /* best effort */ }
  }
  /** A task from that device was typed with report: its report is owed to it. */
  expectReport(id, pub) { this.reportsOut.set(id, { pub, report: null, sent: false, at: this.now() }); this.saveReports(); }
  owesReport(id) { const r = this.reportsOut.get(id); return Boolean(r && r.report === null); }
  /** The report of a task that device dispatched: sent now when it is connected, else on its next hello. */
  sendReport(id, report) {
    const r = this.reportsOut.get(id);
    const clean = C.cleanReport(report);
    if (!r || r.report || !clean || !C.trusted(this.devices, this.secrets, r.pub)) return false;
    Object.assign(r, { report: clean, at: this.now() });
    const conn = this.conns.get(r.pub);
    if (conn) this.flushReports(r.pub, conn);
    this.saveReports();
    return true;
  }
  flushReports(pub, conn) {
    if (!this.peerHas(pub, 'report') || !C.trusted(this.devices, this.secrets, pub)) return;
    // `sent` turns true only on the dispatcher's cmd-report-ack: until then each new connection (hello) resends it
    for (const [id, r] of this.reportsOut) if (r.pub === pub && r.report && !r.sent && r.wroteOn !== conn && !conn.destroyed) {
      this.write(conn, { t: 'cmd-report', id, ...r.report });
      r.wroteOn = conn;   // not persisted: once per connection
    }
  }

  // --- the published snapshot: at most once a second, only when it changed

  publish(snap) {
    const json = JSON.stringify(snap);
    if (json === this.snapJson) return;
    this.snap = snap;
    this.snapJson = json;
    const wait = Math.max(0, 1000 - (this.now() - this.lastPub));
    if (this.pubTimer) return;
    this.pubTimer = setTimeout(() => {
      this.pubTimer = null;
      this.lastPub = this.now();
      for (const [pub, conn] of this.conns) this.flushTo(pub, conn);
    }, wait);
    this.pubTimer.unref?.();
  }
  flushTo(pub, conn) {
    if (!this.snap || this.sentJson.get(pub) === this.snapJson) return;
    this.sentJson.set(pub, this.snapJson);
    this.write(conn, { t: 'state', seq: ++this.seq, snap: this.snap });
  }

  // --- v3.31 capabilities, v3.32 machine resources and catalog

  helloMsg() { return { t: 'hello', v: C.PROTOCOL, name: this.name, ...(this.appVersion ? { app: this.appVersion } : {}), caps: C.OUR_CAPS }; }
  /** Did this peer's hello (on the current connection) name the capability? A v1 peer names none. */
  peerHas(pub, cap) { return Boolean(this.peers.get(pub)?.caps.includes(cap)); }
  forgetPeer(pub) {
    for (const m of [this.peers, this.sentRes, this.sentCatalog, this.peerRes, this.peerCatalog]) m.delete(pub);
  }
  /** This machine's resources: sent to peers with 'res' when it changed enough (C.resChanged). */
  publishRes(res) {
    if (!res || !C.resChanged(this.res, res)) return;
    this.res = res;
    for (const [pub, conn] of this.conns) this.flushRes(pub, conn);
  }
  flushRes(pub, conn) {
    if (!this.res || !this.peerHas(pub, 'res')) return;
    const json = JSON.stringify(this.res);
    if (this.sentRes.get(pub) === json) return;
    this.sentRes.set(pub, json);
    this.write(conn, { t: 'res', res: this.res });
  }
  /** This machine's project catalog (display only): sent only to peers with 'catalog' that we allow to manage. */
  publishCatalog(catalog) {
    const clean = C.cleanCatalog(catalog);
    if (!clean) return;
    this.catalog = clean.projects;
    for (const [pub, conn] of this.conns) this.flushCatalog(pub, conn);
  }
  flushCatalog(pub, conn) {
    if (!this.peerHas(pub, 'catalog')) return;
    if (!C.mayManage(this.devices, this.secrets, pub)) {
      // it was shared on this connection: tell it to forget (an empty message, no data)
      if (this.sentCatalog.has(pub) && this.sentCatalog.get(pub) !== 'off') { this.sentCatalog.set(pub, 'off'); this.write(conn, { t: 'catalog', catalog: { projects: [], shared: false } }); }
      return;
    }
    if (!this.catalog) return;
    const json = JSON.stringify(this.catalog);
    if (this.sentCatalog.get(pub) === json) return;
    this.sentCatalog.set(pub, json);
    this.write(conn, { t: 'catalog', catalog: { projects: this.catalog } });
  }

  // --- the trust list

  rename(pub, name) { this.devices = this.devices.map((d) => (d.pub === pub ? { ...d, name: C.deviceName(name, d.name) } : d)); this.persist(); this.emit('change'); }
  setAllow(pub, on) { this.devices = this.devices.map((d) => (d.pub === pub ? { ...d, allowCommands: on === true } : d)); this.persist(); this.emit('change'); }
  setAllowHandoff(pub, on) { this.devices = this.devices.map((d) => (d.pub === pub ? { ...d, allowHandoff: on === true } : d)); this.persist(); this.emit('change'); }
  /** v3.31 "Allow managing projects": the catalog goes to that device (and stops at once when turned off). */
  setAllowManage(pub, on) {
    this.devices = this.devices.map((d) => (d.pub === pub ? { ...d, allowManage: on === true } : d));
    this.persist();
    const conn = this.conns.get(pub);
    if (conn) this.flushCatalog(pub, conn);
    this.emit('change');
  }
  /** v3.31 "Allow account sign-in" (used by later phases; nothing is sent for it yet). */
  setAllowAccounts(pub, on) { this.devices = this.devices.map((d) => (d.pub === pub ? { ...d, allowAccounts: on === true } : d)); this.persist(); this.emit('change'); }
  setName(name) {
    this.name = C.deviceName(name, this.name);
    for (const conn of this.conns.values()) this.write(conn, this.helloMsg());
    this.persist(); this.emit('change');
  }
  async remove(pub) {
    const secret = this.secrets[pub];
    this.devices = this.devices.filter((d) => d.pub !== pub);
    delete this.secrets[pub];
    this.conns.get(pub)?.destroy();
    this.conns.delete(pub);
    this.remotes.delete(pub);
    this.forgetPeer(pub);
    for (const [id, r] of this.reportsOut) if (r.pub === pub) this.reportsOut.delete(id);   // its reports go with it
    this.saveReports();
    this.persist();
    this.emit('change');
    if (secret) await this.swarm?.leave(C.pairTopic(secret)).catch(() => {});
    await this.maybeStopSwarm();
  }

  persist() { this.emit('persist', { name: this.name, devices: this.devices, secrets: { ...this.secrets } }); }

  /** What the renderer sees. No keys or secrets. */
  view() {
    return {
      name: this.name, id: this.pub.slice(0, 8),
      pairing: this.pairing ? { role: this.pairing.role, code: this.pairing.role === 'inviter' ? this.pairing.code : null, expiresAt: this.pairing.expiresAt } : null,
      devices: this.devices.map((d) => {
        const peer = this.peers.get(d.pub);
        return { id: d.pub, name: d.name, addedAt: d.addedAt, allowCommands: d.allowCommands, allowHandoff: d.allowHandoff, allowManage: d.allowManage, allowAccounts: d.allowAccounts, online: this.conns.has(d.pub),
          // v3.31/v3.32: null = no hello yet; v 1 = an older Agent Office there (no caps)
          v: peer ? peer.v : null, app: peer?.app || '', caps: peer?.caps || [], res: this.peerRes.get(d.pub) || null, catalog: this.peerCatalog.get(d.pub) || null };
      }),
      self: { app: this.appVersion, res: this.res, catalog: this.catalog || [] },
      remotes: [...this.remotes].map(([pub, r]) => ({ device: pub, name: this.devices.find((d) => d.pub === pub)?.name || '?', at: r.at, ...r.snap })),
      outgoing: this.outgoing.map((o) => ({ ...o, deviceName: this.devices.find((d) => d.pub === o.pub)?.name || '?' })),
      handoffs: {
        out: [...this.handoffsOut.values()].slice(-5).map((h) => ({ id: h.id, device: h.pub, deviceName: this.devices.find((d) => d.pub === h.pub)?.name || '?', name: h.name, stage: h.stage, sent: h.sent, total: h.total, ...(h.reason ? { reason: h.reason } : {}), ...(h.applied ? { applied: h.applied } : {}), at: h.at })),
        in: [...this.handoffsIn.values()].map((h) => ({ id: h.id, device: h.pub, deviceName: this.devices.find((d) => d.pub === h.pub)?.name || '?', name: h.offer.name, dir: h.offer.dir, stage: h.stage, got: h.bytes.pack + h.bytes.bundle, total: h.offer.pack.size + (h.offer.bundle?.size || 0), at: h.at })),
      },
    };
  }

  async destroy() {
    this.destroyed = true;
    clearTimeout(this.pubTimer);
    if (this.pairing) { clearTimeout(this.pairing.timer); clearInterval(this.pairing.retry); this.pairing.reject?.(new Error('cancelled')); this.pairing = null; }
    const s = this.swarm;
    this.swarm = null;
    if (s) await s.destroy().catch(() => {});
  }
}

module.exports = { Link };
