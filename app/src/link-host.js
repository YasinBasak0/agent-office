// Device link (contract v3.28): the main-process host. Keeps the key pair and pair secrets encrypted with
// Electron safeStorage (OS keychain), the trust list in userData/link/devices.json, delivers remote commands into
// the owning project's boss tab (queued while it is busy), logs every received command, and bridges to the renderer.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const C = require('./link-core.js');

const QUEUE_MAX = 5;                    // waiting commands per project
const QUEUE_TTL_MS = 30 * 60 * 1000;    // a command that waited this long is dropped ('expired')

/**
 * @param {{ app: any, safeStorage: any, ipcMain: any, send: (ch: string, ...a: any[]) => void,
 *   notify: (title: string, body: string) => void, T: (k: string, v?: any) => string,
 *   projects: () => { id: string, name: string, engine: string }[],
 *   tabState: (projectId: string) => 'ready' | 'busy' | 'gone', type: (projectId: string, text: string) => void }} d
 */
function setupLink(d) {
  const dir = path.join(d.app.getPath('userData'), 'link');
  const keysFile = path.join(dir, 'keys.bin');
  const devicesFile = path.join(dir, 'devices.json');
  const logFile = path.join(dir, 'commands.log');
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
      if (link.devices.length) link.ensureSwarm();
    } catch (e) {
      console.error('link:', e.message);
      error = 'keys';
      link = null;
    }
    return link;
  }
  const C_Link = require('./link.js').Link;

  const view = () => (link ? { ...link.view(), error: null } : { name: os.hostname(), id: '', pairing: null, devices: [], remotes: [], outgoing: [], error: error || 'off' });
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
  ipc('link:send', (l, id, project, text) => l.sendCommand(String(id), String(project), String(text ?? '')));

  // Start at launch only when something is paired: a user who never pairs never touches the DHT.
  if (fs.existsSync(devicesFile)) start();

  return {
    publish(projects, office, attention) { if (link) link.publish(C.snapshotOf(projects, office, attention)); },
    destroy() { clearInterval(pumpTimer); return link?.destroy(); },
  };
}

module.exports = { setupLink };
