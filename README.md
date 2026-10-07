# GitHub Test Lens

Chrome extension (Manifest V3) that tells **test files** from **production code** everywhere GitHub lists files: pull request "Files changed", commit and compare views, the diff file tree, the repository browser, single-file pages and code search. No build step, no dependencies, no telemetry.

## What it does

Every file gets one of four categories, decided from its path:

| Category | Badge | Examples |
| --- | --- | --- |
| Production | none (the unmarked default) | `src/parser.ts`, `cmd/server/main.go` |
| Test | `TEST` | `src/parser.test.ts`, `pkg/parser_test.go`, `spec/models/user_spec.rb`, `tests/test_api.py` |
| Test support | `TEST SUPPORT` (outlined) | `__fixtures__/users.json`, `__mocks__/axios.js`, `*.snap`, `jest.config.js`, `testdata/in.txt` |
| Benchmark | `BENCH` (dashed) | `benches/parse.rs`, `benchmark/http.js`, `fuzz/fuzz_targets/a.rs` |

Hover a badge: its tooltip names the rule that matched. Test, support and benchmark files also get a thin purple rail on diff headers and tree rows. Production files are left alone, so absence is the signal.

On diff pages (PR files, commits, compare) a one-row **summary bar** sits above the first file:

- file counts and added/removed lines for Production, Tests and Support, plus an "Other" count for lockfiles, vendored and generated files that are left out of the numbers;
- the share of changed lines that are tests;
- a **No test changes** warning when production code changed and no test did;
- a **filter**: All / Production / Tests. Hidden files are counted in the bar with a Show all button; tree rows are dimmed, never hidden;
- **Collapse tests**: folds test diffs with GitHub's own toggle. Files you re-open stay open; "Viewed" state is untouched.

Every pull request tab (Conversation, Commits, Checks, Files changed) gets an **Exclude tests** button next to GitHub's `+706 −199 ■■■■■` totals. Pressed, the totals show only non-test lines (for example `+512 −150`), with matching squares; hover them to see how many test files and lines were left out. On the Files changed tab it also greys out every test, test-support and benchmark file (diff headers and tree rows) and collapses their diffs with GitHub's own toggle; turning it off re-expands them. The choice sticks across pull requests and can also be set in Options.

The toolbar icon shows the test share on diff pages (`38%`; amber `0%` when the warning is on). The popup repeats the numbers and offers the filter, the collapse switch and a rescan.

Keyboard shortcuts (change them at `chrome://extensions/shortcuts`):

- `Alt+Shift+T` cycle All / Production / Tests
- `Alt+Shift+C` collapse or expand test diffs

Works with every GitHub theme (light, dark, dimmed, high contrast, colorblind) through Primer's CSS variables, and survives GitHub's in-page navigation and progressive diff loading without duplicate badges.

## Install (unpacked)

Requires Chrome 116 or newer (or another Chromium browser with Manifest V3).

1. Download this repository (clone or unzip).
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the folder that contains `manifest.json`.
5. Open any pull request's "Files changed" tab.

After editing the code, press the reload button on the extension's card and reload the GitHub tab.

## Options

