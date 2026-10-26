# ADR 0003: Dev/test manifest key pinned for a stable extension ID

## Context
Chrome derives an unpacked extension's ID from its path unless the manifest carries a `key`. Playwright e2e tests, the manifest snapshot test and `externally_connectable` / host-permission reasoning all need an ID that is the same on every machine and every build. The Chrome Web Store assigns its own key at first upload, which will change the ID for store installs.

## Decision
- A 2048-bit RSA key pair was generated with `openssl genrsa`. The private half lives in `.refill-dev-key.pem` (gitignored, never committed; `*.pem` is ignored too). The public half (base64 DER SubjectPublicKeyInfo) is committed as `MANIFEST_KEY` in `src/manifest-key.ts` and used as `key` in `wxt.config.ts`.
- `EXTENSION_ID` (`mpkgcobephioakhgajlkoogmmhdkbook`) is hard-coded next to it, computed Chrome's way (first 16 bytes of sha256 over the DER bytes, hex nibbles mapped 0-f to a-p). `tests/unit/manifest-key.test.ts` recomputes it from `MANIFEST_KEY` and asserts equality; e2e fixtures import both constants.
- Dev, test and the manifest snapshot all use this key. Before the first Web Store upload (Plan 7, together with release-please changelog setup) `MANIFEST_KEY` is replaced by the store-assigned public key and `EXTENSION_ID` is updated; the unit test keeps them consistent.
- `externally_connectable` is `{ "ids": [], "matches": [] }`. Verified with Playwright's bundled Chromium (build 1248), loaded unpacked with this manifest: the service worker started, the extension showed no errors or warnings on `chrome://extensions`, and `chrome.runtime.getManifest()` returned the empty lists. The `{ "ids": [] }` fallback was therefore not needed.

## Consequences
- The extension ID is stable across machines and builds for dev and tests.
- The ID changes once, at store submission. This is accepted because no user data exists yet: nothing is stored under the dev ID that needs migrating, and nothing external references it.
- The dev key is not a secret worth protecting beyond hygiene (it only pins an ID for unpacked builds), but the private half still must not be committed; losing it only means generating a new key and updating `src/manifest-key.ts`.
- The store key replacement is a deliberate, reviewed change to `src/manifest-key.ts` and `security/manifest.expected.json` is unaffected (it records only `has_key: true`).

## Status
Accepted (2026-10-26).
