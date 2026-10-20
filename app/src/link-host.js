// Device link (contract v3.28): the main-process host. Keeps the key pair and pair secrets encrypted with
// Electron safeStorage (OS keychain), the trust list in userData/link/devices.json, delivers remote commands into
// the owning project's boss tab (queued while it is busy), logs every received command, and bridges to the renderer.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const C = require('./link-core.js');
const H = require('./handoff.js');

const QUEUE_MAX = 5;                    // waiting commands per project
const QUEUE_TTL_MS = 30 * 60 * 1000;    // a command that waited this long is dropped ('expired')

/**
 * @param {{ app: any, safeStorage: any, ipcMain: any, send: (ch: string, ...a: any[]) => void,
 *   notify: (title: string, body: string) => void, T: (k: string, v?: any) => string,
 *   projects: () => { id: string, name: string, engine: string }[],
 *   tabState: (projectId: string) => 'ready' | 'busy' | 'gone', type: (projectId: string, text: string) => void,
 *   handoff?: { describe: (projectId: string) => any, release: (projectId: string) => void, target: (dir: string) => { root: string, memoryDir: string, factsFile: string },
 *     adopt: (o: { dir: string, settings: any, sessionIds: string[] }) => void, pickFolder: (defaultPath: string) => Promise<string | null> } }} d
 */
