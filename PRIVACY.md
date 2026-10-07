# GitHub Test Lens — Privacy Policy

Last updated: October 7, 2026

GitHub Test Lens is a browser extension that labels files on GitHub as tests or production code. It does not collect, sell or share personal data.

## What the extension reads

- File paths and line counts shown on GitHub pages you open (github.com, and any GitHub Enterprise host you add yourself). They are used only in your browser to decide which files are tests.
- It never reads the contents of files.

## Network requests

The extension makes no requests to any server run by its developer or by any third party. It contacts only GitHub, and only for the "Exclude tests" totals on pull requests, while that option is on or when you point at its button:

- the pull request's own Files page on github.com (or your Enterprise host), using the GitHub session you are already signed in with;
- for public repositories only, if that page cannot be read completely, GitHub's public REST API (api.github.com), without any credentials.

Nothing about you or your browsing is sent anywhere else.

## What is stored

- Your settings, custom rules and Enterprise host list, in Chrome sync storage (`chrome.storage.sync`). Chrome syncs them across your own signed-in browsers; the developer has no access to them.
- The current tab's test/production counts, in session storage that Chrome clears when the browser closes.
- On GitHub pages: the active filter per page and a cache of a pull request's file list, in that tab's session storage, cleared when the tab closes.

## Analytics and tracking

None. No analytics, telemetry, advertising, fingerprinting or error reporting.

## Permissions

- `storage`: save the settings and counts described above.
- `scripting`: run the extension on GitHub Enterprise hosts you add.
- Access to github.com: label files on GitHub pages.
- Optional access to other https sites: requested only for a GitHub Enterprise host you add in Options, and removed when you remove the host.

## Changes

Changes to this policy will be published with a new version of the extension.

## Contact

Tyrus Malmstrom — tyrusm@hotmail.com
