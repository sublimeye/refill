# Threat model

Maintained with the code (spec §8.5). Sections 1–3 are the baseline copied verbatim from the design
spec (`docs/superpowers/specs/2026-10-26-refill-design.md` §8.1–§8.3); where they diverge, the spec
is authoritative until this file is updated in the same PR as the change (§ references below point into the spec). Section 4 is a STRIDE
analysis per component of the spec §2 architecture. Rows whose control is not built yet say
"Plan N" in the Test column and are filled in as that plan lands.

## 1. Assets
Saved field values, drafts, passphrase, DEK/KEKs, PRF secret, the list of enabled sites (low).

## 2. Adversaries (in scope)
Hostile web pages; compromised/XSS'd target site; malicious other extensions; local attacker with
**read** access to the browser profile on disk (stolen disk/backup); supply-chain attacker (npm);
hijacked publisher account / malicious update.

A local attacker with **write** access can patch the extension itself and is out of scope, but
cheap tamper-evidence is in scope: the plaintext `draftPub`, lock policy and KDF params are
duplicated inside `vault:integrity` (encrypted, AAD-bound) and compared at every unlock; a mismatch
forces the passphrase path, restores the encrypted values and warns the user. Plaintext values
are treated as hints while locked.

## 3. Out of scope / accepted residual risk
- Malware with OS-level access (keyloggers, memory readers).
- Scripts on the *same* origin reading values after Refill fills them. With Auto mode this happens
  without a user action; mitigated (visible, eligible, current-step, once-per-document,
  same-origin form action) to roughly the exposure of typing it yourself. Users can set a profile
  to One gesture.
- DEK raw bytes in `storage.session` RAM may be paged to disk; any Refill extension page can read
  them (see §4.3).
- **Touch ID is not device-bound.** PRF on macOS comes from iCloud Keychain passkeys, which sync
  across the user's Apple ID devices. Anyone who controls the Apple ID (and a device on it) plus a
  copy of the vault data could unlock without the passphrase. Disclosed in the Touch ID enable
  screen; passphrase-only remains available.
- Ciphertext rollback (restoring an older encrypted record) by a disk-write attacker is not
  detected.
- LevelDB may retain deleted ciphertext until compaction (ciphertext only).

## 4. STRIDE per component

S spoofing · T tampering · R repudiation · I information disclosure · D denial of service ·
E elevation of privilege. Repudiation is not applicable to a single-user local tool and is noted
only where an audit trail matters. "Plan N" means the control and its test land in that plan
(Plan 1 foundation, 2 sites and scan/fill, 3 recorder and review, 4 return visit and toast,
5 drafts, 6 pages/design/export, 7 hardening and release).

