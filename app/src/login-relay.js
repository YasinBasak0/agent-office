// Remote Claude login relay, the host side (contract v3.34, amendment 8). A paired device with "Allow account sign-in"
// asks this machine to sign one of ITS existing accounts in: `claude auth login` runs here in its own `relay:<id>`
// pty (never a renderer pane, no window needed, never touching a local login), the sign-in URL goes to the asking
// device, the person opens it there and sends back the one-time code, which is typed here once. Credentials and
// tokens stay in this machine's account folder; the code lives only in memory; accounts.log has start/result/device.
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./link-core.js');

const BUF_MAX = 64 * 1024;   // cleaned output kept while looking for the URL

/**
 * @param {{ spawn: (account: any, id: string, devicePub?: string) => { onData: (f: (d: string) => void) => void, onExit: (f: (e: { exitCode: number }) => void) => void, write: (s: string) => void, kill: () => void },
 *   accounts: () => { id: string, label: string }[], checkAuth: (account: any) => Promise<{ ok: boolean, email?: string }>,
 *   localBusy?: (accountId: string) => boolean, logFile?: string | null, notice?: (device: string, label: string) => void,
 *   timeoutMs?: number, promptWaitMs?: number, now?: () => number }} o
 */
function createLoginRelay(o) {
  const timeoutMs = o.timeoutMs || C.LOGIN_TIMEOUT_MS;
  const promptWaitMs = o.promptWaitMs ?? 2000;
  const now = o.now || Date.now;
  const relays = new Map();   // device pub → { id, account, pty, buf, urlSent, codeWritten, done, timer, wait, reply }

  function log(event, device, extra = {}) {
    if (!o.logFile) return;
    try {
      fs.mkdirSync(path.dirname(o.logFile), { recursive: true, mode: 0o700 });
      // start/result/device only: never the URL, the code or anything the pty printed
      fs.appendFileSync(o.logFile, JSON.stringify({ at: new Date(now()).toISOString(), event, device: C.cleanLine(device, 40), ...extra }) + '\n', { mode: 0o600 });
    } catch { /* best effort */ }
  }

  function finish(pub, r, ok, extra = {}) {
    if (r.done) return;
    r.done = true;
    clearTimeout(r.timer);
    clearTimeout(r.wait);
    if (relays.get(pub) === r) relays.delete(pub);
    log('result', r.deviceName, { ok, ...(extra.reason ? { reason: extra.reason } : {}) });
    r.reply({ t: 'login-result', ok, ...extra });
  }
  const kill = (r) => { try { r.pty?.kill(); } catch { /* gone */ } };

  function sendUrl(r, url, prompt) {
    if (r.urlSent || r.done) return;
    r.urlSent = true;
    clearTimeout(r.wait);
    r.reply({ t: 'login-url', url, prompt });
  }

  function start({ device, id, account, reply }) {
    const pub = device.pub;
    if (relays.has(pub)) return reply({ t: 'login-result', ok: false, reason: 'busy' });   // one relay per device
    const acc = o.accounts().find((a) => a.id === account);
    if (!acc) return reply({ t: 'login-result', ok: false, reason: 'unknown-account' });
    if (o.localBusy?.(acc.id)) return reply({ t: 'login-result', ok: false, reason: 'busy' });   // a local login is never killed
    const r = { id, account: acc.id, deviceName: device.name || '?', pty: null, buf: '', urlSent: false, codeWritten: false, done: false, timer: null, wait: null, reply };
    relays.set(pub, r);
    log('start', r.deviceName);
    try { r.pty = o.spawn(acc, id, pub); } catch { return finish(pub, r, false, { reason: 'failed' }); }
    o.notice?.(r.deviceName, acc.label);
    r.timer = setTimeout(() => { kill(r); finish(pub, r, false, { reason: 'timeout' }); }, timeoutMs);
    r.timer.unref?.();
    r.pty.onData((d) => {
      if (r.done || r.urlSent) return;
      r.buf = (r.buf + C.stripAnsi(d)).slice(-BUF_MAX);
      const { url, prompt } = C.parseLoginOutput(r.buf);
      if (!url) return;
      if (prompt) return sendUrl(r, url, prompt);
      // the URL is there; give the code prompt a moment to follow
      if (!r.wait) { r.wait = setTimeout(() => { const p = C.parseLoginOutput(r.buf); sendUrl(r, p.url || url, p.prompt); }, promptWaitMs); r.wait.unref?.(); }
    });
    r.pty.onExit(() => {
      if (r.done) return;
      Promise.resolve().then(() => o.checkAuth(acc)).then(
        (a) => finish(pub, r, Boolean(a?.ok) && r.codeWritten, a?.ok && r.codeWritten ? (a.email ? { email: a.email } : {}) : { reason: 'failed' }),
        () => finish(pub, r, false, { reason: 'failed' }));
    });
  }

  function code({ device, id, code: c }) {
    const r = relays.get(device.pub);
    if (!r || r.id !== id || r.done || !r.urlSent || r.codeWritten || !C.loginCodeOk(c)) return;
    r.codeWritten = true;   // typed once; not kept
    try { r.pty.write(`${c}\r`); } catch { /* exit handler reports */ }
  }

  function cancel({ device, id }) {
    const r = relays.get(device.pub);
    if (!r || (id != null && r.id !== id)) return;
    kill(r);
    finish(device.pub, r, false, { reason: id == null ? 'offline' : 'cancelled' });
  }

  return {
    attach(link) {
      link.on('login-start', start);
      link.on('login-code', code);
      link.on('login-cancel', cancel);
    },
    start, code, cancel,
    active: () => relays.size,
    destroy() { for (const [pub, r] of [...relays]) { kill(r); finish(pub, r, false, { reason: 'cancelled' }); } },
  };
}

module.exports = { createLoginRelay };