function setupLink(d) {
  const dir = path.join(d.app.getPath('userData'), 'link');
  const keysFile = path.join(dir, 'keys.bin');
  const devicesFile = path.join(dir, 'devices.json');
  const logFile = path.join(dir, 'commands.log');
  const handoffLog = path.join(dir, 'handoff.log');
  const ownersFile = path.join(dir, 'owners.json');
  const targets = new Map();             // incoming handoff id → the folder chosen for it
  let link = null;
  let error = null;
  const queue = new Map();               // projectId → [{ id, device, text, at, reply }]

  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  function keychainOk() {
    if (!d.safeStorage.isEncryptionAvailable()) return false;
    // Linux without a keyring falls back to a hard-coded key: that is plain text in all but name
    try { if (process.platform === 'linux' && d.safeStorage.getSelectedStorageBackend() === 'basic_text') return false; } catch { /* older Electron */ }
    return true;
  }
  function loadKeys() {
    if (!fs.existsSync(keysFile)) {
      const kp = require('hyperdht').keyPair();
      return { publicKey: kp.publicKey, secretKey: kp.secretKey, secrets: {}, fresh: true };
    }
    const k = JSON.parse(d.safeStorage.decryptString(fs.readFileSync(keysFile)));
    return { publicKey: Buffer.from(k.publicKey, 'hex'), secretKey: Buffer.from(k.secretKey, 'hex'), secrets: k.secrets || {} };
  }
  function save({ name, devices, secrets }) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const keys = { publicKey: link.pub, secretKey: C.hex(link.keyPair.secretKey), secrets };
    fs.writeFileSync(keysFile, d.safeStorage.encryptString(JSON.stringify(keys)), { mode: 0o600 });
    fs.writeFileSync(devicesFile, JSON.stringify({ name, devices }, null, 2), { mode: 0o600 });
  }

  function start() {
    if (link || error) return link;
    if (!keychainOk()) { error = 'no-keychain'; return null; }
    try {
      const keys = loadKeys();
      const saved = readJson(devicesFile) || {};
      link = new C_Link({ keyPair: { publicKey: keys.publicKey, secretKey: keys.secretKey }, name: saved.name || os.hostname().replace(/\.local$/, ''), devices: saved.devices, secrets: keys.secrets });
      link.on('persist', save);
      if (keys.fresh) link.persist();
      link.on('change', push);
      link.on('remote', onRemote);
      link.on('command', onCommand);
      link.on('handoff-offer', onHandoffOffer);
      link.on('handoff-refused', ({ device, offer, reason }) => hlog({ dir: 'in', device: device.name, project: offer.name, outcome: `refused:${reason}` }));
      link.on('handoff-failed', ({ offer, reason }) => { targets.delete(offer.id); hlog({ dir: 'in', project: offer.name, outcome: `failed:${reason}` }); });
      link.on('handoff-data', (x) => { applyHandoff(x).catch(() => {}); });
      if (link.devices.length) link.ensureSwarm();
    } catch (e) {
      console.error('link:', e.message);
      error = 'keys';
      link = null;
    }
    return link;
  }
  const C_Link = require('./link.js').Link;

  const view = () => ({ ...(link ? { ...link.view(), error: null } : { name: os.hostname(), id: '', pairing: null, devices: [], remotes: [], outgoing: [], handoffs: { out: [], in: [] }, error: error || 'off' }), owners: ownersView() });
  let pushTimer = null;
  function push() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = null; d.send('link:changed', view()); }, 100);
  }

  function onRemote(device, snap, prev) {
    const was = new Map((prev?.projects || []).map((p) => [p.id, p.status]));
    for (const p of snap.projects) {
      if (p.status === 'approval' && was.get(p.id) !== 'approval') d.notify(d.T('main.linkApproval', { device: device.name, project: p.name }), p.tool ? d.T('main.notifyPermissionTool', { tool: p.tool }) : '');
    }
  }

  function log(device, project, text, outcome) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(logFile, `${JSON.stringify(C.logEntry(Date.now(), device, project, text, outcome))}\n`); } catch { /* the log is best effort */ }
  }

  // --- project handoff (v3.29)
  function hlog(entry) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(handoffLog, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); } catch { /* best effort */ }
  }
  /** @returns {Record<string, { owner: string, ownerName: string, project: string, at: number }>} folder → who owns it ('self' or a device key) */
  const readOwners = () => { const o = readJson(ownersFile); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; };
  function setOwner(folder, owner, ownerName, project) {
    const o = readOwners();
    o[folder] = { owner, ownerName, project, at: Date.now() };
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(ownersFile, JSON.stringify(o, null, 2), { mode: 0o600 }); } catch { /* best effort */ }
  }
  const ownersView = () => Object.entries(readOwners()).filter(([, v]) => v && v.owner && v.owner !== 'self').map(([folder, v]) => ({ dir: folder, project: String(v.project || ''), deviceName: String(v.ownerName || '?'), at: Number(v.at) || 0 }));

  /** Hands a local project to a paired device. Resolves with the outcome; on success the project leaves this office. */
  async function handOff(pub, projectId) {
    const l = start();
    const dev = l?.devices.find((x) => x.pub === pub);
    if (!l || !dev || !d.handoff) return { ok: false, reason: 'not-allowed' };
    const info = d.handoff.describe(projectId);
    if (!info) return { ok: false, reason: 'unknown-project' };
    const why = H.refusal({ engine: info.engine, busy: info.busy, git: Boolean(H.gitInfo(info.dir)), online: l.conns.has(pub) });
    if (why) { hlog({ dir: 'out', device: dev.name, project: info.name, outcome: `refused:${why}` }); return { ok: false, reason: why }; }
    let r;
    try {
      const snap = H.snapshotWip(info.dir);
      if (!snap) return { ok: false, reason: 'not-git' };
      const pushed = await H.pushWip(snap);
      const bundle = pushed ? null : H.createBundle(snap, os.tmpdir());
      if (!pushed && !bundle) r = { ok: false, reason: 'too-large' };
      else {
        const pack = H.packSession({ root: info.root, dir: info.dir, sessionIds: info.sessionIds, memoryDir: info.memoryDir, factsFile: info.factsFile, settings: info.settings });
        hlog({ dir: 'out', device: dev.name, project: info.name, outcome: `offered:${pushed ? 'remote' : 'bundle'}`, wip: snap.wip, bytes: pack.length + (bundle?.length || 0) });
        r = await l.offerHandoff(pub, { name: info.name, dir: info.dir, git: { mode: pushed ? 'remote' : 'bundle', wip: snap.wip, base: snap.base, root: snap.root, branch: snap.branch, remote: snap.remote } }, { pack, bundle });
      }
    } catch (e) { r = { ok: false, reason: String(e.message) === 'too-large' ? 'too-large' : 'bad-data' }; }
    hlog({ dir: 'out', device: dev.name, project: info.name, outcome: r.ok ? `done:${r.applied || ''}` : `failed:${r.reason}` });
    if (r.ok) { setOwner(info.dir, pub, dev.name, info.name); d.handoff.release(projectId); push(); }
    return r;
  }

  function onHandoffOffer({ device, offer }) {
    hlog({ dir: 'in', device: device.name, project: offer.name, outcome: 'offered', mode: offer.git.mode });
    d.notify(d.T('main.handoffOffer', { device: device.name, project: offer.name }), '');
    push();
  }
  /** The person's answer: on accept the folder is the sender's path when free or the same repo, else picked. */
  async function answerHandoff(l, id, accept) {
    const h = l.handoffsIn.get(id);
    if (!h || h.stage !== 'asking') return;
    if (!accept) { hlog({ dir: 'in', project: h.offer.name, outcome: 'declined' }); l.answerHandoff(id, false); return; }
    const folder = H.defaultTarget(h.offer) || await d.handoff?.pickFolder(h.offer.dir);
    if (!folder || !path.isAbsolute(folder)) { l.answerHandoff(id, false, 'cancelled'); return; }
    targets.set(id, folder);
    l.answerHandoff(id, true);
  }
  async function applyHandoff({ device, offer, parts, done }) {
    const folder = targets.get(offer.id);
    targets.delete(offer.id);
    let bundleFile = null;
    try {
      const pack = H.parsePack(parts.pack);
      if (!folder || !pack || !d.handoff) return done({ ok: false, reason: 'bad-data' });
      if (parts.bundle) { bundleFile = path.join(os.tmpdir(), `agent-office-handoff-${offer.id}.bundle`); fs.writeFileSync(bundleFile, parts.bundle, { mode: 0o600 }); }
      await H.receiveCode(folder, offer.git, bundleFile);
      const applied = H.restoreWip(folder, offer.git);
      H.writeSession(pack, { from: offer.dir, to: folder, ...d.handoff.target(folder) });
      d.handoff.adopt({ dir: folder, settings: pack.settings, sessionIds: pack.sessionIds });
      setOwner(folder, 'self', '', offer.name);
      hlog({ dir: 'in', device: device.name, project: offer.name, outcome: `done:${applied}`, folder });
      if (applied === 'branch-only') d.notify(d.T('main.handoffBranchOnly', { project: offer.name, branch: offer.git.wip }), '');
      done({ ok: true, applied });
    } catch (e) {
      hlog({ dir: 'in', device: device.name, project: offer.name, outcome: 'failed:apply-failed', error: C.cleanLine(e.message, 200) });
      done({ ok: false, reason: 'apply-failed' });
    } finally {
      if (bundleFile) fs.rmSync(bundleFile, { force: true });
      push();
    }
  }

  // Claude Code projects only: their busy state is known (pid file) and their prompt takes a bracketed paste.
  function onCommand({ device, id, project, text, reply }) {
    const p = d.projects().find((x) => x.id === project);
    const done = (status, reason) => { log(device.name, p?.name || project, text, reason ? `${status}:${reason}` : status); reply(status, reason); };
    if (!p) return done('rejected', 'unknown-project');
    if (p.engine !== 'claude') return done('rejected', 'engine');
    const q = queue.get(project) || [];
    if (q.length >= QUEUE_MAX) return done('rejected', 'queue-full');
    q.push({ id, device, text, at: Date.now(), reply });
    queue.set(project, q);
    done('queued');
    pump();
  }
  function pump() {
    const now = Date.now();
    for (const [project, q] of queue) {
      while (q.length) {
        const c = q[0];
        if (!link?.devices.some((x) => x.pub === c.device.pub)) { q.shift(); continue; }                 // removed meanwhile
        if (now - c.at > QUEUE_TTL_MS) { q.shift(); c.reply('rejected', 'expired'); continue; }
        const s = d.tabState(project);
        if (s === 'gone') { q.shift(); c.reply('rejected', 'not-running'); continue; }
        if (s !== 'ready') break;
        q.shift();
        d.type(project, C.markedCommand(c.device.name, c.text));
        c.reply('delivered');
        break;                                     // one per project per tick: the tab is busy after a prompt
      }
      if (!q.length) queue.delete(project);
    }
  }
  const pumpTimer = setInterval(pump, 1500);
  pumpTimer.unref?.();

  const ipc = (ch, fn) => d.ipcMain.handle(ch, async (_e, ...a) => { const l = start(); if (!l) return view(); await fn(l, ...a); return view(); });
  d.ipcMain.handle('link:get', () => { start(); return view(); });
  ipc('link:invite', (l) => l.invite());
  d.ipcMain.handle('link:join', async (_e, code) => {
    const l = start();
    if (!l) return { ok: false, error: error || 'off', view: view() };
    try { await l.join(code); return { ok: true, view: view() }; } catch (e) { return { ok: false, error: String(e.message || e), view: view() }; }
  });
  ipc('link:cancel', (l) => l.cancelPairing());
  ipc('link:setName', (l, name) => l.setName(String(name || '')));
  ipc('link:rename', (l, id, name) => l.rename(String(id), String(name || '')));
  ipc('link:setAllow', (l, id, on) => l.setAllow(String(id), on === true));
  ipc('link:remove', (l, id) => l.remove(String(id)));
  ipc('link:setAllowHandoff', (l, id, on) => l.setAllowHandoff(String(id), on === true));
  ipc('link:handoffAnswer', (l, id, accept) => answerHandoff(l, String(id), accept === true));
  ipc('link:send', (l, id, project, text) => l.sendCommand(String(id), String(project), String(text ?? '')));

  // Start at launch only when something is paired: a user who never pairs never touches the DHT.
  if (fs.existsSync(devicesFile)) start();

  return {
    publish(projects, office, attention) { if (link) link.publish(C.snapshotOf(projects, office, attention)); },
    /** Paired devices a project can be handed to (online ones first). */
    devices() { const l = start(); return l ? l.devices.map((x) => ({ id: x.pub, name: x.name, online: l.conns.has(x.pub) })) : []; },
    handOff,
    destroy() { clearInterval(pumpTimer); return link?.destroy(); },
  };
}

module.exports = { setupLink };
