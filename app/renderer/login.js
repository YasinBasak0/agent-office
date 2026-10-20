// Account login overlay: a panel centered over the app, with an xterm attached to the `login:<accountId>` pty
// (main runs `claude auth login` there). Closes itself if the account is 'in' when the pty exits.
import { mountTerminal } from './terminal.js';
import { onLang, t } from './i18n.js';

// Strings live in locales/*.json (under "login"), read on every use: t('login.key').

const CLOSE_AFTER = 1500; // close delay after success
const AUTH_WAIT = 6000; // how long to wait for main's login check after exit

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

export function mountLogin(parent, { getTheme = () => ({}), onClose = () => {} } = {}) {
  let accounts = [];
  let cur = null; // { id, ptyId, root, title, label, x, hint, status, statusText, retry, term, exited, code, updated, timers }

  // text: function that produces the text (called again when the language changes)
  function setStatus(text, kind = '') {
    if (!cur) return;
    cur.statusText = text;
    cur.status.textContent = (text && text()) || '';
    cur.status.className = 'lo-status' + (kind ? ' ' + kind : '');
  }

  function clearTimers(c) {
    for (const id of c.timers) clearTimeout(id);
    c.timers = [];
  }

  /** After the pty exits, check the account's state: 'in' → close, otherwise "Tekrar dene". */
  function evaluate(force = false) {
    const c = cur;
    if (!c || !c.exited || c.closing || c.code == null) return;
    const auth = accounts.find((a) => a.id === c.id)?.auth;
    const code = c.code;
    const done = () => (code === 0 ? t('login.done') : t('login.exitCode', { code }));
    // Antigravity (v3.24): its state may not be readable, so a clean exit of agy counts as done
    const extDone = c.ext && code === 0;
    if (extDone || auth?.state === 'in') {
      c.closing = true;
      clearTimers(c);
      c.retry.hidden = true;
      setStatus(() => (extDone ? done() : `${done()} · ${auth?.email || t('login.loggedIn')}`), 'ok');
      c.timers.push(setTimeout(() => { if (cur === c) close(); }, CLOSE_AFTER));
      return;
    }
    if (!force && (!c.updated || auth?.state === 'checking')) return; // wait for main's check
    clearTimers(c);
    const why = () => (auth?.state === 'error' && auth.error ? ` · ${auth.error}` : t('login.notLoggedIn'));
    setStatus(() => done() + why(), 'err');
    c.retry.hidden = false;
  }

  function start() {
    const c = cur;
    if (!c) return;
    clearTimers(c);
    Object.assign(c, { exited: false, code: null, updated: false, closing: false });
    c.retry.hidden = true;
    setStatus(() => t('login.starting'));
    c.term.reset(); // size is reported again with the first data
    requestAnimationFrame(() => { c.term.fit(); c.term.focus(); });
    (c.ext ? c.ext.start() : window.agentOffice.accounts.login(c.id)).then(
      () => { if (cur === c && !c.exited) setStatus(() => t('login.inProgress')); },
      (e) => {
        if (cur !== c) return;
        c.exited = true;
        setStatus(() => t('login.failedToStart', { error: e?.message || e }), 'err');
        c.retry.hidden = false;
      },
    );
  }

  /**
   * @param {{ id: string, label: string }} account
   * @param {{ start: () => Promise<unknown>, hint: () => string, title?: () => string }} [ext] a login that is not a Claude account's
   *   (Antigravity, v3.24): how its pty starts and the hint above the terminal.
   */
  function open(account, ext) {
    if (!account) return;
    if (cur?.id === account.id && cur.term) return cur.term.focus();
    close();
    const root = h('div', 'login-overlay');
    root.id = 'login-overlay';
    const panel = h('div', 'lo-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const head = h('div', 'lo-head');
    const title = h('span', 'lo-title');
    const x = h('button', 'lo-x', '×');
    x.title = t('login.close');
    x.addEventListener('click', () => close());
    head.append(title, x);
    const hintEl = h('p', 'lo-hint', ext ? ext.hint() : t('login.hint'));
    const host = h('div', 'term-host lo-term');
    const foot = h('div', 'lo-foot');
    const status = h('span', 'lo-status');
    const retry = h('button', 'lo-retry', t('login.retry'));
    retry.hidden = true;
    retry.addEventListener('click', () => start());
    foot.append(status, retry);
    panel.append(head, hintEl, host, foot);
    root.append(panel);
    parent.append(root);

    const ptyId = `login:${account.id}`;
    const term = mountTerminal(host, { projectId: ptyId, theme: getTheme(), restartable: false });
    cur = { id: account.id, ptyId, root, title, x, hint: hintEl, status, retry, term, timers: [], ext };
    setLabel(account.label);
    start();
  }

  function setLabel(label) {
    if (!cur) return;
    cur.label = label;
    cur.title.textContent = cur.ext?.title ? cur.ext.title() : t('login.title', { label });
  }

  function close() {
    const c = cur;
    if (!c) return;
    cur = null;
    clearTimers(c);
    // Login closed midway: stop the pty (Ctrl+C) so the next "Giriş yap" starts clean.
    if (c.remote) {
      // a relay still running on the other machine is cancelled there (its claude auth login is stopped)
      if (c.remote.loginId && !c.remote.finished) c.remote.api.link?.loginCancel?.(c.remote.loginId);
    } else {
      if (!c.exited) { try { window.agentOffice.pty.write(c.ptyId, '\x03'); } catch {} }
      c.term.destroy();
    }
    c.root.remove();
    onClose();
  }

  /**
   * v3.34 remote mode: an existing account of another machine signs in there (`claude auth login` runs on that
   * machine). No terminal: Open (the sign-in page opens in this machine's browser), a code field and Send. The URL and
   * the code never reach this page's state beyond the input box; only the page's host is shown.
   * @param {{ api: any, device: { id: string, name: string }, account: { id: string, label: string }, view: () => any }} o
   */
  function openRemote({ api, device, account, view }) {
    close();
    const root = h('div', 'login-overlay');
    root.id = 'login-overlay';
    const panel = h('div', 'lo-panel lo-remote');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const head = h('div', 'lo-head');
    const title = h('span', 'lo-title');
    const x = h('button', 'lo-x', '×');
    x.title = t('login.close');
    x.addEventListener('click', () => close());
    head.append(title, x);
    const hintEl = h('p', 'lo-hint');
    const openBtn = h('button', 'lo-retry lo-open', t('login.remoteOpen'));
    const form = h('form', 'lo-code');
    const input = /** @type {HTMLInputElement} */ (h('input', 'lo-code-input'));
    Object.assign(input, { name: 'code', autocomplete: 'off', spellcheck: false, maxLength: 700, placeholder: t('login.remoteCode') });
    const sendBtn = h('button', 'lo-retry', t('login.remoteSend'));
    sendBtn.setAttribute('type', 'submit');
    form.append(input, sendBtn);
    const foot = h('div', 'lo-foot');
    const status = h('span', 'lo-status');
    const retry = h('button', 'lo-retry', t('login.retry'));
    retry.hidden = true;
    foot.append(status, retry);
    panel.append(head, hintEl, openBtn, form, foot);
    root.append(panel);
    parent.append(root);
    const remote = { api, device, account, view, loginId: null, finished: false, openBtn, form, input, sendBtn };
    const ext = { hint: () => t('login.remoteHint', { device: device.name }), title: () => t('login.remoteTitle', { label: account.label, device: device.name }) };
    cur = { id: `remote:${device.id}:${account.id}`, ptyId: null, root, title, x, hint: hintEl, status, retry, term: null, timers: [], ext, remote };
    hintEl.textContent = ext.hint();
    setLabel(account.label);
    openBtn.addEventListener('click', () => { if (remote.loginId) api.link?.loginOpen?.(remote.loginId); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = input.value.trim();
      if (!remote.loginId || !code) return;
      api.link?.loginCode?.(remote.loginId, code).then((/** @type {any} */ r) => {
        if (cur?.remote !== remote) return;
        if (r?.ok) { input.value = ''; updateRemote(); } else if (r?.reason === 'bad-code') setStatus(() => t('login.remoteBadCode'), 'err');
      });
    });
    const begin = () => {
      Object.assign(remote, { loginId: null, finished: false });
      retry.hidden = true;
      setStatus(() => t('login.remoteStarting', { device: device.name }));
      api.link?.loginStart?.(device.id, account.id).then((/** @type {any} */ r) => {
        if (cur?.remote !== remote) { if (r?.ok) api.link?.loginCancel?.(r.id); return; }
        if (r?.ok) { remote.loginId = r.id; updateRemote(); } else fail(r?.reason || 'failed');
      });
    };
    const fail = (/** @type {string} */ reason) => {
      remote.finished = true;
      const why = () => t(`login.reason.${reason}`, { device: device.name });
      setStatus(() => t('login.remoteFailed', { reason: why() }), 'err');
      retry.hidden = false;
      updateButtons();
    };
    remote.fail = fail;
    retry.addEventListener('click', begin);
    updateButtons();
    begin();
    requestAnimationFrame(() => input.focus());
  }
  function updateButtons() {
    const r = cur?.remote;
    if (!r) return;
    const rec = r.loginId ? (r.view()?.logins || []).find((/** @type {any} */ l) => l.id === r.loginId) : null;
    r.openBtn.disabled = rec?.status !== 'waiting';
    r.sendBtn.disabled = rec?.status !== 'waiting';
    r.input.disabled = rec?.status !== 'waiting';
  }
  /** The LinkView changed: follow the relay's state (starting → waiting → sent → ok | failed). */
  function updateRemote() {
    const c = cur;
    const r = c?.remote;
    if (!r || !r.loginId || r.finished) return updateButtons();
    const rec = (r.view()?.logins || []).find((/** @type {any} */ l) => l.id === r.loginId);
    if (!rec) return;
    const device = r.device.name;
    if (rec.status === 'waiting') setStatus(() => t('login.remoteWaiting', { host: rec.host || '' }));
    else if (rec.status === 'sent') setStatus(() => t('login.remoteSent', { device }));
    else if (rec.status === 'ok') {
      r.finished = true;
      setStatus(() => `${t('login.remoteOk', { device })}${rec.email ? ` · ${rec.email}` : ''}`, 'ok');
      c.timers.push(setTimeout(() => { if (cur === c) close(); }, CLOSE_AFTER));
    } else if (rec.status === 'failed') r.fail(rec.reason || 'failed');
    updateButtons();
  }

  window.addEventListener('keydown', (e) => {
    if (!cur || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }, true);

  // the open overlay's strings are refreshed when the language changes
  onLang(() => {
    if (!cur) return;
    cur.x.title = t('login.close');
    cur.hint.textContent = cur.ext ? cur.ext.hint() : t('login.hint');
    cur.retry.textContent = t('login.retry');
    if (cur.remote) { cur.remote.openBtn.textContent = t('login.remoteOpen'); cur.remote.sendBtn.textContent = t('login.remoteSend'); cur.remote.input.placeholder = t('login.remoteCode'); }
    cur.title.textContent = cur.ext?.title ? cur.ext.title() : t('login.title', { label: cur.label });
    cur.status.textContent = (cur.statusText && cur.statusText()) || '';
  });

  return {
    open,
    openRemote,
    updateRemote,
    close,
    isOpen: () => !!cur,
    focus() { if (cur?.remote) cur.remote.input.focus(); else cur?.term?.focus(); },
    /** pty data: only the open overlay's id gets through, the rest is dropped. */
    write(ptyId, d) { if (cur?.ptyId === ptyId) cur.term.write(d); },
    exit(ptyId, code) {
      const c = cur;
      if (!c || c.ptyId !== ptyId) return;
      c.term.exit();
      c.exited = true;
      c.code = Number.isFinite(code) ? code : 0;
      const n = c.code;
      setStatus(() => `${n === 0 ? t('login.done') : t('login.exitCode', { code: n })} · ${t('login.checking')}`);
      c.timers.push(setTimeout(() => evaluate(true), AUTH_WAIT));
      evaluate();
    },
    setAccounts(list) {
      accounts = list || [];
      if (!cur) return;
      const a = accounts.find((x) => x.id === cur.id);
      if (!a) { if (!cur.ext) close(); return; } // account was removed (an external login is not in the list)
      setLabel(a.label);
      if (cur.exited) { cur.updated = true; evaluate(); }
    },
    setTheme(t) { cur?.term?.setTheme(t); },
  };
}
