// Token usage of one project (contract v3.13): a panel over the office's left side, opened from the project's row.
// mountUsagePanel(el, { load, anchor }) → { show(project), hide(), shownId(), refresh() }
// - load(projectId) → TokenReport (main's src/token-usage.js summarize) | null; re-read every 15 s while open.
// - with anchor, the panel covers that element's height (the office canvas), like the agent panel.
// - report.agents / report.prefix (contract v3.21): the costliest sub-agent runs and the fixed prefix, in two
//   collapsible sections (their open state is kept while the app runs).
import { onLang, t, locale } from './i18n.js';

const REFRESH_MS = 15000;
const PERIODS = ['today', 'week', 'all'];
const KINDS = ['output', 'input', 'write', 'read']; // write = 5 min + 1 h cache writes

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 1234 → "1.2K", 5.6e6 → "5.6M", 1.36e9 → "1.36B". */
export function fmtTokens(n) {
  const v = Number(n) || 0;
  const f = (x, d) => x.toLocaleString(locale(), { maximumFractionDigits: d, minimumFractionDigits: 0 });
  if (v >= 1e9) return `${f(v / 1e9, 2)}B`;
  if (v >= 1e6) return `${f(v / 1e6, 1)}M`;
  if (v >= 1e3) return `${f(v / 1e3, 1)}K`;
  return f(v, 0);
}
/** $ estimate: two decimals under $10, none above. */
export function fmtUsd(n) {
  const v = Number(n) || 0;
  return `$${v.toLocaleString(locale(), { maximumFractionDigits: v < 10 ? 2 : 0, minimumFractionDigits: v < 10 && v > 0 ? 2 : 0 })}`;
}
const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);
const fmtPct = (p) => (p > 0 && p < 0.1
  ? `<${(0.001).toLocaleString(locale(), { style: 'percent', maximumFractionDigits: 1 })}`
  : (p / 100).toLocaleString(locale(), { style: 'percent', maximumFractionDigits: p < 10 ? 1 : 0 }));
const hh = (at) => String(new Date(at).getHours()).padStart(2, '0');

/**
 * @param {HTMLElement} el
 * @param {{ load: (projectId: string) => Promise<any>, anchor?: HTMLElement, onClose?: () => void }} opts
 */
