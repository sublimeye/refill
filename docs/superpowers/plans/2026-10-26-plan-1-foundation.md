# Refill — Plan 1: Foundation (M0 spikes, scaffold & CI, vault) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A loadable Refill extension with zero-warning permissions, CI and security gates, and a
working encrypted vault: onboarding creates it, the popup locks/unlocks it, and lock policies
(idle, screen lock, hard max, restart) are enforced.

**Architecture:** WXT builds an MV3 extension. The service worker is the only holder of keys
(`src/lib/vault`, `src/lib/crypto`); extension pages (Svelte 5) talk to it through a typed,
sender-validated message router. Everything persists through one serialized write queue over
`chrome.storage.local`; the unlocked DEK is mirrored to `chrome.storage.session`.

**Tech Stack:** pnpm 10, Node 23, WXT 0.21, Svelte 5 (`@wxt-dev/module-svelte`), TypeScript strict,
Vitest (+ WXT `fakeBrowser`), Playwright, `hash-wasm` (Argon2id), `@zxcvbn-ts/*`, ESLint, Prettier,
Semgrep, CodeQL, osv-scanner.

**Spec:** `docs/superpowers/specs/2026-10-26-refill-design.md` (read §3, §4, §7, §8, §10 before any task).

**Roadmap (later plans, written after this one ships, using M0 results):**
Plan 2 sites/permissions + scan/fill engine (M2) · Plan 3 recorder + review (M3) · Plan 4 return
visit, toast, badge, unlock-from-toast (M4) · Plan 5 drafts (M5) · Plan 6 design pass, dashboard,
export/import, Touch ID if spike passed (M6) · Plan 7 hardening, release audit, store (M7–M8).

## Global Constraints

- Permissions exactly: `storage`, `activeTab`, `scripting`, `alarms`, `idle`; `optional_host_permissions: ["https://*/*"]`. Never `tabs`, `<all_urls>`, `nativeMessaging`, `webRequest`, `history`, `cookies`.
- `externally_connectable: { "ids": [], "matches": [] }`; no `onMessageExternal` listener; no `web_accessible_resources`.
- Production CSP `extension_pages`: `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self'; font-src 'self'; object-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'` (amended by ADR 0016) (dev builds may omit `connect-src 'none'` for WXT reload).
- `minimum_chrome_version: "127"`; manifest `key` set (stable extension ID).
- No network: no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon` in `src/`.
- No `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`/`{@html}`/`eval`/`new Function`; no `storage.sync`.
- Zero runtime dependencies in the SW except `hash-wasm`; `@zxcvbn-ts/*` only in the onboarding page.
- All `crypto.subtle` calls live in `src/lib/crypto/`. All `storage.local` calls live in `src/lib/store/`.
- AES-256-GCM, fresh random 96-bit IV per encryption. Argon2id floor `m=65536` KiB, `t=3`, `p=1`, 16-byte salt.
- Lock defaults: `idleMinutes: 15`, `maxHours: 12`, `passphraseEveryDays: 14`. Failed-unlock backoff 1 s doubling to 60 s.
- Passphrases are normalized with `String.prototype.normalize("NFC")` before KDF; SW rejects < 12 chars.
- Exact versions pinned in `package.json` (no `^`/`~`); lockfile committed.
- **Every task lands via a PR** (including Tasks 1–2): branch `t<N>-<slug>` → `gh pr create` (body: summary, test evidence, ADRs touched; ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`) → the task reviewer posts its review on the PR (`gh pr review --comment`) → fixes pushed to the same branch → squash-merge once CI is green (CI exists from Task 3; before that, merge after review). Conventional commits. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **ADRs:** any task that makes or changes a meaningful decision (library, algorithm, parameter, permission, data format, deviation from the spec or this plan) adds `docs/adr/NNNN-<slug>.md` (Context / Decision / Consequences / Status) or updates an existing ADR's Status (`Superseded by NNNN`) in the same PR. `docs/adr/README.md` keeps the index.

## Review Focus

1. **SW restart while unlocked** (Chrome kills idle workers after ~30 s): status must come back `unlocked` from `storage.session` without asking again — test in Task 9.
2. **Same passphrase typed in different Unicode forms** (macOS NFD vs NFC input, e.g. `é`): must unlock — test in Task 5 and Task 8.
3. **Two onboarding tabs creating a vault concurrently**: exactly one vault, second call rejects `exists` — test in Task 8.
4. **Corrupted/partial `vault:header`** (hand-edited, truncated, wrong types): `status` returns `corrupt`, unlock fails cleanly, nothing throws uncaught — test in Task 8.
5. **Clock moved backward after failures**: backoff must never block for more than 60 s — test in Task 8.

---

## File Structure

```
refill/
  package.json · pnpm-lock.yaml · wxt.config.ts · tsconfig.json · vitest.config.ts
  eslint.config.js · .prettierrc · playwright.config.ts · LICENSE · README.md
  SECURITY.md · PRIVACY.md
  .github/workflows/ci.yml · .github/workflows/codeql.yml
  .semgrep/refill.yml                    forbidden-API rules (network, HTML sinks, sync, eval)
  scripts/hash-dir.mjs                   deterministic directory hash for reproducible-build check
  security/manifest.expected.json        manifest snapshot (security-relevant keys)
  spikes/m0/                             throwaway probe extension (branch spike/m0 only)
  docs/adr/0001-argon2id-hash-wasm.md · 0002-touch-id-prf.md · 0003-manifest-key.md
  docs/spikes/m0-results.md · docs/security/threat-model.md
  src/
    entrypoints/
      background.ts                      SW wiring: router, lock triggers, onInstalled
      popup/{index.html,main.ts,App.svelte}
      onboarding/{index.html,main.ts,App.svelte}
    lib/
      crypto/bytes.ts                    randomBytes, base64, utf8, canonicalJson
      crypto/aad.ts                      AAD builders (single source of AAD strings)
      crypto/aead.ts                     AES-GCM seal/open, key import, DecryptError
      crypto/kdf.ts                      Argon2id → KEK, calibrate
      crypto/hkdf.ts                     HKDF-SHA256 → AES key
      crypto/draft-seal.ts               ECDH P-256 write-only sealing
      store/queue.ts                     serialized async job queue
      store/local.ts                     typed storage.local access (only module touching it)
      vault/types.ts                     VaultHeader, LockPolicy, UnlockResult, VaultStatus
      vault/header.ts                    header validation (untrusted parse)
      vault/session.ts                   DEK mirror in storage.session
      vault/backoff.ts                   failed-unlock backoff
      vault/vault.ts                     create / unlock / lock / changePassphrase / getDek
      vault/records.ts                   putEncrypted / getEncrypted
      vault/lock-triggers.ts             idle + alarms + startup checks
      messaging/protocol.ts              message unions + validators
      messaging/router.ts                sender classification + dispatch
      passphrase/strength.ts             zxcvbn wrapper (onboarding only)
  tests/
    unit/**                              mirrors src/lib
    manifest/manifest.test.ts            built manifest vs snapshot
    e2e/{fixtures.ts,vault.spec.ts}
```

---

### Task 1: M0 spikes (throwaway) and recorded decisions

Spike code lives on branch `spike/m0`, never merged. Results land via a separate docs PR.

**Files:**
- Create (branch `spike/m0` only): `spikes/m0/manifest.json`, `spikes/m0/probe.html`, `spikes/m0/probe.js`, `spikes/m0/popup.html`, `spikes/m0/popup.js`, `spikes/m0/insert.html`, `spikes/m0/hash-wasm.umd.min.js` (copied from the `hash-wasm` npm tarball `dist/`)
- Create (main): `docs/spikes/m0-results.md`, `docs/adr/0001-argon2id-hash-wasm.md`, `docs/adr/0002-touch-id-prf.md`

**Interfaces:** Produces decisions consumed by Task 5 (Argon2 library + params) and Plan 6 (Touch ID go/no-go).

- [ ] **Step 1: Build the probe extension** (plain MV3, no build step): permissions `storage`, `activeTab`; `optional_host_permissions: ["https://*/*"]`; `action.default_popup: popup.html`; CSP `extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`. `probe.html` has buttons:
  - **(a) PRF create/get:** `navigator.credentials.create` with `rp: { name: "Refill spike" }` (no `rp.id`), `authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", userVerification: "required" }`, `extensions: { prf: { eval: { first: <32 random bytes> } } }`; then `get` with the same salt. Log `getClientExtensionResults().prf` (`enabled`, `results.first` length), errors, and `location.origin`.
  - **(b) Argon2id timing:** `hashwasm.argon2id({ password: "correct horse battery staple", salt: <16 bytes>, parallelism: 1, iterations: t, memorySize: 65536, hashLength: 32, outputType: "binary" })` for `t` in 3, 4, 6; 3 runs each; log median ms.
  - `popup.html` **(c)**: button calls `chrome.permissions.request({ origins: ["https://example.com/*"] })`, writes `{ before: Date.now() }` to `chrome.storage.session` before the await and `{ after: Date.now(), granted }` after; `probe.html` shows both keys so you can see whether code after the await ran.
  - `insert.html` **(d)**: an `<input>` with listeners logging `event.isTrusted` for `input`; a button does `input.focus(); input.select(); document.execCommand("insertText", false, "x")`.