Right-click the toolbar icon, choose **Options** (or use the popup's Options link).

- **General**: on/off switch, tint rails, summary bar, toolbar badge, which categories get badges (including "Mark production files too"), badge labels.
- **Behavior**: auto-collapse (off / test files / every test-related file), the default filter for new pages, which surfaces to decorate (diffs, diff tree, repository browser, file view, search).
- **Custom rules**: your own patterns, evaluated before the built-ins. A "Try a path" box shows how any path would be classified and which rules matched.
- **Built-in rules**: search, enable or disable individual rules, grouped by ecosystem.
- **GitHub Enterprise hosts**: see below.
- **Import / export**: settings as JSON.
- **Storage**: usage against the `chrome.storage.sync` quota (100 KB) and a reset button.

Settings sync with your Chrome profile. Site permissions for Enterprise hosts do not sync; grant them once per machine.

## Custom rule syntax

A rule is a pattern, a category (`test`, `support`, `bench` or `prod`) and an optional repository scope. Rules run first, in order; the first match wins. Patterns are case-insensitive.

| Pattern | Meaning |
| --- | --- |
| `*.spec.rb` | no `/`: matches a file **or directory name** at any depth |
| `qa` | the `qa` directory (or a file called `qa`) anywhere |
| `tests/` | trailing `/`: everything under a top-level `tests` directory |
| `src/**/testing/*.go` | contains `/`: anchored to the repository root; `**` spans directories |
| `{spec,test}/**` | braces, `?` and `[abc]` work as in gitignore |
| `/\.stories\.(js|tsx)$/i` | `/regex/flags` literal, tested against the full path |
| `/build/` | no flags and no regex syntax: an anchored folder glob (`build/` at the repo root) |

Examples:

- `**/*.sql` → `test` for a repository whose SQL files are all test fixtures.
- `src/testing-library/**` → `prod` to stop a built-in rule from marking a product folder.
- `acceptance/` → `test`, scoped to `my-org/*` so it only applies to that organization.

Repository scope accepts `owner/name` or `owner/*`. Leave it empty for every repository.

Order of evaluation: custom rules → vendored trees (`vendor/`, `node_modules/`, `third_party/`, `coverage/`) → built-in rules (highest confidence wins; at equal confidence, support beats bench beats test) → production overrides, which beat low and medium confidence matches (`src/main/`, `examples/`, Storybook, docs inside `spec/`) → lockfiles, `dist/`, minified and generated files are ignored unless a rule marked them as tests → production. Ignored files are counted as "Other" and left out of the test share.

## GitHub Enterprise

1. Open Options → **GitHub Enterprise hosts**.
2. Enter the host, for example `ghe.example.com` (https only; a port is fine).
3. Click **Add** and accept Chrome's permission prompt for that site.

The extension registers its content script for that origin, so it works on the next page load. **Remove** unregisters the script and gives the permission back. Nothing is requested for hosts you have not added.

## Privacy

- No telemetry and no third parties. The only requests it makes are for the "Exclude tests" totals, and only while that toggle is on (or when you point at it): it reads the pull request's own Files page from github.com with your existing session, and, if that page cannot be read completely, GitHub's public REST API for public repositories. The file list is cached for the browser tab.
- No telemetry, no analytics, no accounts.
- Only file **paths** from the page are read; file contents are never touched.
- Settings live in `chrome.storage.sync`; per-tab statistics for the toolbar badge live in `chrome.storage.session` and disappear when the browser closes.

Permissions: `storage` (settings), `scripting` (register the content script on Enterprise hosts you add), `https://github.com/*` (run on GitHub), and the optional `https://*/*` that is only ever granted host by host, when you add one.

## Development

```
manifest.json
src/patterns.js      built-in rule catalog
src/classifier.js    classification engine (pure; no DOM, no chrome.*)
src/settings.js      defaults, sanitizing, chrome.storage helpers
src/gh-dom.js        GitHub DOM adapters (where files are listed, where badges go)
src/content.js       content script orchestrator, summary bar, filter, collapse
src/content.css      injected styles
src/background.js    service worker: badge, per-tab state, commands, GHE scripts
src/options.*        options page
src/popup.*          toolbar popup
test/*.test.js       node tests
scripts/make-icons.js
```

- Run the tests with `node --test 'test/**/*.test.js'` (Node 20 or newer, no packages to install).
- Regenerate the icons with `node scripts/make-icons.js`.
- Every library file is a classic script that attaches to `globalThis.GHTL` and also sets `module.exports`, so the same file runs as a content script, in the options and popup pages, in the service worker (`importScripts`) and under `node --test`.
- Debug the service worker from its "Inspect views" link on `chrome://extensions`; everything it logs is prefixed `[ghtl]`.

## Manifest V3 notes

- Background work runs in a service worker that Chrome stops when idle. It keeps no state in memory: per-tab statistics are stored in `chrome.storage.session`, and every event listener is registered at the top level so the worker can be woken for it.
- Enterprise hosts use `optional_host_permissions` plus `chrome.scripting.registerContentScripts` with `persistAcrossSessions`, re-checked at install and browser start.
- No remote code, no inline scripts, no `eval`, default content security policy. Everything ships inside the package.
- Keyboard shortcuts go through the `commands` API; the content script installs no key listeners on the page.

## Known limitations

- Classification is path-based. A test that follows no naming convention is reported as production, and an oddly named production file can be marked as a test. Add a custom rule for either case; the badge tooltip tells you which rule fired.
- GitHub changes its markup regularly. When a surface stops being decorated, the selectors in `src/gh-dom.js` are the place to look.
- Code search results are only available to signed-in users, so the search surface needs a GitHub login.
- The summary counts the files GitHub has rendered so far; very large pull requests load files progressively and the bar updates as they arrive.
- GitHub Enterprise versions that ship older markup may not expose every surface.

## Releasing

`npm run package` runs the tests, validates the manifest and writes the Chrome Web Store upload to `dist/github-test-lens-<version>.zip`. Store listing copy, privacy answers, screenshots and promo tiles live in `store/`; the step-by-step checklist is `store/RELEASE.md`. The privacy policy is `PRIVACY.md`.

