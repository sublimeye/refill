# Refill — Plan 2: Sites & permissions, scan and fill engine (M2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can enable Refill on a site from the popup (per-origin permission, dynamic content
script), and on an enabled site with an unlocked vault Refill scans the page, matches eligible
controls against the site's encrypted profile in the service worker, and fills them safely — proven
end to end on local fixture sites. (Profiles are created by the recorder in Plan 3; here they are
seeded through an e2e-only test seam.)

**Architecture:** `src/lib/sites/` owns origins, the plaintext site index, pending intents and the
content-script reconciler. `src/lib/fields/` (DOM, content-script side) produces signatures and
eligibility; `src/lib/match/` (pure, SW side) scores signatures against a profile; `src/lib/fill/`
(DOM) writes values. The content script (`src/entrypoints/refill-content.ts`, WXT unlisted script,
registered at runtime) sends signatures only; the SW replies with values only for controls it
matched. Profiles are encrypted records (`p:<id>`, `aad.profile`).

**Tech Stack:** as Plan 1, plus Vitest browser mode (Playwright provider, Chromium), `react` /
`react-dom` / `vue` as devDependencies for controlled-input tests, `openssl` (CI + macOS) for the
e2e TLS fixture certificate.

**Spec:** `docs/superpowers/specs/2026-10-26-refill-design.md` — read §3.1, §4.2, §5, §7, §8 before any task. Plan 1 (`docs/superpowers/plans/2026-10-26-plan-1-foundation.md`) Global Constraints still apply. Carry-overs: GitHub issue #16.

## Global Constraints

- All Plan 1 Global Constraints hold (permissions, CSP, no network, `crypto.subtle` only in `src/lib/crypto/`, `storage.local` only in `src/lib/store/`, exact versions, PR per task, ADR per meaningful decision, `now` never taken from a message payload).
- The production manifest does not change: `content_scripts: []`, `host_permissions: []`, no `web_accessible_resources`. Content scripts exist only via `chrome.scripting.registerContentScripts` with `id: "refill-content"`, `allFrames: false`, `runAt: "document_idle"`, `world: "ISOLATED"`, `persistAcrossSessions: true`, `matches` = `["<origin>/*"]` per enabled granted origin.
- Only `https:` origins are eligible, normalized via `new URL(x).origin` (lowercase, punycode, default port elided). Exact-origin equality everywhere; no eTLD+1, globs or substring matching.
- The content script never receives a value the SW did not match on that page; it sends signatures, never field values. It logs nothing that contains page or field data.
- Content-script messages: `JSON.stringify(msg).length <= 65_536`; at most 300 controls per scan; every string field ≤ 256 UTF-16 units; exact keys only.
- The origin used by every content handler is `sender.origin`; the path is `new URL(sender.url).pathname`. Payload origins/URLs are ignored.
- Fill rules (spec §5.5) are enforced in the content script before every write: vault plan says `fill`, control eligible (spec §5.2), not sensitive (spec §5.3), current value is `""` or `=== pageDefault`, enclosing form's `action` (if any) resolves to `sender.origin`, top frame, field not yet filled in this document.
- e2e seams compile only when `import.meta.env.MODE === "e2e"`; the production build is checked by CI to contain no seam marker strings.
- Weights (spec §5.4): autocomplete 4, name 3 (name/id derived pair counted once), labelText 3, idStable 2 (only if not derived from name), formAction 1, ordinal 1; match iff score ≥ 5 and unique best with margin ≥ 2; step tie-break Jaccard ≥ 0.5.

## Review Focus

1. **User revokes site access in Chrome's own menu while a tab is open** → the reconciler marks the site `accessRevoked`, unregisters the script, and later `scan-report`s from that tab are rejected (no values sent) — tests in Task 3 and Task 11.
2. **Page with thousands of inputs** → scan stops at 300 controls, reports `truncated: true`, never hangs the page (budget: < 50 ms for 2 000 inputs in browser-mode test) — test in Task 9.
3. **Vault locks between scan and fill** (SW restart, idle) → the reply is `{ state: "locked" }`, nothing fills, no partial values leak — test in Task 11.
4. **Same origin, path outside the profile's `pathPrefix`** (e.g. `/account` vs `/billpay`) → no fill — tests in Task 7 and Task 12.
5. **User typed into a field before Refill's scan finished** → the typed value is never overwritten (empty-or-`pageDefault` rule) — test in Task 10.

