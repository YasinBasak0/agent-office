// Machines panel (contract v3.32): one card per machine, this one first, from the LinkView of v3.28 with the v3.31
// capabilities and the v3.32 `res` / `catalog` data. Display only, plus the existing actions: Move ▸ (the v3.29
// handoff, local projects) and a prompt to a remote running Claude Code project (the v3.28 command).
// mountMachines(el, { api, view, anchor }) → { show(), hide(), toggle(), shown(), render() }
import { onLang, t, locale } from './i18n.js';

/** @param {string} tag @param {Record<string, any>} [attrs] @param {...any} children @returns {HTMLElement} */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

/** 17179869184 → "16 GB" (one decimal under 10). @param {number} n */
export function fmtBytes(n) {
  const gb = (Number(n) || 0) / 2 ** 30;
  return `${gb.toLocaleString(locale(), { maximumFractionDigits: gb < 10 ? 1 : 0 })} GB`;
}

/**
 * The machines to draw: this one first, then the paired devices (online first).
 * @param {any} view LinkView @returns {any[]}
 */
export function machinesOf(view) {
  const self = view?.self || {};
  const list = [{ self: true, id: 'self', name: view?.name || '', online: true, app: self.app || '', res: self.res || null, catalog: self.catalog || [], v: null, caps: [] }];
  const devs = [...(view?.devices || [])].sort((a, b) => Number(b.online) - Number(a.online));
  for (const d of devs) list.push({ ...d, self: false });
  return list;
}

/**
 * @param {HTMLElement} el the #machines-panel aside
 * @param {{ api: any, view: () => any, anchor?: HTMLElement, onClose?: () => void }} o
 */
