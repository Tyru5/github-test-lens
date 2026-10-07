/* GitHub Test Lens — GitHub DOM adapters.
 * Finds every "file entry" on the current page (diff headers, file-tree items, repo rows, blob
 * title, search results) and describes where to decorate it. Selectors were verified live on
 * github.com in October 2026 for both the legacy server-rendered diff and the React diff view. */
(function (root) {
  'use strict';

  const GHTL = root.GHTL || (root.GHTL = {});

  const SEL = {
    legacyHeader: '.file-header[data-path]',
    reactHeader: '[class*="DiffFileHeader-module__diff-file-header"]',
    reactRegion: 'div[role="region"][aria-labelledby^="heading-"]',
    legacyTreeItem: 'li[data-tree-entry-type="file"], li[data-tree-entry-type="directory"]',
    reactTreeItem: '#diff_file_tree li[role="treeitem"], ul[role="tree"][aria-label="File Tree"] li[role="treeitem"], #repos-file-tree li[role="treeitem"]',
    skeleton: 'div[role="region"][data-testid^="lazy-load-"]',
    embedded: 'script[type="application/json"][data-target="react-app.embeddedData"]',
    repoRow: 'table[aria-labelledby="folders-and-files"] tr.react-directory-row',
    breadcrumbs: 'nav[data-testid="breadcrumbs"]',
    blobTitle: 'div[data-testid="breadcrumbs-filename"] h1',
    searchResults: '[data-testid="results-list"]',
    searchLink: 'a[data-testid="link-to-search-result"]',
    legacyFiles: '#files.diff-view, #files',
  };

  const STATS_RE = /(\d[\d,]*)\s+additions?(?:\s*&|\s+and|,)?\s*(\d[\d,]*)\s+deletions?/i;

  function normalizePath(p) {
    return GHTL.classifier ? GHTL.classifier.normalizePath(p) : String(p || '').trim();
  }

  function text(el) {
    return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  /** textContent of an element minus anything we injected (badges / UI), whitespace-collapsed. */
  function ownText(el) {
    if (!el) return '';
    let s = '';
    const walk = (n) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) s += c.nodeValue;
        else if (c.nodeType === 1 && !c.hasAttribute('data-ghtl-badge') && !c.hasAttribute('data-ghtl-ui')) walk(c);
      }
    };
    walk(el);
    return s.replace(/\s+/g, ' ').trim();
  }

  function num(s) {
    const n = parseInt(String(s || '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  }

  function parseStats(s) {
    const m = STATS_RE.exec(s || '');
    if (!m) return null;
    return { additions: num(m[1]), deletions: num(m[2]) };
  }

  function isOurs(node) {
    if (!node || node.nodeType !== 1) return false;
    return node.hasAttribute('data-ghtl-ui') || node.hasAttribute('data-ghtl-badge') || !!node.closest('[data-ghtl-ui]');
  }

  function looksLikePath(s) {
    return !!s && s.length < 1024 && !/\s/.test(s) && /[./]/.test(s);
  }

  /** Coarse page kind from the URL (GitHub and GHE share the same routes). */
  function pageKind(loc) {
    const p = (loc || root.location || {}).pathname || '';
    // React "Files changed" lives at /pull/N/changes (ranges: /changes/<sha>..<sha>); a single
    // /changes/<sha> or /commits/<sha> is one commit of the PR. Legacy /files still exists.
    if (/^\/[^/]+\/[^/]+\/pull\/\d+\/(?:commits|changes)\/[0-9a-f]{5,40}(?:\/|$)/.test(p)) return 'pr-commit';
    if (/^\/[^/]+\/[^/]+\/pull\/\d+\/(?:files|changes)(?:\/[0-9a-f]{5,40}\.\.[0-9a-f]{5,40})?(?:\/|$)/.test(p)) return 'pr-files';
    if (/^\/[^/]+\/[^/]+\/pull\/\d+/.test(p)) return 'pr';
    if (/^\/[^/]+\/[^/]+\/commit\//.test(p)) return 'commit';
    if (/^\/[^/]+\/[^/]+\/compare\//.test(p)) return 'compare';
    if (/^\/[^/]+\/[^/]+\/tree\//.test(p)) return 'tree';
    if (/^\/[^/]+\/[^/]+\/blob\//.test(p)) return 'blob';
    if (/^\/search/.test(p)) return 'search';
    if (/^\/[^/]+\/[^/]+\/?$/.test(p)) return 'repo-root';
    return 'other';
  }

  /** "owner/name" (lowercase) of the current repository, or ''. */
  function currentRepo(loc) {
    const p = (loc || root.location || {}).pathname || '';
    const m = /^\/([^/]+)\/([^/]+)(?:\/|$)/.exec(p);
    if (!m) return '';
    const reserved = ['search', 'settings', 'orgs', 'marketplace', 'explore', 'notifications', 'login', 'topics', 'sponsors', 'features', 'pulls', 'issues'];
    if (reserved.includes(m[1])) return '';
    return (m[1] + '/' + m[2]).toLowerCase();
  }

  /** Repo-relative path of the current tree directory or blob, from the React breadcrumbs
   * (the current leaf — directory name or file name — is rendered as an <h1> after the list). */
  function currentLocationPath(doc) {
    const d = doc || root.document;
    const nav = d.querySelector(SEL.breadcrumbs);
    const segs = [];
    if (nav) {
      let afterRepo = false;
      let sawLeaf = false;
      nav.querySelectorAll('ol > li').forEach((li) => {
        if (li.querySelector('[data-testid="breadcrumbs-repo-link"]')) { afterRepo = true; return; }
        if (!afterRepo) return;
        const h1 = li.querySelector('h1');
        if (h1) { segs.push(text(h1)); sawLeaf = true; return; }
        const a = li.querySelector('a');
        const t = text(a || li).replace(/^\/\s*/, '').replace(/\s*\/$/, '');
        if (t) segs.push(t);
      });
      if (!sawLeaf) {
        const h1 = nav.querySelector('h1') || d.querySelector(SEL.blobTitle);
        if (h1 && afterRepo) segs.push(text(h1));
        else if (h1 && !nav.querySelector('ol')) segs.push(text(h1));
      }
      if (afterRepo || segs.length) return normalizePath(segs.join('/'));
    }
    // Fallback: URL parsing, assuming a single-segment ref.
    const m = /^\/[^/]+\/[^/]+\/(?:tree|blob)\/[^/]+\/(.*)$/.exec((root.location || {}).pathname || '');
    if (m) { try { return normalizePath(decodeURIComponent(m[1])); } catch (e) { return normalizePath(m[1]); } }
    return '';
  }

  function tooltipText(button, doc) {
    if (!button) return '';
    const id = button.getAttribute('aria-labelledby') || button.getAttribute('aria-describedby');
    const el = id ? (doc || root.document).getElementById(id) : null;
    return text(el) || button.getAttribute('aria-label') || '';
  }

  // ---- adapters -------------------------------------------------------------------------------

  function collectLegacyDiff(doc, out) {
    doc.querySelectorAll(SEL.legacyHeader).forEach((header) => {
      if (isOurs(header)) return;
      const path = normalizePath(header.getAttribute('data-path'));
      if (!path) return;
      const info = header.querySelector('.file-info') || header;
      const truncate = info.querySelector('.Truncate') || info.querySelector('a.Link--primary');
      const toggle = header.querySelector('button.js-details-target');
      const container = header.closest('copilot-diff-entry') || header.closest('.file') || header.parentElement;
      const sr = info.querySelector('.sr-only');
      out.push({
        surface: 'diff-legacy',
        el: header,
        path,
        isDir: false,
        badgeHost: info,
        badgeRef: truncate && truncate.parentElement === info ? truncate : null,
        compact: false,
        tintEl: header,
        container,
        toggle,
        isExpanded: () => (toggle ? toggle.getAttribute('aria-expanded') === 'true' : !!(container && container.classList.contains('open'))),
        stats: parseStats(text(sr)) || { additions: 0, deletions: 0 },
        deleted: header.getAttribute('data-file-deleted') === 'true',
      });
    });
  }

  function reactHeaderPath(header) {
    const btn = header.querySelector('button[data-file-path]');
    if (btn) {
      const p = normalizePath(btn.getAttribute('data-file-path'));
      if (p) return p;
    }
    const h3 = header.querySelector('h3');
    const code = h3 && (h3.querySelector('code') || h3.querySelector('a') || h3);
    return normalizePath(text(code));
  }

  function reactHeaderStats(header) {
    const srs = header.querySelectorAll('.sr-only');
    for (const sr of srs) {
      const s = parseStats(text(sr));
      if (s) return s;
    }
    const add = header.querySelector('span.fgColor-success');
    const del = header.querySelector('span.fgColor-danger');
    if (add || del) return { additions: num(text(add)), deletions: num(text(del)) };
    return { additions: 0, deletions: 0 };
  }

  function collectReactDiff(doc, out) {
    let headers = doc.querySelectorAll(SEL.reactHeader);
    if (!headers.length) {
      headers = Array.from(doc.querySelectorAll(SEL.reactRegion)).map((r) => r.querySelector('[class*="diffHeaderWrapper"] > div, h3')).filter(Boolean).map((e) => (e.tagName === 'H3' ? e.parentElement.parentElement : e));
    }
    headers.forEach((header) => {
      if (!header || isOurs(header)) return;
      const path = reactHeaderPath(header);
      if (!path) return;
      const h3 = header.querySelector('h3');
      const region = header.closest(SEL.reactRegion);
      const container = region ? (region.parentElement && region.parentElement.parentElement && region.parentElement.parentElement.hasAttribute('data-hpc') ? region.parentElement : region) : header.parentElement;
      const first = header.firstElementChild;
      const toggle = first ? first.querySelector('button') : null;
      out.push({
        surface: 'diff-react',
        el: header,
        path,
        isDir: false,
        badgeHost: h3 ? h3.parentElement : header,
        badgeRef: h3 || null,
        compact: false,
        tintEl: header,
        container,
        toggle,
        isExpanded: () => {
          const tip = tooltipText(toggle, doc);
          if (/collapse/i.test(tip)) return true;
          if (/expand/i.test(tip)) return false;
          return !!(region && region.children.length > 1);
        },
        stats: reactHeaderStats(header),
        deleted: false,
      });
    });
  }

  /** The ActionList row is a grid; its "trailingVisual" area never truncates, unlike the label. */
  function trailingVisual(content) {
    if (!content) return null;
    let span = content.querySelector(':scope > .ActionList-item-visual--trailing');
    if (!span) {
      span = content.ownerDocument.createElement('span');
      span.className = 'ActionList-item-visual ActionList-item-visual--trailing';
      span.setAttribute('data-ghtl-ui', 'trailing');
      content.appendChild(span);
    }
    return span;
  }

  function collectLegacyTree(doc, out) {
    doc.querySelectorAll(SEL.legacyTreeItem).forEach((li) => {
      if (isOurs(li)) return;
      const isDir = li.getAttribute('data-tree-entry-type') === 'directory';
      const hidden = li.querySelector(':scope > [data-filterable-item-text]');
      const label = li.querySelector('.ActionList-item-label');
      let path = normalizePath(text(hidden));
      if (!path) {
        const parts = [];
        let cur = li;
        while (cur && cur.matches && cur.matches('li[data-tree-entry-type]')) {
          const l = cur.querySelector(':scope > .ActionList-content .ActionList-item-label, :scope > button .ActionList-item-label, :scope > a .ActionList-item-label');
          parts.unshift(ownText(l));
          cur = cur.parentElement && cur.parentElement.closest('li[data-tree-entry-type]');
        }
        path = normalizePath(parts.filter(Boolean).join('/'));
      }
      if (!path || !label) return;
      const content = li.querySelector(':scope > .ActionList-content');
      out.push({
        surface: 'tree-legacy',
        el: li,
        path,
        isDir,
        badgeHost: trailingVisual(content) || label,
        badgeRef: null,
        compact: true,
        tintEl: li.querySelector(':scope > .ActionList-content') || li,
        container: null,
        toggle: null,
        isExpanded: null,
        stats: null,
        deleted: li.getAttribute('data-file-deleted') === 'true',
      });
    });
  }

  function collectReactTree(doc, out) {
    doc.querySelectorAll(SEL.reactTreeItem).forEach((li) => {
      if (isOurs(li) || li.hasAttribute('data-tree-entry-type')) return; // legacy tree handled above
      const isDir = li.hasAttribute('aria-expanded');
      const label = li.getAttribute('aria-label') || '';
      let id = li.id || '';
      if (id && li.closest('#repos-file-tree')) id = id.replace(/-item$/, ''); // code-view sidebar: "<path>-item"
      const idLooksLikePath = !!id && !/^file-tree-item-|^_R_|^:r/.test(id) && (!label || id === label || id.endsWith('/' + label));
      let path = idLooksLikePath ? normalizePath(id) : '';
      const textSpan = li.querySelector('.PRIVATE_TreeView-item-content-text');
      const content = li.querySelector('.PRIVATE_TreeView-item-content') || li;
      if (!path) {
        // No path-bearing id: rebuild from ancestors' labels.
        const parts = [];
        let cur = li;
        while (cur && cur.matches && cur.matches('li[role="treeitem"]')) {
          parts.unshift(cur.getAttribute('aria-label') || ownText(cur.querySelector('.PRIVATE_TreeView-item-content-text')));
          cur = cur.parentElement && cur.parentElement.closest('li[role="treeitem"]');
        }
        path = normalizePath(parts.filter(Boolean).join('/'));
      }
      if (!path) return;
      out.push({
        surface: 'tree-react',
        el: li,
        path,
        isDir,
        badgeHost: textSpan && textSpan.parentElement === content ? content : (textSpan || content),
        badgeRef: textSpan && textSpan.parentElement === content ? textSpan : null,
        compact: true,
        tintEl: li.querySelector(':scope > .PRIVATE_TreeView-item-container') || li,
        container: null,
        toggle: null,
        isExpanded: null,
        stats: null,
        deleted: false,
      });
    });
  }

  function collectRepoTree(doc, out) {
    const rows = doc.querySelectorAll(SEL.repoRow);
    if (!rows.length) return;
    const dir = currentLocationPath(doc);
    rows.forEach((row) => {
      if (isOurs(row)) return;
      row.querySelectorAll('.react-directory-filename-column').forEach((cell) => {
        const a = cell.querySelector('a');
        if (!a) return;
        const name = (text(a) || a.getAttribute('title') || '').trim();
        if (!name || name === '..' || name === '.') return;
        const aria = a.getAttribute('aria-label') || '';
        const href = a.getAttribute('href') || '';
        const isDir = /\(Directory\)/i.test(aria) || (/\/tree\//.test(href) && !/\(File\)/i.test(aria));
        const path = normalizePath(dir ? dir + '/' + name : name);
        if (!path) return;
        out.push({
          surface: 'repo-tree',
          el: cell,
          path,
          isDir,
          badgeHost: a.parentElement || cell,
          badgeRef: a.parentElement ? a : null,
          compact: false,
          tintEl: row,
          container: null,
          toggle: null,
          isExpanded: null,
          stats: null,
          deleted: false,
        });
      });
    });
  }

  function collectBlob(doc, out) {
    if (pageKind() !== 'blob') return;
    const h1s = doc.querySelectorAll(SEL.blobTitle);
    if (!h1s.length) return;
    const path = currentLocationPath(doc);
    if (!path) return;
    h1s.forEach((h1) => {
      if (isOurs(h1)) return;
      out.push({
        surface: 'blob',
        el: h1,
        path,
        isDir: false,
        badgeHost: h1.parentElement || h1,
        badgeRef: h1.parentElement ? h1 : null,
        compact: false,
        tintEl: null,
        container: null,
        toggle: null,
        isExpanded: null,
        stats: null,
        deleted: false,
      });
    });
  }

  function pathFromBlobHref(href) {
    const m = /\/blob\/[^/]+\/([^?#]+)/.exec(href || '');
    if (!m) return '';
    try { return normalizePath(decodeURIComponent(m[1])); } catch (e) { return normalizePath(m[1]); }
  }

  function collectSearch(doc, out) {
    const list = doc.querySelector(SEL.searchResults);
    if (!list) return;
    const seen = new Set();
    let links = list.querySelectorAll(SEL.searchLink);
    if (!links.length) links = list.querySelectorAll('a[href*="/blob/"]');
    links.forEach((a) => {
      if (isOurs(a)) return;
      const t = text(a);
      if (!looksLikePath(t)) return;
      const path = looksLikePath(t) && !t.includes('://') ? normalizePath(t) : pathFromBlobHref(a.getAttribute('href'));
      if (!path || seen.has(a)) return;
      seen.add(a);
      out.push({
        surface: 'search',
        el: a,
        path,
        isDir: false,
        badgeHost: a.parentElement || a,
        badgeRef: a.parentElement ? a : null,
        compact: false,
        tintEl: null,
        container: null,
        toggle: null,
        isExpanded: null,
        stats: null,
        deleted: false,
      });
    });
  }

  /** Last resort on diff pages whose DOM we do not recognise: badge any "#diff-…" link whose text is a path. */
  function collectGenericDiffLinks(doc, out) {
    doc.querySelectorAll('a[href^="#diff-"]').forEach((a) => {
      if (isOurs(a)) return;
      const t = text(a);
      if (!looksLikePath(t)) return;
      const path = normalizePath(t);
      if (!path) return;
      out.push({
        surface: 'link',
        el: a,
        path,
        isDir: false,
        badgeHost: a.parentElement || a,
        badgeRef: a.parentElement ? a : null,
        compact: false,
        tintEl: null,
        container: null,
        toggle: null,
        isExpanded: null,
        stats: null,
        deleted: false,
      });
    });
  }

  /** Paths of diffs GitHub has not rendered yet (React lazy-load skeletons). */
  function pendingDiffPaths(doc) {
    const d = doc || root.document;
    const out = [];
    d.querySelectorAll(SEL.skeleton).forEach((region) => {
      const tid = region.getAttribute('data-testid') || '';
      let p = tid.slice('lazy-load-'.length);
      if (!p) p = (region.getAttribute('aria-label') || '').replace(/^Loading\s+/i, '');
      p = normalizePath(p);
      if (p) out.push(p);
    });
    return out;
  }

  const embeddedCache = typeof WeakMap === 'function' ? new WeakMap() : null;

  /** Walks a React route payload for the first array of { path, linesAdded|additions, ... } objects
   * and fills `into` (Map path → { additions, deletions }). Returns the map. */
  function summariesFromJson(data, into) {
    const result = into || new Map();
    let found = false;
    const visit = (v, depth) => {
      if (found || !v || typeof v !== 'object' || depth > 10) return;
      if (Array.isArray(v)) {
        const first = v.find((x) => x && typeof x === 'object');
        if (first && typeof first.path === 'string' && (typeof first.linesAdded === 'number' || typeof first.additions === 'number')) {
          found = true;
          v.forEach((it) => {
            if (!it || typeof it.path !== 'string') return;
            const p = normalizePath(it.path);
            if (!p || result.has(p)) return;
            result.set(p, { additions: num(it.additions != null ? it.additions : it.linesAdded), deletions: num(it.deletions != null ? it.deletions : it.linesDeleted) });
          });
          return;
        }
        v.forEach((x) => visit(x, depth + 1));
        return;
      }
      Object.keys(v).forEach((k) => visit(v[k], depth + 1));
    };
    visit(data, 0);
    return result;
  }

  const HEADER_STATS_RE = /Lines changed:\s*([\d,]+)\s+additions?\s*(?:&|and)\s*([\d,]+)\s+deletions?/i;

  /** The PR-level "+706 −199 ■■■■■" totals next to the pull request tabs, in either header:
   * React (a .sr-only "Lines changed: N additions & M deletions" beside the numbers) or legacy (#diffstat).
   * → { container, additions, deletions, mode } or null. */
  function findPrDiffstat(doc) {
    const d = doc || root.document;
    const srs = d.querySelectorAll('[data-component="PageHeader"] .sr-only, [data-component="PH_Navigation"] .sr-only');
    for (let i = 0; i < srs.length; i++) {
      const m = HEADER_STATS_RE.exec(srs[i].textContent || '');
      if (!m || isOurs(srs[i]) || srs[i].closest('[role="region"]')) continue;
      return { container: srs[i].parentElement, additions: num(m[1]), deletions: num(m[2]), mode: 'react' };
    }
    const legacy = d.querySelector('#diffstat');
    if (legacy && !isOurs(legacy)) {
      const add = legacy.querySelector('.color-fg-success, .text-green');
      const del = legacy.querySelector('.color-fg-danger, .text-red');
      if (add || del) return { container: legacy, additions: num(text(add)), deletions: num(text(del)), mode: 'legacy' };
    }
    return null;
  }

  /** Per-file line counts from the page's server-embedded route payload (initial load only):
   * Map(path → { additions, deletions }). Empty after a client-side navigation (payload is stale). */
  function embeddedDiffSummaries(doc) {
    const d = doc || root.document;
    const result = new Map();
    const app = d.querySelector('react-app[initial-path]');
    const initial = app ? app.getAttribute('initial-path') : null;
    if (!initial || initial !== (root.location || {}).pathname) return result;
    const script = d.querySelector(SEL.embedded);
    if (!script) return result;
    if (embeddedCache && embeddedCache.has(script)) return embeddedCache.get(script);
    try {
      summariesFromJson(JSON.parse(script.textContent || 'null'), result);
    } catch (e) {
      if (root.console) root.console.debug('[ghtl] embedded payload unreadable', e);
    }
    if (embeddedCache) embeddedCache.set(script, result);
    return result;
  }

  /**
   * collectEntries(doc, surfaces) → Entry[]
   * surfaces: { diff, tree, repoTree, blob, search } booleans (all default true).
   */
  function collectEntries(doc, surfaces) {
    const d = doc || root.document;
    const s = Object.assign({ diff: true, tree: true, repoTree: true, blob: true, search: true }, surfaces || {});
    const out = [];
    try {
      if (s.diff) { collectLegacyDiff(d, out); collectReactDiff(d, out); }
      if (s.tree) { collectLegacyTree(d, out); collectReactTree(d, out); }
      if (s.repoTree) collectRepoTree(d, out);
      if (s.blob) collectBlob(d, out);
      if (s.search) collectSearch(d, out);
      if (s.diff && !out.some((e) => e.surface === 'diff-legacy' || e.surface === 'diff-react')) {
        const kind = pageKind();
        if (kind === 'pr-files' || kind === 'commit' || kind === 'compare' || kind === 'pr-commit') collectGenericDiffLinks(d, out);
      }
    } catch (e) {
      if (root.console) root.console.debug('[ghtl] collectEntries failed', e);
    }
    return out;
  }

  /** Where the summary bar goes on diff pages: { parent, before } or null. */
  function summaryAnchor(doc) {
    const d = doc || root.document;
    const files = d.querySelector(SEL.legacyFiles);
    if (files && files.querySelector(SEL.legacyHeader)) return { parent: files, before: files.firstElementChild, mode: 'legacy' };
    const region = d.querySelector(SEL.reactRegion);
    if (region) {
      const hpc = region.closest('[data-hpc]');
      if (hpc && hpc.parentElement) return { parent: hpc.parentElement, before: hpc, mode: 'react' };
      const wrapper = region.parentElement && region.parentElement.parentElement;
      if (wrapper && wrapper.parentElement) return { parent: wrapper.parentElement, before: wrapper, mode: 'react' };
    }
    const skeleton = d.querySelector(SEL.skeleton);
    if (skeleton) {
      const hpc = skeleton.closest('[data-hpc]');
      if (hpc && hpc.parentElement) return { parent: hpc.parentElement, before: hpc, mode: 'react' };
    }
    const header = d.querySelector(SEL.reactHeader);
    if (header) {
      const region2 = header.closest(SEL.reactRegion) || header.parentElement.parentElement;
      if (region2 && region2.parentElement) return { parent: region2.parentElement, before: region2, mode: 'react' };
    }
    return null;
  }

  /** Debounced re-scan trigger: SPA navigation events + DOM mutations (ignoring our own nodes). */
  function onNavigate(cb, options) {
    const o = Object.assign({ debounce: 150, maxWait: 1000 }, options || {});
    let timer = null;
    let first = 0;
    const schedule = () => {
      const now = Date.now();
      if (!first) first = now;
      if (timer) clearTimeout(timer);
      const wait = Math.max(0, Math.min(o.debounce, o.maxWait - (now - first)));
      timer = setTimeout(() => { timer = null; first = 0; cb(); }, wait);
    };
    const docEvents = ['turbo:load', 'turbo:render', 'turbo:frame-load', 'turbo:frame-render', 'soft-nav:end', 'soft-nav:success', 'soft-nav:react-done', 'soft-nav:render', 'soft-nav:payload', 'pjax:end'];
    const winEvents = ['popstate', 'hashchange', 'pageshow'];
    docEvents.forEach((ev) => root.document.addEventListener(ev, schedule, { passive: true }));
    winEvents.forEach((ev) => root.addEventListener(ev, schedule, { passive: true }));
    const mo = new MutationObserver((records) => {
      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (isOurs(r.target)) continue;
        let relevant = false;
        for (let j = 0; j < r.addedNodes.length && !relevant; j++) relevant = r.addedNodes[j].nodeType === 1 && !isOurs(r.addedNodes[j]);
        for (let j = 0; j < r.removedNodes.length && !relevant; j++) relevant = r.removedNodes[j].nodeType === 1 && !isOurs(r.removedNodes[j]);
        if (relevant) { schedule(); return; }
      }
    });
    mo.observe(root.document.documentElement, { childList: true, subtree: true });
    return () => {
      if (timer) clearTimeout(timer);
      docEvents.forEach((ev) => root.document.removeEventListener(ev, schedule));
      winEvents.forEach((ev) => root.removeEventListener(ev, schedule));
      mo.disconnect();
    };
  }

  GHTL.dom = { SEL, collectEntries, summaryAnchor, onNavigate, pageKind, currentRepo, currentLocationPath, parseStats, isOurs, looksLikePath, pathFromBlobHref, ownText, pendingDiffPaths, embeddedDiffSummaries, summariesFromJson, findPrDiffstat, HEADER_STATS_RE };
  if (typeof module !== 'undefined' && module.exports) module.exports = GHTL.dom;
})(typeof globalThis !== 'undefined' ? globalThis : this);