---

## File Structure

```
src/
  entrypoints/
    refill-content.ts              content script (unlisted): scan → report → apply plan
    background.ts                  + reconciler wiring, content router, e2e seam (MODE gated)
    popup/App.svelte               + site section (enable / status / remove)
  lib/
    sites/origin.ts                normalizeOrigin, originPattern
    sites/index.ts                 SiteRecord, readSites, upsertSite, removeSite (tx-aware)
    sites/intent.ts                pending intent in storage.session
    sites/reconcile.ts             registerContentScripts ⇄ granted origins ⇄ site index
    sites/handlers.ts              page handlers: site-status, site-enable, site-remove
    fields/signature.ts            Sig, buildSignature, labelText, idStable, derivedPair
    fields/eligibility.ts          isEligible, controlKind
    fields/sensitive.ts            isSensitive, PasswordHistory (type-flip watcher)
    fields/scan.ts                 scanDocument → ScannedControl[] (+ element refs, cap 300)
    match/match.ts                 profileApplies, scoreSig, matchControls (pure)
    fill/fill.ts                   fillControl, FillSnapshot, withFillingGuard
    profiles/types.ts              Profile, ProfileField, parseProfile
    profiles/store.ts              saveProfile, loadProfileForOrigin (encrypted)
    messaging/content-protocol.ts  ContentRequest, parseContentRequest, FillPlan
    messaging/content-handlers.ts  scan-report, fill-result handlers
    messaging/router.ts            + content dispatch with enabled-site check
tests/
  browser/**                       Vitest browser mode (real Chromium DOM, React, Vue)
  unit/{sites,match,profiles,messaging}/**
  e2e/fixtures-server.ts           HTTPS static server, two origins, self-signed cert
  e2e/sites/*.html                 fixture pages
  e2e/{sites,fill}.spec.ts
scripts/check-no-seams.mjs         fails if a prod build contains e2e seam markers
```

---

### Task 1: E2E harness — HTTPS fixture origins, e2e build mode, seam guard

**Files:**
- Create: `tests/e2e/fixtures-server.ts`, `tests/e2e/sites/index.html` (placeholder "fixture ok"), `scripts/check-no-seams.mjs`, `tests/unit/check-no-seams.test.ts`
- Modify: `wxt.config.ts`, `package.json` (scripts `build:e2e`, `test:e2e` builds e2e first), `tests/e2e/fixtures.ts`, `.github/workflows/ci.yml`, `docs/adr/` (new ADR)