- [ ] **Step 2: Run (a)–(d) in Brave on the user's Mac** (load unpacked; ask the user to perform the Touch ID prompts and permission dialog). Also run (a) in Chrome if installed, with both "iCloud Keychain" and "Chrome profile" choices if offered. Also run (b) in the Brave service-worker context via a `chrome.runtime.sendMessage` round-trip if feasible; otherwise note page-context timing only.
- [ ] **Step 3: Write `docs/spikes/m0-results.md`** — a table per probe: browser + version, macOS version, outcome, raw numbers/log lines.
- [ ] **Step 4: Write ADR 0001** (Argon2id via `hash-wasm` 4.12.0, exact pinned; params: floor `m=65536,t=3,p=1`; calibration target from measured timing — if median at `t=3` > 1500 ms, the ADR records the floor as accepted and calibration never goes below it). **Write ADR 0002** (Touch ID: GO if (a) returned `prf.results.first` of 32 bytes in Brave via a platform passkey; otherwise NO-GO for v1, v2 via native helper). Each ADR: Context / Decision / Consequences / Status.
- [ ] **Step 5: PR** — branch `t1-m0-results` from `main` with `docs/spikes/m0-results.md`, `docs/adr/0001-argon2id-hash-wasm.md`, `docs/adr/0002-touch-id-prf.md`, `docs/adr/README.md` (index); commit `docs: record M0 spike results and ADRs 0001-0002`; open PR; review; merge.

---

### Task 2: Scaffold (WXT + Svelte + strict TS) with manifest snapshot

