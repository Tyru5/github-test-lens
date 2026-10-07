# Changelog

## 1.0.0 — 2026-10-07

First public release.

- Labels test, test-support and benchmark files on GitHub: pull request and commit diffs, compare pages, diff file trees, the repository browser, single-file pages and code search.
- 213 built-in rules covering more than 30 languages and test frameworks, with production overrides for common look-alikes (`src/main/`, Storybook, docs, examples, CI workflows).
- Pull request summary bar: production / tests / support counts, test share of changed lines, "No test changes" warning, All / Production / Tests filter and "Collapse tests".
- "Exclude tests" toggle next to GitHub's pull request totals on every PR tab; on Files changed it also greys out and collapses test diffs.
- Toolbar badge with the test share, popup with the same numbers and controls.
- Options: custom glob/regex rules (optionally per repository), "Try a path", built-in rule switches, badge labels, GitHub Enterprise hosts, import/export.
- Keyboard shortcuts: Alt+Shift+T (cycle filter), Alt+Shift+C (collapse tests).
