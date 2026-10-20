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
 *   handoff?: { describe: (projectId: string) => any, release: (projectId: string) => void, lock: (projectId: string, on: boolean) => void,
 *     confirmPush: (project: string, url: string) => Promise<boolean>, confirmKeep: (project: string, device: string) => Promise<boolean>,
 *     target: (dir: string) => { root: string, memoryDir: string, factsFile: string, accountId?: string },
 *     adopt: (o: { dir: string, settings: any, sessionIds: string[], accountId?: string }) => void, pickFolder: (defaultPath: string) => Promise<string | null> } }} d
 */
function setupLink(d) {
  const dir = path.join(d.app.getPath('userData'), 'link');
  const keysFile = path.join(dir, 'keys.bin');
  const devicesFile = path.join(dir, 'devices.json');
  const logFile = path.join(dir, 'commands.log');
  const handoffLog = path.join(dir, 'handoff.log');
  const ownersFile = path.join(dir, 'owners.json');
  const resultsFile = path.join(dir, 'handoff-results.json');   // the receiver's handoff outcomes (no secrets)
  const targets = new Map();             // incoming handoff id → the folder chosen for it
  const defaults = new Map();            // incoming handoff id → the folder used without asking ('' = the person picks)
  const answered = new Set();            // incoming handoff ids already answered (a second click does nothing)
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
      link = new C_Link({ keyPair: { publicKey: keys.publicKey, secretKey: keys.secretKey }, name: saved.name || os.hostname().replace(/\.local$/, ''), devices: saved.devices, secrets: keys.secrets, resultsFile });
      link.on('persist', save);
      if (keys.fresh) link.persist();
      link.on('change', push);
      link.on('remote', onRemote);
      link.on('command', onCommand);
      link.on('handoff-offer', onHandoffOffer);
      link.on('handoff-refused', ({ device, offer, reason }) => hlog({ dir: 'in', device: device.name, project: offer.name, outcome: `refused:${reason}` }));
      link.on('handoff-failed', ({ offer, reason }) => { targets.delete(offer.id); defaults.delete(offer.id); answered.delete(offer.id); hlog({ dir: 'in', project: offer.name, outcome: `failed:${reason}` }); });
      link.on('handoff-data', (x) => { applyHandoff(x).catch(() => {}); });
      link.on('handoff-late-result', onLateResult);
      link.on('handoff-status', onStatus);
      // a handoff whose outcome is still unknown keeps its project locked across restarts
      for (const v of Object.values(readOwners())) if (v?.owner === 'unknown' && v.projectId) d.handoff?.lock(v.projectId, true);
      if (link.devices.length) link.ensureSwarm();
    } catch (e) {
      console.error('link:', e.message);
      error = 'keys';
      link = null;
    }
    return link;
  }
  const C_Link = require('./link.js').Link;

  const withTargets = (v) => ({ ...v, handoffs: { ...v.handoffs, in: v.handoffs.in.map((x) => ({ ...x, target: targetFor(x.id), answered: answered.has(x.id) })) } });
  function targetFor(id) {
    if (!defaults.has(id)) { const h = link?.handoffsIn.get(id); defaults.set(id, h ? H.defaultTarget(h.offer) || '' : ''); }
    return defaults.get(id);
  }
  const view = () => ({ ...(link ? { ...withTargets(link.view()), error: null } : { name: os.hostname(), id: '', pairing: null, devices: [], remotes: [], outgoing: [], handoffs: { out: [], in: [] }, error: error || 'off' }), owners: ownersView() });
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
  /** @returns {Record<string, { owner: string, ownerName: string, project: string, at: number, handoffId?: string, pub?: string, projectId?: string, wipPushed?: boolean, remoteName?: string, wip?: string }>} folder → who owns it ('self' or a device key) */
  const readOwners = () => { const o = readJson(ownersFile); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; };
  /** owner 'unknown': handed to the device ownerName, outcome not known yet (extra: handoffId, pub, projectId, push data). */
  function setOwner(folder, owner, ownerName, project, extra = {}) {
    const o = readOwners();
    if (owner == null) delete o[folder];
    else o[folder] = { owner, ownerName, project, at: Date.now(), ...extra };
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(ownersFile, JSON.stringify(o, null, 2), { mode: 0o600 }); } catch { /* best effort */ }
  }
  const ownersView = () => Object.entries(readOwners()).filter(([, v]) => v && v.owner && v.owner !== 'self').map(([folder, v]) => ({ dir: folder, project: String(v.project || ''), deviceName: String(v.ownerName || '?'), at: Number(v.at) || 0, unknown: v.owner === 'unknown', online: Boolean(v.pub && link?.conns.has(v.pub)) }));

  /** The receiver's result for a handoff this side had marked unknown (it applied, or not, while we were apart). */
  function onLateResult({ device, id, ok, applied, reason: _reason }) {
    const hit = Object.entries(readOwners()).find(([, v]) => v?.owner === 'unknown' && v.handoffId === id && v.pub === device.pub);
    if (!hit) return;
    const [folder, v] = hit;
    hlog({ dir: 'out', device: device.name, project: v.project, outcome: ok ? `late-done:${applied || ''}` : 'late-failed' });
    if (ok) {
      setOwner(folder, device.pub, device.name, v.project);
      if (v.wipPushed) H.deleteRemoteWip({ top: folder, remoteName: v.remoteName, wip: v.wip });
      if (v.projectId) d.handoff?.release(v.projectId);
    } else {
      setOwner(folder, null);
      if (v.projectId) d.handoff?.lock(v.projectId, false);
    }
    push();
  }

  /** The answer to "Ask again": applied / not-applied resolve it like a late result; unknown leaves it locked. */
  function onStatus({ device, id, status, applied, reason }) {
    if (status === 'applied' || status === 'not-applied') return onLateResult({ device, id, ok: status === 'applied', applied, reason });
    const hit = Object.values(readOwners()).find((v) => v?.owner === 'unknown' && v.handoffId === id && v.pub === device.pub);
    if (hit) { hlog({ dir: 'out', device: device.name, project: hit.project, outcome: 'query:unknown' }); d.notify(d.T('main.handoffStillUnknown', { project: hit.project, device: device.name }), ''); }
  }
  const unknownEntry = (folder) => { const v = readOwners()[folder]; return v?.owner === 'unknown' ? v : null; };
  /** The owners.json folder of a project whose handoff outcome is unknown, or null. */
  function unknownFor(projectId) {
    const hit = Object.entries(readOwners()).find(([, v]) => v?.owner === 'unknown' && v.projectId === projectId);
    return hit ? { dir: hit[0], project: String(hit[1].project || ''), deviceName: String(hit[1].ownerName || '?'), online: Boolean(link?.conns.has(hit[1].pub)) } : null;
  }
  /** "Ask again": re-queries the receiver (ho-query). Returns false when it is offline. */
  function askAgain(folder) {
    const v = unknownEntry(folder);
    if (!v || !link || !v.handoffId || !v.pub) return false;
    const ok = link.queryHandoff(v.pub, v.handoffId);
    hlog({ dir: 'out', device: v.ownerName, project: v.project, outcome: ok ? 'query' : 'query:offline' });
    return ok;
  }
  /** "Keep it here": after a warning that both machines may then own it, unlocks the project here and forgets the handoff. */
  async function keepHere(folder) {
    const v = unknownEntry(folder);
    if (!v || !d.handoff) return false;
    if (!(await d.handoff.confirmKeep(String(v.project || ''), String(v.ownerName || '?')))) return false;
    if (!unknownEntry(folder)) return false;   // resolved meanwhile
    setOwner(folder, null);
    if (v.projectId) d.handoff.lock(v.projectId, false);
    hlog({ dir: 'out', device: v.ownerName, project: v.project, outcome: 'kept-here', handoffId: v.handoffId });
    push();
    return true;
  }

  /** Hands a local project to a paired device. Resolves with the outcome; on success the project leaves this office. */
  async function handOff(pub, projectId) {
    const l = start();
    const dev = l?.devices.find((x) => x.pub === pub);
    if (!l || !dev || !d.handoff) return { ok: false, reason: 'not-allowed' };
    const info = d.handoff.describe(projectId);
    if (!info) return { ok: false, reason: 'unknown-project' };
    const isGit = Boolean(H.gitInfo(info.dir));
    const why = H.refusal({ engine: info.engine, busy: info.busy, git: isGit, subfolder: isGit && !H.isRepoRoot(info.dir), online: l.conns.has(pub) });
    if (why) { hlog({ dir: 'out', device: dev.name, project: info.name, outcome: `refused:${why}` }); return { ok: false, reason: why }; }
    // no prompts (typed or remote) reach the project's tabs from the snapshot until the outcome is known
    d.handoff.lock(projectId, true);
    /** @type {any} */ let r;
    let snap = null;
    let pushed = false;
    try {
      snap = H.snapshotWip(info.dir);
      if (!snap) r = { ok: false, reason: 'not-git' };
      else {
        const code = await H.prepareCode(snap, os.tmpdir(), { confirmPush: (url) => d.handoff.confirmPush(info.name, url) });
        if ('reason' in code) r = { ok: false, reason: code.reason };
        else {
          pushed = code.mode === 'remote';
          const pack = H.packSession({ root: info.root, dir: info.dir, sessionIds: info.sessionIds, memoryDir: info.memoryDir, factsFile: info.factsFile, settings: info.settings });
          hlog({ dir: 'out', device: dev.name, project: info.name, outcome: `offered:${code.mode}`, wip: snap.wip, bytes: pack.length + (code.bundle?.length || 0) });
          const s = snap;
          // just before the data goes: still idle, and nothing changed in the folder since the snapshot
          const beforeSend = () => H.changedSince(s, info.dir) || (d.handoff?.describe(projectId)?.busy ? 'busy' : null);
          r = await l.offerHandoff(pub, { name: info.name, dir: info.dir, git: { mode: code.mode, wip: snap.wip, base: snap.base, root: snap.root, branch: snap.branch, remote: snap.remote } }, { pack, bundle: code.bundle }, { beforeSend });
        }
      }
    } catch (e) { r = { ok: false, reason: String(e.message) === 'too-large' ? 'too-large' : 'bad-data' }; }
    hlog({ dir: 'out', device: dev.name, project: info.name, outcome: r.ok ? `done:${r.applied || ''}` : r.unknown ? `unknown:${r.reason}` : `failed:${r.reason}` });
    if (r.ok) {
      setOwner(info.dir, pub, dev.name, info.name);
      if (pushed && snap) H.deleteRemoteWip(snap);
      d.handoff.release(projectId);
    } else if (r.unknown) {
      // the receiver may have applied it: neither side runs it until its result comes (on the next connection)
      setOwner(info.dir, 'unknown', dev.name, info.name, { handoffId: r.id, pub, projectId, wipPushed: pushed, remoteName: snap?.remoteName || '', wip: snap?.wip || '' });
    } else {
      if (pushed && snap) H.deleteRemoteWip(snap);
      d.handoff.lock(projectId, false);
    }
    push();
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
    if (!h || h.stage !== 'asking' || answered.has(id)) return;
    answered.add(id);
    push();
    if (!accept) { hlog({ dir: 'in', project: h.offer.name, outcome: 'declined' }); l.answerHandoff(id, false); return; }
    // the sender's path is used only when it is free or the same repository; any other folder is the person's choice
    const folder = targetFor(id) || await d.handoff?.pickFolder(h.offer.dir);
    if (!folder || !path.isAbsolute(folder)) { l.answerHandoff(id, false, 'cancelled'); return; }
    targets.set(id, folder);
    l.answerHandoff(id, true);
  }
  async function applyHandoff({ device, offer, parts, done, alive = () => true }) {
    const folder = targets.get(offer.id);
    targets.delete(offer.id);
    defaults.delete(offer.id);
    answered.delete(offer.id);
    let bundleFile = null;
    try {
      const pack = H.parsePack(parts.pack);
      if (!folder || !pack || !d.handoff) return done({ ok: false, reason: 'bad-data' });
      if (parts.bundle) { bundleFile = path.join(os.tmpdir(), `agent-office-handoff-${offer.id}.bundle`); fs.writeFileSync(bundleFile, parts.bundle, { mode: 0o600 }); }
      await H.receiveCode(folder, offer.git, bundleFile);
      const applied = H.restoreWip(folder, offer.git);
      const target = d.handoff.target(folder);   // the account of the project at this folder if there is one
      // the sender gave up meanwhile (it then still owns the project): leave the fetched branch, adopt nothing
      if (!alive() || !link?.handoffsIn.has(offer.id)) {
        hlog({ dir: 'in', device: device.name, project: offer.name, outcome: 'failed:dropped', folder });
        return done({ ok: false, reason: 'cancelled' });
      }
      H.writeSession(pack, { from: offer.dir, to: folder, root: target.root, memoryDir: target.memoryDir, factsFile: target.factsFile });
      d.handoff.adopt({ dir: folder, settings: pack.settings, sessionIds: pack.sessionIds, accountId: target.accountId });
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
  ipc('link:handoffAsk', (_l, folder) => askAgain(String(folder)));
  ipc('link:handoffKeep', (_l, folder) => keepHere(String(folder)));
  ipc('link:send', (l, id, project, text) => l.sendCommand(String(id), String(project), String(text ?? '')));

  // Start at launch only when something is paired: a user who never pairs never touches the DHT.
  if (fs.existsSync(devicesFile)) start();

  return {
    publish(projects, office, attention) { if (link) link.publish(C.snapshotOf(projects, office, attention)); },
    /** Paired devices a project can be handed to (online ones first). */
    devices() { const l = start(); return l ? l.devices.map((x) => ({ id: x.pub, name: x.name, online: l.conns.has(x.pub) })) : []; },
    handOff, unknownFor, askAgain, keepHere,
    destroy() { clearInterval(pumpTimer); return link?.destroy(); },
  };
}

module.exports = { setupLink };
