// Device link (contract v3.28): Hyperswarm networking between this user's Agent Offices. No Electron: main.js
// gives it the key pair, the trust list and callbacks; tests run two of these on a local DHT testnet.
'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');
const C = require('./link-core.js');

class Link extends EventEmitter {
  /**
   * @param {{ keyPair: { publicKey: Buffer, secretKey: Buffer }, name: string, devices?: C.Device[], secrets?: Record<string, string>,
   *   bootstrap?: any[], now?: () => number, swarmFactory?: (opts: any) => any }} o
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
    const device = { pub, name: C.deviceName(name), addedAt: this.now(), allowCommands: false };   // commands OFF by default
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
    let invalid = 0;
    if (_why !== 'paired') this.reader(conn, (raw) => this.handle(conn, device, raw, () => { if (++invalid > 20) conn.destroy(); }));
    conn.on('close', () => {
      if (this.conns.get(device.pub) !== conn) return;
      this.conns.delete(device.pub);
      this.remotes.delete(device.pub);
      // its answers came on this connection: a command still sent or queued will never hear its outcome
      for (const o of this.outgoing) if (o.pub === device.pub && (o.status === 'sent' || o.status === 'queued')) o.status = 'unknown';
      this.emit('change');
    });
    this.write(conn, { t: 'hello', v: C.PROTOCOL, name: this.name });
    this.flushTo(device.pub, conn);
    this.emit('change');
  }

  handle(conn, device, raw, onInvalid = () => {}) {
    const d = C.trusted(this.devices, this.secrets, device.pub);   // checked on every message: removal revokes at once
    if (!d) return conn.destroy();
    const m = C.validateMessage(raw);
    if (!m) return onInvalid();
    if (m.t === 'hello') {
      if (m.name !== d.name && !d.renamed) { /* the local name wins; the remote name is only a default at pairing */ }
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
    }
  }

  receiveCommand(conn, d, m) {
    const reply = (status, reason) => this.write(conn, { t: 'cmd-status', id: m.id, status, ...(reason ? { reason } : {}) });
    if (!C.mayCommand(this.devices, this.secrets, d.pub)) return reply('rejected', 'not-allowed');
    if (!this.limiter.take(d.pub)) return reply('rejected', 'rate-limited');
    const s = C.sanitizeCommand(m.text);
    if (!s.ok) return reply('rejected', s.reason);
    // main decides (project, engine, busy tab) and answers through reply()
    this.emit('command', { device: d, id: m.id, project: m.project, text: s.text, reply });
  }

  /** Sends a prompt to a remote project's boss tab. Returns the command's local record. */
  sendCommand(pub, project, text) {
    const conn = this.conns.get(pub);
    const s = C.sanitizeCommand(text);
    const snap = this.remotes.get(pub)?.snap;
    const rec = { id: crypto.randomBytes(8).toString('hex'), pub, project, projectName: snap?.projects.find((p) => p.id === project)?.name || project, firstLine: C.cleanLine(String(text).split('\n')[0], 80), status: 'sent', at: this.now() };
    if (!s.ok) Object.assign(rec, { status: 'rejected', reason: s.reason });
    else if (!conn) Object.assign(rec, { status: 'rejected', reason: 'not-running' });
    else this.write(conn, { t: 'cmd', id: rec.id, project, text: s.text });
    this.outgoing = [rec, ...this.outgoing].slice(0, 20);
    this.emit('change');
    return rec;
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

  // --- the trust list

  rename(pub, name) { this.devices = this.devices.map((d) => (d.pub === pub ? { ...d, name: C.deviceName(name, d.name) } : d)); this.persist(); this.emit('change'); }
  setAllow(pub, on) { this.devices = this.devices.map((d) => (d.pub === pub ? { ...d, allowCommands: on === true } : d)); this.persist(); this.emit('change'); }
  setName(name) {
    this.name = C.deviceName(name, this.name);
    for (const conn of this.conns.values()) this.write(conn, { t: 'hello', v: C.PROTOCOL, name: this.name });
    this.persist(); this.emit('change');
  }
  async remove(pub) {
    const secret = this.secrets[pub];
    this.devices = this.devices.filter((d) => d.pub !== pub);
    delete this.secrets[pub];
    this.conns.get(pub)?.destroy();
    this.conns.delete(pub);
    this.remotes.delete(pub);
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
      devices: this.devices.map((d) => ({ id: d.pub, name: d.name, addedAt: d.addedAt, allowCommands: d.allowCommands, online: this.conns.has(d.pub) })),
      remotes: [...this.remotes].map(([pub, r]) => ({ device: pub, name: this.devices.find((d) => d.pub === pub)?.name || '?', at: r.at, ...r.snap })),
      outgoing: this.outgoing.map((o) => ({ ...o, deviceName: this.devices.find((d) => d.pub === o.pub)?.name || '?' })),
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