export function mountUsagePanel(el, { load, anchor, onClose }) {
  let project = null; // { id, name }
  let report = null;
  let period = 'today';
  let timer = 0;
  let seq = 0;
  let failed = false;
  const folds = { agents: true, prefix: true }; // collapsible sections: open?

  el.classList.add('agent-panel', 'usage-panel');
  el.tabIndex = -1;
  el.setAttribute('role', 'dialog');
  el.hidden = true;
  el.addEventListener('mouseup', (e) => e.stopPropagation());

  let ro = null;
  function place() {
    if (!anchor || el.hidden) return;
    const host = el.offsetParent;
    if (!host) return;
    const a = anchor.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    el.style.top = `${Math.round(a.top - h.top + 2)}px`;
    el.style.height = `${Math.max(120, Math.round(a.height - 4))}px`;
    el.style.left = `${Math.round(a.left - h.left + 2)}px`;
  }
  if (anchor && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(place);
    ro.observe(anchor);
  }

  async function refresh() {
    if (!project) return;
    const my = ++seq;
    try {
      const r = await load(project.id);
      if (my !== seq || !project) return;
      report = r;
      failed = false;
    } catch (e) {
      console.error('token usage:', e);
      if (my === seq) failed = true;
    }
    render();
  }

  function bar(share, cls = '') {
    return `<span class="up-bar ${cls}"><span style="width:${Math.max(0, Math.min(100, share))}%"></span></span>`;
  }

  function kindRows(tot) {
    const tk = tot.tokens;
    const c = tot.cost;
    const rows = {
      output: { tokens: tk.output, usd: c.output },
      input: { tokens: tk.input, usd: c.input },
      write: { tokens: tk.write5m + tk.write1h, usd: c.write5m + c.write1h,
        sub: tk.write1h ? t('usage.writeSplit', { m5: fmtTokens(tk.write5m), h1: fmtTokens(tk.write1h) }) : '' },
      read: { tokens: tk.read, usd: c.read },
    };
    return KINDS.map((k) => {
      const r = rows[k];
      const share = pct(r.tokens, tot.total);
      const costShare = pct(r.usd, tot.usd);
      return `<li class="up-row" data-kind="${k}" title="${esc(t(`usage.kindTitle.${k}`))}">
        <span class="up-name">${esc(t(`usage.kind.${k}`))}</span>
        ${bar(share, 'tok')}
        <span class="up-num mono">${fmtTokens(r.tokens)}</span>
        <span class="up-share">${esc(t('usage.shares', { tok: fmtPct(share), cost: fmtPct(costShare) }))}</span>
        ${r.sub ? `<span class="up-sub">${esc(r.sub)}</span>` : ''}
      </li>`;
    }).join('');
  }

  function partRows(tot) {
    const parts = [['main', tot.main], ['sub', tot.sub]];
    return parts.map(([k, p]) => {
      const share = pct(p.usd, tot.usd);
      return `<li class="up-row" data-part="${k}">
        <span class="up-name">${esc(t(`usage.part.${k}`))}</span>
        ${bar(share, 'usd')}
        <span class="up-num mono">${fmtUsd(p.usd)}</span>
        <span class="up-share">${esc(t('usage.partShare', { pct: fmtPct(share), tokens: fmtTokens(p.total), n: p.requests }))}</span>
      </li>`;
    }).join('');
  }

  function modelRows(tot) {
    if (!tot.models.length) return `<li class="ap-empty">${esc(t('usage.none'))}</li>`;
    return tot.models.slice(0, 6).map((m) => {
      const share = pct(m.usd, tot.usd);
      return `<li class="up-row">
        <span class="up-name mono" title="${esc(m.model)}">${esc(m.model.replace(/^claude-/, ''))}</span>
        ${bar(share, 'usd')}
        <span class="up-num mono">${fmtUsd(m.usd)}</span>
        <span class="up-share">${esc(t('usage.modelShare', { pct: fmtPct(share), tokens: fmtTokens(m.total) }))}</span>
      </li>`;
    }).join('');
  }

  const shortDate = (at) => new Date(at).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  /** A collapsible section; `key` keeps its open state across re-renders. */
  function fold(key, label, inner) {
    return `<details class="ap-sec up-fold" data-fold="${key}"${folds[key] ? ' open' : ''}>
      <summary class="ap-label">${label}</summary>${inner}</details>`;
  }

  /** The costliest sub-agent runs of the period (contract v3.21). */
  function agentsSec(a) {
    if (!a) return '';
    if (!a.count) return fold('agents', esc(t('usage.agents.title')), `<div class="ap-empty">${esc(t('usage.agents.none'))}</div>`);
    const stats = `<div class="up-astats" title="${esc(t('usage.agents.longTitle', { n: a.long.limit }))}">
      ${esc(t('usage.agents.avgSteps', { steps: Math.round(a.avgSteps).toLocaleString(locale()), n: a.count }))}
      · ${esc(t('usage.agents.long', { n: a.long.limit, count: a.long.count, pct: fmtPct(a.long.share * 100) }))}</div>`;
    const rows = a.top.map((r) => {
      const tk = r.tokens;
      const label = r.label || r.agentType || r.id;
      const tip = [r.label, r.agentType, r.model].filter(Boolean).join(' · ');
      return `<li class="up-row up-agent">
        <span class="up-name" title="${esc(tip)}">${esc(label)}</span>
        <span class="up-num mono">${fmtUsd(r.usd)}</span>
        <span class="up-share">${esc(t('usage.agents.meta', { model: (r.model || '?').replace(/^claude-/, ''), steps: r.steps, tools: r.tools, date: shortDate(r.at) }))}</span>
        <span class="up-share mono">${esc(t('usage.agents.tokens', { read: fmtTokens(tk.read), write: fmtTokens(tk.write5m + tk.write1h), input: fmtTokens(tk.input), output: fmtTokens(tk.output) }))}</span>
      </li>`;
    }).join('');
    const label = `${esc(t('usage.agents.title'))} <span class="ap-dim">${esc(t('usage.agents.cost', { usd: fmtUsd(a.usd) }))}</span>`;
    return fold('agents', label, `${stats}<ul class="up-list">${rows}</ul>`);
  }

  /** The fixed prefix (system prompt + tools) and the share of cache reads it accounts for (contract v3.21). */
  function prefixSec(px) {
    if (!px) return '';
    if (!px.sessions) return fold('prefix', esc(t('usage.prefix.title')), `<div class="ap-empty">${esc(t('usage.none'))}</div>`);
    const row = (k, p) => (p.sessions ? `<li class="up-row" data-prefix="${k}">
        <span class="up-name">${esc(t(`usage.prefix.${k}`))}</span>
        ${bar(p.share * 100, 'tok')}
        <span class="up-num mono">${fmtTokens(p.avg)}</span>
        <span class="up-share">${esc(t('usage.prefix.share', { pct: fmtPct(p.share * 100), n: p.sessions, steps: p.requests }))}</span>
      </li>` : '');
    const head = `<div class="up-astats" title="${esc(t('usage.prefix.howTitle'))}">${esc(t('usage.prefix.summary', { tokens: fmtTokens(px.avg), pct: fmtPct(px.share * 100) }))}</div>`;
    return fold('prefix', esc(t('usage.prefix.title')), `${head}<ul class="up-list">${row('main', px.main)}${row('sub', px.sub)}</ul>
      <div class="ap-note up-note">${esc(t('usage.prefix.note'))}</div>`);
  }

  function chart(hours) {
    const maxT = Math.max(1, ...hours.map((x) => x.total));
    const maxU = Math.max(1e-9, ...hours.map((x) => x.usd));
    const cols = hours.map((x, i) => {
      const th = x.total ? Math.max(2, Math.round((x.total / maxT) * 100)) : 0;
      const uh = x.usd ? Math.max(2, Math.round((x.usd / maxU) * 100)) : 0;
      const tip = t('usage.hourTitle', { from: hh(x.at), to: hh(x.at + 3600e3), tokens: fmtTokens(x.total), usd: fmtUsd(x.usd) });
      const label = i % 6 === 0 || i === hours.length - 1 ? `<span class="up-tick">${hh(x.at)}</span>` : '';
      return `<div class="up-col" title="${esc(tip)}"><span class="up-t" style="height:${th}%"></span><span class="up-u" style="height:${uh}%"></span>${label}</div>`;
    }).join('');
    return `<div class="up-chart">${cols}</div>
      <div class="up-legend"><span><i class="up-key tok"></i>${esc(t('usage.legendTokens'))}</span><span><i class="up-key usd"></i>${esc(t('usage.legendCost'))}</span></div>`;
  }

  function sinceText(r) {
    const at = r.since ?? r.firstAt;
    if (!at) return '';
    const d = new Date(at).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
    return r.since ? t('usage.sinceAdded', { date: d }) : t('usage.sinceFirst', { date: d });
  }

  function render() {
    if (el.hidden || !project) return;
    el.setAttribute('aria-label', t('usage.title'));
    const head = `<div class="ap-head">
      <span class="ap-title">${esc(t('usage.title'))}</span>
      <span class="ap-proj">${esc(project.name)}</span>
      <button class="ap-close" data-close title="${esc(t('usage.close'))}">×</button>
    </div>`;
    const tabs = `<div class="up-periods" role="tablist">${PERIODS.map((p) =>
      `<button class="up-period${p === period ? ' on' : ''}" data-period="${p}" role="tab" aria-selected="${p === period}">${esc(t(`usage.period.${p}`))}</button>`).join('')}</div>`;
    let body;
    if (!report) {
      body = `<div class="ap-empty">${esc(failed ? t('usage.failed') : t('usage.loading'))}</div>`;
    } else {
      const tot = report[period];
      const fp = pct(tot.fpt, tot.total);
      const since = period === 'all' ? sinceText(report) : '';
      body = `
        <div class="up-total"><span class="up-big mono">${fmtTokens(tot.total)}</span> <span class="ap-dim">${esc(t('usage.tokens'))}</span>
          <span class="up-usd" title="${esc(t('usage.usdTitle'))}">≈ ${fmtUsd(tot.usd)}</span></div>
        <div class="up-fp" title="${esc(t('usage.fullPriceTitle'))}">${esc(t('usage.fullPrice', { tokens: fmtTokens(tot.fpt), pct: fmtPct(fp) }))}</div>
        ${since ? `<div class="ap-dim up-since">${esc(since)}</div>` : ''}
        <div class="ap-sec"><div class="ap-label">${esc(t('usage.byKind'))}</div><ul class="up-list">${kindRows(tot)}</ul></div>
        <div class="ap-sec"><div class="ap-label">${esc(t('usage.byPart'))}</div><ul class="up-list">${partRows(tot)}</ul></div>
        <div class="ap-sec"><div class="ap-label">${esc(t('usage.byModel'))}</div><ul class="up-list">${modelRows(tot)}</ul></div>
        ${agentsSec(report.agents?.[period])}
        ${prefixSec(report.prefix?.[period])}
        <div class="ap-sec"><div class="ap-label">${esc(t('usage.last24h'))}</div>${chart(report.hours)}</div>
        <div class="ap-note up-note">${esc(t('usage.noteRead'))}<br>${esc(t('usage.noteEstimate'))}</div>`;
    }
    const scroll = el.querySelector('.ap-body')?.scrollTop || 0;
    el.innerHTML = `${head}<div class="ap-body">${tabs}${body}</div>`;
    const b = el.querySelector('.ap-body');
    if (b) b.scrollTop = scroll;
  }

  // a collapsible section remembers whether it is open (the panel re-renders every 15 s)
  el.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d instanceof HTMLElement && d.tagName === 'DETAILS' && d.dataset.fold && d.dataset.fold in folds) folds[d.dataset.fold] = d.hasAttribute('open');
  }, true);

  el.addEventListener('click', (e) => {
    const b = /** @type {Element} */ (e.target).closest('button');
    if (!b || !el.contains(b)) return;
    if (b.hasAttribute('data-close')) return api.hide();
    if (b instanceof HTMLElement && b.dataset.period && PERIODS.includes(b.dataset.period)) {
      period = b.dataset.period;
      render();
    }
  });

  function onKey(e) {
    if (e.key !== 'Escape' || el.hidden) return;
    const a = document.activeElement;
    if (a && a !== el && !el.contains(a) && a.closest?.('.term-host, .xterm')) return;
    e.preventDefault();
    e.stopPropagation();
    api.hide();
  }
  window.addEventListener('keydown', onKey, true);
  onLang(() => render());

  const api = {
    /** Opens (or switches to) a project: { id, name }. Clicking the open project's line again closes it. */
    show(p) {
      if (!p) return api.hide();
      if (!el.hidden && project?.id === p.id) return api.hide();
      if (project?.id !== p.id) report = null;
      project = { id: p.id, name: p.name };
      el.hidden = false;
      place();
      render();
      refresh();
      clearInterval(timer);
      timer = setInterval(refresh, REFRESH_MS);
      el.focus({ preventScroll: true });
    },
    hide() {
      if (el.hidden) return;
      el.hidden = true;
      project = null;
      report = null;
      el.innerHTML = '';
      clearInterval(timer);
      timer = 0;
      try { onClose?.(); } catch (err) { console.error(err); }
    },
    shownId: () => project?.id ?? null,
    refresh,
  };
  return api;
}
