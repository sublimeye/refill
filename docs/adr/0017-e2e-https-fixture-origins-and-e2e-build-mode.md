# ADR 0017: E2E HTTPS fixture origins and e2e build mode

## Context
Plan 2 adds a content script that fills forms on real sites. Its e2e specs need web pages the extension may act on. The extension only supports `https:` origins (exact match via `URL.origin`), and permissions are normally granted by a user gesture in the popup, which Playwright cannot perform (ADR 0007). Specs also need two distinct origins to cover cross-origin behavior.

## Decision
- Fixture sites are served over **https with a self-signed certificate** on `https://localhost:4510` (`FIXTURE_A`) and `https://localhost:4511` (`FIXTURE_B`) from `tests/e2e/sites/`, by `startFixtureServers()` (Node `https`, no new dependency). The certificate is generated per run with `openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=localhost -days 1` into a temp dir that is deleted on close; it is never committed. Without `openssl` the fixture fails at startup with a clear error. Playwright contexts use `ignoreHTTPSErrors: true`.
- An **http exception in product code** (allowing `http://localhost`) was rejected: it would weaken the https-only rule in the code that ships, to make tests easier.
- `wxt build --mode e2e` (`pnpm build:e2e`, output `.output/chrome-mv3-e2e`, WXT's default mode-suffixed directory) adds `host_permissions: ["https://localhost/*"]` to the manifest, so the fixture origins are granted without a prompt. Chrome ignores ports in match patterns, so this covers both. Everything else, including the production CSP, is identical to the production build. The production manifest is unchanged (`host_permissions` stays empty) and `pnpm test:manifest` keeps checking the production build.
- All e2e specs use the e2e build (one extension path). The permission check in `vault.spec.ts` therefore expects exactly `https://localhost/*`: nothing beyond the pre-grant.
- Any e2e-only code seam lives under `import.meta.env.MODE === "e2e"` and every seam identifier contains `__refillE2E`. `scripts/check-no-seams.mjs <dir>` runs in CI on the production build and fails if the marker appears in any file; it fails closed on a missing or empty directory.

## Consequences
- The e2e build is not byte-identical to production; the difference is one manifest field plus any marked seams. The CI seam check bounds the code difference.
- Specs depend on ports 4510/4511 being free and on `openssl` (present on ubuntu-latest and macOS).
- The pre-granted host is `https://localhost/*` only; specs cannot exercise the runtime permission-request flow against fixture sites.

## Status
Accepted.
