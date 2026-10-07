# GitHub Test Lens — implementation spec (v1, final)

Chrome extension (Manifest V3) that visually differentiates **test files** from **production code** on github.com (and, optionally, GitHub Enterprise hosts). Zero build step, zero runtime dependencies, vanilla JS/CSS. Chrome 116+.

Existing, finished modules (read them, do not rewrite): `src/classifier.js`, `src/settings.js`, `src/gh-dom.js`, `src/patterns.js` (catalog data; shape is final, contents will grow), `test/classifier.test.js`, `icons/*`, `scripts/make-icons.js`.

## 1. Goals

- Mark every file listed on a GitHub surface as **production** (unmarked), **test**, **test support** (fixtures, mocks, snapshots, factories, helpers, runner config) or **benchmark**. Production is the unmarked default: absence is the signal.
- On diff surfaces (PR "Files changed", commit, compare) add a one-row **summary bar**: file counts and +/− lines per category, share of changed lines that are tests, a "No test changes" warning, a **filter** (All / Production / Tests) and **Collapse tests**.
- Path-based, deterministic, explainable (every badge's `title` names the matching rule), fast (2000 entries per page), configurable (custom globs/regexes, per-repo scope, disable built-ins, GHE hosts).
- Native look in every GitHub theme via Primer CSS custom properties with fallbacks. No layout shift. Accessible: real text, `aria-label`s, not color-only, `aria-live` announcements, keyboard reachable controls.
- Survives Turbo/React SPA navigation, progressive diff loading and React re-renders without duplicate badges.

## 2. File layout

```
manifest.json
src/patterns.js    built-in catalog: GHTL.patterns = { version, rules, prodOverrides, ignore }     (done)
src/classifier.js  GHTL.classifier = { CATEGORIES, LABELS, TITLES, normalizePath, compileGlob, createClassifier }  (done)
src/settings.js    GHTL.settings = { DEFAULTS, KEYS, load, save, onChange, validateCustomRule, exportJSON, importJSON, bytesInUse, ... }  (done)
src/gh-dom.js      GHTL.dom = { SEL, collectEntries, summaryAnchor, onNavigate, pageKind, currentRepo, currentLocationPath, parseStats, isOurs }  (done)
src/content.js     content-script orchestrator                        (TODO)
src/content.css    injected styles                                    (TODO)
src/background.js  service worker; importScripts('settings.js')       (TODO)
src/options.html / options.js / options.css                           (TODO)
src/popup.html / popup.js / popup.css                                 (TODO)
icons/icon-{16,32,48,128}.png                                         (done)
test/classifier.test.js (done), test/patterns.test.js (TODO), test/content.test.js (TODO, optional pure helpers)
README.md                                                             (TODO)
```

### 2.1 Module convention (no bundler)

Every library file is a classic script that attaches to `globalThis.GHTL` and also does `module.exports = …` for node tests. Content scripts list, in order: `src/patterns.js, src/classifier.js, src/settings.js, src/gh-dom.js, src/content.js`. Options/popup pages load `patterns.js`, `classifier.js`, `settings.js` then their own script with plain `<script src>` tags (relative to `src/`). The service worker starts with `importScripts('settings.js')` (plus `patterns.js`/`classifier.js` only if needed). No ES modules, no inline scripts, no inline event handlers, no `eval`, no remote code.

## 3. Classification (`src/classifier.js`)

- Categories `prod | test | support | bench`. `classify(path, { isDir })` → `{ category, confidence, ruleId, reason, ignored }`.
- Order: user rules (first match wins; may force `prod`; optional `repo` glob) → strong ignore rules (vendored trees: `{ category:'prod', ignored:true }`) → built-ins (best confidence; ties: support > bench > test; then catalog order) → prod overrides beat low- and medium-confidence matches → `onlyIfProd` ignore rules (lockfiles, `dist/`, generated) apply only when the result is `prod` → `prod`.
- `explain(path)` lists all matching rules for the options "Try a path" box. `errors` lists bad custom rules. `createClassifier({ rules, prodOverrides, ignoreRules, userRules, disabledRuleIds, repo })`.
- User pattern syntax (`compileGlob`): gitignore-like glob (`**`, `*`, `?`, `{a,b}`, `[abc]`); no `/` → matches file or directory name at any depth; with `/` → anchored full path; trailing `/` = everything under; `/regex/flags` literal. Case-insensitive.

## 4. Settings (done — `src/settings.js`)

Keys in `chrome.storage.sync`: `settings` (object), `customRules` (array), `gheHosts` (array of origins). `DEFAULTS`:

```js
{ version: 1, enabled: true,
  badges: { test: true, support: true, bench: true, prod: false },
  tint: true, summary: true,
  autoCollapse: 'off' /* 'off' | 'test' | 'all-tests' */,
  defaultFilter: 'all' /* 'all' | 'prod' | 'tests' */,
  surfaces: { diff: true, tree: true, repoTree: true, blob: true, search: true },
  labels: { test: 'TEST', support: 'TEST SUPPORT', bench: 'BENCH', prod: 'PROD' },
  disabledRuleIds: [], actionBadge: true }
// customRules item: { pattern, category: 'test'|'support'|'bench'|'prod', repo: '' | 'owner/name' | 'owner/*', enabled }
```

`load()` → `{ settings, customRules, gheHosts }` (sanitized). `save({ settings?: partial, customRules?, gheHosts? })` deep-merges one level. `onChange(cb)` → unsubscribe. Writes must be debounced (sync quota: 120 writes/min, 8 KB/item, 100 KB total).

## 5. DOM adapters (done — `src/gh-dom.js`)

`GHTL.dom.collectEntries(document, settings.surfaces)` → `Entry[]`:

```js
{ surface: 'diff-legacy'|'diff-react'|'tree-legacy'|'tree-react'|'repo-tree'|'blob'|'search'|'link',
  el,            // element we mark with data-ghtl-path / data-ghtl-cat (stable per file)
  path, isDir,
  badgeHost,     // parent for the badge
  badgeRef,      // insert badge right after this child of badgeHost, or append when null
  compact,       // true on tree sidebars (narrow rows): render the short label
  tintEl,        // gets .ghtl-tint.ghtl-tint--<cat> (null = no tint)
  container,     // whole-file block for filtering (diff surfaces) or null
  toggle,        // GitHub's own collapse button (diff surfaces) or null
  isExpanded,    // () => boolean (diff surfaces) or null
  stats,         // { additions, deletions } (diff surfaces) or null
  deleted }      // file deleted in this diff
```

Verified live (Oct 2026): legacy diff `.file-header[data-path]` inside `copilot-diff-entry`; React diff `[class*="DiffFileHeader-module__diff-file-header"]` inside `div[role="region"][aria-labelledby^="heading-"]` (commit pages and the new PR experience; not virtualized at 35 files); legacy tree `li[data-tree-entry-type]`; React tree `#diff_file_tree li[role="treeitem"]` (`id` = full path); repo rows `tr.react-directory-row` (two cells per row: small/large screen — both get entries); blob `div[data-testid="breadcrumbs-filename"] h1` (two copies); search `[data-testid="results-list"] a[href*="/blob/"]`.

`summaryAnchor()` → `{ parent, before, mode }` or null. `onNavigate(cb)` → debounced rescans (Turbo/soft-nav events + MutationObserver ignoring `[data-ghtl-ui]`/`[data-ghtl-badge]` nodes). `pageKind()` → `'pr-files'|'pr-commit'|'pr'|'commit'|'compare'|'tree'|'blob'|'search'|'repo-root'|'other'`. `currentRepo()` → `'owner/name'`.

## 6. Content script (`src/content.js`) — TODO

```
boot():
  data = await GHTL.settings.load(); settings = data.settings
  classifier = createClassifier({ rules: GHTL.patterns.rules, prodOverrides: GHTL.patterns.prodOverrides,
                                  ignoreRules: GHTL.patterns.ignore, userRules: data.customRules,
                                  disabledRuleIds: settings.disabledRuleIds, repo: GHTL.dom.currentRepo() })
  state = { filter: restoreFilter() || settings.defaultFilter, collapse: settings.autoCollapse,
            collapsedByUs: new WeakSet(), lastStatsKey: '', entries: [] }
  scan(); stopNav = GHTL.dom.onNavigate(scan)
  GHTL.settings.onChange(() => reboot())   // reload settings, strip all UI, rescan
  chrome.runtime.onMessage.addListener(handleMessage)
  document.addEventListener('click', onToggleClick, true)   // only to remember user expands; never preventDefault
  if (!settings.enabled) → stripAll() and do nothing else (keep the storage listener)
```

`scan()` (wrapped in try/catch; `console.debug('[ghtl]', e)` on failure):
1. `entries = GHTL.dom.collectEntries(document, settings.surfaces)`; if `GHTL.dom.currentRepo()` changed since the classifier was built → rebuild classifier (repo-scoped rules).
2. For each entry: `cls = classifier.classify(entry.path, { isDir })`; for `isDir` tree entries also apply **subtree aggregation**: if every file entry under that directory (from the same surface's entries) is non-prod and the directory itself classified `prod`, use `{ category: 'test', reason: 'all N files inside are tests' }` (support if all support). Then `decorate(entry, cls)`.
3. `diffEntries = entries.filter(diff surfaces)`; dedupe by `path` (legacy + react never coexist, but two cells/copies may) for stats.
4. `applyFilter(entries)`, `applyCollapse(diffEntries)`.
5. `stats = computeStats(diffEntries)`; if `settings.summary && diffEntries.length` → `ensureSummaryBar()` + `renderSummary(stats)`; else `removeSummaryBar()`.
6. `reportStats(stats)` → `chrome.runtime.sendMessage({ type: 'ghtl:stats', stats, kind: pageKind(), url })` only when the JSON key changed; swallow errors (SW asleep is fine, it wakes on message).

`decorate(entry, cls)`:
- If `el.dataset.ghtlPath === entry.path && el.dataset.ghtlCat === cls.category && el.dataset.ghtlIgn === String(cls.ignored)` and a badge/tint is already consistent with settings → return (idempotent). If the path differs (React recycled the node) → `undecorate(el)` first (remove `[data-ghtl-badge]` descendants of `el`/`badgeHost`, remove `ghtl-tint*` classes from `tintEl`, clear datasets).
- Set `el.dataset.ghtlPath`, `el.dataset.ghtlCat`, `el.dataset.ghtlIgn`; set `entry.container.dataset.ghtlFile = cat` (diff surfaces) and `entry.container.dataset.ghtlIgnored = '1'` when ignored.
- Tint: when `settings.tint && tintEl && cat !== 'prod'` → `tintEl.classList.add('ghtl-tint', 'ghtl-tint--' + cat)`.
- Badge: when `settings.badges[cat]` (prod badge only if enabled and not ignored): `<span class="ghtl-badge ghtl-badge--<cat>[ ghtl-badge--compact]" data-ghtl-badge="" title="<Title> · <reason>"><span class="ghtl-badge__text"><LABEL or short label></span><span class="ghtl-sr"> file</span></span>`; `LABEL = settings.labels[cat]`; compact short labels `{ test: 'T', support: 'S', bench: 'B', prod: 'P' }` with `aria-label` = full title. Insert after `badgeRef` (`badgeRef.insertAdjacentElement('afterend', badge)`) or append to `badgeHost`. Exactly one badge per `el`.
- Never touch GitHub's attributes/classes except adding ours; never move/remove GitHub nodes.

Filter (`state.filter`):
- `document.documentElement.dataset.ghtlFilter = filter` (remove attribute for `'all'`). CSS hides diff containers by `data-ghtl-file`. Tree entries (`tree-*`) whose category would be hidden get `.ghtl-dimmed` on `tintEl || el` (never hidden; clicking still works).
- Guard: if `filter === 'prod'` and zero prod diff entries (or `'tests'` and zero test entries) → fall back to `'all'` and announce "Nothing to show for this filter".
- The summary bar always states the effect: `12 test files hidden` / `9 production files hidden` with a **Show all** button. `aria-live="polite"` region announces changes.
- Persist per page: `sessionStorage['ghtl:filter:' + location.pathname]` (try/catch) so Conversation → Files changed round-trips keep it; `settings.defaultFilter` seeds new pages.

Collapse (`state.collapse`: `'off' | 'test' | 'all-tests'`): for diff entries with category in the set (`test` or `test+support+bench`) that are `isExpanded()` and not `collapsedByUs` and `el.dataset.ghtlUserExpanded !== '1'` → `toggle.click()`, `collapsedByUs.add(el)`. `onToggleClick` (capture): if the clicked element is inside a known `toggle` of an entry we collapsed → `el.dataset.ghtlUserExpanded = '1'`. Switching to `'off'` re-expands entries in `collapsedByUs` that are still collapsed, then clears the set. Never touch "Viewed" state. Use GitHub's own toggle only — no CSS collapsing of diff bodies.

Stats (`computeStats(diffEntries)`) — unique by path:
```js
{ prod: { files, additions, deletions }, test: {...}, support: {...} /* support+bench */, bench: {...}, ignored: {...},
  totalFiles, codeLines /* prod+test+support+bench lines, excludes ignored */,
  testShare /* 0..100 integer: (test+support+bench lines) / codeLines, null when codeLines == 0 */,
  prodCodeFiles /* prod files whose extension is NOT in NON_CODE_EXT and not ignored */,
  warning /* true when prodCodeFiles > 0 && test+support+bench lines === 0 && test files === 0 */,
  loaded: diffEntries.length }
NON_CODE_EXT = ['md','mdx','markdown','rst','txt','adoc','lock','json','ya?ml','toml','ini','cfg','csv','svg','png','jpe?g','gif','ico','webp','woff2?','ttf','pdf']
```

Summary bar (`ensureSummaryBar`): `<div class="ghtl-summary" data-ghtl-ui role="region" aria-label="Test Lens: tests vs production">` inserted via `GHTL.dom.summaryAnchor()` (`parent.insertBefore(bar, before)`); re-inserted if GitHub dropped it; updated in place otherwise (`min-height: 32px`, single row that wraps on narrow widths). Content, left to right:
1. `.ghtl-summary__stats`: `Production <n> files <+a> <−d>` · `Tests <n> <+a> <−d>` · `Support <n> <+a> <−d>` (omit zero groups except Production/Tests) · `Other <n>` when ignored > 0 (title "lockfiles / vendored / generated"). Numbers use `font-variant-numeric: tabular-nums`; `+a` in `--fgColor-success`, `−d` in `--fgColor-danger`.
2. `.ghtl-summary__share`: `tests <NN>% of changed lines` (title with the breakdown) or `no code lines` when null.
3. Warning chip when `stats.warning`: `⚠ No test changes` (`role="status"`), attention colors.
4. Filter state note when filter ≠ all: `<n> <category> files hidden` + `Show all` button.
5. Right: segmented control `role="radiogroup" aria-label="Show"` with three `<button type="button" role="radio" aria-checked>`: All / Production / Tests; and a toggle `<button type="button" aria-pressed>` "Collapse tests" (`state.collapse !== 'off'`; clicking toggles between `'off'` and `settings.autoCollapse === 'off' ? 'all-tests' : settings.autoCollapse`).
6. `<span class="ghtl-sr" aria-live="polite">` for announcements.
Buttons have no `accesskey`, no key listeners on document; arrow keys optional inside the radiogroup only.

Messages (`chrome.runtime.onMessage`), always respond synchronously via `sendResponse(...)` and `return false`:
- `ghtl:get-state` → `{ ok: true, kind, url, repo, stats, filter, collapse, counts: { entries } }`
- `ghtl:set-filter { filter }`, `ghtl:set-collapse { collapse }`, `ghtl:cycle-filter`, `ghtl:toggle-collapse`, `ghtl:rescan` → apply, `scan()`, respond `{ ok: true, filter, collapse }`.

## 7. Styles (`src/content.css`) — TODO

One hue, two weights. Purple (`done`) is the only Primer semantic hue diff views do not already spend (green/red = ±lines, blue = links/selection, yellow = outdated/pending).

```css
.ghtl-badge { --ghtl-c: var(--fgColor-done, var(--color-done-fg, #8250df)); --ghtl-bg: var(--bgColor-done-muted, var(--color-done-subtle, #fbefff)); --ghtl-b: var(--borderColor-done-emphasis, var(--color-done-emphasis, #8250df));
  display: inline-flex; align-items: center; flex: none; box-sizing: border-box; height: 18px; margin-left: 8px; padding: 0 6px;
  border-radius: 2em; border: 1px solid var(--ghtl-b); background: var(--ghtl-bg); color: var(--ghtl-c);
  font: 600 10px/16px var(--fontStack-sansSerif, system-ui, sans-serif); letter-spacing: .03em; text-transform: uppercase; white-space: nowrap; vertical-align: middle; user-select: none; }
.ghtl-badge--test    { /* filled */ }
.ghtl-badge--support { background: transparent; border-color: var(--ghtl-b); }           /* outlined */
.ghtl-badge--bench   { background: transparent; border-style: dashed; }                   /* outlined dashed */
.ghtl-badge--prod    { --ghtl-c: var(--fgColor-muted, #59636e); --ghtl-bg: var(--bgColor-neutral-muted, #eff2f5); --ghtl-b: transparent; }
.ghtl-badge--compact { height: 16px; min-width: 16px; padding: 0 4px; margin-left: 6px; font-size: 9px; }
.ghtl-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
/* tint = 3px rail drawn with background-image so GitHub's sticky header shadows/borders are untouched */
.ghtl-tint { background-image: linear-gradient(var(--ghtl-rail), var(--ghtl-rail)); background-size: 3px 100%; background-repeat: no-repeat; background-position: left top; }
.ghtl-tint--test    { --ghtl-rail: var(--borderColor-done-emphasis, #8250df); }
.ghtl-tint--support { --ghtl-rail: var(--borderColor-done-muted, #d8b9ff); }
.ghtl-tint--bench   { --ghtl-rail: var(--borderColor-done-muted, #d8b9ff); }
[data-ghtl-filter="prod"]  [data-ghtl-file="test"], [data-ghtl-filter="prod"] [data-ghtl-file="support"], [data-ghtl-filter="prod"] [data-ghtl-file="bench"],
[data-ghtl-filter="tests"] [data-ghtl-file="prod"] { display: none !important; }
.ghtl-dimmed { opacity: .45; }
.ghtl-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; min-height: 32px; margin: 0 0 12px; padding: 6px 12px; box-sizing: border-box;
  border: 1px solid var(--borderColor-default, #d0d7de); border-radius: 6px; background: var(--bgColor-muted, #f6f8fa);
  color: var(--fgColor-default, #1f2328); font: 400 12px/18px var(--fontStack-sansSerif, system-ui, sans-serif); }
/* chips / segmented control: Primer-like, focus ring 2px solid var(--focus-outlineColor, #0969da); active radio uses --bgColor-accent-muted / --fgColor-accent */
.ghtl-chip--warn { background: var(--bgColor-attention-muted, #fff8c5); color: var(--fgColor-attention, #9a6700); border: 1px solid var(--borderColor-attention-emphasis, #bf8700); }
@media (forced-colors: active) { .ghtl-badge { forced-color-adjust: none; border: 1px solid CanvasText; background: Canvas; color: CanvasText; } .ghtl-tint { background-image: none; outline: 1px solid CanvasText; outline-offset: -1px; } }
@media (prefers-reduced-motion: reduce) { .ghtl-summary *, .ghtl-badge { transition: none !important; } }
```
Dark-mode fallbacks only matter off-GitHub; tokens re-resolve per theme (light, dark, dimmed, HC, colorblind). No transitions > 100 ms anywhere. Our React-header badge sits after the `<h3>` inside a flex row: `flex: none` keeps it visible when the name truncates.

## 8. Service worker (`src/background.js`) — TODO

- Top: `importScripts('settings.js');` All listeners at top level, synchronously.
- `chrome.runtime.onInstalled` (`install` → seed defaults only if `settings` missing; `update` → nothing destructive) then `syncGheScripts()`. `chrome.runtime.onStartup` → `syncGheScripts()`.
- `chrome.runtime.onMessage` single dispatcher (`switch (msg.type)`), responds with `sendResponse` and returns `true` only for async branches:
  - `ghtl:stats` from a content script (`sender.tab.id`): if `settings.actionBadge` and `msg.kind` is a diff page → badge text = `stats.testShare == null ? '' : stats.testShare + '%'` (≤ 4 chars), bg `#8250df`, text color white; when `stats.warning` → text `'0%'`, bg `#bf8700`; non-diff pages → `''`. `chrome.storage.session.set({ ['tab:' + tabId]: { stats, kind, url } })`.
  - `ghtl:get-tab-state { tabId }` from the popup → from `storage.session`.
  - `ghtl:ghe-add { origin }` from options (after the page called `chrome.permissions.request` in a click): verify `chrome.permissions.contains({ origins: [origin + '/*'] })`, register/update dynamic script id `ghtl-ghe-<hostname>` (`matches: [origin + '/*']`, the manifest's js/css lists, `runAt: 'document_idle'`, `persistAcrossSessions: true`); use `getRegisteredContentScripts({ ids })` + `updateContentScripts` to avoid "Duplicate script ID"; add origin to `gheHosts`; respond `{ ok }`.
  - `ghtl:ghe-remove { origin }` → `unregisterContentScripts`, `chrome.permissions.remove`, drop from `gheHosts`.
- `chrome.permissions.onRemoved` → unregister scripts for removed origins; `chrome.tabs.onUpdated` (`status === 'loading'`) → clear that tab's badge; `chrome.tabs.onRemoved` → delete session entry.
- `chrome.commands.onCommand`: `cycle-filter` → `chrome.tabs.query({ active: true, currentWindow: true })` → `chrome.tabs.sendMessage(tab.id, { type: 'ghtl:cycle-filter' })`; `toggle-collapse` likewise. Catch errors when no content script.
- `syncGheScripts()`: reconcile `gheHosts` vs registered scripts (register missing with granted permission, unregister stale). Idempotent.
- No `window`/DOM, no timers for state, no globals assumed to persist.

## 9. Options page (`src/options.html/js/css`) — TODO

Single page, external JS only, works in light/dark (`prefers-color-scheme`), 720px max width. Sections:
1. **General**: enabled; tint rails; summary bar; action badge; badges per category (Test / Test support / Benchmark / "Mark production files too"); labels (text inputs, ≤ 24 chars).
2. **Behavior**: auto-collapse (`off` / `test` / `all-tests`), default filter, surfaces checkboxes.
3. **Custom rules**: table rows (pattern input, category select, repo input, enabled checkbox, delete button); "Add rule"; inline validation via `GHTL.settings.validateCustomRule`; help text with glob syntax; **Try a path** input + optional repo → shows category, rule id, reason, and all matches from `classifier.explain` (classifier built from current form state).
4. **Built-in rules**: search box; grouped by ecosystem (first id segment); each row: checkbox (enabled), id, description, confidence; "Enable all". Writes `disabledRuleIds`.
5. **GitHub Enterprise hosts**: list + input; "Add" → normalize via `GHTL.settings.normalizeOrigin`, `chrome.permissions.request({ origins: [origin + '/*'] })` inside the click handler, then `chrome.runtime.sendMessage({ type: 'ghtl:ghe-add', origin })`; remove button → `ghtl:ghe-remove`.
6. **Import / export**: export downloads `test-lens-settings.json` (Blob URL + `<a download>`); import via `<input type=file>` → `GHTL.settings.importJSON` → confirm → save.
7. **Storage**: bytes used / 102,400 via `bytesInUse()`; "Reset to defaults".
Saving: debounce 300 ms, `GHTL.settings.save(...)`, toast "Saved" (`role="status"`). Errors (quota) shown inline.

## 10. Popup (`src/popup.html/js/css`) — TODO (320px wide)

Header: icon, "GitHub Test Lens", enabled switch (writes `settings.enabled`). Body: `chrome.tabs.query({ active: true, currentWindow: true })` → if `tab.url` matches a GitHub host → `chrome.tabs.sendMessage(tab.id, { type: 'ghtl:get-state' })` (catch → "Reload the page to activate Test Lens"). On diff pages: three stat tiles (Production / Tests / Support: files, +add, −del), the share line, the warning chip, segmented filter (All / Production / Tests) and "Collapse test diffs" checkbox (send `ghtl:set-filter` / `ghtl:set-collapse`). On other GitHub pages: entry count ("42 files marked"). Non-GitHub: hint text. Footer: "Options" (`chrome.runtime.openOptionsPage()`), "Shortcuts" (`chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })`), "Rescan".

## 11. Manifest (`manifest.json`) — TODO

```json
{
  "manifest_version": 3,
  "name": "GitHub Test Lens",
  "short_name": "Test Lens",
  "version": "0.1.0",
  "description": "Tells test files from production code on GitHub: badges, PR test/prod summary, filters and collapse.",
  "minimum_chrome_version": "116",
  "icons": { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" },
  "action": { "default_title": "GitHub Test Lens", "default_popup": "src/popup.html",
              "default_icon": { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png" } },
  "background": { "service_worker": "src/background.js" },
  "options_ui": { "page": "src/options.html", "open_in_tab": true },
  "permissions": ["storage", "scripting"],
  "host_permissions": ["https://github.com/*"],
  "optional_host_permissions": ["https://*/*"],
  "content_scripts": [{ "matches": ["https://github.com/*"], "exclude_matches": ["https://github.com/login*"],
    "js": ["src/patterns.js", "src/classifier.js", "src/settings.js", "src/gh-dom.js", "src/content.js"],
    "css": ["src/content.css"], "run_at": "document_idle", "all_frames": false, "world": "ISOLATED" }],
  "commands": {
    "cycle-filter": { "suggested_key": { "default": "Alt+Shift+T" }, "description": "Cycle All / Production / Tests on the current diff" },
    "toggle-collapse": { "suggested_key": { "default": "Alt+Shift+C" }, "description": "Collapse or expand test diffs" }
  }
}
```

`host_permissions` for github.com adds no extra warning beyond the content script's and lets the popup read `tab.url` without the `tabs` permission. GHE hosts are granted at runtime from `optional_host_permissions`. No `author` key (ignored since 2024), no CSP key (default is strict), no `web_accessible_resources` (not needed).

## 12. Never list

- Never change the height of GitHub rows/headers (badges 18px inline, `flex: none`; rails are backgrounds; the bar is inserted once and only its text changes).
- Never duplicate badges or bars after re-render/navigation (idempotent decorate keyed by `data-ghtl-path`).
- Never hide files silently: the bar always shows the hidden count + "Show all"; tree rows dim instead of hiding.
- Never register document key listeners; shortcuts only via `chrome.commands`.
- Never `preventDefault`/`stopPropagation` on GitHub events; never synthetic clicks except the collapse toggle the user asked for.
- Never use `innerHTML` with page-derived text; file paths via `textContent`.
- Never fetch, never read file contents, no telemetry.
- Never throw out of the top level of any script; `console.debug('[ghtl]', …)` only.

## 13. Tests (`node --test 'test/**/*.test.js'`)

- `test/classifier.test.js` (done).
- `test/patterns.test.js`: every rule compiles; `matches` paths classify to the rule's category with only that rule enabled (and to a non-prod category with the full catalog); `nonMatches` do not match that rule; ids unique; `prodOverrides`/`ignore` regexes compile; spot checks of ~40 real-world paths across ecosystems against the full catalog.
- Optional `test/content.test.js` for pure helpers exported from content.js when `module` exists (e.g. `computeStats`, `shortLabel`, `NON_CODE_EXT`) — content.js must guard all DOM/chrome access behind `typeof document !== 'undefined'` so it can be required in node.
