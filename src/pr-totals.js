/* GitHub Test Lens — PR header totals with and without tests.
 * Adds an "Exclude tests" toggle next to GitHub's "+706 −199 ■■■■■" pull request totals (every PR tab).
 * When pressed, GitHub's totals are hidden and replaced by totals that leave out test, test-support and
 * benchmark files. The per-file line counts come from, in order: the rendered diffs (Files tab, when every
 * file is loaded), the PR's Files page fetched same-origin (embedded React payload, or the legacy page plus
 * its "load more" fragments), and the public REST API (public repositories only).
 * Pure helpers come first and are exported for node tests. */
(function (root) {
  'use strict';

  const GHTL = root.GHTL || (root.GHTL = {});

  const TEST_CATEGORIES = ['test', 'support', 'bench'];
  const MAX_FRAGMENT_HOPS = 40;
  const MAX_API_PAGES = 30; // REST caps the files list at 3000 entries
  const CACHE_PREFIX = 'ghtl:prfiles:';

  // ---- pure helpers ---------------------------------------------------------------------------

  function num(v) {
    const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  }

  function fmt(n) {
    return String(Math.max(0, Math.floor(n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** "/owner/repo/pull/123/anything" → { owner, repo, number, key } or null. */
  function prFromPath(pathname) {
    const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(String(pathname || ''));
    if (!m) return null;
    return { owner: m[1], repo: m[2], number: m[3], key: (m[1] + '/' + m[2] + '#' + m[3]).toLowerCase() };
  }

  /** "96 changes: 69 additions & 27 deletions" (legacy file header) → { additions, deletions } | null. */
  function parseChangeText(s) {
    const t = String(s || '');
    const m = /([\d,]+)\s+additions?\s*(?:&|and|,)\s*([\d,]+)\s+deletions?/i.exec(t);
    if (m) return { additions: num(m[1]), deletions: num(m[2]) };
    return null;
  }

  /** GitHub-style five squares: one square per changed line up to five, split by the add/delete ratio. */
  function squares(additions, deletions) {
    const total = additions + deletions;
    const filled = Math.min(5, total);
    let add = total ? Math.round((filled * additions) / total) : 0;
    if (additions > 0 && add === 0 && filled > 1) add = 1;
    if (deletions > 0 && add === filled && filled > 1) add = filled - 1;
    return { add, del: filled - add, neutral: 5 - filled };
  }

  /**
   * split(files, classify) — files: [{ path, additions, deletions }]; classify(path) → { category, ignored }.
   * → { tests: { files, additions, deletions }, all: { files, additions, deletions } }
   */
  function split(files, classify) {
    const tests = { files: 0, additions: 0, deletions: 0 };
    const all = { files: 0, additions: 0, deletions: 0 };
    const seen = new Set();
    (files || []).forEach((f) => {
      if (!f || !f.path || seen.has(f.path)) return;
      seen.add(f.path);
      all.files++;
      all.additions += num(f.additions);
      all.deletions += num(f.deletions);
      const c = classify(f.path);
      if (c && !c.ignored && TEST_CATEGORIES.includes(c.category)) {
        tests.files++;
        tests.additions += num(f.additions);
        tests.deletions += num(f.deletions);
      }
    });
    return { tests, all };
  }

  /**
   * withoutTests(header, parts) — header: GitHub's { additions, deletions }; parts: split() result.
   * Subtracts the test lines from GitHub's own totals, so files we could not see still count as
   * non-test. `exact` is true when the file list adds up to GitHub's totals.
   */
  function withoutTests(header, parts) {
    const exact = parts.all.additions === header.additions && parts.all.deletions === header.deletions;
    return {
      additions: Math.max(0, header.additions - parts.tests.additions),
      deletions: Math.max(0, header.deletions - parts.tests.deletions),
      testFiles: parts.tests.files,
      testAdditions: parts.tests.additions,
      testDeletions: parts.tests.deletions,
      knownFiles: parts.all.files,
      exact,
    };
  }

  GHTL.prTotals = { prFromPath, parseChangeText, squares, split, withoutTests, fmt };
  if (typeof module !== 'undefined' && module.exports) module.exports = GHTL.prTotals;

  // ---- everything below needs a page --------------------------------------------------------------

  if (typeof document === 'undefined' || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
  if (!GHTL.dom || !GHTL.classifier) return;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const loads = new Map(); // pr key → Promise<{ files, source }>
  let ui = null;
  let lastCtx = null;

  function debug() {
    try { console.debug.apply(console, ['[ghtl]'].concat(Array.prototype.slice.call(arguments))); } catch (e) { /* ignore */ }
  }

  // ---- loading the file list -----------------------------------------------------------------------

  function readCache(pr, header) {
    try {
      const raw = root.sessionStorage.getItem(CACHE_PREFIX + pr.key);
      if (!raw) return null;
      const c = JSON.parse(raw);
      if (!c || c.a !== header.additions || c.d !== header.deletions || !Array.isArray(c.f)) return null;
      return { files: c.f.map((x) => ({ path: x[0], additions: x[1], deletions: x[2] })), source: c.s + ' (cached)' };
    } catch (e) { return null; }
  }

  function writeCache(pr, header, data) {
    try {
      root.sessionStorage.setItem(CACHE_PREFIX + pr.key, JSON.stringify({
        a: header.additions, d: header.deletions, s: data.source,
        f: data.files.map((x) => [x.path, x.additions, x.deletions]),
      }));
    } catch (e) { /* quota or blocked storage: the in-memory promise still caches it */ }
  }

  async function fetchText(url) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'text/html' } });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    return r.text();
  }

  function parseHtml(text) {
    return new DOMParser().parseFromString(text, 'text/html');
  }

  function collectLegacy(doc, into) {
    doc.querySelectorAll('.file-header[data-path]').forEach((h) => {
      const path = GHTL.classifier.normalizePath(h.getAttribute('data-path'));
      if (!path || into.has(path)) return;
      const sr = h.querySelector('.file-info .sr-only') || h.querySelector('.sr-only');
      const stats = parseChangeText(sr ? sr.textContent : '') || { additions: 0, deletions: 0 };
      into.set(path, stats);
    });
  }

  /** The PR's Files page, same-origin with the user's session (works for private repositories). */
  async function loadFromFilesPage(pr) {
    const base = '/' + pr.owner + '/' + pr.repo + '/pull/' + pr.number;
    const doc = parseHtml(await fetchText(base + '/files'));
    const files = new Map();
    const script = doc.querySelector(GHTL.dom.SEL.embedded);
    if (script) {
      try { GHTL.dom.summariesFromJson(JSON.parse(script.textContent || 'null'), files); } catch (e) { debug('payload unreadable', e); }
      if (files.size) return { files, source: 'files page (React payload)' };
    }
    collectLegacy(doc, files);
    let next = doc.querySelector('include-fragment[src*="/diffs?"]');
    let hops = 0;
    while (next && hops < MAX_FRAGMENT_HOPS) {
      hops++;
      const frag = parseHtml(await fetchText(next.getAttribute('src')));
      collectLegacy(frag, files);
      next = frag.querySelector('include-fragment[src*="/diffs?"]');
    }
    return { files, source: 'files page' + (hops ? ' + ' + hops + ' fragment' + (hops === 1 ? '' : 's') : '') };
  }

  /** Public REST API, unauthenticated (public repositories only; 60 requests/hour per IP). */
  async function loadFromApi(pr) {
    const files = new Map();
    for (let page = 1; page <= MAX_API_PAGES; page++) {
      const url = 'https://api.github.com/repos/' + encodeURIComponent(pr.owner) + '/' + encodeURIComponent(pr.repo)
        + '/pulls/' + pr.number + '/files?per_page=100&page=' + page;
      const r = await fetch(url, { credentials: 'omit', headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error('API HTTP ' + r.status);
      const list = await r.json();
      if (!Array.isArray(list) || !list.length) break;
      list.forEach((f) => {
        const p = GHTL.classifier.normalizePath(f.filename);
        if (p && !files.has(p)) files.set(p, { additions: num(f.additions), deletions: num(f.deletions) });
      });
      if (list.length < 100) break;
    }
    return { files, source: 'GitHub API' };
  }

  function sums(map) {
    let a = 0;
    let d = 0;
    map.forEach((v) => { a += v.additions; d += v.deletions; });
    return { additions: a, deletions: d };
  }

  function toList(map) {
    return Array.from(map, ([path, v]) => ({ path, additions: v.additions, deletions: v.deletions }));
  }

  async function loadFiles(pr, header) {
    let best = null;
    try {
      const r = await loadFromFilesPage(pr);
      best = r;
      const s = sums(r.files);
      if (s.additions === header.additions && s.deletions === header.deletions) return { files: toList(r.files), source: r.source };
    } catch (e) { debug('files page load failed', e && e.message); }
    try {
      const r = await loadFromApi(pr);
      const s = sums(r.files);
      if (!best || r.files.size > best.files.size || (s.additions === header.additions && s.deletions === header.deletions)) best = r;
    } catch (e) { debug('API load failed', e && e.message); }
    if (!best || !best.files.size) throw new Error('Could not load the list of changed files');
    return { files: toList(best.files), source: best.source };
  }

  /** In-page data on the Files tab, when every changed file is rendered and adds up to the header. */
  function inPageFiles(diffEntries, header) {
    if (!diffEntries || !diffEntries.length) return null;
    const files = new Map();
    diffEntries.forEach((e) => { if (e.path && e.stats && !files.has(e.path)) files.set(e.path, { additions: num(e.stats.additions), deletions: num(e.stats.deletions) }); });
    const s = sums(files);
    if (s.additions !== header.additions || s.deletions !== header.deletions) return null;
    return { files: toList(files), source: 'this page' };
  }

  function getFiles(pr, header, diffEntries) {
    const local = inPageFiles(diffEntries, header);
    if (local) return Promise.resolve(local);
    const key = pr.key + '|' + header.additions + '|' + header.deletions;
    if (!loads.has(key)) {
      const cached = readCache(pr, header);
      const p = cached ? Promise.resolve(cached) : loadFiles(pr, header).then((data) => { writeCache(pr, header, data); return data; });
      p.catch(() => loads.delete(key)); // let a later attempt retry
      loads.set(key, p);
    }
    return loads.get(key);
  }

  // ---- rendering ----------------------------------------------------------------------------------

  function svgIcon() {
    // Octicon "beaker" (16px), drawn with createElementNS (no innerHTML).
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'ghtl-totals__icon');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M5 5.782V2.5h-.25a.75.75 0 0 1 0-1.5h6.5a.75.75 0 0 1 0 1.5H11v3.282l3.666 5.76C15.619 13.04 14.543 15 12.767 15H3.233c-1.776 0-2.852-1.96-1.899-3.458Zm-2.4 6.565a.75.75 0 0 0 .633 1.153h9.534a.75.75 0 0 0 .633-1.153L12.225 10.5h-8.45ZM9.5 2.5h-3V6c0 .143-.04.283-.117.403L4.73 9h6.54L9.617 6.403A.746.746 0 0 1 9.5 6Z');
    svg.appendChild(path);
    return svg;
  }

  function build() {
    const wrap = document.createElement('span');
    wrap.className = 'ghtl-totals';
    wrap.setAttribute('data-ghtl-ui', 'totals');
    const stat = document.createElement('span');
    stat.className = 'ghtl-totals__stat';
    stat.hidden = true;
    const add = document.createElement('span');
    add.className = 'ghtl-totals__add';
    const del = document.createElement('span');
    del.className = 'ghtl-totals__del';
    const sq = document.createElement('span');
    sq.className = 'ghtl-totals__squares';
    sq.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 5; i++) sq.appendChild(document.createElement('span'));
    const sr = document.createElement('span');
    sr.className = 'ghtl-sr';
    stat.append(add, del, sq, sr);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghtl-totals__btn';
    btn.setAttribute('aria-pressed', 'false');
    btn.append(svgIcon(), document.createTextNode('Exclude tests'));
    wrap.append(stat, btn);
    return { wrap, stat, add, del, sq, sr, btn };
  }

  function paintStat(u, data) {
    u.add.textContent = (data.exact ? '' : '~') + '+' + fmt(data.additions);
    u.del.textContent = '−' + fmt(data.deletions);
    const s = squares(data.additions, data.deletions);
    Array.from(u.sq.children).forEach((c, i) => {
      c.className = 'ghtl-sq ' + (i < s.add ? 'ghtl-sq--add' : i < s.add + s.del ? 'ghtl-sq--del' : 'ghtl-sq--neutral');
    });
    u.sr.textContent = 'Lines changed without tests: ' + fmt(data.additions) + ' additions & ' + fmt(data.deletions) + ' deletions';
  }

  function describe(data, header, source) {
    const files = data.testFiles + ' test ' + (data.testFiles === 1 ? 'file' : 'files');
    return 'Without ' + files + ' (+' + fmt(data.testAdditions) + ' −' + fmt(data.testDeletions) + ').'
      + ' With tests: +' + fmt(header.additions) + ' −' + fmt(header.deletions) + '.'
      + (data.exact ? '' : ' Approximate: only ' + data.knownFiles + ' changed files could be read.')
      + ' Source: ' + source + '.';
  }

  function remove() {
    document.querySelectorAll('[data-ghtl-ui="totals"]').forEach((n) => n.remove());
    document.querySelectorAll('[data-ghtl-totals-hidden]').forEach((n) => n.removeAttribute('data-ghtl-totals-hidden'));
    ui = null;
  }

  /**
   * update(ctx) — called on every content-script scan.
   * ctx: { enabled, hide (setting), classify(path) → result, diffEntries, setHide(bool) }
   */
  function update(ctx) {
    lastCtx = ctx;
    try {
      const pr = prFromPath(root.location.pathname);
      const header = pr && ctx.enabled ? GHTL.dom.findPrDiffstat(document) : null;
      if (!header) { remove(); return; }
      if (!ui || !ui.wrap.isConnected) {
        remove();
        ui = build();
        ui.btn.addEventListener('click', () => {
          if (!lastCtx) return;
          const next = ui.btn.getAttribute('aria-pressed') !== 'true';
          lastCtx.hide = next;
          update(lastCtx); // respond immediately; the saved setting follows
          lastCtx.setHide(next);
        });
        const prefetch = () => {
          const h = GHTL.dom.findPrDiffstat(document);
          const p = prFromPath(root.location.pathname);
          if (h && p && lastCtx) getFiles(p, h, lastCtx.diffEntries).catch(() => {});
        };
        ui.btn.addEventListener('pointerenter', prefetch);
        ui.btn.addEventListener('focus', prefetch);
      }
      // Keep our control right after GitHub's totals (React can move or re-create them).
      if (ui.wrap.previousElementSibling !== header.container) header.container.insertAdjacentElement('afterend', ui.wrap);
      ui.btn.setAttribute('aria-pressed', ctx.hide ? 'true' : 'false');
      if (!ctx.hide) {
        ui.stat.hidden = true;
        header.container.removeAttribute('data-ghtl-totals-hidden');
        ui.btn.removeAttribute('aria-busy');
        ui.btn.title = 'Show line totals without test, test-support and benchmark files';
        return;
      }
      const token = pr.key + '|' + header.additions + '|' + header.deletions;
      ui.token = token;
      ui.btn.setAttribute('aria-busy', 'true');
      ui.btn.title = 'Loading the list of changed files…';
      getFiles(pr, header, ctx.diffEntries).then((data) => {
        if (!ui || ui.token !== token) return;
        const parts = split(data.files, ctx.classify);
        const w = withoutTests(header, parts);
        paintStat(ui, w);
        ui.stat.hidden = false;
        ui.stat.title = describe(w, header, data.source);
        header.container.setAttribute('data-ghtl-totals-hidden', '');
        ui.btn.removeAttribute('aria-busy');
        ui.btn.title = 'Showing totals without tests. Press to include them again.';
      }).catch((e) => {
        if (!ui || ui.token !== token) return;
        ui.btn.removeAttribute('aria-busy');
        ui.stat.hidden = true;
        header.container.removeAttribute('data-ghtl-totals-hidden');
        ui.btn.title = 'Could not read the changed files: ' + ((e && e.message) || e) + '. Showing GitHub totals.';
      });
    } catch (e) { debug('PR totals failed', e); }
  }

  Object.assign(GHTL.prTotals, { update, remove, getFiles });
})(typeof globalThis !== 'undefined' ? globalThis : this);
