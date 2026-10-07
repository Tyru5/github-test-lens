# Chrome Web Store listing — GitHub Test Lens 1.0.0

Copy each block into the matching field of the Chrome Web Store Developer Dashboard.

## Store listing tab

**Name** (from manifest): GitHub Test Lens

**Summary** (from manifest, 115/132 characters):
Tells test files from production code on GitHub: badges, PR test/prod totals, filters and collapsing of test diffs.

**Category:** Developer Tools

**Language:** English

**Description:**

```
See at a glance which files in a pull request are tests and which are production code.

GitHub Test Lens labels every file GitHub lists, using path conventions from more than 30 languages and test frameworks (Jest, Vitest, Playwright, Cypress, pytest, Go, JUnit/Gradle/Maven, RSpec, PHPUnit, Rust, XCTest, .NET, Elixir and many more).

ON PULL REQUESTS
• "Exclude tests" button next to GitHub's +additions −deletions totals, on every pull request tab: one click shows how big the change really is without test, fixture and snapshot files.
• On the Files changed tab the same button greys out and collapses every test diff, so you can review production code first.
• Summary bar above the diff: files and lines for production, tests and test support, the share of changed lines that are tests, and a "No test changes" warning when production code changed and no test did.
• Filter: All / Production / Tests. Hidden files are always counted, with a one-click "Show all".
• "Collapse tests" folds test diffs with GitHub's own toggle; your "Viewed" state is never touched.

EVERYWHERE ELSE
• TEST, TEST SUPPORT and BENCH badges in the file tree, on commit and compare pages, in the repository file browser, on single-file pages and in code search results.
• Production files stay unmarked, so a missing badge means production code.
• Hover any badge to see which rule matched.

YOURS TO TUNE
• Add your own patterns (globs or regular expressions), optionally per repository, or switch off any of the 213 built-in rules.
• "Try a path" shows how any path would be classified, and why.
• GitHub Enterprise Server: add your host in Options; access is requested only for that host.
• Keyboard shortcuts: Alt+Shift+T cycles the filter, Alt+Shift+C collapses or expands test diffs.

PRIVATE BY DESIGN
• No accounts, no analytics, no tracking, no third-party servers.
• Classification happens in your browser from file paths only; file contents are never read.
• The only requests it makes are to GitHub itself, to read a pull request's file list for the "Exclude tests" totals, and only while that toggle is on.

Works with every GitHub theme: light, dark, dimmed, high contrast and colorblind.
```

**Graphic assets** (all in `store/`):

| Field | File |
|---|---|
| Store icon (128×128) | `store-icon-128.png` |
| Screenshot 1 | `screenshots/1-files-changed.png` — badges, file tree and summary bar on a PR |
| Screenshot 2 | `screenshots/2-exclude-tests.png` — "Exclude tests": test diffs greyed and collapsed |
| Screenshot 3 | `screenshots/3-pr-totals.png` — PR totals without tests on the Conversation tab |
| Screenshot 4 | `screenshots/4-repo-browser.png` — badges in the repository browser |
| Screenshot 5 | `screenshots/5-options.png` — "Try a path" in Options |
| Small promo tile (440×280) | `promo/small-tile-440x280.png` |
| Marquee promo tile (1400×560, optional) | `promo/marquee-1400x560.png` |

**Official URL / Homepage URL:** leave empty, or use the repository URL once it is public.

**Support URL:** the repository's Issues page once it is public, or an email address.

## Privacy practices tab

**Single purpose description:**

```
GitHub Test Lens marks which files on GitHub pages are tests and which are production code, and shows pull request size with and without test files.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Saves the user's settings and custom classification rules (chrome.storage.sync) and the current tab's test/production counts for the toolbar badge and popup (chrome.storage.session). |
| `scripting` | Registers the extension's own content script for GitHub Enterprise Server hosts that the user adds in Options. No code is injected anywhere else, and no code is downloaded. |
| Host permission `https://github.com/*` | The extension's purpose is to label files on github.com pages. The content script reads file paths and line counts from GitHub's pages, and, when the "Exclude tests" totals are on, reads the pull request's Files page on github.com with the user's existing session. |
| Optional host permission `https://*/*` | Requested at runtime, only for the single GitHub Enterprise Server origin a user types into Options, so the same labels work on their company's GitHub. Never requested otherwise; removing the host revokes it. |

**Are you using remote code?** No, I am not using remote code. All JavaScript is packaged in the extension.

**Data usage:** check none of the data types. The extension does not collect or transmit user data. File paths and line counts it reads from GitHub pages are processed in the browser and never leave it; the only network requests go to github.com (and, for public repositories, api.github.com) to read the same pull request the user is viewing.

**Certifications:** check all three:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** a public URL of `PRIVACY.md` (see RELEASE.md).

## Distribution tab

- Visibility: Public (or Unlisted for a soft launch).
- Regions: all regions.
- Pricing: free.
