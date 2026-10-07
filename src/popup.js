/* GitHub Test Lens — action popup.
 * Classic script loaded after settings.js. Reads the active tab, asks its content script for the
 * page state (ghtl:get-state) and renders stats + controls. Everything is built with
 * createElement/textContent: no inline handlers, no innerHTML, no remote code.
 * Pure helpers are exported (GHTL.popup / module.exports); DOM work only runs in a document. */
(function (root) {
  'use strict';

  const GHTL = root.GHTL || (root.GHTL = {});

  const DIFF_KINDS = ['pr-files', 'pr-commit', 'commit', 'compare'];
  const FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'prod', label: 'Production' },
    { id: 'tests', label: 'Tests' },
  ];
  const KIND_LABELS = {
    'pr-files': 'Pull request · Files changed',
    'pr-commit': 'Pull request · Commit',
    pr: 'Pull request',
    commit: 'Commit',
    compare: 'Compare',
    tree: 'Repository tree',
    blob: 'File',
    search: 'Code search',
    'repo-root': 'Repository',
    other: '',
  };
  const SEG_KEYS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  const REFRESH_DELAY = 350; // ms; gives the content script time to reboot after a settings change
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Hollow triangle (evenodd) + exclamation mark, 16x16 grid.
  const WARN_ICON = ['M8 1 15.5 14.5H.5Zm0 3L3 13h10Z', 'M7.25 5.5h1.5v4h-1.5Zm.75 5.2a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z'];

  // ---- pure helpers -----------------------------------------------------------------------

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function fmt(n) {
    return num(n).toLocaleString();
  }

  function plural(n, one) {
    return n === 1 ? one : one + 's';
  }

  function clampPct(v) {
    return Math.max(0, Math.min(100, Math.round(num(v))));
  }

  /** Normalises one stats group ({ files, additions, deletions }); missing → zeros. */
  function group(g) {
    const o = g && typeof g === 'object' ? g : {};
    return { files: num(o.files), additions: num(o.additions), deletions: num(o.deletions) };
  }

  /** True for https://github.com/… and for any configured GitHub Enterprise origin. */
  function isGitHubUrl(url, gheHosts) {
    if (typeof url !== 'string') return false;
    let u;
    try { u = new URL(url); } catch (e) { return false; }
    if (u.protocol !== 'https:') return false;
    if (u.hostname === 'github.com') return true;
    return Array.isArray(gheHosts) && gheHosts.includes(u.origin.toLowerCase());
  }

  /** "owner/name" from a GitHub URL (original case) or ''. */
  function repoFromUrl(url) {
    try {
      const m = /^\/([^/]+)\/([^/]+)(?:\/|$)/.exec(new URL(url).pathname);
      return m ? m[1] + '/' + m[2] : '';
    } catch (e) { return ''; }
  }

  /** Files the content script hides for a filter. stats.support already includes bench;
   * ignored files (lockfiles, vendored, generated) are production containers. */
  function hiddenCount(stats, filter) {
    if (!stats) return 0;
    if (filter === 'prod') return group(stats.test).files + group(stats.support).files;
    if (filter === 'tests') return group(stats.prod).files + group(stats.ignored).files;
    return 0;
  }

  function hiddenText(stats, filter) {
    const n = hiddenCount(stats, filter);
    if (filter === 'prod') return fmt(n) + ' test ' + plural(n, 'file') + ' hidden';
    if (filter === 'tests') return fmt(n) + ' production ' + plural(n, 'file') + ' hidden';
    return '';
  }

  function shareText(stats) {
    if (!stats || stats.testShare == null) return 'No code lines changed';
    return clampPct(stats.testShare) + '% of changed lines are tests';
  }

  function hasDiff(page) {
    const s = page && page.stats;
    return !!s && (num(s.loaded) > 0 || num(s.totalFiles) > 0);
  }

  GHTL.popup = { DIFF_KINDS, FILTERS, KIND_LABELS, isGitHubUrl, repoFromUrl, hiddenCount, hiddenText, shareText, clampPct, hasDiff };
  if (typeof module !== 'undefined' && module.exports) module.exports = GHTL.popup;
  if (typeof document === 'undefined') return;

  // ---- DOM utilities ----------------------------------------------------------------------

  const state = {
    tab: null,
    onGitHub: false,
    settings: null,
    gheHosts: [],
    page: null, // last ghtl:get-state response
    timer: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function logErr(e) {
    if (root.console) root.console.debug('[ghtl] popup', e);
  }

  /** el(tag, props, children): props are attributes except `text` (textContent) and `class`.
   * Children: nodes or strings (strings become text nodes); null/false entries are skipped. */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach((k) => {
        const v = props[k];
        if (v == null || v === false) return;
        if (k === 'text') node.textContent = String(v);
        else if (k === 'class') node.className = v;
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach((c) => {
        if (c == null || c === false) return;
        node.append(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  function svgIcon(paths, size) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', String(size || 14));
    svg.setAttribute('height', String(size || 14));
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    paths.forEach((d) => {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill-rule', 'evenodd');
      svg.append(p);
    });
    return svg;
  }

  function announce(text) {
    const live = $('live');
    if (!live) return;
    live.textContent = '';
    setTimeout(() => { live.textContent = text; }, 30);
  }

  // ---- chrome glue ------------------------------------------------------------------------

  async function activeTab() {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) return null;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  }

  /** Sends to the active tab's content script; null when there is no receiver. */
  async function send(msg) {
    const tab = state.tab;
    if (!tab || typeof tab.id !== 'number') return null;
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.sendMessage) return null;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, msg);
      return res && typeof res === 'object' ? res : null;
    } catch (e) {
      logErr('no receiver for ' + msg.type + ': ' + (e && e.message));
      return null;
    }
  }

  // ---- views ------------------------------------------------------------------------------

  function message(title, hint) {
    return el('div', { class: 'msg' }, [
      el('p', { class: 'msg__title', text: title }),
      hint ? el('p', { class: 'msg__hint', text: hint }) : null,
    ]);
  }

  function viewOffGitHub() {
    return message('Not a GitHub page',
      'Open a pull request, commit or repository on github.com to see which files are tests. Enterprise hosts can be added in Options.');
  }

  function viewDisabled() {
    return message('Test Lens is off', 'Turn it on to mark test files and show pull request stats.');
  }

  function viewUnreachable() {
    return message('Reload the page to activate Test Lens',
      'This tab was loaded before the extension was installed or updated.');
  }

  function contextLine(page) {
    const parts = [];
    const repo = repoFromUrl(state.tab && state.tab.url) || page.repo || '';
    if (repo) parts.push(repo);
    const kind = KIND_LABELS[page.kind];
    if (kind) parts.push(kind);
    if (!parts.length) return null;
    return el('p', { class: 'ctx', text: parts.join(' · ') });
  }

  function lines(cls, sign, value, srLabel) {
    return el('span', { class: 'num ' + cls }, [
      el('span', { 'aria-hidden': 'true', text: sign }),
      fmt(value),
      el('span', { class: 'sr', text: ' ' + srLabel }),
    ]);
  }

  function tile(label, cat, g) {
    return el('li', { class: 'tile tile--' + cat }, [
      el('span', { class: 'tile__label', text: label }),
      el('span', { class: 'tile__files' }, [
        el('span', { class: 'tile__num', text: fmt(g.files) }),
        el('span', { class: 'tile__unit', text: plural(g.files, 'file') }),
      ]),
      el('span', { class: 'tile__lines' }, [
        lines('num--add', '+', g.additions, 'additions'),
        lines('num--del', '−', g.deletions, 'deletions'),
      ]),
    ]);
  }

  function shareLine(stats) {
    const p = el('p', { class: 'share' });
    const text = el('span', { class: 'share__text' });
    if (stats.testShare == null) {
      text.textContent = shareText(stats);
      p.append(text);
      return p;
    }
    const pct = clampPct(stats.testShare);
    text.append(el('strong', { text: pct + '%' }), ' of changed lines are tests');
    const t = group(stats.test);
    const s = group(stats.support);
    const testLines = t.additions + t.deletions + s.additions + s.deletions;
    p.title = fmt(testLines) + ' of ' + fmt(stats.codeLines) + ' changed code lines are in test, support or benchmark files';
    const fill = el('span', { class: 'meter__fill' });
    fill.style.width = pct + '%';
    p.append(text, el('span', { class: 'meter', 'aria-hidden': 'true' }, fill));
    return p;
  }

  function warningChip() {
    return el('p', { class: 'chip chip--warn', role: 'status' }, [
      svgIcon(WARN_ICON),
      el('span', { class: 'sr', text: 'Warning: ' }),
      'No test changes',
    ]);
  }

  function filterControl(page) {
    const current = FILTERS.some((f) => f.id === page.filter) ? page.filter : 'all';
    const seg = el('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': 'filter-label' });
    FILTERS.forEach((f) => {
      const on = f.id === current;
      const b = el('button', {
        type: 'button',
        role: 'radio',
        class: 'seg__btn',
        'data-filter': f.id,
        'aria-checked': String(on),
        tabindex: on ? '0' : '-1',
        text: f.label,
      });
      b.addEventListener('click', () => { setFilter(f.id).catch(logErr); });
      seg.append(b);
    });
    seg.addEventListener('keydown', onSegKeydown);
    return el('div', { class: 'field' }, [
      el('span', { class: 'field__label', id: 'filter-label', text: 'Show' }),
      seg,
    ]);
  }

  function collapseControl(page) {
    const input = el('input', { type: 'checkbox', id: 'collapse', class: 'check__input' });
    input.checked = page.collapse !== 'off';
    input.addEventListener('change', (ev) => { onCollapseChange(ev).catch(logErr); });
    return el('label', { class: 'check', for: 'collapse' }, [input, el('span', { text: 'Collapse test diffs' })]);
  }

  function viewDiff(page) {
    const s = page.stats;
    const nodes = [];
    const ctx = contextLine(page);
    if (ctx) nodes.push(ctx);
    nodes.push(el('ul', { class: 'stats', 'aria-label': 'Changed files by category' }, [
      tile('Production', 'prod', group(s.prod)),
      tile('Tests', 'test', group(s.test)),
      tile('Support', 'support', group(s.support)),
    ]));
    nodes.push(shareLine(s));
    if (s.warning) nodes.push(warningChip());
    const ignored = group(s.ignored).files;
    if (ignored > 0) {
      nodes.push(el('p', { class: 'muted', text: fmt(ignored) + ' other ' + plural(ignored, 'file') + ' not counted (lockfiles, vendored, generated)' }));
    }
    nodes.push(el('div', { class: 'controls' }, [
      filterControl(page),
      el('p', { class: 'note', 'data-role': 'hidden-note', text: hiddenText(s, page.filter) }),
      collapseControl(page),
    ]));
    return nodes;
  }

  function viewCount(page) {
    const nodes = [];
    const ctx = contextLine(page);
    if (ctx) nodes.push(ctx);
    if (DIFF_KINDS.includes(page.kind)) {
      nodes.push(message('No changed files found yet', 'If the diff is still loading, use Rescan.'));
      return nodes;
    }
    const c = page.counts || {};
    const n = num(c.files != null ? c.files : c.entries); // files = distinct paths; entries double-count repo rows
    const title = n > 0 ? fmt(n) + ' ' + plural(n, 'file') + ' marked on this page' : 'No files marked on this page';
    const hint = page.kind === 'pr' ? 'Open the Files changed tab to see test vs. production stats.' : null;
    nodes.push(message(title, hint));
    return nodes;
  }

  function viewPage(page) {
    return hasDiff(page) ? viewDiff(page) : viewCount(page);
  }

  function render(nodes) {
    const content = $('content');
    if (!content) return;
    content.replaceChildren();
    (Array.isArray(nodes) ? nodes : [nodes]).forEach((n) => { if (n) content.append(n); });
    content.removeAttribute('aria-busy');
  }

  /** Updates filter buttons, hidden-files note and collapse box in place (keeps focus). */
  function syncControls() {
    const page = state.page;
    const content = $('content');
    if (!page || !content) return;
    content.querySelectorAll('.seg__btn').forEach((b) => {
      const on = b.getAttribute('data-filter') === page.filter;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    const note = content.querySelector('[data-role="hidden-note"]');
    if (note) note.textContent = hiddenText(page.stats, page.filter);
    const cb = $('collapse');
    if (cb) cb.checked = page.collapse !== 'off';
  }

  function syncSwitch(enabled) {
    const input = $('enabled');
    if (input) input.checked = !!enabled;
    const text = $('enabled-text');
    if (text) text.textContent = enabled ? 'On' : 'Off';
  }

  // ---- actions ----------------------------------------------------------------------------

  function onSegKeydown(ev) {
    const delta = Object.prototype.hasOwnProperty.call(SEG_KEYS, ev.key) ? SEG_KEYS[ev.key] : 0;
    const btns = Array.from(ev.currentTarget.querySelectorAll('.seg__btn'));
    const idx = btns.indexOf(document.activeElement);
    if (idx < 0) return;
    let next;
    if (delta) next = (idx + delta + btns.length) % btns.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = btns.length - 1;
    else return;
    ev.preventDefault();
    btns[next].focus();
    btns[next].click();
  }

  async function setFilter(filter) {
    if (!state.page) return;
    const res = await send({ type: 'ghtl:set-filter', filter });
    if (!res || !res.ok) { await refresh(); return; }
    const applied = FILTERS.some((f) => f.id === res.filter) ? res.filter : 'all';
    state.page.filter = applied;
    if (typeof res.collapse === 'string') state.page.collapse = res.collapse;
    syncControls();
    if (applied !== filter) announce('Nothing to show for this filter');
    else announce(hiddenText(state.page.stats, applied) || 'Showing all files');
  }

  async function onCollapseChange(ev) {
    const cb = ev.currentTarget;
    if (!state.page) return;
    const auto = state.settings ? state.settings.autoCollapse : 'off';
    const collapse = cb.checked ? (auto && auto !== 'off' ? auto : 'all-tests') : 'off';
    const res = await send({ type: 'ghtl:set-collapse', collapse });
    if (!res || !res.ok) { await refresh(); return; }
    state.page.collapse = typeof res.collapse === 'string' ? res.collapse : collapse;
    if (typeof res.filter === 'string') state.page.filter = res.filter;
    syncControls();
    announce(state.page.collapse !== 'off' ? 'Test diffs collapsed' : 'Test diffs expanded');
  }

  async function onEnabledChange(ev) {
    const enabled = !!ev.currentTarget.checked;
    syncSwitch(enabled);
    if (state.settings) state.settings.enabled = enabled;
    try {
      await GHTL.settings.save({ settings: { enabled } });
    } catch (e) {
      logErr(e);
    }
    // The content script reboots on the storage change; give it a moment before asking again.
    scheduleRefresh(enabled ? REFRESH_DELAY : 0);
  }

  function openOptions() {
    try {
      Promise.resolve(chrome.runtime.openOptionsPage()).then(() => root.close()).catch(logErr);
    } catch (e) {
      logErr(e);
    }
  }

  function openShortcuts() {
    try {
      Promise.resolve(chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })).then(() => root.close()).catch(logErr);
    } catch (e) {
      logErr(e);
    }
  }

  async function rescan() {
    if (state.onGitHub && state.settings && state.settings.enabled) await send({ type: 'ghtl:rescan' });
    await refresh();
    announce('Rescanned');
  }

  function scheduleRefresh(ms) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      refresh().catch(logErr);
    }, ms);
  }

  async function refresh() {
    try {
      const tab = await activeTab();
      state.tab = tab;
      state.onGitHub = !!tab && isGitHubUrl(tab.url, state.gheHosts);
      state.page = null;
      const rescanBtn = $('btn-rescan');
      if (rescanBtn) rescanBtn.disabled = !state.onGitHub;
      if (!state.onGitHub) { render(viewOffGitHub()); return; }
      if (state.settings && !state.settings.enabled) { render(viewDisabled()); return; }
      const res = await send({ type: 'ghtl:get-state' });
      if (!res || !res.ok) { render(viewUnreachable()); return; }
      state.page = res;
      render(viewPage(res));
    } catch (e) {
      logErr(e);
      render(message('Something went wrong', 'Close and reopen the popup.'));
    }
  }

  async function loadSettings() {
    const S = GHTL.settings;
    try {
      if (!S || typeof S.load !== 'function') throw new Error('settings module missing');
      const data = await S.load();
      state.settings = data.settings;
      state.gheHosts = Array.isArray(data.gheHosts) ? data.gheHosts : [];
    } catch (e) {
      logErr(e);
      if (!state.settings) state.settings = { enabled: true, autoCollapse: 'off' };
    }
  }

  async function init() {
    const sw = $('enabled');
    if (sw) sw.addEventListener('change', (ev) => { onEnabledChange(ev).catch(logErr); });
    const options = $('btn-options');
    if (options) options.addEventListener('click', openOptions);
    const shortcuts = $('btn-shortcuts');
    if (shortcuts) shortcuts.addEventListener('click', openShortcuts);
    const rescanBtn = $('btn-rescan');
    if (rescanBtn) rescanBtn.addEventListener('click', () => { rescan().catch(logErr); });

    await loadSettings();
    syncSwitch(state.settings.enabled);
    await refresh();

    try {
      if (GHTL.settings && typeof GHTL.settings.onChange === 'function') {
        GHTL.settings.onChange(() => {
          loadSettings().then(() => {
            syncSwitch(state.settings.enabled);
            scheduleRefresh(REFRESH_DELAY);
          }).catch(logErr);
        });
      }
    } catch (e) {
      logErr(e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init().catch(logErr); });
  } else {
    init().catch(logErr);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
