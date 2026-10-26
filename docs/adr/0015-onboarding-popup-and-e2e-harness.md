# 0015 — Onboarding, popup and e2e harness

## Context

Task 11 ships the first user-facing pages (onboarding and the lock/unlock popup), the shared Playwright fixture, and folds in hardening from the Task 10 review (ruling R25).

## Decision

- **zxcvbn-ts only in onboarding.** `@zxcvbn-ts/core` 4.2.0, `language-common` 4.1.3 and `language-en` 4.1.1 (exact). `src/lib/passphrase/strength.ts` imports them and is imported only by the onboarding page, so the 1.6 MB dictionary chunk is not in `background.js`, the popup chunk or the shared messaging chunk (checked on the built output).
- **One definition of "long enough".** `src/lib/passphrase/rules.ts` holds `MIN_PASSPHRASE_CHARS` (12) and `meetsMinLength`, counted in code points after NFC as the vault always did. The vault, the page handlers and `scorePassphrase` share it. The plan's `p.normalize("NFC").length >= 12` counts UTF-16 units, which would accept 6 emoji that the vault then rejects as `weak`; code points make the UI and the vault agree.
- **`vault-create` checks before it calibrates.** The handler returns `exists` (any stored header, including a corrupt one) or `weak` before `calibrate()`, so an invalid create never spends seconds in Argon2. `createVault` repeats both checks authoritatively.
- **Router hardening.** A falsy runtime id classifies nothing. A page sender whose `origin` is present must equal `chrome-extension://<id>`. `toRuntimeListener` swallows a throwing `sendResponse` (a closed popup). `sendToSw` wraps raw transport errors in `MessagingError("internal")` without the original message. `MAX_MESSAGE_BYTES` is renamed `MAX_MESSAGE_CHARS`, because it has always compared the JSON string length.
- **Popup and onboarding are plain.** Labels are bound to inputs, Enter submits (forms), buttons are disabled while a request is in flight, and an error goes into an `aria-live="polite"` region and receives focus. No `{@html}`. The popup clears its passphrase field as soon as it sends it. The integrity-restored banner shows only for the unlock that returned the warning; a popup opened later cannot know it (the status response does not carry it).
- **Install opens onboarding** from `runtime.onInstalled` with `reason === "install"`, registered synchronously with the other listeners. `tabs.create` needs no `tabs` permission for this.
- **Shared e2e fixture.** `tests/e2e/fixtures.ts` launches a fresh persistent Chromium profile with the built extension and reads the extension id from the service worker URL, asserting the pinned id. The fixture also waits out the idle event described below.
- **E2e and idle.** Refill sets its 15-minute idle interval only once the vault is unlocked, so before the first unlock Chrome uses its default 60 s threshold. A machine with no input for 60 s (a dev box, a CI runner running unattended) is "idle" to Chrome, which sends one `idle.onStateChanged` event shortly after the worker starts. Refill locks on it, as it should. Argon2 calibration blocks the worker for seconds, so a queued event was handled just as `createVault` committed, lock won (ADR 0012), and the vault was created but locked. The fixture therefore waits for that event (only when `idle.queryState(60)` is not `active`, at most 5 s) before handing the worker to a test. No product code changed for this.
- **Confirm field and cleared fields (R27).** Onboarding has a "Confirm passphrase" field; "Create vault" needs the acknowledgment, an acceptable strength and matching fields. Both fields are cleared when a create is sent, whatever the outcome, so a failure means retyping. All passphrase inputs have `maxlength="1024"`, the router's cap in the same unit.

## Consequences

- Real users hit the race only if the screen locks (or 60 s without input passes) during the few seconds of calibration; the vault is then created but locked, onboarding still says "ready" and the popup asks for the passphrase. Locking in that case is correct, so this is accepted.
- The onboarding bundle is large (dictionaries); that is deliberate and confined to a page opened once.
- Error copy for onboarding failures and for transport failures is not fixed by the brief and is minimal; Plan 6 may reword it.

## Status

Accepted
