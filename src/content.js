/* GitHub Test Lens — content-script orchestrator.
 * Classic script. Pure helpers (stats, directory aggregation, labels) come first and are exported
 * for node tests; everything that touches the DOM or chrome.* lives behind the guard below. */
(function (root) {
  'use strict';

  const GHTL = root.GHTL || (root.GHTL = {});

  // ---- pure helpers (no document, no chrome) ----------------------------------------------

  const CATEGORIES = ['prod', 'test', 'support', 'bench'];
  const TEST_CATEGORIES = ['test', 'support', 'bench'];
  const FILTERS = ['all', 'prod', 'tests'];
  const COLLAPSE_MODES = ['off', 'test', 'all-tests'];
  const DIFF_SURFACES = ['diff-legacy', 'diff-react'];
  const TREE_SURFACES = ['tree-legacy', 'tree-react'];
  const SHORT_LABELS = { test: 'T', support: 'S', bench: 'B', prod: 'P' };

  // Production files with these extensions never trigger the "No test changes" warning.
  const NON_CODE_EXT = ['md', 'mdx', 'markdown', 'rst', 'txt', 'adoc', 'lock', 'json', 'ya?ml', 'toml', 'ini', 'cfg', 'csv',
    'svg', 'png', 'jpe?g', 'gif', 'ico', 'webp', 'woff2?', 'ttf', 'pdf'];
  const NON_CODE_RE = new RegExp('\\.(?:' + NON_CODE_EXT.join('|') + ')$', 'i');

  function shortLabel(category) {
    return SHORT_LABELS[category] || SHORT_LABELS.prod;
  }

  /** True unless the file name ends in a documentation / data / asset extension. */
  function isCodeFile(path) {
    const p = String(path == null ? '' : path);
    if (!p) return false;
    const base = p.slice(p.lastIndexOf('/') + 1);
    return !!base && !NON_CODE_RE.test(base);
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function fmt(n) {
    return String(num(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function plural(n, word) {
    return num(n) === 1 ? word : word + 's';
  }

  function emptyGroup() {
    return { files: 0, additions: 0, deletions: 0 };
  }

  function lines(group) {
    return num(group && group.additions) + num(group && group.deletions);
  }

  function isDiffEntry(entry) {
    return !!entry && DIFF_SURFACES.includes(entry.surface);
  }

  function isTreeEntry(entry) {
    return !!entry && TREE_SURFACES.includes(entry.surface);
  }

  /** Does `filter` show a file of this category? Ignored files are production containers. */
  function filterShows(filter, category) {
    if (filter === 'prod') return category === 'prod';
    if (filter === 'tests') return category !== 'prod';
    return true;
  }

  /** Files hidden by `filter`, from stats (support already includes bench). */
  function hiddenCount(stats, filter) {
    if (!stats) return 0;
    if (filter === 'prod') return num(stats.test && stats.test.files) + num(stats.support && stats.support.files);
    if (filter === 'tests') return num(stats.prod && stats.prod.files) + num(stats.ignored && stats.ignored.files);
    return 0;
  }

  function hiddenText(stats, filter) {
    const n = hiddenCount(stats, filter);
    if (filter === 'prod') return fmt(n) + ' test ' + plural(n, 'file') + ' hidden';
    if (filter === 'tests') return fmt(n) + ' production ' + plural(n, 'file') + ' hidden';
    return '';
  }

  /** Would this filter show at least one of the files in `stats`? Unknown stats → true. */
  function filterHasContent(stats, filter) {
    if (filter === 'all' || !stats || !num(stats.totalFiles)) return true;
    if (filter === 'prod') return num(stats.prod && stats.prod.files) + num(stats.ignored && stats.ignored.files) > 0;
    if (filter === 'tests') return num(stats.test && stats.test.files) + num(stats.support && stats.support.files) > 0;
    return true;
  }

  /** Next filter in All → Production → Tests order, skipping filters that would show nothing. */
  function cycleFilter(current, stats) {
    const i = Math.max(0, FILTERS.indexOf(current));
    for (let k = 1; k <= FILTERS.length; k++) {
      const f = FILTERS[(i + k) % FILTERS.length];
      if (f === 'all' || filterHasContent(stats, f)) return f;
    }
    return 'all';
  }

  /** Categories collapsed by a collapse mode. */
  function collapseSet(mode) {
    if (mode === 'test') return ['test'];
    if (mode === 'all-tests') return TEST_CATEGORIES.slice();
    return [];
  }

  function dirKey(surface, path) {
    return String(surface || '') + '\n' + String(path || '');
  }

  /**
   * indexDirs(entries, results) → Map(surface + '\n' + dirPath → { files, prod, test, support, bench })
   * Counts the file entries (not directories) below every ancestor directory, per surface.
   * Ignored files count as prod. Duplicate paths within a surface count once.
   */
  function indexDirs(entries, results) {
    const index = new Map();
    const seen = new Set();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e || e.isDir || typeof e.path !== 'string' || e.path.indexOf('/') === -1) continue;
      const fileKey = dirKey(e.surface, e.path);
      if (seen.has(fileKey)) continue;
      seen.add(fileKey);
      const r = results[i] || {};
      const cat = !r.ignored && CATEGORIES.includes(r.category) ? r.category : 'prod';
      const parts = e.path.split('/');
      for (let d = 1; d < parts.length; d++) {
        const key = dirKey(e.surface, parts.slice(0, d).join('/'));
        let info = index.get(key);
        if (!info) { info = { files: 0, prod: 0, test: 0, support: 0, bench: 0 }; index.set(key, info); }
        info.files++;
        info[cat]++;
      }
    }
    return index;
  }

  /**
   * aggregateDirs(entries, results, index?) → results'
   * A directory row that classified "prod" but whose listed files (same surface) are all non-prod
   * inherits their category: test, or support / bench when every file is support / bench.
   */
  function aggregateDirs(entries, results, index) {
    const idx = index || indexDirs(entries, results);
    return results.map((r, i) => {
      const e = entries[i];
      if (!e || !e.isDir || !r || r.category !== 'prod' || r.ignored) return r;
      const info = idx.get(dirKey(e.surface, e.path));
      if (!info || !info.files || info.prod > 0) return r;
      const category = info.support === info.files ? 'support' : info.bench === info.files ? 'bench' : 'test';
      const n = info.files;
      const noun = category === 'support' ? 'test support' : category === 'bench' ? (n === 1 ? 'a benchmark' : 'benchmarks') : (n === 1 ? 'a test' : 'tests');
      const reason = n === 1 ? 'the only file inside is ' + noun : 'all ' + n + ' files inside are ' + noun;
      return { category, confidence: 'medium', ruleId: 'aggregate.' + category, reason, ignored: false, aggregated: true };
    });
  }

  /**
   * computeStats(diffEntries) — entries carry { path, category, ignored, stats: { additions, deletions } }.
   * Unique by path (first occurrence wins). `support` folds bench in; `ignored` is kept apart from
   * `prod` and excluded from codeLines / testShare.
   */
  function computeStats(diffEntries) {
    const list = Array.isArray(diffEntries) ? diffEntries : [];
    const seen = new Set();
    const g = { prod: emptyGroup(), test: emptyGroup(), support: emptyGroup(), bench: emptyGroup(), ignored: emptyGroup() };
    let prodCodeFiles = 0;
    let loadedFiles = 0;
    let pendingFiles = 0;   // listed (tree / lazy-load placeholder) but its diff is not rendered yet
    let unmeasuredFiles = 0; // pending and without server-provided line counts
    for (const e of list) {
      if (!e || typeof e.path !== 'string' || !e.path || seen.has(e.path)) continue;
      seen.add(e.path);
      const category = CATEGORIES.includes(e.category) ? e.category : 'prod';
      const ignored = !!e.ignored;
      const bucket = ignored ? g.ignored : g[category];
      bucket.files++;
      bucket.additions += num(e.stats && e.stats.additions);
      bucket.deletions += num(e.stats && e.stats.deletions);
      if (!ignored && category === 'prod' && isCodeFile(e.path)) prodCodeFiles++;
      if (e.pending) { pendingFiles++; if (!e.stats) unmeasuredFiles++; } else loadedFiles++;
    }
    const support = {
      files: g.support.files + g.bench.files,
      additions: g.support.additions + g.bench.additions,
      deletions: g.support.deletions + g.bench.deletions,
    };
    const testLines = lines(g.test) + lines(support);
    const codeLines = lines(g.prod) + testLines;
    const testShare = codeLines > 0 ? Math.round((testLines / codeLines) * 100) : null;
    const warning = prodCodeFiles > 0 && testLines === 0 && g.test.files === 0;
    return {
      prod: g.prod, test: g.test, support, bench: g.bench, ignored: g.ignored,
      totalFiles: seen.size, codeLines, testShare, prodCodeFiles, warning,
      loaded: loadedFiles, pendingFiles, unmeasuredFiles,
    };
  }

  GHTL.content = {
    CATEGORIES, TEST_CATEGORIES, FILTERS, COLLAPSE_MODES, DIFF_SURFACES, TREE_SURFACES, NON_CODE_EXT, SHORT_LABELS,
    shortLabel, isCodeFile, fmt, plural, isDiffEntry, isTreeEntry, filterShows, hiddenCount, hiddenText, filterHasContent,
    cycleFilter, collapseSet, indexDirs, aggregateDirs, computeStats,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = GHTL.content;

  // ---- everything below needs a page and the extension runtime --------------------------------

  if (typeof document === 'undefined' || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
  if (!GHTL.settings || !GHTL.classifier || !GHTL.dom || !GHTL.patterns) return;

  const TITLES = GHTL.classifier.TITLES;
  const TINT_CLASSES = ['ghtl-tint', 'ghtl-tint--test', 'ghtl-tint--support', 'ghtl-tint--bench'];
  const FILTER_KEY_PREFIX = 'ghtl:filter:';

  const state = {
    settings: null,
    customRules: [],
    classifier: null,
    classifierRepo: null,
    filter: 'all',
    pathname: null,
    warned: false,
    appliedFilter: null,
    filterEvent: null,
    collapseEvent: null,
    collapse: 'off',
    collapsedByUs: new WeakSet(),
    selfClick: false,
    lastStatsKey: '',
    entries: [],
    diffEntries: [],
    dirIndex: null,
    stats: null,
    bar: null,
    ui: null,
    stopNav: null,
    announceTimer: null,
    queue: Promise.resolve(),
  };

  function debug() {
    try { console.debug.apply(console, ['[ghtl]'].concat(Array.prototype.slice.call(arguments))); } catch (e) { /* ignore */ }
  }

  function alive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  // ---- settings / classifier --------------------------------------------------------------

  function applyData(data) {
    state.settings = data.settings;
    state.customRules = data.customRules || [];
    state.classifier = null;
    state.classifierRepo = null;
  }

  function ensureClassifier() {
    const repo = GHTL.dom.currentRepo();
    if (state.classifier && repo === state.classifierRepo) return state.classifier;
    state.classifier = GHTL.classifier.createClassifier({
      rules: GHTL.patterns.rules,
      prodOverrides: GHTL.patterns.prodOverrides,
      ignoreRules: GHTL.patterns.ignore,
      userRules: state.customRules,
      disabledRuleIds: state.settings.disabledRuleIds,
      repo,
    });
    state.classifierRepo = repo;
    if (state.classifier.errors.length) debug('rule errors', state.classifier.errors);
    return state.classifier;
  }

  function restoreFilter() {
    try {
      const v = root.sessionStorage.getItem(FILTER_KEY_PREFIX + location.pathname);
      return FILTERS.includes(v) ? v : null;
    } catch (e) { return null; }
  }

  function persistFilter(filter) {
    try { root.sessionStorage.setItem(FILTER_KEY_PREFIX + location.pathname, filter); } catch (e) { /* storage blocked */ }
  }

  // ---- boot / reboot ----------------------------------------------------------------------

  async function boot() {
    try {
      const data = await GHTL.settings.load();
      applyData(data);
      state.filter = restoreFilter() || state.settings.defaultFilter;
      state.pathname = location.pathname;
      state.collapse = state.settings.autoCollapse;
      state.lastStatsKey = '';
      if (!state.settings.enabled) {
        stripAll();
        reportStats(computeStats([]));
        return;
      }
      scan();
      if (!state.stopNav) state.stopNav = GHTL.dom.onNavigate(scan);
    } catch (e) { debug('boot failed', e); }
  }

  /** Settings changed: reload them, strip our UI, rescan. Serialized so bursts cannot interleave. */
  function onlyTotalsChanged(data) {
    if (!state.settings) return false;
    const strip = (o) => JSON.stringify(Object.assign({}, o, { hideTestsInTotals: null }));
    return strip(state.settings) === strip(data.settings)
      && JSON.stringify(state.customRules || []) === JSON.stringify(data.customRules || []);
  }

  function setHideTestsInTotals(hide) {
    if (state.settings) state.settings.hideTestsInTotals = !!hide;
    // Apply the Files-tab side effects (grey out + collapse test diffs) right away; the saved
    // setting comes back through settings.onChange and rescans idempotently.
    if (excludeTestsActive() || !hide) {
      state.collapseEvent = hide ? 'Test files excluded and collapsed' : 'Test files included again';
      scan();
    }
    GHTL.settings.save({ settings: { hideTestsInTotals: !!hide } }).catch((e) => debug('could not save totals toggle', e));
  }

  function updateTotals() {
    if (!GHTL.prTotals || !GHTL.prTotals.update) return;
    const settings = state.settings;
    const classifier = state.classifier;
    GHTL.prTotals.update({
      enabled: !!(settings && settings.enabled && classifier),
      hide: !!(settings && settings.hideTestsInTotals),
      classify: (p) => classifier.classify(p),
      diffEntries: state.diffEntries,
      setHide: setHideTestsInTotals,
    });
  }

  function reboot() {
    state.queue = state.queue.then(async () => {
      try {
        if (!alive()) return;
        const data = await GHTL.settings.load();
        if (onlyTotalsChanged(data)) {
          // The header "Exclude tests" toggle: no need to tear down badges, filters or collapse state.
          state.settings = data.settings;
          scan();
          return;
        }
        if (data.settings.enabled) stripUI(); else stripAll();
        applyData(data);
        state.filter = restoreFilter() || state.settings.defaultFilter;
        state.pathname = location.pathname;
        state.collapse = state.settings.autoCollapse;
        state.lastStatsKey = '';
        if (!state.settings.enabled) {
          if (state.stopNav) { state.stopNav(); state.stopNav = null; }
          reportStats(computeStats([]));
          return;
        }
        scan();
        if (!state.stopNav) state.stopNav = GHTL.dom.onNavigate(scan);
      } catch (e) { debug('reboot failed', e); }
    });
  }

  // ---- scan -------------------------------------------------------------------------------

  function scan() {
    try {
      if (!alive()) { if (state.stopNav) { state.stopNav(); state.stopNav = null; } return; }
      const settings = state.settings;
      if (!settings || !settings.enabled) return;
      if (state.pathname !== location.pathname) {
        // Soft navigation to another page: restore that page's filter (or the default) instead of
        // carrying the previous PR's filter over.
        state.pathname = location.pathname;
        state.filter = restoreFilter() || settings.defaultFilter;
        state.warned = false;
      }
      const classifier = ensureClassifier();
      const entries = GHTL.dom.collectEntries(document, settings.surfaces);
      const raw = entries.map((e) => classifier.classify(e.path, { isDir: e.isDir }));
      const index = indexDirs(entries, raw);
      const results = aggregateDirs(entries, raw, index);
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const cls = results[i];
        entry.cls = cls;
        entry.category = cls.category;
        entry.ignored = !!cls.ignored;
        try { decorate(entry, cls); } catch (e) { debug('decorate failed', entry.path, e); }
      }
      state.entries = entries;
      state.diffEntries = entries.filter(isDiffEntry);
      state.dirIndex = index;
      // Lazy-loaded diffs count too: the filter guard must not bounce "Tests" to "All" just because
      // the first rendered diffs happen to be production files.
      const pending = collectPending(entries, state.diffEntries, classifier);
      applyFilter(pending);
      applyCollapse();
      applyExcluded();
      const stats = computeStats(state.diffEntries.concat(pending));
      state.stats = stats;
      // With the bar turned off it still appears while a filter hides files, so nothing vanishes silently.
      const filtering = !!state.appliedFilter && state.appliedFilter !== 'all';
      if ((settings.summary || filtering) && (state.diffEntries.length || pending.length)) {
        if (ensureSummaryBar()) renderSummary(stats);
      } else {
        removeSummaryBar();
      }
      flushAnnouncements(stats);
      updateTotals();
      reportStats(stats);
    } catch (e) { debug('scan failed', e); }
  }

  // ---- files whose diff is not rendered yet --------------------------------------------------

  const DIFF_KINDS = ['pr-files', 'pr-commit', 'commit', 'compare'];

  /** Diff pages render lazily (React placeholders, progressive legacy loading). The file tree and
   * GitHub's lazy-load placeholders list every file up front, so count those as pending entries;
   * line counts come from the server-embedded payload when the page was loaded directly. */
  function collectPending(entries, diffEntries, classifier) {
    const kind = GHTL.dom.pageKind();
    const onDiffPage = DIFF_KINDS.includes(kind);
    if (!diffEntries.length && !onDiffPage) return [];
    const loaded = new Set(diffEntries.map((e) => e.path));
    const seen = new Set();
    const paths = [];
    const add = (p) => { if (p && !loaded.has(p) && !seen.has(p)) { seen.add(p); paths.push(p); } };
    GHTL.dom.pendingDiffPaths(document).forEach(add);
    if (onDiffPage) entries.forEach((e) => { if (isTreeEntry(e) && !e.isDir) add(e.path); });
    if (!paths.length) return [];
    const hints = GHTL.dom.embeddedDiffSummaries(document);
    return paths.map((p) => {
      const cls = classifier.classify(p);
      const h = hints.get(p);
      return { surface: 'diff-pending', path: p, category: cls.category, ignored: !!cls.ignored, pending: true,
        stats: h ? { additions: h.additions, deletions: h.deletions } : null };
    });
  }

  // ---- decorate ---------------------------------------------------------------------------

  // badge element → the entry.el it belongs to. Two entries may share a badgeHost (blob title
  // copies, repo rows), so ownership is by node, not by position or path.
  const badgeOwner = new WeakMap();

  /** Badges in this entry's host that belong to it. An unowned badge (a Turbo snapshot clone)
   * sitting where ours would go is adopted rather than duplicated. */
  function ownBadges(entry) {
    const host = entry.badgeHost || entry.el;
    const out = [];
    for (let i = 0; i < host.children.length; i++) {
      const c = host.children[i];
      if (!c.hasAttribute('data-ghtl-badge')) continue;
      const owner = badgeOwner.get(c);
      if (owner === entry.el) { out.push(c); continue; }
      if (owner) continue;
      const expected = entry.badgeRef ? entry.badgeRef.nextElementSibling === c : true;
      if (expected) { badgeOwner.set(c, entry.el); out.push(c); }
    }
    return out;
  }

  function removeBadges(entry) {
    ownBadges(entry).forEach((b) => b.remove());
  }

  function wantsBadge(settings, cls) {
    const cat = cls.category;
    if (!settings.badges[cat]) return false;
    return !(cat === 'prod' && cls.ignored);
  }

  function badgeMatches(badge, entry, cls, settings) {
    if (!badge) return false;
    if (!badge.classList.contains('ghtl-badge--' + cls.category)) return false;
    if (badge.classList.contains('ghtl-badge--compact') !== !!entry.compact) return false;
    const text = badge.querySelector('.ghtl-badge__text');
    const want = entry.compact ? shortLabel(cls.category) : settings.labels[cls.category];
    return !!text && text.textContent === want;
  }

  function tintMatches(entry, cls, settings) {
    const el = entry.tintEl;
    if (!el) return true;
    const want = settings.tint && cls.category !== 'prod';
    if (!want) return !el.classList.contains('ghtl-tint');
    return el.classList.contains('ghtl-tint') && el.classList.contains('ghtl-tint--' + cls.category);
  }

  function buildBadge(entry, cls, settings) {
    const cat = cls.category;
    const badge = document.createElement('span');
    badge.className = 'ghtl-badge ghtl-badge--' + cat + (entry.compact ? ' ghtl-badge--compact' : '');
    badge.setAttribute('data-ghtl-badge', '');
    badge.title = TITLES[cat] + ' · ' + cls.reason;
    const text = document.createElement('span');
    text.className = 'ghtl-badge__text';
    text.textContent = entry.compact ? shortLabel(cat) : settings.labels[cat];
    const sr = document.createElement('span');
    sr.className = 'ghtl-sr';
    if (entry.compact) {
      // "T" alone means nothing to a screen reader: hide it and speak the full category instead.
      text.setAttribute('aria-hidden', 'true');
      sr.textContent = ' ' + TITLES[cat].split(' (')[0];
    } else {
      sr.textContent = ' file';
    }
    badge.append(text, sr);
    return badge;
  }

  function markContainer(entry, cls) {
    const c = entry.container;
    if (!c || !isDiffEntry(entry)) return;
    if (c.dataset.ghtlFile !== cls.category) c.dataset.ghtlFile = cls.category;
    if (cls.ignored) { if (c.dataset.ghtlIgnored !== '1') c.dataset.ghtlIgnored = '1'; } else if (c.dataset.ghtlIgnored) delete c.dataset.ghtlIgnored;
  }

  /** Remove everything we added for this entry's node (React recycled it for another path). */
  function undecorate(entry) {
    const el = entry.el;
    removeBadges(entry);
    if (entry.tintEl) entry.tintEl.classList.remove.apply(entry.tintEl.classList, TINT_CLASSES.concat(['ghtl-dimmed', 'ghtl-excluded']));
    el.classList.remove('ghtl-dimmed');
    delete el.dataset.ghtlPath;
    delete el.dataset.ghtlCat;
    delete el.dataset.ghtlIgn;
    delete el.dataset.ghtlUserExpanded;
    delete el.dataset.ghtlCollapsed;
    state.collapsedByUs.delete(el);
  }

  function decorate(entry, cls) {
    const settings = state.settings;
    const el = entry.el;
    const ign = String(!!cls.ignored);
    const wantBadge = wantsBadge(settings, cls);
    if (el.dataset.ghtlPath === entry.path && el.dataset.ghtlCat === cls.category && el.dataset.ghtlIgn === ign) {
      const own = ownBadges(entry);
      const badgeOk = wantBadge ? own.length === 1 && badgeMatches(own[0], entry, cls, settings) : own.length === 0;
      if (badgeOk && tintMatches(entry, cls, settings)) { markContainer(entry, cls); return; }
    }
    if (el.dataset.ghtlPath !== undefined && el.dataset.ghtlPath !== entry.path) undecorate(entry);
    else {
      removeBadges(entry);
      if (entry.tintEl) entry.tintEl.classList.remove.apply(entry.tintEl.classList, TINT_CLASSES);
    }
    el.dataset.ghtlPath = entry.path;
    el.dataset.ghtlCat = cls.category;
    el.dataset.ghtlIgn = ign;
    markContainer(entry, cls);
    if (settings.tint && entry.tintEl && cls.category !== 'prod') entry.tintEl.classList.add('ghtl-tint', 'ghtl-tint--' + cls.category);
    if (wantBadge) {
      const badge = buildBadge(entry, cls, settings);
      badgeOwner.set(badge, el);
      if (entry.badgeRef) entry.badgeRef.insertAdjacentElement('afterend', badge);
      else (entry.badgeHost || el).appendChild(badge);
    }
  }

  // ---- strip ------------------------------------------------------------------------------

  /** Remove badges, tints, dimming, data attributes and the bar. Keeps collapse memory. */
  function stripUI() {
    removeSummaryBar();
    if (GHTL.prTotals && GHTL.prTotals.remove) GHTL.prTotals.remove();
    document.querySelectorAll('[data-ghtl-badge]').forEach((n) => n.remove());
    document.querySelectorAll('.ghtl-tint, .ghtl-dimmed, .ghtl-excluded').forEach((n) => n.classList.remove.apply(n.classList, TINT_CLASSES.concat(['ghtl-dimmed', 'ghtl-excluded'])));
    document.querySelectorAll('[data-ghtl-path]').forEach((n) => { delete n.dataset.ghtlPath; delete n.dataset.ghtlCat; delete n.dataset.ghtlIgn; });
    document.querySelectorAll('[data-ghtl-file]').forEach((n) => { delete n.dataset.ghtlFile; delete n.dataset.ghtlIgnored; });
    delete document.documentElement.dataset.ghtlFilter;
    state.appliedFilter = null;
    state.entries = [];
    state.diffEntries = [];
    state.dirIndex = null;
    state.stats = null;
  }

  /** Full teardown (extension disabled): also re-expands the diffs we collapsed. */
  function stripAll() {
    expandOurs();
    document.querySelectorAll('[data-ghtl-user-expanded]').forEach((n) => { delete n.dataset.ghtlUserExpanded; });
    document.querySelectorAll('[data-ghtl-collapsed]').forEach((n) => { delete n.dataset.ghtlCollapsed; });
    stripUI();
  }

  // ---- filter -----------------------------------------------------------------------------

  function setFilter(filter) {
    const f = FILTERS.includes(filter) ? filter : 'all';
    state.filter = f;
    persistFilter(f);
    return f;
  }

  /** A directory row dims when every file listed under it would be hidden (its own category when it lists none). */
  function dirHidden(entry, filter) {
    const info = state.dirIndex && state.dirIndex.get(dirKey(entry.surface, entry.path));
    if (!info || !info.files) return !filterShows(filter, entry.category);
    if (filter === 'prod') return info.prod === 0;
    if (filter === 'tests') return info.prod === info.files;
    return false;
  }

  function applyFilter(pending) {
    let filter = state.filter;
    const diff = state.diffEntries.concat(pending || []);
    let fallback = false;
    if (filter !== 'all' && diff.length && !diff.some((e) => filterShows(filter, e.category))) {
      filter = setFilter('all');
      fallback = true;
    }
    const html = document.documentElement;
    if (filter === 'all') { if (html.dataset.ghtlFilter !== undefined) delete html.dataset.ghtlFilter; }
    else if (html.dataset.ghtlFilter !== filter) html.dataset.ghtlFilter = filter;
    state.entries.forEach((e) => {
      if (!isTreeEntry(e)) return;
      const target = e.tintEl || e.el;
      const dim = filter !== 'all' && (e.isDir ? dirHidden(e, filter) : !filterShows(filter, e.category));
      if (target.classList.contains('ghtl-dimmed') !== dim) target.classList.toggle('ghtl-dimmed', dim);
    });
    if (fallback) state.filterEvent = 'fallback';
    else if (state.appliedFilter !== null && state.appliedFilter !== filter) state.filterEvent = 'changed';
    state.appliedFilter = filter;
  }

  function filterAnnouncement(filter, stats) {
    if (filter === 'all') return 'Showing all files';
    const hidden = hiddenText(stats, filter);
    return (filter === 'prod' ? 'Showing production files only' : 'Showing test files only') + (hidden ? ', ' + hidden : '');
  }

  /** Announce filter / collapse changes once the stats for the new state exist. */
  function flushAnnouncements(stats) {
    const fe = state.filterEvent;
    state.filterEvent = null;
    if (fe === 'fallback') announce('Nothing to show for this filter. Showing all files.');
    else if (fe === 'changed') announce(filterAnnouncement(state.appliedFilter, stats));
    const ce = state.collapseEvent;
    state.collapseEvent = null;
    if (ce) announce(ce);
  }

  // ---- collapse (GitHub's own toggle only) ---------------------------------------------------

  function setCollapse(mode) {
    const m = COLLAPSE_MODES.includes(mode) ? mode : 'off';
    if (m === state.collapse) return m;
    state.collapse = m;
    state.collapseEvent = m === 'off' ? 'Test diffs expanded' : 'Test diffs collapsed';
    return m;
  }

  function toggleCollapse() {
    const s = state.settings;
    const on = s && s.autoCollapse !== 'off' ? s.autoCollapse : 'all-tests';
    return setCollapse(state.collapse === 'off' ? on : 'off');
  }

  // Membership lives in the DOM as well as the WeakSet: a Turbo snapshot restore brings back cloned
  // (already collapsed) headers that the WeakSet has never seen.
  function weCollapsed(e) {
    return state.collapsedByUs.has(e.el) || e.el.dataset.ghtlCollapsed === '1';
  }

  function rememberCollapsed(e) {
    state.collapsedByUs.add(e.el);
    e.el.dataset.ghtlCollapsed = '1';
  }

  function forgetCollapsed(e) {
    state.collapsedByUs.delete(e.el);
    delete e.el.dataset.ghtlCollapsed;
  }

  function clickToggle(entry) {
    state.selfClick = true;
    try { entry.toggle.click(); } finally { state.selfClick = false; }
  }

  /** Re-expand diffs we collapsed that are still collapsed, except categories in `keep`; forget them. */
  function expandOurs(keep) {
    const keepCats = keep || [];
    state.diffEntries.forEach((e) => {
      if (!e.toggle || !weCollapsed(e)) return;
      if (keepCats.includes(e.category)) return;
      forgetCollapsed(e);
      try { if (e.isExpanded && !e.isExpanded()) clickToggle(e); } catch (err) { debug('expand failed', e.path, err); }
    });
  }

  const PR_DIFF_KINDS = ['pr-files', 'pr-commit'];

  /** "Exclude tests" (PR header toggle) is on and we are looking at a pull request's diffs. */
  function excludeTestsActive() {
    return !!(state.settings && state.settings.hideTestsInTotals) && PR_DIFF_KINDS.includes(GHTL.dom.pageKind());
  }

  /** Exclude tests forces every test-related diff closed; otherwise the user's collapse mode. */
  function effectiveCollapse() {
    return excludeTestsActive() ? 'all-tests' : state.collapse;
  }

  /** Grey out test, support and benchmark files (diff headers and tree rows) while tests are excluded. */
  function applyExcluded() {
    const on = excludeTestsActive();
    state.entries.forEach((e) => {
      if (!isDiffEntry(e) && !isTreeEntry(e)) return;
      const target = e.tintEl || e.el;
      const grey = on && !e.ignored && TEST_CATEGORIES.includes(e.category);
      if (target.classList.contains('ghtl-excluded') !== grey) target.classList.toggle('ghtl-excluded', grey);
    });
  }

  function applyCollapse() {
    const cats = collapseSet(effectiveCollapse());
    if (!cats.length) { expandOurs(); return; }
    expandOurs(cats);
    state.diffEntries.forEach((e) => {
      if (!e.toggle || !e.isExpanded || !cats.includes(e.category)) return;
      if (weCollapsed(e) || e.el.dataset.ghtlUserExpanded === '1') return;
      try {
        if (!e.isExpanded()) return;
        clickToggle(e);
        rememberCollapsed(e);
      } catch (err) { debug('collapse failed', e.path, err); }
    });
  }

  /** Capture-phase observer: a user click on the toggle of a diff we collapsed means "keep it open". */
  function onToggleClick(ev) {
    try {
      if (state.selfClick) return;
      const t = ev.target;
      if (!t || t.nodeType !== 1) return;
      const diff = state.diffEntries;
      for (let i = 0; i < diff.length; i++) {
        const e = diff[i];
        if (!e.toggle || !weCollapsed(e)) continue;
        if (e.toggle === t || e.toggle.contains(t)) {
          e.el.dataset.ghtlUserExpanded = '1';
          forgetCollapsed(e);
          return;
        }
      }
    } catch (err) { debug('click tracking failed', err); }
  }

  /** A dimmed tree row points at a diff the filter hides: clicking it shows everything first, so
   * GitHub's own jump-to-file still lands. Capture phase, never preventDefault. */
  function onDimmedTreeClick(ev) {
    try {
      if (state.appliedFilter === 'all' || !state.appliedFilter) return;
      const t = ev.target;
      if (!t || t.nodeType !== 1 || !t.closest) return;
      const dimmed = t.closest('.ghtl-dimmed');
      if (!dimmed) return;
      const entry = state.entries.find((e) => isTreeEntry(e) && !e.isDir && (e.tintEl || e.el) === dimmed);
      if (!entry) return;
      setFilter('all');
      scan();
      announce('Showing all files');
    } catch (err) { debug('tree click failed', err); }
  }

  // ---- summary bar ------------------------------------------------------------------------

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        if (k === 'text') node.textContent = attrs[k];
        else if (k === 'class') node.className = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach((c) => {
      if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else if (c) node.appendChild(c);
    });
    return node;
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function setHidden(node, hidden) {
    if (node && node.hidden !== !!hidden) node.hidden = !!hidden;
  }

  function setAttr(node, name, value) {
    if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
  }

  function statGroup(key, label, title) {
    const files = el('span', { class: 'ghtl-stat__files' });
    const add = el('span', { class: 'ghtl-num ghtl-num--add' });
    const del = el('span', { class: 'ghtl-num ghtl-num--del' });
    // Real spaces between the parts: flex `gap` draws the spacing, the text nodes keep
    // textContent / screen-reader output readable ("Production 12 files +120 −30").
    const node = el('span', { class: 'ghtl-stat', 'data-ghtl-stat': key, title }, [
      el('span', { class: 'ghtl-stat__label', text: label }), ' ', files, ' ', add, ' ', del,
    ]);
    return { node, files, add, del };
  }

  function buildSummaryBar() {
    const ui = {};
    ui.groups = {
      prod: statGroup('prod', 'Production', 'Production code; lockfiles, vendored and generated files are counted under Other'),
      test: statGroup('test', 'Tests', 'Test files'),
      support: statGroup('support', 'Support', 'Test support (fixtures, mocks, snapshots, helpers, runner config) and benchmarks'),
      ignored: statGroup('ignored', 'Other', 'lockfiles / vendored / generated'),
    };
    ui.stats = el('div', { class: 'ghtl-summary__stats' }, [ui.groups.prod.node, ui.groups.test.node, ui.groups.support.node, ui.groups.ignored.node]);
    ui.share = el('span', { class: 'ghtl-summary__share' });
    ui.pending = el('span', { class: 'ghtl-summary__pending', hidden: '' });
    ui.warn = el('span', { class: 'ghtl-chip ghtl-chip--warn', role: 'status', hidden: '' }, [
      el('span', { 'aria-hidden': 'true', text: '⚠ ' }),
      el('span', { text: 'No test changes' }),
    ]);
    ui.noteText = el('span', { class: 'ghtl-summary__note-text' });
    ui.showAll = el('button', { type: 'button', class: 'ghtl-btn ghtl-btn--link', text: 'Show all' });
    ui.note = el('span', { class: 'ghtl-summary__note', hidden: '' }, [ui.noteText, ui.showAll]);
    ui.radios = {};
    const radios = [['all', 'All'], ['prod', 'Production'], ['tests', 'Tests']].map((pair) => {
      const b = el('button', { type: 'button', class: 'ghtl-seg__item', role: 'radio', 'aria-checked': 'false', 'data-ghtl-value': pair[0], text: pair[1] });
      ui.radios[pair[0]] = b;
      return b;
    });
    ui.group = el('div', { class: 'ghtl-seg', role: 'radiogroup', 'aria-label': 'Show' }, radios);
    ui.collapse = el('button', { type: 'button', class: 'ghtl-btn ghtl-btn--toggle', 'aria-pressed': 'false', text: 'Collapse tests' });
    ui.controls = null;
    ui.live = el('span', { class: 'ghtl-sr', 'aria-live': 'polite' });
    const bar = el('div', { class: 'ghtl-summary', 'data-ghtl-ui': '', role: 'region', 'aria-label': 'Test Lens: tests vs production' }, [
      ui.stats, ui.share, ui.pending, ui.warn, ui.note,
      (ui.controls = el('div', { class: 'ghtl-summary__controls' }, [ui.group, ui.collapse])),
      ui.live,
    ]);
    ui.group.addEventListener('click', onRadioClick);
    ui.group.addEventListener('keydown', onRadioKey);
    ui.collapse.addEventListener('click', onCollapseClick);
    ui.showAll.addEventListener('click', onShowAllClick);
    state.ui = ui;
    return bar;
  }

  function onRadioClick(ev) {
    try {
      const b = ev.target && ev.target.closest ? ev.target.closest('[data-ghtl-value]') : null;
      if (!b || !state.ui || !state.ui.group.contains(b)) return;
      setFilter(b.getAttribute('data-ghtl-value'));
      scan();
    } catch (e) { debug('filter click failed', e); }
  }

  /** Arrow keys move the selection inside our radiogroup only (roving tabindex). */
  function onRadioKey(ev) {
    try {
      const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
      if (!delta || !state.ui || !state.ui.group.contains(ev.target)) return;
      ev.preventDefault();
      const i = FILTERS.indexOf(state.appliedFilter || state.filter);
      setFilter(FILTERS[(Math.max(0, i) + delta + FILTERS.length) % FILTERS.length]);
      scan();
      const b = state.ui.radios[state.appliedFilter || state.filter];
      if (b) b.focus();
    } catch (e) { debug('filter key failed', e); }
  }

  function onCollapseClick() {
    try {
      if (excludeTestsActive()) {
        // Collapse is forced by "Exclude tests": pressing it here includes tests again.
        setHideTestsInTotals(false);
        return;
      }
      toggleCollapse();
      scan();
    } catch (e) { debug('collapse click failed', e); }
  }

  function onShowAllClick() {
    try {
      setFilter('all');
      scan();
      // The note (and this button) is now hidden: move focus to the selected radio, not <body>.
      const b = state.ui && state.ui.radios.all;
      if (b && state.settings.summary) b.focus();
    } catch (e) { debug('show all failed', e); }
  }

  function ensureSummaryBar() {
    const anchor = GHTL.dom.summaryAnchor(document);
    if (!anchor || !anchor.parent) return null;
    if (!state.bar) state.bar = buildSummaryBar();
    const bar = state.bar;
    // A Turbo snapshot restore can bring back a listener-less clone of the bar: drop strangers.
    document.querySelectorAll('.ghtl-summary[data-ghtl-ui]').forEach((n) => { if (n !== bar) n.remove(); });
    if (bar.parentElement !== anchor.parent) {
      const before = anchor.before && anchor.before !== bar && anchor.before.parentElement === anchor.parent ? anchor.before : null;
      anchor.parent.insertBefore(bar, before);
    }
    return bar;
  }

  function removeSummaryBar() {
    document.querySelectorAll('.ghtl-summary[data-ghtl-ui]').forEach((n) => n.remove());
  }

  function renderGroup(g, data, withWord, hide) {
    setHidden(g.node, hide);
    setText(g.files, fmt(data.files) + (withWord ? ' ' + plural(data.files, 'file') : ''));
    setText(g.add, '+' + fmt(data.additions));
    setText(g.del, '−' + fmt(data.deletions));
  }

  function renderSummary(stats) {
    const ui = state.ui;
    if (!ui) return;
    // Summary turned off in Options: the bar only exists to say what the active filter hides.
    const minimal = !state.settings.summary;
    [ui.stats, ui.share, ui.controls].forEach((n) => setHidden(n, minimal));
    renderGroup(ui.groups.prod, stats.prod, true, false);
    renderGroup(ui.groups.test, stats.test, false, false);
    renderGroup(ui.groups.support, stats.support, false, stats.support.files === 0);
    setHidden(ui.groups.ignored.node, stats.ignored.files === 0);
    setText(ui.groups.ignored.files, fmt(stats.ignored.files));
    setHidden(ui.groups.ignored.add, true);
    setHidden(ui.groups.ignored.del, true);
    if (stats.testShare == null) {
      setText(ui.share, 'no code lines');
      setAttr(ui.share, 'title', 'No added or removed lines in code files');
    } else {
      const testLines = lines(stats.test) + lines(stats.support);
      setText(ui.share, 'tests ' + stats.testShare + '% of changed lines');
      setAttr(ui.share, 'title', fmt(testLines) + ' of ' + fmt(stats.codeLines) + ' changed lines are in test, support or benchmark files'
        + (stats.ignored.files ? ' (lockfiles, vendored and generated files excluded)' : ''));
    }
    setHidden(ui.warn, minimal || !stats.warning);
    // role=status toggled through `hidden` is not announced reliably: say it once through the live region.
    if (stats.warning && !state.warned && !minimal) announce('No test changes: production code changed and no test file did');
    state.warned = !!stats.warning;
    const unmeasured = num(stats.unmeasuredFiles);
    setHidden(ui.pending, minimal || unmeasured === 0);
    if (unmeasured > 0) {
      const counted = num(stats.totalFiles) - unmeasured;
      setText(ui.pending, 'lines counted for ' + fmt(counted) + ' of ' + fmt(stats.totalFiles) + ' files');
      setAttr(ui.pending, 'title', fmt(unmeasured) + ' ' + plural(unmeasured, 'diff') + ' not rendered by GitHub yet; scroll to load them');
    }
    const filter = state.appliedFilter || 'all';
    setHidden(ui.note, filter === 'all');
    setText(ui.noteText, filter === 'all' ? '' : hiddenText(stats, filter) + ' ');
    FILTERS.forEach((f) => {
      const b = ui.radios[f];
      setAttr(b, 'aria-checked', f === filter ? 'true' : 'false');
      setAttr(b, 'tabindex', f === filter ? '0' : '-1');
    });
    setAttr(ui.collapse, 'aria-pressed', effectiveCollapse() !== 'off' ? 'true' : 'false');
    setAttr(ui.collapse, 'title', excludeTestsActive()
      ? 'Test files are collapsed because "Exclude tests" is on. Press to include them again.'
      : 'Collapse or expand test, test-support and benchmark diffs');
  }

  // ---- announcements ----------------------------------------------------------------------

  function liveRegion() {
    if (state.ui && state.bar && state.bar.isConnected) return state.ui.live;
    let node = document.querySelector('[data-ghtl-ui="live"]');
    if (!node) {
      node = el('span', { class: 'ghtl-sr', 'aria-live': 'polite', 'data-ghtl-ui': 'live' });
      (document.body || document.documentElement).appendChild(node);
    }
    return node;
  }

  function announce(message) {
    try {
      const node = liveRegion();
      node.textContent = '';
      if (state.announceTimer) clearTimeout(state.announceTimer);
      state.announceTimer = setTimeout(() => {
        state.announceTimer = null;
        try { node.textContent = message; } catch (e) { /* detached */ }
      }, 50);
    } catch (e) { debug('announce failed', e); }
  }

  // ---- service worker + messages ---------------------------------------------------------------

  function pageUrl() {
    return location.origin + location.pathname + location.search;
  }

  /** The worker empties the badge when a tab starts loading; forget the last report so the next
   * scan re-sends it after a soft navigation or a back/forward-cache restore, same numbers or not. */
  function forgetReport() {
    state.lastStatsKey = '';
  }

  function reportStats(stats) {
    try {
      const kind = GHTL.dom.pageKind();
      const url = pageUrl();
      const key = JSON.stringify([kind, url, stats]);
      if (key === state.lastStatsKey) return;
      state.lastStatsKey = key;
      if (!alive()) return;
      const p = chrome.runtime.sendMessage({ type: 'ghtl:stats', stats, kind, url });
      if (p && typeof p.catch === 'function') p.catch((e) => debug('stats not delivered', e && e.message));
    } catch (e) { debug('stats not delivered', e && e.message); }
  }

  /** Distinct paths among the entries: repo rows and blob titles list the same file twice. */
  function uniquePathCount(entries) {
    const seen = new Set();
    for (let i = 0; i < entries.length; i++) if (entries[i] && entries[i].path) seen.add(entries[i].path);
    return seen.size;
  }

  function currentFilter() {
    return state.appliedFilter || state.filter;
  }

  function snapshot() {
    return {
      ok: true,
      kind: GHTL.dom.pageKind(),
      url: pageUrl(),
      repo: GHTL.dom.currentRepo(),
      stats: state.stats,
      filter: currentFilter(),
      collapse: state.collapse,
      counts: { entries: state.entries.length, files: uniquePathCount(state.entries) },
      enabled: !!(state.settings && state.settings.enabled),
    };
  }

  function result() {
    return { ok: true, filter: currentFilter(), collapse: state.collapse };
  }

  function handleMessage(msg, sender, sendResponse) {
    try {
      const type = msg && msg.type;
      if (typeof type !== 'string' || type.indexOf('ghtl:') !== 0) return false;
      switch (type) {
        case 'ghtl:get-state': sendResponse(snapshot()); break;
        case 'ghtl:set-filter': setFilter(msg.filter); scan(); sendResponse(result()); break;
        case 'ghtl:set-collapse': setCollapse(msg.collapse); scan(); sendResponse(result()); break;
        case 'ghtl:cycle-filter': setFilter(cycleFilter(currentFilter(), state.stats)); scan(); sendResponse(result()); break;
        case 'ghtl:toggle-collapse': toggleCollapse(); scan(); sendResponse(result()); break;
        case 'ghtl:rescan': scan(); sendResponse(result()); break;
        default: sendResponse({ ok: false, error: 'Unknown message ' + type });
      }
    } catch (e) {
      debug('message failed', e);
      try { sendResponse({ ok: false, error: String((e && e.message) || e) }); } catch (e2) { /* channel closed */ }
    }
    return false;
  }

  // ---- startup ----------------------------------------------------------------------------

  try {
    GHTL.settings.onChange(reboot);
    chrome.runtime.onMessage.addListener(handleMessage);
    document.addEventListener('click', onToggleClick, true);
    document.addEventListener('click', onDimmedTreeClick, true);
    ['turbo:load', 'soft-nav:end'].forEach((ev) => document.addEventListener(ev, forgetReport, { passive: true }));
    root.addEventListener('pageshow', forgetReport, { passive: true });
    boot();
  } catch (e) { debug('startup failed', e); }
})(typeof globalThis !== 'undefined' ? globalThis : this);