| Component | Threat | Control | Test |
|---|---|---|---|
| `vault/` (unlock, lock policy, KDF, wrap) | **S** attacker guesses the passphrase offline from a stolen profile. **T** disk-write attacker flips plaintext lock policy, KDF params or `draftPub`. **I** DEK or passphrase lingers in memory or storage. **D** online brute force through the unlock UI. **E** a page or content script triggers unlock/admin operations. | Argon2id (m ≥ 65536 KiB, t ≥ 3, p = 1, 16-byte salt) with NFC-normalised passphrases of ≥ 12 characters; plaintext lock/KDF/`draftPub` duplicated in `vault:integrity` and compared at every unlock, mismatch forces the passphrase path and warns; DEK only in SW memory and `storage.session`; idle (15 min) and hard-max (12 h) locks; passphrase required every 14 days; failed-unlock backoff 1 s doubling to 60 s; unlock only from extension pages. | Plan 1: create/unlock/lock round trips, KDF floor rejection, backoff, integrity-mismatch recovery, lock-trigger tests. Plan 7: release audit. |
| `crypto/` (AES-GCM, ECDH sealing, HKDF, AAD) | **T** ciphertext modified, truncated, or swapped between records. **I** IV reuse or weak key derivation leaks plaintext relations. **E** other modules call WebCrypto ad hoc and skip AAD. | AES-256-GCM with a fresh random 96-bit IV per encryption; AAD binds type, id and origin (`refill/v1\|…`) from a single builder module; HKDF-SHA256 for draft keys; `crypto.subtle` allowed only in `src/lib/crypto/` (Semgrep `refill-subtle-only-in-crypto`). | Plan 1: known-answer tests, wrong-AAD / wrong-key / truncated-ciphertext failures, IV uniqueness. CI today: Semgrep rule. |
| `store/` (single write queue over `storage.local`) | **T** concurrent writes corrupt records; ciphertext swapped or rolled back on disk. **I** plaintext secrets written next to ciphertext. **D** quota exhaustion. **E** any module or page writes arbitrary keys. | One serialized write queue; `storage.local` accessed only from `src/lib/store/` (Semgrep `refill-storage-local-only-in-store`); `storage.sync` banned (Semgrep `refill-no-sync-storage`); only the documented plaintext records (header, site index, settings, draft expiry); draft quotas. Ciphertext rollback is an accepted residual risk (§3). | Plan 1: queue ordering and failure tests, key whitelist. CI today: Semgrep rules. Plan 5: draft quota eviction. |
| `sites/` (optional host permissions ⇄ registered content scripts) | **S** lookalike / punycode origin or http downgrade treated as the enabled site. **T** stale registration after revoke. **E** broad host access, scripts injected on pages the user did not enable. | Exact-origin https matching only; host access requested per site at user gesture via `optional_host_permissions`; reconciler removes scripts when permission is revoked; manifest has no `<all_urls>`, `tabs`, `webRequest`, `cookies`, `history`, `nativeMessaging`. | Plan 2: reconciler tests, lookalike/punycode/http e2e fixtures. CI today: manifest snapshot (`pnpm test:manifest`). |
| `router/` (typed messages, sender validation) | **S** content script or other extension forges origin or admin messages. **T** malformed or oversized payloads. **E** page-reachable messages invoke privileged operations. **D** message flooding. | `externally_connectable` is `{ids: [], matches: []}` and no `onMessageExternal` handler; sender classified by `sender.id`, URL and frame (top frame only); exact-key schema validation and a 64 KiB size cap; content-script messages carry no authority over vault operations; origin taken from `sender`, never from the payload. | Plan 1: sender-classification and protocol-validation unit tests. Plan 7: spoofed-origin / admin-message e2e. CI today: manifest snapshot. |
| `match/` (pure signature matcher) | **T** crafted page structure induces a wrong profile or field match. **I** values matched against attacker-controlled fields (honeypots). | Pure module with no chrome APIs; exact origin and path-prefix match; eligibility rules (visible, current step, never-capture list) applied to both record and fill; values never leave the SW unless matched. | Plan 2: property and unit tests for matching, honeypot fixtures. |
| `drafts/` (write-only sealing, TTL sweep) | **I** disk reader recovers draft contents. **T** draft ciphertext swapped between ids. **D** unbounded draft growth. | ECDH(ephemeral, `draftPub`) → HKDF → AES-GCM with AAD `refill/v1\|draft\|<id>`; only the public key is needed while locked, private key wrapped by the DEK; plaintext only `expiresAt`; quotas (≤ 20 per origin, ≤ 512 KB per origin, ≤ 5 MB total, oldest evicted); alarm-driven TTL purge. | Plan 5: seal/open round trip, wrong-AAD, quota and TTL tests. Plan 1 covers the seal primitive. |
| `recorder/` (per-tab recording sessions in `storage.session`) | **I** captured sensitive fields (passwords, OTP, card numbers) persisted or shown. **T** page injects fake fields into a recording. **R** user cannot tell what was saved. | Never-capture list (§5.3) applied at capture and again at save; mandatory review screen before anything is stored, with dropped values listed; session state in memory-only `storage.session`, cleared on lock and tab close. | Plan 3: never-capture fixtures (password flip, hidden, card-like), review-gate tests. |
| Content script (scan → signature → fill, capture, toast) | **S** page forges the toast or triggers fills. **T** page mutates DOM between scan and fill. **I** same-origin scripts read values after fill; honeypot or cross-origin iframe receives values. **E** page script reaches extension APIs. | Registered only for enabled origins, top frame only; fill rules (visible, eligible, current step, once per document, same-origin form action); optional One-gesture mode per profile; toast in a closed shadow root in the top layer; values only on matched fields; no `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`/`{@html}`/`eval` (Semgrep `refill-no-html-sinks`, `refill-svelte-no-html-sinks`, `refill-no-eval`). Same-origin disclosure after fill is an accepted residual risk (§3). | Plan 2: fill-rule e2e fixtures (hidden honeypot, all-steps honeypot, cross-origin iframe, http downgrade). Plan 4: forged-toast fixture. CI today: Semgrep rules. |
| Extension pages (onboarding, popup, review, dashboard, settings, unlock) | **S** phishing look-alike of the unlock UI in a page. **I** pages hold the DEK or render page-derived data as HTML. **E** XSS in an extension page escalates to full extension power. | Pages never hold the DEK, they request operations from the SW; the unlock UI lives only on extension pages (no in-page secret input); strict CSP `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'none'`; no `{@html}`/`innerHTML`; no web-accessible resources; `@zxcvbn-ts/*` only in onboarding. | Plan 1: onboarding and popup e2e. Plan 6: dashboard/settings. CI today: manifest and CSP snapshot, Semgrep, ESLint. |
| Build and release pipeline (cross-cutting, not in spec §2) | **T** malicious or compromised dependency or GitHub Action; non-reproducible release build. **E** hijacked publisher account or CI secret. **I** secret committed to the repo. | Exact dependency versions and committed lockfile; zero runtime dependencies in the SW except `hash-wasm`; actions pinned by commit SHA (ADR 0005); `pnpm audit` and OSV-Scanner on the lockfile; CodeQL; Semgrep custom rules; reproducible-build check (two clean builds hash identically via `scripts/hash-dir.mjs`); secret scanning with push protection; no store credentials in CI, manual upload of the release zip; branch protection requires `verify` and `analyze`. | CI today: `ci / verify` and `codeql / analyze` workflows. Plan 7: release audit and store 2FA checklist. |