export function mountMachines(el, { api, view, anchor, onClose }) {
  el.classList.add('agent-panel', 'machines-panel');
  el.tabIndex = -1;
  el.setAttribute('role', 'dialog');
  el.hidden = true;
  const drafts = new Map(); // "<device>/<project>" → unsent text

  function place() {
    if (!anchor || el.hidden) return;
    const host = el.offsetParent;
    if (!host) return;
    const a = anchor.getBoundingClientRect();
    const b = host.getBoundingClientRect();
    el.style.top = `${Math.round(a.top - b.top + 2)}px`;
    el.style.height = `${Math.max(120, Math.round(a.height - 4))}px`;
    el.style.left = `${Math.round(a.left - b.left + 2)}px`;
  }
  if (anchor && typeof ResizeObserver !== 'undefined') new ResizeObserver(place).observe(anchor);

  /** @param {any} m @param {string} selfApp */
  function stats(m, selfApp) {
    const r = m.res;
    if (!m.self && m.online && m.v === 1) return h('div', { class: 'mc-note warn' }, t('machines.update', { device: m.name }));
    if (!r) return h('div', { class: 'mc-note' }, t(m.online ? 'machines.noRes' : 'machines.offline'));
    const used = Math.max(0, r.mem.total - r.mem.free);
    const pct = r.mem.total ? Math.round((used / r.mem.total) * 100) : 0;
    const versionOff = !m.self && r.app && selfApp && r.app !== selfApp;
    return h('div', { class: 'mc-stats' },
      h('div', { class: 'mc-row' },
        h('span', { class: 'mc-label' }, t('machines.ram')),
        h('span', { class: 'up-bar mc-bar' }, h('span', { style: `width:${pct}%` })),
        h('span', { class: 'mc-num mono', title: r.platform === 'darwin' ? t('machines.freeApprox') : '' },
          t(r.platform === 'darwin' ? 'machines.freeOfApprox' : 'machines.freeOf', { free: fmtBytes(r.mem.free), total: fmtBytes(r.mem.total) }))),
      h('div', { class: 'mc-row' },
        h('span', { class: 'mc-label' }, t('machines.load')),
        h('span', { class: 'mc-num mono' }, t('machines.loadOf', { load: r.load1.toLocaleString(locale(), { maximumFractionDigits: 1 }), cpus: r.cpus }))),
      h('div', { class: 'mc-row mc-sub' }, t('machines.counts', { tabs: r.tabs, agents: r.agents, sleeping: r.sleeping })),
      r.app ? h('div', { class: `mc-row mc-sub${versionOff ? ' mc-amber' : ''}`, title: versionOff ? t('machines.versionDiffers', { app: selfApp }) : '' }, t('machines.version', { app: r.app })) : null);
  }

  /** @param {any} m @param {any[]} devices */
  function projects(m, devices) {
    if (!m.self && !m.online) return null;
    if (!m.self && m.v === 1) return null;
    if (!m.self && !m.catalog) return h('div', { class: 'mc-note' }, t('machines.notShared', { device: m.name }));
    const list = m.catalog;
    if (!list.length) return h('div', { class: 'mc-note' }, t('machines.noProjects'));
    const remoteSnap = m.self ? null : (view().remotes || []).find((/** @type {any} */ r) => r.device === m.id);
    const targets = devices.filter((d) => d.online && d.v !== 1);
    return h('ul', { class: 'mc-projects' }, list.map((/** @type {any} */ p) => {
      const key = `${m.id}/${p.id}`;
      const live = remoteSnap?.projects.find((/** @type {any} */ x) => x.id === p.id);
      const canPrompt = !m.self && p.state === 'running' && p.engine === 'claude' && live;
      return h('li', { class: `mc-proj st-${p.state}` },
        h('div', { class: 'mc-proj-top' },
          h('span', { class: 'mc-dot', title: t(`machines.state.${p.state}`) }),
          h('span', { class: 'mc-name' }, p.dirName),
          h('span', { class: 'mc-sub' }, [t(`machines.state.${p.state}`), p.engine !== 'claude' ? p.engine : '', p.accountLabel].filter(Boolean).join(' · '))),
        m.self && p.engine === 'claude' && targets.length
          ? h('div', { class: 'mc-actions' }, h('span', { class: 'mc-sub' }, t('machines.move')),
            targets.map((d) => h('button', { class: 'sb-x mc-move', title: t('machines.moveTo', { project: p.dirName, device: d.name }), onclick: () => api.link?.handOff?.(p.id, d.id) }, `▸ ${d.name}`)))
          : null,
        manageButtons(m, p),
        canPrompt
          ? h('form', { class: 'sb-rcmd', onsubmit: (/** @type {Event} */ e) => {
            e.preventDefault();
            const input = /** @type {HTMLInputElement} */ (/** @type {HTMLFormElement} */ (e.target).elements.namedItem('text'));
            if (!input.value.trim()) return;
            drafts.delete(key);
            api.link?.send(m.id, p.id, input.value);
            input.value = '';
          } },
          h('input', { name: 'text', maxlength: 8192, placeholder: t('devices.prompt', { project: p.dirName }), value: drafts.get(key) || '', oninput: (/** @type {Event} */ e) => drafts.set(key, /** @type {HTMLInputElement} */ (e.target).value) }),
          h('button', { class: 'sb-x', type: 'submit' }, t('devices.send')))
          : null);
    }));
  }

  // v3.33 Start / Wake / Sleep / Stop on a remote device that allows us to manage its projects (cap 'manage')
  const OPS = { stopped: ['start'], asleep: ['wake', 'stop'], running: ['sleep', 'stop'] };
  function manageButtons(/** @type {any} */ m, /** @type {any} */ p) {
    if (m.self || !m.online || !m.caps?.includes('manage') || !m.catalog) return null;
    const ops = (/** @type {Record<string, string[]>} */ (OPS))[p.state] || [];
    const st = view().projOps?.[`${m.id}/${p.id}`];
    const note = !st ? '' : st.state === 'sent' ? t('machines.opSent', { op: t(`machines.op.${st.op}`) })
      : st.state === 'failed' ? t('machines.opFailed', { op: t(`machines.op.${st.op}`), reason: st.reason || '?' }) : '';
    return h('div', { class: 'mc-actions mc-ops' },
      ops.map((op) => h('button', { class: 'sb-x mc-op', title: t('machines.opTitle', { op: t(`machines.op.${op}`), project: p.dirName, device: m.name }), disabled: st?.state === 'sent', onclick: () => api.link?.projOp?.(m.id, p.id, op) }, t(`machines.op.${op}`))),
      note ? h('span', { class: `mc-sub${st.state === 'failed' ? ' mc-amber' : ''}` }, note) : null);
  }

  function render() {
    if (el.hidden) return;
    const focused = /** @type {HTMLInputElement | null} */ (document.activeElement);
    if (focused && el.contains(focused) && focused.name === 'text') return;   // keep typed text across live updates
    const v = view();
    const ms = machinesOf(v);
    const selfApp = v?.self?.app || '';
    const devices = ms.filter((m) => !m.self);
    el.replaceChildren(
      h('div', { class: 'ap-head' },
        h('span', { class: 'ap-title' }, t('machines.title')),
        h('button', { class: 'ap-close', title: t('machines.close'), onclick: hide }, '×')),
      h('div', { class: 'mc-list' }, ms.map((m) => h('section', { class: `mc-card${m.online ? ' online' : ''}${m.self ? ' self' : ''}` },
        h('div', { class: 'mc-head' },
          h('span', { class: 'sb-adot mc-online', title: t(m.online ? 'devices.online' : 'devices.offline') }),
          h('span', { class: 'mc-title' }, m.name || '?'),
          m.self ? h('span', { class: 'mc-sub' }, t('machines.thisMachine')) : null),
        stats(m, selfApp),
        projects(m, devices)))),
      ...(devices.length ? [] : [h('div', { class: 'mc-note' }, t('machines.none'))]));   // replaceChildren would print a null
    place();
  }
  function show() { el.hidden = false; render(); place(); }
  function hide() { if (el.hidden) return; el.hidden = true; onClose?.(); }
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.hidden) { e.stopPropagation(); hide(); } }, true);
  el.addEventListener('mouseup', (e) => e.stopPropagation());
  onLang(render);
  return { show, hide, toggle: () => (el.hidden ? show() : hide()), shown: () => !el.hidden, render };
}
