# Releasing to the Chrome Web Store

## Every release

1. Bump `version` in `manifest.json` and `package.json` (store versions must increase), and add a `CHANGELOG.md` entry.
2. Build and check the upload:

   ```bash
   npm run package    # runs the tests, validates the manifest, writes dist/github-test-lens-<version>.zip
   ```

3. Load the unpacked zip contents once in Chrome (`chrome://extensions` → Developer mode → Load unpacked) and open a pull request's Files changed tab as a smoke test.
4. Developer Dashboard → the item → **Package** → Upload new package → pick the zip.
5. Update store listing text or screenshots if behavior changed (`store/LISTING.md`, `store/screenshots/`).
6. **Submit for review.** Reviews usually take from a few hours to a few days.

## First release only

1. Register a developer account at https://chrome.google.com/webstore/devconsole (one-time US$5 fee, 2-Step Verification required). Verify the contact email.
2. **New item** → upload `dist/github-test-lens-1.0.0.zip`.
3. Fill the **Store listing**, **Privacy practices** and **Distribution** tabs from `store/LISTING.md`.
4. **Privacy policy URL:** https://github.com/Tyru5/github-test-lens/blob/main/PRIVACY.md (the repository is public).
5. Submit for review.

## Store asset specs (already met by the files in `store/`)

| Asset | Required | Spec |
|---|---|---|
| Store icon | yes | 128×128 PNG, 96×96 artwork with transparent padding |
| Screenshots | at least 1, up to 5 | 1280×800 or 640×400, 24-bit PNG or JPEG, no alpha |
| Small promo tile | yes | 440×280, 24-bit PNG or JPEG |
| Marquee promo tile | optional | 1400×560 |

Regenerate screenshots by loading the extension and capturing GitHub pages at a 1280×800 viewport; `scripts/make-icons.js` regenerates the extension icons.