**Files:**
- Create: `package.json`, `wxt.config.ts`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc`, `LICENSE` (MIT, "Roman Morozov"), `README.md`, `src/entrypoints/background.ts` (empty `defineBackground(() => {})`), `src/entrypoints/popup/{index.html,main.ts,App.svelte}` (placeholder text "Refill"), `security/manifest.expected.json`, `tests/manifest/manifest.test.ts`, `docs/adr/0003-manifest-key.md`, `.refill-dev-key.pem` → **gitignored**

**Interfaces:**
- Produces: `pnpm build` → `.output/chrome-mv3/`; scripts `dev`, `build`, `zip`, `lint`, `typecheck` (`svelte-check && tsc --noEmit`), `test` (vitest unit), `test:manifest` (`pnpm build && vitest run tests/manifest`), `test:e2e`, `format`.

- [ ] **Step 1: Initialize.** `pnpm init`; add exact-version devDeps: `wxt@0.21.5`, `@wxt-dev/module-svelte@2.0.5`, `svelte@5.57.3`, `typescript`, `svelte-check`, `vitest`, `@playwright/test`, `eslint`, `typescript-eslint`, `eslint-plugin-svelte`, `prettier`, `prettier-plugin-svelte` (latest at install, then pin exact); runtime deps: `hash-wasm@4.12.0`. Set `"packageManager": "pnpm@10.33.0"`, `.npmrc` with `save-exact=true`.
- [ ] **Step 2: Generate the manifest key** — `openssl genrsa -out .refill-dev-key.pem 2048`; public key DER base64 → `wxt.config.ts` constant `MANIFEST_KEY`. ADR 0003 records: dev/test use this key; before first store upload (Plan 7, alongside release-please changelog setup) it is replaced by the store-assigned public key, accepted because no user data exists yet.
- [ ] **Step 3: `wxt.config.ts`** — `srcDir: "src"`, `modules: ["@wxt-dev/module-svelte"]`, `manifest: ({ mode }) => ({ name: "Refill", description: "Private, encrypted form memory. Local-only.", key: MANIFEST_KEY, minimum_chrome_version: "127", permissions: [...], optional_host_permissions: [...], externally_connectable: { ids: [], matches: [] }, content_security_policy: { extension_pages: mode === "production" ? PROD_CSP : DEV_CSP } })` with values from Global Constraints. `tsconfig.json` extends `.wxt/tsconfig.json` and sets `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- [ ] **Step 4: Write the failing manifest test** `tests/manifest/manifest.test.ts`:

```ts
const built = JSON.parse(readFileSync(".output/chrome-mv3/manifest.json", "utf8"));
const pick = (m) => ({ permissions: [...m.permissions].sort(), optional_host_permissions: m.optional_host_permissions,
  host_permissions: m.host_permissions ?? [], externally_connectable: m.externally_connectable,
  content_security_policy: m.content_security_policy, web_accessible_resources: m.web_accessible_resources ?? [],
  content_scripts: m.content_scripts ?? [], minimum_chrome_version: m.minimum_chrome_version, has_key: typeof m.key === "string" });
test("security-relevant manifest keys match the reviewed snapshot", () => {
  expect(pick(built)).toEqual(JSON.parse(readFileSync("security/manifest.expected.json", "utf8")));
});
```
- [ ] **Step 5: Run** `pnpm test:manifest` → FAIL (snapshot file empty/missing).
- [ ] **Step 6: Write `security/manifest.expected.json`** by hand from Global Constraints (permissions sorted: `activeTab, alarms, idle, scripting, storage`; `host_permissions: []`; `content_scripts: []`; `web_accessible_resources: []`; `has_key: true`). Do not generate it from the build output.
- [ ] **Step 7: Run** `pnpm test:manifest` → PASS. Load `.output/chrome-mv3` unpacked in Brave: no errors, no permission warnings on the extension details page. If Chrome rejects `externally_connectable.matches: []`, switch to `{ ids: [] }` and note it in ADR 0003.
- [ ] **Step 8: PR** `chore: scaffold WXT + Svelte extension with manifest snapshot` (branch `t2-scaffold`; CI arrives next task, so merge after review).

---

### Task 3: CI, security gates, branch protection

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/codeql.yml`, `.semgrep/refill.yml`, `scripts/hash-dir.mjs`, `SECURITY.md`, `PRIVACY.md`, `docs/security/threat-model.md`

**Interfaces:**
- Produces: required status check names `ci / verify` and `codeql / analyze` used by branch protection.

- [ ] **Step 1: `.semgrep/refill.yml`** rules (all `severity: ERROR`, paths `src/`):
  - `refill-no-network`: `fetch(...)`, `new XMLHttpRequest(...)`, `new WebSocket(...)`, `new EventSource(...)`, `navigator.sendBeacon(...)`.
  - `refill-no-html-sinks`: `$X.innerHTML = ...`, `$X.outerHTML = ...`, `$X.insertAdjacentHTML(...)`, `document.write(...)`; plus a `generic` `pattern-regex: '\{@html'` on `*.svelte`.
  - `refill-no-eval`: `eval(...)`, `new Function(...)`.
  - `refill-no-sync-storage`: `$B.storage.sync`.
  - `refill-subtle-only-in-crypto`: `crypto.subtle` outside `src/lib/crypto/`.
  - `refill-storage-local-only-in-store`: `$B.storage.local` outside `src/lib/store/`.
- [ ] **Step 2: Prove the rules bite** — temporarily add `fetch("x")` to `background.ts`, run `semgrep --config .semgrep/refill.yml --error src` → exit 1 naming `refill-no-network`; revert.
- [ ] **Step 3: `scripts/hash-dir.mjs <dir>`** prints one line `sha256` over the sorted list of `relativePath\0sha256(file)\n` for every file. 
- [ ] **Step 4: `ci.yml`** job `verify` (ubuntu-latest, Node 23, pnpm via `pnpm/action-setup`, `pnpm install --frozen-lockfile`): `lint` → `typecheck` → `test` → `test:manifest` → reproducible build (`pnpm build && node scripts/hash-dir.mjs .output/chrome-mv3 > a.txt && rm -rf .output && pnpm build && node scripts/hash-dir.mjs .output/chrome-mv3 > b.txt && diff a.txt b.txt`) → `semgrep --config .semgrep/refill.yml --error src` (via `returntocorp/semgrep` container step) → `osv-scanner --lockfile=pnpm-lock.yaml` (google/osv-scanner-action) → `pnpm audit --audit-level high` → `npx playwright install --with-deps chromium && pnpm build && pnpm test:e2e` (script is `playwright test --pass-with-no-tests` so it passes until Task 11 adds specs). `codeql.yml`: `javascript-typescript`, on push/PR/weekly.
- [ ] **Step 5: Docs.** `SECURITY.md` (report privately via GitHub Security Advisories; scope; no bounty). `PRIVACY.md` (no data leaves the device; what is stored, encrypted vs plaintext site index per spec §4.2; no analytics). `docs/security/threat-model.md`: copy spec §8.1–§8.3 as the baseline, plus a STRIDE table with one row per component in spec §2 (columns: component, threat, control, test) — rows for components not yet built say "Plan N".
- [ ] **Step 6: Protect main** (after the Step 7 PR merges and both workflows pass on `main`):

```bash
gh api -X PATCH repos/sublimeye/refill -f allow_auto_merge=true -f delete_branch_on_merge=true -f allow_merge_commit=false -f allow_rebase_merge=false
gh api -X PUT repos/sublimeye/refill/branches/main/protection --input - <<'JSON'
{"required_status_checks":{"strict":true,"contexts":["verify","analyze"]},"enforce_admins":false,
 "required_pull_request_reviews":null,"restrictions":null,"allow_force_pushes":false,"allow_deletions":false}
