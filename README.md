# Refill

Refill is a private, encrypted form memory for Chromium browsers (Manifest V3). It will remember
what you type into the sites you choose and fill it back on return visits, with every saved value
encrypted under a passphrase-derived key (Argon2id, AES-256-GCM). It is local-only: no network
access, no sync, no accounts, no telemetry.

**Status: pre-release. Plan 4 of 7 (return visit) — implemented; final review in progress.**
Plans 1 (foundation), 2 (fill engine) and 3 (recorder and review) are complete; see issue #16 for
carried-over follow-ups. Drafts arrive in a later plan. Not on the Chrome Web Store yet.

## What works now

- Create, lock and unlock an encrypted vault from the onboarding page and the popup.
- Enable a site: open the popup on an https page and choose "Enable Refill on this site". Chrome asks for access to that one
  origin, and Refill runs only there. Remove the site, or revoke access in the browser, to stop it.
- Record a form: on an https page choose "Record this site" in the popup (Chrome asks for access
  the first time) and fill the form or wizard once by hand; going back to an earlier step shows what
  you recorded there. Finish on the page or in the popup, review the captured fields (masked until
  you show them) and Save. Everything you type is saved, encrypted, except passwords, one-time codes,
  card security codes and captchas; card numbers and SSNs included unless you set them to "Don't
  save". "Record again" starts from the saved form, so you change only what differs.
- View the saved form from the popup: on a site with a saved form, the popup shows "Saved form · N
  fields" and View. View opens the form with its values masked until you show them. You can change
  its name, the fill mode, the pages it fills under and each field's "When I return", then Save. A
  "Don't save" field stays empty: record again to capture it. Locking Refill or removing the site
  hides the form at once.
- Fill from a saved profile: on an enabled site with a profile, once the vault is unlocked, Refill
  fills the matching fields of the current page (including multi-step forms that change without a
  reload). It skips fields it detects as passwords, one-time codes or card security codes (judged by
  field type, autocomplete value, name and label heuristics), fields that are hidden or covered under
  its eligibility rules, forms whose `action` points to another origin, and fields you already edited.
  Detection is heuristic and has known gaps; see the residual risks in the
  [threat model](docs/security/threat-model.md).

- Return visit: when Refill fills a page, a small notice at the top right of the page says
  "Refill filled N fields" with an Undo button, and the toolbar icon shows how many fields were
  filled in that tab. Undo puts back only the fields that still hold what Refill wrote, so anything
  you edited since stays as you left it. Fields set to Ask are not filled; an empty one (or any
  checkbox or radio) gets a blue outline until you act on it. The notice adds "N need you" only when
  it also filled something, so a page with only Ask fields is outlined but shows no notice. The notice hides itself after about
  6 seconds, and stays while you hover over it or it has focus. While you record a form there is no
  return-visit notice, Undo or outline; the recording notice is the only one.
- Locked vault: on a site with a saved form, the toolbar icon shows a lock and the page notice says
  so, with an Unlock button that opens the Refill popup (if the browser will not open it, the notice
  points you at the toolbar icon). After you unlock, the open tabs of your sites with a saved form
  fill at once, or, for a form set to One gesture, show the "N fields ready" notice.
- Fill now: a form set to One gesture never fills on its own. The page notice says "N fields ready —
  open Refill to fill", and Fill now in the popup fills that tab once.
- If Refill is updated while a page is open, the notice asks you to reload that page.

Profiles are created by recording (Record this site → review → Save).

## Install from source

Needs Node 23 and pnpm 10.33.0.

```sh
pnpm install
pnpm build
```

Then open `chrome://extensions` (or `brave://extensions`), turn on Developer mode, choose
**Load unpacked** and select `.output/chrome-mv3`. Onboarding opens on first install. Requires
Chrome/Chromium 127 or newer. `pnpm dev` runs a WXT dev build with HMR instead.

## Checks

```sh
pnpm test                       # unit tests (vitest, Node)
pnpm test:browser               # DOM tests in real headless Chromium (Vitest browser mode);
                                # once per machine: pnpm exec playwright install chromium
pnpm test:manifest              # build, then compare the manifest with security/manifest.expected.json
pnpm build:e2e                  # e2e build into .output/chrome-mv3-e2e: production plus the
                                # pre-granted https://localhost/* host and the __refillE2E test seams
pnpm test:e2e                   # runs build:e2e, then Playwright against it (needs openssl for the
                                # self-signed https fixture sites on localhost:4510 and :4511)
pnpm lint                       # ESLint
pnpm typecheck                  # svelte-check + tsc
pnpm check:built-network        # after pnpm build: no network API in the built JS
pnpm check:no-frameworks        # after pnpm build: no React or Vue runtime in the built output
pnpm check:sw-no-dom            # after pnpm build: no DOM-only API in the service-worker bundle
node scripts/check-no-seams.mjs .output/chrome-mv3   # after pnpm build: no e2e seam in production
scripts/semgrep.sh selftest     # Semgrep rule tests (needs Docker)
scripts/semgrep.sh scan         # scan the repo with the Refill rules (needs Docker)
```

### Manual check in Brave

The automated suites cannot open the browser's own popup or judge colours, so check these by hand after a change to the notice, the badge or the unlock flow:

1. Lock Refill, then open a site with a saved form. The toolbar icon shows a lock and the notice
   says Refill has a saved form. Click **Unlock** in the notice: the real Refill popup opens
   (`action.openPopup`, Chromium 127+). Unlock it; the page fills and the notice changes to
   "Refill filled N fields" (a form set to One gesture shows "N fields ready" instead). If the popup does not open, the notice should point at the toolbar icon
   instead and have no button.
2. Open a form on a dark page (for example a site in dark mode). The notice stays readable and its
   border keeps it visible against the page.
3. Let Refill fill a form, edit one filled field yourself, then click **Undo**. Every field you did
   not touch goes back to what it held before; the field you edited keeps your value. The notice
   says "Fill undone".
4. Set a saved form to One gesture, reload the site and choose **Fill now** in the popup. The page
   fills once; reloading it does not fill it again until you choose Fill now again.

## Documents

- [Design spec](docs/superpowers/specs/2026-10-26-refill-design.md)
- [Plan 1: foundation](docs/superpowers/plans/2026-10-26-plan-1-foundation.md)
- [Plan 2: sites and fill engine](docs/superpowers/plans/2026-10-26-plan-2-sites-and-fill-engine.md)
- [Plan 3: recorder and review](docs/superpowers/plans/2026-10-27-plan-3-recorder-and-review.md)
- [Plan 4: return visit](docs/superpowers/plans/2026-10-29-plan-4-return-visit.md)
- [Threat model](docs/security/threat-model.md)
- [Architecture decision records](docs/adr/README.md)
- [SECURITY.md](SECURITY.md): report vulnerabilities privately
- [PRIVACY.md](PRIVACY.md)

## License

MIT
