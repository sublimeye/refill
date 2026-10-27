# Refill

Refill is a private, encrypted form memory for Chromium browsers (Manifest V3). It will remember
what you type into the sites you choose and fill it back on return visits, with every saved value
encrypted under a passphrase-derived key (Argon2id, AES-256-GCM). It is local-only: no network
access, no sync, no accounts, no telemetry.

**Status: pre-release. Plan 1 of 7 (foundation: vault, lock policy, CI) is implemented and merged; its final audit is in progress.** Today the
extension can create, lock and unlock an encrypted vault from an onboarding page and a popup;
sites, recording, filling and drafts arrive in later plans. Not on the Chrome Web Store yet.

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
pnpm test                       # unit tests (vitest)
pnpm test:manifest              # build, then compare the manifest with security/manifest.expected.json
pnpm test:e2e                   # Playwright against the built extension (run pnpm build first;
                                # once per machine: pnpm exec playwright install chromium)
pnpm lint                       # ESLint
pnpm typecheck                  # svelte-check + tsc
scripts/semgrep.sh selftest     # Semgrep rule tests (needs Docker)
scripts/semgrep.sh scan         # scan the repo with the Refill rules (needs Docker)
```

## Documents

- [Design spec](docs/superpowers/specs/2026-10-26-refill-design.md)
- [Plan 1: foundation](docs/superpowers/plans/2026-10-26-plan-1-foundation.md)
- [Threat model](docs/security/threat-model.md)
- [Architecture decision records](docs/adr/README.md)
- [SECURITY.md](SECURITY.md): report vulnerabilities privately
- [PRIVACY.md](PRIVACY.md)

## License

MIT