JSON
```
Enable secret scanning + push protection: `gh api -X PATCH repos/sublimeye/refill -F security_and_analysis[secret_scanning][status]=enabled -F security_and_analysis[secret_scanning_push_protection][status]=enabled`.
- [ ] **Step 7: PR** `ci: add CI, CodeQL, Semgrep rules, security docs` (branch `t3-ci`); Step 6's protection is applied after this PR merges and CI is green on `main`.

---

### Task 4: Crypto primitives — bytes, AAD, AES-GCM

**Files:**
- Create: `src/lib/crypto/bytes.ts`, `src/lib/crypto/aad.ts`, `src/lib/crypto/aead.ts`
- Test: `tests/unit/crypto/bytes.test.ts`, `tests/unit/crypto/aead.test.ts`

**Interfaces:**
- Produces:
  - `randomBytes(n: number): Uint8Array`; `toB64(b: Uint8Array): string`; `fromB64(s: string): Uint8Array` (throws `TypeError` on invalid input); `utf8(s: string): Uint8Array`; `fromUtf8(b: Uint8Array): string`; `canonicalJson(v: unknown): string` (sorted keys, no whitespace).
  - `aad`: `{ dekPw(): Uint8Array; dekPrf(credentialId: string): Uint8Array; draftPriv(): Uint8Array; integrity(): Uint8Array; profile(id: string, origin: string): Uint8Array; draft(id: string, expiresAt: number | null): Uint8Array }` producing exactly `refill/v1|dek|pw`, `refill/v1|dek|prf|<credentialId>`, `refill/v1|draft-priv`, `refill/v1|integrity`, `refill/v1|profile|<id>|<origin>`, `refill/v1|draft|<id>|<expiresAt ?? "none">`.
  - `interface Sealed { iv: string; ct: string }` (base64).
  - `importAesKey(raw: Uint8Array, extractable?: boolean): Promise<CryptoKey>` (default non-extractable, AES-GCM, encrypt/decrypt/wrapKey/unwrapKey).
  - `seal(key: CryptoKey, plaintext: Uint8Array, aad: Uint8Array): Promise<Sealed>`; `open(key: CryptoKey, s: Sealed, aad: Uint8Array): Promise<Uint8Array>` throws `DecryptError`.
  - `class DecryptError extends Error`.

- [ ] **Step 1: Write failing tests.** `aead.test.ts`:
  - `seal then open round-trips` with `aad.profile("p1","https://a.example")`.
  - `open with different AAD throws DecryptError` (`aad.profile("p1","https://b.example")`).
  - `open with a different key throws DecryptError`.
  - `flipping one ciphertext byte throws DecryptError`; `truncated ciphertext throws DecryptError`.
  - `two seals of the same plaintext use different IVs` (1000 seals → 1000 distinct `iv`; each `fromB64(iv).length === 12`).
  - `known-answer`: key = 32×`0x00`, IV forced via an internal `sealWithIv` test export = 12×`0x00`, plaintext `utf8("refill")`, AAD `utf8("refill/v1|integrity")` → ciphertext equals the value computed once with Node `crypto.createCipheriv("aes-256-gcm")` and hard-coded in the test (compute it in the test file's comment, not at runtime).
  - `bytes.test.ts`: `fromB64("%%%")` throws; `canonicalJson({b:1,a:{d:2,c:3}}) === '{"a":{"c":3,"d":2},"b":1}'`; AAD strings equal the exact literals above.
- [ ] **Step 2: Run** `pnpm vitest run tests/unit/crypto` → FAIL (modules missing).
- [ ] **Step 3: Implement** the three modules with WebCrypto only. `sealWithIv` is exported for tests but not re-exported from any index.
- [ ] **Step 4: Run** → PASS. Run `pnpm lint && pnpm typecheck`.
- [ ] **Step 5: Commit & PR** `feat(crypto): AES-GCM seal/open with AAD builders`.

---

### Task 5: KDF (Argon2id) and HKDF

**Files:**
- Create: `src/lib/crypto/kdf.ts`, `src/lib/crypto/hkdf.ts`
- Test: `tests/unit/crypto/kdf.test.ts`, `tests/unit/crypto/hkdf.test.ts`

**Interfaces:**
- Consumes: Task 4 `importAesKey`, `utf8`, `randomBytes`, `toB64`, `fromB64`.
- Produces:
  - `interface KdfParams { alg: "argon2id"; v: 1; m: number; t: number; p: 1; salt: string }` (`m` in KiB, `salt` base64 16 bytes).
  - `KDF_FLOOR = { m: 65536, t: 3 } as const`.
  - `newKdfParams(t?: number): KdfParams` (fresh salt, `m = 65536`, `t = max(t ?? 3, 3)`).
  - `deriveKek(passphrase: string, params: KdfParams): Promise<CryptoKey>` — NFC-normalizes, runs `hash-wasm` `argon2id` (hashLength 32, binary), imports non-extractable AES-GCM key; throws `RangeError` if `params.m < 65536 || params.t < 3 || params.alg !== "argon2id"`.
  - `calibrate(timeIt?: (t: number) => Promise<number>): Promise<KdfParams>` — starts at `t=3`, increments while measured ms < 500 and `t < 10`; uses `newKdfParams(t)`.
  - `hkdfAesKey(ikm: Uint8Array, info: Uint8Array, salt?: Uint8Array): Promise<CryptoKey>` — HKDF-SHA256, default salt 32×`0x00`, output non-extractable AES-256-GCM key.

- [ ] **Step 1: Write failing tests.**
  - `argon2id matches an external vector`: hard-code the expected 32-byte hex for password `"password"`, salt `utf8("somesaltsomesalt")`, `m=65536,t=3,p=1`, computed once with the `argon2` CLI (`echo -n password | argon2 somesaltsomesalt -id -t 3 -m 16 -p 1 -l 32 -r`) and pasted into the test. Test calls an internal `argon2Raw(passphrase, params): Promise<Uint8Array>` export.
  - `NFC and NFD passphrases derive the same key`: `"café"` vs `"café"` → sealing with one KEK opens with the other.
  - `deriveKek rejects params below floor` (`m: 32768` → `RangeError`; `t: 2` → `RangeError`).
  - `calibrate raises t until ≥ 500 ms`: fake `timeIt` returning `t * 150` → `t === 4`; returning `2000` → `t === 3`; returning `10` → `t === 10`.
  - `hkdf known-answer`: RFC 5869 test case 1 IKM/salt/info → internal export `hkdfBits(ikm, info, salt, lengthBytes: number): Promise<Uint8Array>` with length 42 equals the RFC OKM; `hkdfAesKey` is built on `hkdfBits`.
  - Mark Argon2 tests with a 20 s timeout.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `hash-wasm` imported as `import { argon2id } from "hash-wasm"`.
- [ ] **Step 4: Run** → PASS. Then `pnpm build` and load in Brave; in the SW console run a one-off `deriveKek` via a temporary dev-only log to confirm WASM runs under the production CSP — remove the log before committing.
- [ ] **Step 5: Commit & PR** `feat(crypto): Argon2id KEK derivation and HKDF`.

---

### Task 6: Write-only draft sealing (ECDH)

**Files:**
- Create: `src/lib/crypto/draft-seal.ts`
- Test: `tests/unit/crypto/draft-seal.test.ts`

**Interfaces:**
- Consumes: Task 4 `aad.draft`, `seal`/`open` internals, Task 5 `hkdfAesKey`.
- Produces:
  - `interface SealedDraft { id: string; expiresAt: number | null; eph: JsonWebKey; iv: string; ct: string }`.
  - `generateDraftKeyPair(): Promise<{ publicJwk: JsonWebKey; privateKey: CryptoKey }>` (P-256 ECDH; private extractable so the vault can wrap it as PKCS#8).
  - `sealDraft(draftPub: JsonWebKey, id: string, expiresAt: number | null, plaintext: Uint8Array): Promise<SealedDraft>`.
  - `openDraft(draftPriv: CryptoKey, draftPub: JsonWebKey, d: SealedDraft): Promise<Uint8Array>` throws `DecryptError`.
  - Key schedule exactly per spec §4.1: `info = utf8("refill/v1|draft|" + id + "|") ‖ raw(eph.pub) ‖ utf8("|") ‖ raw(draftPub)`; AAD `aad.draft(id, expiresAt)`; ephemeral private key generated non-extractable.

- [ ] **Step 1: Write failing tests:** round-trip; `changing expiresAt on the record makes openDraft throw`; `changing id throws`; `swapping eph between two drafts throws`; `a draft sealed to another public key throws`; `sealDraft needs no private key` (call it with only `publicJwk` in scope).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit & PR** `feat(crypto): ECDH write-only draft sealing`.

---

### Task 7: Store — serialized queue and typed local storage

**Files:**
- Create: `src/lib/store/queue.ts`, `src/lib/store/local.ts`
- Test: `tests/unit/store/queue.test.ts`, `tests/unit/store/local.test.ts`

**Interfaces:**
- Produces:
  - `createQueue(): <T>(job: () => Promise<T>) => Promise<T>` — FIFO, one job at a time, a rejected job doesn't stall later jobs.
  - `KEYS = { header: "vault:header", integrity: "vault:integrity", sites: "sites", settings: "settings" } as const`; `profileKey(id: string) => "p:" + id`; `draftKey(id: string) => "d:" + id`.
  - `getItem(key: string): Promise<unknown>` (callers validate), `getMany(prefix: string): Promise<Record<string, unknown>>`, `setItems(items: Record<string, unknown>): Promise<void>`, `removeItems(keys: string[]): Promise<void>`, `withStoreLock<T>(job: () => Promise<T>): Promise<T>` (the shared queue, so read-modify-write sequences are atomic w.r.t. other store writes).
- Uses WXT `browser.storage.local`; tests use `fakeBrowser` from `wxt/testing` with `fakeBrowser.reset()` in `beforeEach`.

- [ ] **Step 1: Write failing tests:** queue runs jobs in order with overlapping delays (`[3,1,2]` ms jobs record `[1st,2nd,3rd]`); a throwing job rejects its own promise and the next job still runs; `getMany("p:")` returns only `p:*`; `withStoreLock` read-modify-write from 50 concurrent increments yields 50.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit & PR** `feat(store): serialized write queue over storage.local`.

---

### Task 8: Vault core — create, unlock, lock, change passphrase, integrity, backoff

**Files:**
- Create: `src/lib/vault/types.ts`, `src/lib/vault/header.ts`, `src/lib/vault/backoff.ts`, `src/lib/vault/session.ts`, `src/lib/vault/vault.ts`, `src/lib/vault/records.ts`
- Test: `tests/unit/vault/vault.test.ts`, `tests/unit/vault/header.test.ts`, `tests/unit/vault/backoff.test.ts`, `tests/unit/vault/records.test.ts`

**Interfaces:**
- Consumes: Tasks 4–7.
- Produces:
  - `types.ts`: `interface LockPolicy { idleMinutes: number; maxHours: number; passphraseEveryDays: number }`; `DEFAULT_LOCK: LockPolicy = { idleMinutes: 15, maxHours: 12, passphraseEveryDays: 14 }`; `interface VaultHeader { v: 1; kdf: KdfParams; wrappedDek: Sealed; prf?: { credentialId: string; salt: string; wrappedDek: Sealed }; draftPub: JsonWebKey; wrappedDraftPriv: Sealed; lock: LockPolicy; lastPassphraseAt: number }`; `type VaultStatus = { state: "none" } | { state: "corrupt" } | { state: "locked"; lock: LockPolicy } | { state: "unlocked"; unlockedAt: number; lock: LockPolicy }`; `type UnlockResult = { ok: true; warning?: "integrity-restored" } | { ok: false; reason: "wrong-passphrase" | "no-vault" | "corrupt" | "backoff"; retryAfterMs?: number }`; `class LockedError extends Error`.
  - `header.ts`: `parseHeader(raw: unknown): VaultHeader | null` — strict structural validation (every field type, `v === 1`, base64 decodes, `lock` values: `idleMinutes` 1–240, `maxHours` 1–72, `passphraseEveryDays` 1–90); returns `null` on anything else.
  - `backoff.ts`: `delayFor(failures: number): number` (`0` for 0, else `min(60_000, 1000 * 2 ** (failures - 1))`); `checkBackoff(now: number): Promise<number>` (ms to wait; clamps a stored `nextAllowedAt` more than 60 000 ms in the future to `now + 60_000`); `recordFailure(now: number): Promise<void>`; `resetBackoff(): Promise<void>` — state `{ failures, nextAllowedAt }` in `storage.session` key `vault:backoff`.
  - `session.ts`: `writeSession(dekRaw: Uint8Array, unlockedAt: number): Promise<void>`; `readSession(): Promise<{ dekRaw: Uint8Array; unlockedAt: number } | null>`; `clearSession(): Promise<void>` — key `vault:session` in `browser.storage.session` (the Semgrep rule restricts only `storage.local`).
  - `vault.ts`: `status(now?: number): Promise<VaultStatus>`; `createVault(passphrase: string, kdf: KdfParams, now?: number): Promise<void>` (throws `Error("exists")` / `Error("weak")` if < 12 chars after NFC); `unlockWithPassphrase(passphrase: string, now?: number): Promise<UnlockResult>`; `lock(): Promise<void>`; `getDek(): Promise<CryptoKey>` (throws `LockedError`; after SW restart rebuilds from `readSession`); `getDraftPrivateKey(): Promise<CryptoKey>`; `changePassphrase(oldP: string, newP: string, kdf: KdfParams): Promise<UnlockResult>`; `onLockChange(cb: (unlocked: boolean) => void): () => void`.
  - `records.ts`: `putEncrypted(key: string, aadBytes: Uint8Array, value: unknown): Promise<void>`; `getEncrypted<T>(key: string, aadBytes: Uint8Array): Promise<T | undefined>` (JSON inside; throws `LockedError` when locked).
- Behavior decided here:
  - `createVault`: random 32-byte DEK; `wrappedDek = seal(KEK_pw, dek, aad.dekPw())`; draft key pair, private exported PKCS#8 and sealed with DEK under `aad.draftPriv()`; `vault:integrity` = `seal(DEK, canonicalJson({ draftPub, lock, kdf }), aad.integrity())`; header + integrity written in one `setItems` inside `withStoreLock`, after re-checking no header exists. Leaves the vault **unlocked** (writes session).
  - `unlockWithPassphrase`: `checkBackoff` → `parseHeader` → derive → open `wrappedDek` (DecryptError ⇒ `recordFailure`, `wrong-passphrase`) → open integrity and compare `canonicalJson` of `{draftPub, lock, kdf}` with header; mismatch ⇒ rewrite header fields from the integrity copy and return `warning: "integrity-restored"` → `resetBackoff`, set `lastPassphraseAt = now`, `writeSession`.
  - In-memory DEK held as non-extractable `CryptoKey`; raw bytes exist only transiently to write the session.

- [ ] **Step 1: Write failing tests** (`fakeBrowser`, real WebCrypto, Argon2 with floor params; 30 s timeouts):
  - `status is none before create`; `create → status unlocked`; `lock → status locked`; `unlock with right passphrase → ok`; `wrong passphrase → wrong-passphrase`.
  - `NFD passphrase unlocks a vault created with NFC` (Review Focus 2).
  - `two concurrent createVault calls create exactly one vault` — `Promise.allSettled` → one fulfilled, one rejected `exists`; `getItem(KEYS.header)` decrypts with the fulfilled passphrase (Review Focus 3).
  - `corrupt header`: for each of `{}`, `"garbage"`, header with `v: 2`, header with `kdf.m: "x"`, header with truncated `wrappedDek.ct` → `status().state === "corrupt"` and `unlockWithPassphrase` resolves `{ ok: false, reason: "corrupt" }` (Review Focus 4).
  - `backoff`: after 3 failures `checkBackoff(now)` returns 4000; unlock during backoff returns `reason: "backoff"` without running the KDF (spy on `deriveKek`); `delayFor(20) === 60000`; stored `nextAllowedAt = now + 10 days` (clock moved back) → `checkBackoff(now) <= 60000` (Review Focus 5).
  - `integrity`: tamper header `lock.maxHours` to 72 → unlock returns `warning: "integrity-restored"` and header `lock.maxHours` is back to 12; tamper `draftPub` → restored.
  - `changePassphrase`: old fails afterwards, new works, `p:x` record written before change still decrypts (DEK unchanged).
  - `records`: `putEncrypted`/`getEncrypted` round-trip; reading with a different AAD throws `DecryptError`; when locked both throw `LockedError`.
  - `getDek after simulated SW restart`: reset the module's in-memory state (export `__resetForTests`), session still present → `getDek` resolves; after `clearSession` → `LockedError`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `pnpm lint && pnpm typecheck`.
- [ ] **Step 5: Commit & PR** `feat(vault): encrypted vault with integrity check and unlock backoff`.

---

### Task 9: Lock triggers and SW lifecycle

**Files:**
- Create: `src/lib/vault/lock-triggers.ts`
- Modify: `src/entrypoints/background.ts`
- Test: `tests/unit/vault/lock-triggers.test.ts`

**Interfaces:**
- Consumes: Task 8 `lock`, `status`, `onLockChange`, `readSession`.
- Produces:
  - `HARD_MAX_ALARM = "refill-hard-max"`.
  - `installLockTriggers(): void` — synchronous listener registration (must run at SW top level): `browser.idle.onStateChanged` (`"locked"` or `"idle"` ⇒ `lock()`), `browser.alarms.onAlarm` (`HARD_MAX_ALARM` ⇒ `lock()`), `onLockChange(true)` ⇒ `idle.setDetectionInterval(lock.idleMinutes * 60)` and `alarms.create(HARD_MAX_ALARM, { when: unlockedAt + maxHours * 3_600_000 })`; `onLockChange(false)` ⇒ `alarms.clear(HARD_MAX_ALARM)`.
  - `enforceOnWake(now?: number): Promise<void>` — called at SW start: if session exists and `now >= unlockedAt + maxHours*3_600_000` ⇒ `lock()`; also ⇒ `lock()` when `now - header.lastPassphraseAt > passphraseEveryDays * 86_400_000` (only matters once Touch ID exists).
  - `background.ts`: top-level `browser.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })`, `installLockTriggers()`, `enforceOnWake()`.

- [ ] **Step 1: Write failing tests** (`fakeBrowser`, triggering events via `fakeBrowser.idle.onStateChanged.trigger("locked")` etc.):
  - `screen lock locks the vault`; `idle locks the vault`; `"active" does not lock`.
  - `unlock schedules hard-max alarm at unlockedAt + 12h`; `alarm fires → locked`; `lock clears the alarm`.
  - `SW restart while unlocked keeps it unlocked` — create vault, reset module memory, call `enforceOnWake(now + 60_000)` → `status().state === "unlocked"` (Review Focus 1).
  - `SW wake after hard max locks` — `enforceOnWake(unlockedAt + 12h + 1)` → `locked`.
  - `setDetectionInterval called with 900` for default policy.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit & PR** `feat(vault): idle, screen-lock and hard-max lock triggers`.

---

### Task 10: Messaging protocol and sender-validated router

**Files:**
- Create: `src/lib/messaging/protocol.ts`, `src/lib/messaging/router.ts`
- Modify: `src/entrypoints/background.ts`
- Test: `tests/unit/messaging/router.test.ts`

**Interfaces:**
- Consumes: Task 8 vault API.
- Produces:
  - `protocol.ts`: `type PageRequest = { type: "vault-status" } | { type: "vault-create"; passphrase: string } | { type: "vault-unlock"; passphrase: string } | { type: "vault-lock" }`; `type PageResponse<R extends PageRequest>` mapping to `VaultStatus` / `{ ok: true } | { ok: false; error: "exists" | "weak" }` / `UnlockResult` / `{ ok: true }`; `parsePageRequest(raw: unknown): PageRequest | null` (exact keys only, string lengths ≤ 1024, rejects extra keys); `MAX_MESSAGE_BYTES = 65_536`; `type ContentRequest = never` (placeholder union extended in Plan 2); `sendToSw<R extends PageRequest>(req: R): Promise<PageResponse<R>>` helper for pages.
  - `router.ts`: `type SenderKind = "page" | "content"`; `classifySender(sender: Browser.runtime.MessageSender, runtimeId: string): SenderKind | null` — `page` iff `sender.id === runtimeId` and `sender.url` starts with `chrome-extension://${runtimeId}/` and (`!sender.tab` or `sender.tab.url` starts with that same prefix); `content` iff `sender.id === runtimeId`, `sender.tab` present, `sender.frameId === 0`, `sender.origin` starts with `https://`; otherwise `null`. `createRouter(handlers: { page: { [K in PageRequest["type"]]: (req: Extract<PageRequest, { type: K }>) => Promise<unknown> } }): (msg: unknown, sender: Browser.runtime.MessageSender) => Promise<unknown> | undefined` — oversized (`JSON.stringify(msg).length > MAX_MESSAGE_BYTES`), unparseable, unclassified, or wrong-kind messages resolve `{ ok: false, error: "rejected" }` and are never dispatched; `background.ts` wires `vault-create` to `createVault(passphrase, await calibrate())`; router tests inject handlers that use `newKdfParams()` so they stay fast.
  - `background.ts`: `browser.runtime.onMessage.addListener(router)` — no `onMessageExternal`.

