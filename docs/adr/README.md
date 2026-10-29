# Architecture decision records

Each ADR has Context / Decision / Consequences / Status. Add a new `NNNN-<slug>.md` for any meaningful decision (library, algorithm, parameter, permission, data format, deviation from the spec or plan), and update the index below. To retire a decision, set its Status to `Superseded by NNNN` and add the new ADR.

| # | Title | Status |
|---|---|---|
| [0001](0001-argon2id-hash-wasm.md) | Argon2id via hash-wasm 4.12.0 | Accepted |
| [0002](0002-touch-id-prf.md) | Touch ID unlock via WebAuthn PRF is a go for v1 | Accepted |
| [0003](0003-manifest-key.md) | Dev/test manifest key pinned for a stable extension ID | Accepted |
| [0004](0004-typescript-6-toolchain.md) | TypeScript pinned to 6.0.3, not 7.x | Accepted |
| [0005](0005-ci-supply-chain-pinning.md) | CI supply-chain pinning (actions by SHA, Semgrep image by digest) | Accepted |
| [0006](0006-semgrep-svelte-and-rule-tests.md) | Semgrep coverage of Svelte files, spelling variants and rule self-tests | Accepted |
| [0007](0007-permission-request-popup-lifecycle.md) | Popup does no work after `permissions.request`; the service worker completes the flow | Accepted |
| [0008](0008-crypto-primitives-details.md) | Crypto primitive details (strict base64, uniform DecryptError, 32-byte keys, AAD delimiter) | Accepted |
| [0009](0009-ci-playwright-no-with-deps.md) | CI installs Playwright Chromium without `--with-deps`, with step timeouts | Accepted |
| [0010](0010-draft-sealing-details.md) | Draft sealing details (ECDH P-256 key schedule, PKCS#8 helpers, public JWK validation) | Accepted |
| [0011](0011-store-queue-and-tx-lock.md) | Store write queue and transaction-handle `withStoreLock` | Accepted |
| [0012](0012-vault-core-details.md) | Vault core details (strict header parsing, lock serialization, fail-closed integrity, backoff) | Accepted |
| [0013](0013-lock-triggers-and-sw-wake.md) | Lock triggers and service-worker wake (`lockIfExpired`, re-arming, synchronous registration) | Accepted |
| [0014](0014-messaging-router.md) | Messaging router (sendResponse listener, generic rejections, strict parsing, `sendToSw` errors) | Accepted |
| [0015](0015-onboarding-popup-and-e2e-harness.md) | Onboarding, popup, e2e harness (zxcvbn only in onboarding, shared length rule, create-before-calibrate, idle settle in fixture) | Accepted |
| [0016](0016-extension-page-csp-default-src-none.md) | Extension-page CSP `default-src 'none'`, modulepreload polyfill off, built-output network gate | Accepted |
| [0017](0017-e2e-https-fixture-origins-and-e2e-build-mode.md) | E2E HTTPS fixture origins and e2e build mode (self-signed https, pre-granted fixture hosts only in e2e, seam guard) | Accepted |
| [0018](0018-content-script-registration-and-reconciler.md) | Content-script registration and permission reconciler (unlisted script, one registration id, coalesced reconcile, executeScript after grant) | Accepted |
| [0019](0019-vitest-browser-mode-and-field-signatures.md) | Vitest browser mode (Playwright provider) for DOM tests; field signature rules (`idStable`, bounded `labelText`) | Accepted |
| [0020](0020-eligibility-and-sensitive-field-rules.md) | Eligibility and sensitive-field rules (word semantics, bounded ancestor walk, fail closed, password type-flip history; amended 2026-10-27: secrets only) | Accepted |
| [0021](0021-matcher-details.md) | Matcher details (type gate, derived pair, conflict resolution; path case amended by 0034) | Accepted |
| [0022](0022-profile-records-and-e2e-profile-seam.md) | Profile records (strict parse, one-lock save, origin check on load) and the e2e profile seam with CI positive control | Accepted |
| [0023](0023-document-scanner.md) | Document scanner (bounded iterative walk, cap before signatures, shadow roots joined to the password history) | Accepted |
| [0024](0024-fill-engine.md) | Fill engine (captured prototypes, guard depth counter, insertText fallback, widgets, React/Vue build gate) | Accepted |
| [0025](0025-content-protocol-and-fill-plan.md) | Content protocol and fill plan (sender authorization order, exact-origin record, all-policy matching, zero fillable = none, lock-epoch re-check, `touchLastUsed` compare-and-set) | Accepted |
| [0026](0026-content-script-runtime.md) | Content-script runtime and fixture e2e suite (isolated-world start guard, checked `chrome` capture, mutation/shadow/scrollend re-scan with max wait, vet-then-fill with signature re-check, profiles built from real scans, prerender untestable under DevTools; while recording, once per element, ruling P20) | Accepted |
| [0027](0027-vendored-deepmerge.md) | Vendored, poisoning-safe `deepmerge` replacing the transitive build-time dependency through `pnpm.overrides` (GHSA-gcqx-w48m-w2h4) | Accepted |
| [0028](0028-recorder-model.md) | Recorder model (cumulative step fingerprints, Back/re-render join the most similar step, field identity and the `fieldId` link, reverts remove, fill from the session, per-segment default path prefix) | Accepted |
| [0029](0029-recording-sessions.md) | Recording sessions (one at a time, body sealed under the DEK with `aad.recording`, seeding, one serialized chain, discard on lock/expiry/tab close, tombstones, badge and nudge; lock-epoch check around the job, `expiresAt` ceiling, discard by id; no tombstone for a finished session, discard on site removal, data-free "recording ended" to extension pages) | Accepted |
| [0030](0030-recording-content-protocol.md) | Recording content protocol (`record-status`/`record-capture`/`record-finish` scoped to the sender's tab and origin, `full` at 200 fields or an eleventh page, scan-report files the page and fills from the session, finish opens the review page) | Accepted |
| [0031](0031-recording-page-requests.md) | Recording page requests (`record-start`/`record-state`/`record-finish`/`record-cancel` page-only, the `record` intent, reopen on a finished session, cancel scope) | Accepted |
| [0032](0032-content-capture-and-pill.md) | Content-side capture and the recording pill (trusted events only, event-time re-check, page defaults from the first scan, edited elements never refilled, edited marks, page defaults and the `fieldId` link bound to the element's meaning, 400 ms debounce, over-cap values sent as reverts, P12 re-report on start ahead of any capture, stopped notice once per document, closed root with CSSOM-only styles) | Accepted |
| [0033](0033-review-page.md) | Review page (page-only load/save/discard of a finished session, re-check of the session and the lock epoch at save time, the site keeps one profile id, values in the DOM only on Show after a `review-check`, also on the worker's "recording ended" signal; Don't save keeps no value; M9: a profile load follows a moved pointer, lock-free) | Accepted |
| [0034](0034-path-scope.md) | Path scope (case-insensitive path compare on segment boundaries, origin exact; off the prefix on the same origin a field fills only where its step's fingerprint Jaccard with the page is >= 0.5; default prefix unchanged; review label "Fills on pages under") | Accepted |
| [0035](0035-view-saved-form.md) | View the saved form (popup line `Saved form · N fields` and View through page-only `saved-summary`; the review page's saved mode keyed by profile id, with page-only `saved-load`/`-check`/`-save`; Save is a compare-and-set in one store lock that never recreates a site; a Don't save field cannot become Fill it in and stays empty; Close instead of Discard; the data-free signal renamed `refill-recheck`, sent on every lock and site removal and accepted only from the service worker) | Accepted |