**Interfaces:**
- Produces: e2e build at `.output/chrome-mv3-e2e` (verify WXT's mode-suffixed outDir; set `outDirTemplate` explicitly if needed) whose manifest additionally has `host_permissions: ["https://localhost/*"]`; fixture origins `https://localhost:4510` (`FIXTURE_A`) and `https://localhost:4511` (`FIXTURE_B`) exported from `tests/e2e/fixtures-server.ts` with `startFixtureServers(): Promise<{ close(): Promise<void> }>` serving `tests/e2e/sites/` on both ports; Playwright fixture `sites` (worker-scoped) starting them; contexts launched with `ignoreHTTPSErrors: true` and the e2e extension path.
- `SEAM_MARKER = "__refillE2E"` — every seam identifier contains it.

- [ ] **Step 1:** Test `check-no-seams.test.ts`: a temp dir with `a.js` containing `__refillE2E` → exit 1 naming the file; clean dir → exit 0; empty or missing dir → non-zero (fail closed, like `check-built-network.mjs`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `scripts/check-no-seams.mjs <dir>`.
- [ ] **Step 4:** `wxt.config.ts`: `mode === "e2e"` adds `host_permissions: ["https://localhost/*"]`; production unchanged (manifest snapshot test still passes untouched). Certificate: generated per run by `startFixtureServers` with `openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=localhost -days 1` into a temp dir (never committed).
- [ ] **Step 5:** Smoke spec `tests/e2e/sites.spec.ts › fixture origins are reachable`: page.goto both origins → "fixture ok".
- [ ] **Step 6:** CI: after the production build steps run `node scripts/check-no-seams.mjs .output/chrome-mv3`; the e2e step runs `pnpm build:e2e && pnpm test:e2e`. ADR: "E2E HTTPS fixture origins and e2e build mode" (why https+self-signed instead of an http exception in product code; why pre-granted host_permissions only in e2e).
- [ ] **Step 7:** All checks green; PR `test(e2e): https fixture origins, e2e build mode, seam guard`.

---

### Task 2: Origins, site index, pending intents

**Files:**
- Create: `src/lib/sites/origin.ts`, `src/lib/sites/index.ts`, `src/lib/sites/intent.ts`
- Test: `tests/unit/sites/origin.test.ts`, `tests/unit/sites/index.test.ts`, `tests/unit/sites/intent.test.ts`

**Interfaces:**
- `normalizeOrigin(url: string): string | null` — `null` unless `https:`; returns `URL.origin`. `originPattern(origin: string): string` → `origin + "/*"`.
- `interface SiteRecord { profileId: string | null; drafts: boolean; ttl: number | null; accessRevoked: boolean }`; `DEFAULT_TTL_MS = 604_800_000`.
- `readSites(tx?: StoreTx): Promise<Record<string, SiteRecord>>` — strict validation; invalid entries dropped (never throws on garbage); `upsertSite(origin: string, patch: Partial<SiteRecord>, tx?: StoreTx): Promise<SiteRecord>` (creates `{ profileId: null, drafts: false, ttl: DEFAULT_TTL_MS, accessRevoked: false }` then applies patch; uses `withStoreLock` when no tx); `removeSite(origin: string, tx?: StoreTx): Promise<void>`.
- `type IntentKind = "enable"`; `interface PendingIntent { tabId: number; origin: string; kind: IntentKind; ts: number }`; `INTENT_TTL_MS = 120_000`; `writeIntent(i: PendingIntent)`, `takeIntent(origin: string, now?: number): Promise<PendingIntent | null>` (removes it; expired → null) — `storage.session` key `sites:intent`.

- [ ] **Step 1: Failing tests:** `normalizeOrigin("https://BÜCHER.example:443/x?y")` → `"https://xn--bcher-kva.example"`; `http://…`, `file://…`, `chrome-extension://…`, `"garbage"` → `null`; port kept when non-default. Site index: garbage values (`"x"`, `{profileId: 5}`, extra keys, non-https origin keys) dropped on read; upsert inside a caller's `withStoreLock` via `tx` does not deadlock; concurrent upserts for two origins both persist. Intent: take after 121 s → null; take for another origin → null and the intent is kept; take twice → second null.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS + lint/typecheck. **Step 5:** PR `feat(sites): origins, site index, pending intents`.

---

### Task 3: Reconciler, permission events, site page handlers

**Files:**
- Create: `src/lib/sites/reconcile.ts`, `src/lib/sites/handlers.ts`, `src/lib/sites/popup-flow.ts`, `src/entrypoints/refill-content.ts` (stub: on load sends nothing yet; sets `document.documentElement.dataset.refillLoaded = "1"` only in e2e mode for detection)
- Modify: `src/lib/messaging/protocol.ts` (page requests), `src/lib/messaging/page-handlers.ts`, `src/entrypoints/background.ts`
- Test: `tests/unit/sites/reconcile.test.ts`, `tests/unit/sites/handlers.test.ts`, `tests/unit/messaging/router.test.ts` (new types)

**Interfaces:**
- `CONTENT_SCRIPT_ID = "refill-content"`; `CONTENT_SCRIPT_FILE` = the built path of the unlisted script (verify, e.g. `"/refill-content.js"`).
- `reconcile(): Promise<void>` — desired = origins with a site record AND `permissions.contains({origins:[originPattern(o)]})`; site records whose permission is missing get `accessRevoked: true` (and `false` again when regained); registers/updates/unregisters exactly one script id with `matches = desired.map(originPattern)` (unregister when empty). Serialized: concurrent calls coalesce (no double-register errors).
- `installSiteListeners(): void` (sync, top level): `runtime.onInstalled`, `runtime.onStartup` → `reconcile()`; `permissions.onAdded(p)` → for each https origin in `p.origins`: `takeIntent(origin)` → if intent: `upsertSite(origin, {accessRevoked:false})`, `reconcile()`, `scripting.executeScript({ target: { tabId: intent.tabId }, files: [CONTENT_SCRIPT_FILE] })` (ignore failures from closed tabs) else just `reconcile()`; `permissions.onRemoved` → `reconcile()`.
- Page requests (add to `PageRequest`, exact keys, origin ≤ 256 chars): `{ type: "site-status"; origin: string }` → `{ origin: string; enabled: boolean; granted: boolean; accessRevoked: boolean; hasProfile: boolean } | { origin: null }` (`origin: null` when not https); `{ type: "site-enable"; tabId: number; origin: string }` → `{ ok: true } | { ok: false; error: "not-granted" | "invalid-origin" }` — only when `permissions.contains` is already true (the popup's already-granted path; spec §3.1 step 2); `{ type: "site-remove"; origin: string }` → removes site record (and its profile record if any), `permissions.remove({origins:[pattern]})`, `reconcile()` → `{ ok: true }`.
- Page-side helper for the popup in Task 4: `requestSiteEnable(tabId: number, origin: string): Promise<"granted-pending" | "enabled" | "denied">` in `src/lib/sites/popup-flow.ts` — writes the intent via a new page request `{ type: "site-intent"; tabId: number; origin: string }` **before** `permissions.request`, does no work after the await except returning (spec §3.1, ADR 0007); if `permissions.contains` is already true it sends `site-enable` instead.

- [ ] **Step 1: Failing tests** (fakeBrowser + small `scripting`/`permissions` shims): granted+record → registered with exact matches; record without permission → `accessRevoked: true` and not registered; permission without record → not registered; revoke via `onRemoved` → unregistered and `accessRevoked` (Review Focus 1); `onAdded` with intent → site created, script registered, `executeScript` called with intent's tabId; `onAdded` without intent → reconcile only; two concurrent `reconcile()` calls → one registration; `site-enable` when not granted → `not-granted`; `site-remove` removes record, profile record and permission; router rejects `site-*` from content senders; origin strings > 256 rejected.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (listeners registered synchronously in `background.ts` before any await). **Step 4:** PASS. ADR: "Content-script registration and permission reconciler" (unlisted script + manual registration, WXT #2239; single registration id; executeScript after grant). **Step 5:** PR `feat(sites): reconciler, permission listeners, site handlers`.

---

### Task 4: Popup — enable / status / remove for the current site

**Files:**
- Modify: `src/entrypoints/popup/App.svelte`
- Modify: `tests/e2e/sites.spec.ts` (extend). Uses `src/lib/sites/popup-flow.ts` created in Task 3.

**Interfaces:**
- Consumes: Task 3 page requests; `browser.tabs.query({ active: true, currentWindow: true })` (URL readable via `activeTab` after the action click; in e2e the popup opens as a tab, so the spec passes the target tab id/url via query params `?tabId=&url=` **only in e2e mode** — seam marker in the param name: `__refillE2E_tab`).
- Copy (exact): section title "This site"; not https: "Refill works on secure (https) sites only."; not enabled: button "Enable Refill on this site" + help "Refill will ask Chrome for access to this site only."; enabled: "Enabled on {host}" + button "Remove site" (confirm text: "Remove {host} and its saved form?" with "Remove" / "Cancel" in-popup, no `confirm()`); revoked: "Access to {host} was turned off in Chrome. Enable again to use Refill here." + button "Enable again".
- The site section shows only when the vault exists; enabling works while locked (no secrets involved).

- [ ] **Step 1: Failing e2e** (e2e build, pre-granted localhost): popup for `FIXTURE_A` tab shows "Enable Refill on this site" → click → "Enabled on localhost:4510"; the fixture tab now has `data-refill-loaded="1"` without reload (executeScript path); "Remove site" → confirm → back to not enabled, and a reload of the fixture tab has no marker; non-https tab (`about:blank`) shows the https-only copy.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (unit + e2e). **Step 5:** PR `feat(popup): enable, status and remove for the current site`.

---

### Task 5: Field signatures (browser mode)

**Files:**
- Create: `src/lib/fields/signature.ts`, `vitest.browser.config.ts`, `tests/browser/fields/signature.test.ts`
- Modify: `package.json` (devDeps `@vitest/browser-playwright` (or the Vitest 5 equivalent), `react`, `react-dom`, `vue` — exact; script `test:browser`), `.github/workflows/ci.yml` (run `test:browser` in `verify`), ADR (Vitest browser mode)

**Interfaces:**
- `interface Sig { name: string | null; idStable: string | null; autocomplete: string | null; type: string; labelText: string | null; ordinal: number; formAction: string | null; nameIdDerived: boolean }`
- `buildSignature(el: FormControl, ordinal: number, formAction: string | null): Sig` where `type FormControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement`.
- `labelText(el): string | null` — sources in order `label[for=id]`, wrapping `<label>`, `aria-labelledby` (joined), `aria-label`, `placeholder`; normalize: lowercase, collapse whitespace, trim, strip trailing `*` and `:` (repeatedly), digits kept; truncate to 256.
- `idStable(id: string): string | null` — `null` for: `""`; ≥ 4 consecutive digits; hex/base64-ish run ≥ 12 chars with mixed letters+digits; React `:r…:`/`«r…»` ids; `/^[a-z][\w-]*[-_]\d+$/i` sequential (`mat-input-3`, `field_12`).
- `nameIdDerived(name, id): boolean` — true when equal after mapping `$`→`_` (ASP.NET `ctl00$Main$Acct` ↔ `ctl00_Main_Acct`) or equal case-insensitively.
- `autocomplete`: lowercased token list; `on`/`off`/`""` → `null`.

- [ ] **Step 1: Failing tests** with real DOM: each label source; trailing `*`/`:` stripped; "Address 1"/"Address 2" distinct; generated-id cases (`:r1:`, `mat-input-3`, `field_12`, `a8f3c9e21b7d44e0`, `input-123456`) → null, stable ids (`email`, `account-number`) kept; ASP.NET derived pair → `nameIdDerived: true`; autocomplete normalization.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** PR `feat(fields): control signatures`.

---

### Task 6: Eligibility, sensitive-field classifier, type-flip history

**Files:**
- Create: `src/lib/fields/eligibility.ts`, `src/lib/fields/sensitive.ts`
- Test: `tests/browser/fields/eligibility.test.ts`, `tests/browser/fields/sensitive.test.ts`

**Interfaces:**
- `type ControlKind = "text" | "select" | "checkbox" | "radio"`; `controlKind(el): ControlKind | null` — text-like input types `text, email, tel, number, date, search, url` and `textarea` → `"text"`; others null.
- `isEligible(el, doc = el.ownerDocument): boolean` — exactly spec §5.2: kind non-null, top frame, `!disabled`, `!readOnly`, `el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })`, rect ≥ 4×4, rect intersects `[0, scrollWidth] × [0, scrollHeight]` of the document, no `[inert]` / `[aria-hidden="true"]` ancestor, and when the rect intersects the viewport `doc.elementFromPoint(center)` is the element or a descendant.
- `class PasswordHistory` — `observe(root: Document)` watches `type` attribute changes; `wasPassword(el): boolean` (ever `type=password` in this document, incl. at observe time).
- `isSensitive(el, sig: Sig, history: PasswordHistory): boolean` — spec §5.3: type `password`/`hidden`/`file`, history says was-password, computed `-webkit-text-security` ≠ `none`, autocomplete in {`current-password`,`new-password`,`one-time-code`} or starts with `cc-`, name/label/id matching (case-insensitive word-ish) `pass(word)?|pwd|\bpin\b|otp|2fa|mfa|totp|verification code|cvv|cvc|csc|security code|ssn|social security|card ?number|seed|mnemonic|recovery phrase|__viewstate|__eventvalidation|csrf|xsrf|token|nonce`, captcha-like (`captcha` in name/id/label/class).
- `looksLikeCardNumber(value: string, sig: Sig): boolean` — Luhn-valid 13–19 digits (spaces/dashes stripped) AND (card hint in sig OR IIN prefix 4 / 51–55 / 2221–2720 / 34 / 37 / 6011 / 65). Used by the recorder (Plan 3); defined and tested here.

- [ ] **Step 1: Failing tests** (real layout): `display:none`, `visibility:hidden`, `opacity:0`, `left:-9999px`, 1×1 px, `inert` ancestor, `aria-hidden` ancestor, covered by an overlay div → ineligible; normal visible input below the fold → eligible; disabled/readonly → ineligible; show-password toggle (password → text) → still sensitive; each §5.3 name/label/autocomplete case; Luhn true/false and IIN rule.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** PR `feat(fields): eligibility and sensitive-field rules`.

---

### Task 7: Matcher (pure)

**Files:**
- Create: `src/lib/match/match.ts`
- Test: `tests/unit/match/match.test.ts`

**Interfaces:**
- Consumes: `Sig`, `ControlKind` (types only).
- `profileApplies(profile: { origin: string; pathPrefix: string }, origin: string, pathname: string): boolean` — exact origin; `pathname.startsWith(pathPrefix)`; `pathPrefix` must start with `/`.
- `scoreSig(saved: Sig, page: Sig): number` — weights from Global Constraints; `type`/kind must be compatible (`text` types interchangeable among text-like; otherwise equal) else `-Infinity`; name/id derived pair (either side `nameIdDerived`) contributes the name weight once and suppresses the idStable weight.
- `interface MatchInput { i: number; sig: Sig; kind: ControlKind }`; `interface SavedField { id: string; step: number; sig: Sig; kind: ControlKind }`; `matchControls(saved: SavedField[], steps: { index: number; fingerprint: string[] }[], page: MatchInput[]): Map<string, number>` (field id → control index). Algorithm: for each saved field compute scores against all page controls; candidate = best with score ≥ 5 and margin ≥ 2 over runner-up; if two saved fields claim the same control, keep the one whose step fingerprint has the higher Jaccard with the page's signature set, and only if that Jaccard ≥ 0.5, else drop both; each control used at most once.
- `sigKey(sig: Sig, kind: ControlKind): string` = `${kind}|${sig.name ?? ""}|${sig.labelText ?? ""}|${sig.autocomplete ?? ""}`; `jaccard(a: string[], b: string[]): number`.

- [ ] **Step 1: Failing tests:** each weight in isolation; threshold 5 (4 fails, 5 passes); margin 2 (tie → no match); Address 1/Address 2 twins match correctly by label; randomized name+id with only a placeholder label → score 3 → unmatched; ASP.NET derived pair not double-counted; kind mismatch never matches; step tie-break: "amount" on steps 1 and 3 → page resembling step 3 gets step 3's field; Jaccard < 0.5 → both dropped; `profileApplies` exact origin, port difference, path prefix (Review Focus 4).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** PR `feat(match): weighted signature matcher`.

---

### Task 8: Profile records and the e2e profile seam

**Files:**
- Create: `src/lib/profiles/types.ts`, `src/lib/profiles/store.ts`
- Modify: `src/entrypoints/background.ts` (e2e seam), `docs/superpowers/specs/2026-10-26-refill-design.md` §4.2 (fields gain `id`)
- Test: `tests/unit/profiles/types.test.ts`, `tests/unit/profiles/store.test.ts`

**Interfaces:**
- `interface ProfileField { id: string; sig: Sig; step: number; kind: ControlKind; value: string; pageDefault: string; policy: "save" | "ask" | "skip" }` (checkbox/radio values: `"true"`/`"false"` for checkbox, option value for radio/select).
- `interface Profile { v: 1; id: string; name: string; origin: string; pathPrefix: string; fillMode: "auto" | "gesture"; createdAt: number; lastUsedAt: number | null; steps: { index: number; pathHint: string; fingerprint: string[] }[]; fields: ProfileField[] }`
- `parseProfile(raw: unknown): Profile | null` — strict (exact keys, lengths: name ≤ 120, value ≤ 4096, ≤ 200 fields, ≤ 10 steps; origin passes `normalizeOrigin` and equals itself).
- `saveProfile(p: Profile): Promise<void>` — `putEncrypted(profileKey(p.id), aad.profile(p.id, p.origin), p, tx)` and `upsertSite(p.origin, { profileId: p.id }, tx)` in one `withStoreLock`; replaces a previous profile id for that origin (removes its record).
- `loadProfileForOrigin(origin: string): Promise<Profile | null>` — via site index `profileId`; `null` when no site/profile; throws `LockedError` when locked; returns `null` (and logs name only) when the record fails to parse; a profile whose decrypted `origin` ≠ requested origin is rejected (defence in depth beside AAD).
- `newId(): string` — 128-bit random, base64url.
- e2e seam (`MODE === "e2e"` only): `globalThis.__refillE2E = { saveProfile }` in the SW so Playwright `worker.evaluate` can seed profiles.

- [ ] **Step 1: Failing tests:** round trip; AAD binds origin (record copied under another site's key fails); `parseProfile` rejects extra keys, oversize, bad origin, bad policy; replace removes old record; locked → `LockedError`; tampered origin inside plaintext rejected.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; update spec §4.2 (`fields[].id`). **Step 4:** PASS; `node scripts/check-no-seams.mjs .output/chrome-mv3` still clean after `pnpm build`. **Step 5:** PR `feat(profiles): encrypted profile records`.

---

### Task 9: Scanner

**Files:**
- Create: `src/lib/fields/scan.ts`
- Test: `tests/browser/fields/scan.test.ts`

**Interfaces:**
- Consumes: Tasks 5–6.
- `interface ScannedControl { i: number; el: FormControl; sig: Sig; kind: ControlKind }`; `interface ScanResult { controls: ScannedControl[]; truncated: boolean }`.
- `scanDocument(doc: Document, history: PasswordHistory, openOrClosedShadowRoot?: (el: Element) => ShadowRoot | null): ScanResult` — walks the light DOM plus open shadow roots (and closed via the provided function), keeps eligible, non-sensitive controls in document order, `ordinal` = index among kept controls in the same `form` (or the document when formless), `formAction` = resolved action pathname or `null`; stops after 300 kept controls (`truncated: true`); radio groups contribute one entry per radio.
- `pageFingerprint(r: ScanResult): string[]` = `sigKey` of each control.

- [ ] **Step 1: Failing tests:** ordering and ordinals per form; shadow DOM (open) included; sensitive and ineligible excluded; 2 000 inputs → 300 + truncated in < 50 ms median of 5 runs (Review Focus 2); formAction resolution.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** PR `feat(fields): document scanner`.

---

### Task 10: Fill engine

**Files:**
- Create: `src/lib/fill/fill.ts`
- Test: `tests/browser/fill/fill.test.ts` (vanilla, React 19 controlled input, Vue 3 `v-model`, masked input fixture, select, checkbox, radio, react-select-like combobox)

**Interfaces:**
- `type FillOutcome = "filled" | "skipped-not-empty" | "skipped-ineligible" | "unsupported" | "rejected-by-page"`.
- `interface FillItem { el: FormControl; kind: ControlKind; value: string; pageDefault: string }`
- `canFill(item: FillItem, history: PasswordHistory, origin: string): boolean` — the Global Constraints fill rules (eligible, not sensitive, value `""` or `=== pageDefault` — for checkbox compare `String(checked)`, form action same origin).
- `fillControl(item: FillItem): FillOutcome` — text: `focus()`, prototype `value` setter (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype|HTMLTextAreaElement.prototype, "value").set`), dispatch `input` + `change` (bubbling) + `blur`; verify `el.value === value`, else fallback `select()` + `document.execCommand("insertText", false, value)`, verify again → `rejected-by-page` if still different; select: option must exist else `unsupported`; checkbox/radio: `.click()` only if state differs.
- `withFillingGuard<T>(fn: () => T): T` and `isFilling(): boolean` — module flag consumed by the recorder/draft tracker later.
- `snapshot(items: FillItem[]): FillSnapshot`; `restore(s: FillSnapshot): void` (undo, same technique, under the guard).
- Custom widgets: an element with `role="combobox"` that is not a native `select`, or an input inside `[role=combobox]` with an attached listbox → `unsupported`.

- [ ] **Step 1: Failing tests:** React controlled input's state updates (rendered text mirrors value); Vue `v-model` updates; masked phone input (rewrites programmatic value) filled via `insertText`; a field the user typed into is skipped (Review Focus 5); `pageDefault` equality allows fill; form posting to another origin → `canFill` false; react-select-like → `unsupported`; checkbox already in target state not clicked; `isFilling()` true inside handlers during fill; `restore` returns original values.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** PR `feat(fill): robust control filling`.

---

### Task 11: Content protocol, SW content handlers, router content path

**Files:**
- Create: `src/lib/messaging/content-protocol.ts`, `src/lib/messaging/content-handlers.ts`
- Modify: `src/lib/messaging/router.ts`, `src/lib/messaging/protocol.ts` (`ContentRequest` re-export), `src/entrypoints/background.ts`
- Test: `tests/unit/messaging/content-protocol.test.ts`, `tests/unit/messaging/content-handlers.test.ts`, `tests/unit/messaging/router.test.ts`

**Interfaces:**
- `ContentRequest = { type: "scan-report"; controls: { i: number; kind: ControlKind; sig: Sig }[]; truncated: boolean } | { type: "fill-result"; filled: number; skipped: number; unsupported: number }`; `parseContentRequest(raw): ContentRequest | null` — Global Constraints caps, exact keys at every level, `Sig` fields typed and length-capped, `i` unique integers 0–299.
- `type FillPlan = { state: "locked" } | { state: "none" } | { state: "gesture"; count: number } | { state: "fill"; items: { fieldId: string; i: number; kind: ControlKind; value: string; pageDefault: string }[] }`.
- Router: content senders (Plan 1 `classifySender`) are additionally rejected unless `sender.origin` has a site record with `accessRevoked: false` AND `permissions.contains` for its pattern; content handlers receive `(req, { origin: sender.origin, pathname: new URL(sender.url).pathname, tabId: sender.tab.id, documentId: sender.documentId })`.
- `scan-report` handler: vault not unlocked → `{ state: "locked" }`; no profile / `!profileApplies` → `{ state: "none" }`; `fillMode === "gesture"` → `{ state: "gesture", count: matched.size }` with no values; else `matchControls` and return items only for matched fields with `policy === "save"`; sets `lastUsedAt` only when ≥ 1 item returned (via `saveProfile` inside the lock — throttled to once per 60 s per profile).
- `fill-result` handler: validates and records nothing persistent in Plan 2 (returns `{ ok: true }`; badge in Plan 4).

- [ ] **Step 1: Failing tests:** content sender for a not-enabled origin → rejected; revoked → rejected (Review Focus 1); page-kind message types from content → rejected; payload `origin`/`url` keys → rejected (exact keys); 301 controls → rejected; locked → `{state:"locked"}` with no values (Review Focus 3); path outside prefix → `none`; gesture → count only; `ask`/`skip` fields never returned; values returned only for matched controls (an unmatched saved field's value never appears in the reply).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** PR `feat(messaging): content protocol and fill-plan handler`.

---

### Task 12: Content script wiring and fixture e2e suite

**Files:**
- Modify: `src/entrypoints/refill-content.ts`
- Create: `tests/e2e/sites/{spa-wizard,post-wizard,random-ids,twins,masked,react-select,iframe-host,honeypot,prerender-host,account}.html` (+ minimal inline-free JS files beside them), `tests/e2e/fill.spec.ts`

**Interfaces:**
- Content script flow: wait for `document.prerendering === false` (listen `prerenderingchange`); `PasswordHistory.observe(document)`; `scanDocument` → `sendMessage(scan-report)` → apply plan: for each item resolve `controls[i].el`, `canFill` then `fillControl` under `withFillingGuard`, each `fieldId` at most once per document; send `fill-result`; debounced (250 ms) `MutationObserver` re-scan for SPA steps (only sends when the page fingerprint changed); `pageshow` with `persisted` → treat as the same document (no re-fill of filled ids); if `browser.runtime.id` is undefined or `sendMessage` throws "Extension context invalidated" → stop observers silently (toast in Plan 4). No logging of page data.
- Fixture behaviors: `post-wizard` re-renders server-side `value="…"` after a failed-validation POST (the e2e server answers POST with the same form and the posted amount); `iframe-host` on `FIXTURE_A` embeds a form from `FIXTURE_B`; `honeypot` adds hidden/off-canvas/opacity-0/covered fields with the same names as profile fields; `account` lives at `/account` while the profile prefix is `/billpay/`.

- [ ] **Step 1: Failing e2e** (seed profiles via `__refillE2E.saveProfile`, unlock via popup): SPA wizard step 1 fills → advance → step 2 fills (same URL); POST wizard: step fills, user edits amount, failed-validation POST re-renders the edited amount → NOT overwritten; random ids + placeholder-only field → that field unfilled, others filled; twins Address 1/2 correct; masked phone filled; react-select left empty and reported unsupported; iframe form never filled; honeypot decoys never filled while the visible fields are; `/account` page not filled (Review Focus 4); locked vault → nothing filled, then unlock + reload → filled; site removed → reload → no content script.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (3 consecutive runs, no flakes). **Step 5:** PR `feat(content): scan and fill on enabled sites`.

---

### Task 13: Plan 2 close-out

**Files:** Modify `docs/security/threat-model.md` (rows for sites, reconciler, content script, match, fill, e2e seams), `README.md` (status: Plan 2 of 7), issue #16 (tick carried items resolved here, if any).

- [ ] **Step 1:** Threat-model rows with control + proving test + ADR for every new component; residual risks: same-origin scripts can read filled values (spec §8.3), signatures reveal page structure to the SW only, e2e build differs from production by host_permissions + seam (CI-guarded).
- [ ] **Step 2:** README status and new commands (`test:browser`, `build:e2e`).
- [ ] **Step 3:** PR `docs: Plan 2 threat model and README`. The controller then runs the whole-plan review and tags `v0.2.0-fill-engine`.