- [ ] **Step 1: Write failing tests:**
  - `page sender (popup, no tab) can call vault-status`.
  - `content-script sender cannot call vault-unlock` → `rejected`, handler spy not called.
  - `sender with another extension id is rejected`; `sender.frameId 1 is not content`; `http:// origin is not content`; `page URL from a different extension id is rejected`.
  - `extra keys rejected` (`{ type: "vault-lock", x: 1 }`); `oversized message rejected` (70 KB passphrase); `passphrase of 1025 chars rejected`.
  - `vault-create → vault-lock → vault-unlock round-trip through the router` (real vault, floor KDF).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit & PR** `feat(messaging): sender-validated typed router for vault operations`.

---

### Task 11: Onboarding and popup (functional), E2E harness

Visual polish is Plan 6; this task ships plain, accessible, keyboard-usable UI with copy fixed below.

**Files:**
- Create: `src/entrypoints/onboarding/{index.html,main.ts,App.svelte}`, `src/lib/passphrase/strength.ts`, `playwright.config.ts`, `tests/e2e/fixtures.ts`, `tests/e2e/vault.spec.ts`
- Modify: `src/entrypoints/popup/App.svelte`, `src/entrypoints/background.ts`, `package.json` (deps `@zxcvbn-ts/core`, `@zxcvbn-ts/language-common`, `@zxcvbn-ts/language-en`, exact)
- Test: `tests/unit/passphrase/strength.test.ts`

