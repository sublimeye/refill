# Refill

Refill is a private, encrypted form memory for Chromium browsers (Manifest V3). It will remember
what you type into the sites you choose and fill it back on return visits, with every saved value
encrypted under a passphrase-derived key (Argon2id, AES-256-GCM). It is local-only: no network
access, no sync, no accounts, no telemetry.

**Status: pre-release. Plan 2 of 7 (fill engine) — implemented; final audit in progress.** Plan 1 (foundation) is
complete; see issue #16 for carried-over follow-ups. Recording, the review screen, the return-visit
toast and drafts arrive in later plans. Not on the Chrome Web Store yet.

## What works now

- Create, lock and unlock an encrypted vault from the onboarding page and the popup.
- Enable a site: open the popup on an https page and choose "Enable Refill on this site". Chrome asks for access to that one
  origin, and Refill runs only there. Remove the site, or revoke access in the browser, to stop it.
- Fill from a saved profile: on an enabled site with a profile, once the vault is unlocked, Refill
  fills the matching fields of the current page (including multi-step forms that change without a
  reload). It never fills password, one-time-code or card fields, hidden or covered fields, forms
  that submit to another origin, or a field you already edited.

Profiles are created by the recorder, which is Plan 3, so there is no way to create one from the UI
yet. The tests seed them through an e2e-only seam. A profile set to One gesture never fills until the
Fill now button of Plan 4 exists.

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
node scripts/check-no-seams.mjs .output/chrome-mv3   # after pnpm build: no e2e seam in production
scripts/semgrep.sh selftest     # Semgrep rule tests (needs Docker)
scripts/semgrep.sh scan         # scan the repo with the Refill rules (needs Docker)
```

## Documents

- [Design spec](docs/superpowers/specs/2026-10-26-refill-design.md)
- [Plan 1: foundation](docs/superpowers/plans/2026-10-26-plan-1-foundation.md)
- [Plan 2: sites and fill engine](docs/superpowers/plans/2026-10-26-plan-2-sites-and-fill-engine.md)
- [Threat model](docs/security/threat-model.md)
- [Architecture decision records](docs/adr/README.md)
- [SECURITY.md](SECURITY.md): report vulnerabilities privately
- [PRIVACY.md](PRIVACY.md)

## License

MIT