**Interfaces:**
- Consumes: Task 10 `sendToSw`.
- Produces:
  - `strength.ts`: `scorePassphrase(p: string): { score: 0 | 1 | 2 | 3 | 4; acceptable: boolean; feedback: string }` — `acceptable` iff `score >= 3 && p.normalize("NFC").length >= 12`.
  - `background.ts`: `browser.runtime.onInstalled` with `reason === "install"` ⇒ `browser.tabs.create({ url: browser.runtime.getURL("/onboarding.html") })`.
  - `tests/e2e/fixtures.ts`: Playwright `test` extended with `context` (persistent, `channel: "chromium"`, `--disable-extensions-except` / `--load-extension` = `.output/chrome-mv3`) and `extensionId` (read from the SW URL; assert it equals the ID derived from `MANIFEST_KEY`).
- Copy (exact):
  - Onboarding heading "Create your Refill passphrase"; body "Refill encrypts everything it saves with this passphrase. There is no recovery: if you forget it, your saved forms are gone."; checkbox "I understand there is no recovery"; button "Create vault"; success "Refill is ready. Pin it to your toolbar, then open a form you fill often."
  - Popup none: "Set up Refill" button (opens onboarding). Locked: label "Passphrase", button "Unlock", errors "Wrong passphrase" / "Too many attempts — try again in {n} s" / "Refill's vault data is damaged". Unlocked: "Unlocked" + button "Lock now"; warning banner "Some vault settings were changed outside Refill and have been restored." when `integrity-restored`.

- [ ] **Step 1: Write failing unit tests** for `scorePassphrase`: `"password123"` not acceptable; `"correct horse battery staple"` acceptable; an 11-char strong random string not acceptable (length rule).
- [ ] **Step 2: Write failing E2E** `vault.spec.ts`:
  - `install opens onboarding` (a page with URL ending `/onboarding.html` appears).
  - `create vault requires acknowledgment` (button disabled until checkbox + acceptable passphrase).
  - `create → popup shows Unlocked → Lock now → Locked → wrong passphrase shows "Wrong passphrase" → right passphrase → Unlocked` (open `chrome-extension://<id>/popup.html` as a tab).
  - `no permission warnings`: built manifest has no `host_permissions` (sanity duplicate of Task 2 at runtime: `chrome.permissions.getAll()` from the popup page returns `origins: []`).
- [ ] **Step 3: Run** `pnpm build && pnpm test:e2e` and `pnpm vitest run tests/unit/passphrase` → FAIL.
- [ ] **Step 4: Implement** pages (Svelte 5 runes; no `{@html}`; labels bound to inputs; Enter submits; focus management on error) and the `onInstalled` handler.
- [ ] **Step 5: Run** all: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:manifest && pnpm build && pnpm test:e2e` → PASS. Manually load in Brave and walk the same flow once; note result in the PR description.
- [ ] **Step 6: Commit & PR** `feat: onboarding and popup lock/unlock with e2e harness`.

---

### Task 12: Plan 1 close-out — threat-model update and independent review

**Files:**
- Modify: `docs/security/threat-model.md`, `README.md`

- [ ] **Step 1:** Update the STRIDE rows for crypto, store, vault, lock triggers, router with the concrete control and the test file that proves it.
- [ ] **Step 2:** README: what Refill is, status ("pre-release, Plan 1 of 7"), build/test commands, link to spec, threat model, SECURITY.md.
- [ ] **Step 3:** Dispatch one fresh-context reviewer (most capable model) with only the repo path, the spec, and this plan: audit `src/lib/**` against spec §4 and §8 and the Global Constraints; every finding becomes a GitHub issue labeled `security` or `bug`; fix Critical/High before closing Plan 1.
- [ ] **Step 4:** Commit & PR `docs: Plan 1 threat-model update and README`; tag `v0.1.0-foundation` after merge.
