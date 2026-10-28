# Refill — Plan 3: Recorder and review (M3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With the vault unlocked, the user clicks **Record this site** in the popup and fills the
form or wizard once by hand. While recording, returning to an earlier step (Back, a reload, a
failed submit) shows what was already recorded there, pre-filled. The user clicks **Finish**,
reviews the captured fields (masked values, a policy per field, name, fill mode, path prefix) and
saves them as the site's encrypted profile, which Plan 2's fill engine fills on the next visit.
**Record again** on a site with a saved form starts from that form: its values fill as the user
walks through, and the user changes only what differs. Everything typed is saved by default except
passwords, one-time codes, card security codes (CVV) and captchas. The full loop is proven end to
end on the fixture sites.

**Architecture:** The worker owns at most one recording session (`src/lib/recorder/session.ts`).
Its metadata is plaintext and its body (steps and fields) is sealed under the DEK, both in
`storage.session`. Pure modules decide step boundaries (`recorder/steps.ts`), field identity and
updates (`recorder/fields.ts`), the in-recording fill plan (`recorder/plan.ts`, reusing
`matchControls`), and the review model, path prefix and final `Profile` (`recorder/profile.ts`).
Step tracking reuses Plan 2's `scan-report`. While a session is active for the tab, the worker files
the page into the session and answers with a fill plan built **from the session**, never from the
stored profile. Record again seeds the session from the stored profile, so its values fill the same
way. On the content side, `recorder/capture.ts` reads values and page defaults, and
`content/recording.ts` captures trusted edits and shows the pill (`content/pill.ts`, closed shadow
root, top layer). The worker wakes a running content script with a data-free `refill-nudge`. The
review page is a new Svelte entrypoint, `src/entrypoints/review/`.

**Tech Stack:** As in Plan 2; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-26-refill-design.md`. Read §1.2, §1.4, §3.1, §4.2, §5.2 to
§5.5, §6.2, §6.6, §7 and §8 before any task. The Plan 1 and Plan 2 Global Constraints still apply.
Task 2 amends the spec, following the user's decision of 2026-10-27: only secrets are never
captured. This plan also carries the Plan 2 final-review items deferred to it
(`.superpowers/sdd/2026-10-26-plan-2-sites-and-fill-engine/final-review.md`): M7 (Task 1), M2
(Task 3), M9 (Task 10), the shadow-root variant of clobber fixture 8 (Task 8) and M10 (Task 12).

## Global Constraints

- The Plan 1 and Plan 2 Global Constraints hold: permissions, CSP, no network, `crypto.subtle` only in `src/lib/crypto/`, `storage.local` only in `src/lib/store/`, exact versions, one PR per task, an ADR for each meaningful decision, the worker's own clock, `sender.origin` as the only origin, and exact keys plus size caps on every message.
- The production manifest does not change, and there is no `tabs` permission. `tabs.get(id).url` is readable only through the host permission or `activeTab`. `tabs.onRemoved`, `tabs.create`, `tabs.sendMessage` and `action.setBadgeText` need no permission.
- **Never captured, never filled: secrets only** (spec §5.3 as amended in Task 2):
  - passwords: `type=password`, a field that was ever `type=password` in the document, `-webkit-text-security`, `current-password`/`new-password`, and the password, PIN, passphrase, seed and recovery-phrase words;
  - one-time codes: `one-time-code`, OTP/2FA/MFA/TOTP and the verification-code words;
  - card security codes: `cc-csc`, CVV/CVC/CSC, and "security code" / card code;
  - captchas;
  - fields that are never typed: `hidden`, `file`, and the `__VIEWSTATE` / `__EVENTVALIDATION` / CSRF / XSRF / token / nonce names.

  Everything else the user typed, card numbers and SSNs included, is captured. Every field defaults to policy `save`, and the user can set any field to "Don't save" on the review page.
- A captured value is never plaintext at rest. The session body is sealed with `seal(getDek(), …)` under `aad.recording(sessionId, origin)` = `"refill/v1|recording|<sessionId>|<origin>"`. Only metadata is plaintext.
- Recording limits:
  - session TTL `RECORDING_TTL_MS = 1_800_000` from start, reset to 30 min from Finish;
  - at most 10 steps and 200 fields;
  - fingerprints of at most 300 entries, each at most 1024 chars;
  - value and pageDefault at most 4096 each.

  These are the profile `LIMITS`, so a session always fits a profile.
- A capture is sent only for a **trusted** (`isTrusted`) `input` or `change` event, only when `isFilling()` is false, and only for a control that is eligible (§5.2) and not secret at event time. The worker re-checks with `sigLooksSensitive`.
- During recording, Refill fills only from the session, never from the stored profile directly. It fills only fields with policy `save`, under all of Plan 2's fill rules (empty or `pageDefault`, eligible, same-origin form, each field id at most once per document). It never fills an element the user edited in this document.
- Only an extension page can start recording: `record-start` and the `record` intent are page-only. Content scripts can query status, send captures and finish, and only for the session whose `tabId` and `origin` equal the sender's.
- The worker bundle is DOM-free, and `scripts/check-sw-no-dom.mjs` gates CI (Task 1). The worker side imports pure modules only (`fields/sensitive-rules.ts`, `match/match.ts`); it may import DOM modules as types.
- The pill is a host element with a **closed** shadow root, shown with `popover="manual"` + `showPopover()`. It holds text and buttons only: no inputs, and never a value. Styles are set through CSSOM only (`style.setProperty` or a constructed `CSSStyleSheet`). Never use a `style` attribute, a `<style>` element, `innerHTML` or `insertAdjacentHTML`. A click acts only when `isTrusted`.
- The content script still logs nothing that contains page or field data, and the worker logs error names only.

## Review Focus

1. **During recording, the user clears a field or sets it back to its original value.** It is not saved, and Refill does not put the old value back (edited elements are never refilled in that document). Tests in Task 4 and Task 8.
2. **A wizard's Back button, in an SPA or after a full reload.** Back to step 1 returns to step 1: its recorded values are pre-filled when the inputs are empty, edits update step 1's fields, and no extra step is created. Tests in Task 4, Task 8 and Task 11.
3. **A failed-validation POST re-renders the same form as a new document.** The recording stays on the same step and keeps the captured edits, and no duplicate step is created (duplicate steps make the matcher drop every claimant). Tests in Task 4 and Task 11.
4. **The vault locks while the review page is open.** Save refuses with the "no longer available" copy and writes nothing. Test in Task 10.
5. **Record again where the page changed a label since the first recording.** The saved value still fills, and the user's edit replaces that field (linked by the filled field id, not by signature), so no duplicate field is left that would make both claimants drop. Fields not reached stay as saved. Tests in Task 4, Task 8 and Task 11.

---

## File Structure

```
src/
  entrypoints/
    background.ts                    + recorder listeners and handlers
    refill-content.ts                + nudge wiring
    popup/App.svelte                 + Record this site / Record again / recording state
    review/{index.html,main.ts,App.svelte}   review page
  lib/
    fields/sensitive-rules.ts        pure secret rules (worker + content); sensitive.ts keeps the DOM part
    sites/tab.ts                     tabShowsOrigin (M2)
    recorder/types.ts                RecStep, RecField, RecBody, Capture, emptyBody, seedBody
    recorder/steps.ts                observePage (pure)
    recorder/fields.ts               applyCapture, capturedCount (pure)
    recorder/plan.ts                 recordingPlan: fill items from the session (pure)
    recorder/profile.ts              defaultPathPrefix, reviewModel, buildProfile (pure)
    recorder/session.ts              the one sealed session, listeners, badge, nudge
    recorder/handlers.ts             content record-* / scan-report-while-recording; page record-* and review-*
    recorder/capture.ts              readValue, PageDefaults (DOM)
    content/recording.ts             capture listeners, edited-element set, pill state
    content/pill.ts                  closed-shadow-root pill
    content/chrome-api.ts            + onNudge
    content/runner.ts                + recording integration, rescan(), filled element → field id
    messaging/content-protocol.ts    + record-status, record-capture, record-finish
    messaging/protocol.ts            + record-*, review-*; site-intent gains kind
    crypto/aad.ts                    + recording
scripts/check-sw-no-dom.mjs
tests/unit/{recorder,sites,messaging,fields}/**, tests/unit/check-sw-no-dom.test.ts
tests/browser/{recorder,content}/**
tests/e2e/sites/{never-capture.html,never-capture.js,strict-csp.html}, tests/e2e/record.spec.ts
```

---

### Task 1: Worker-bundle DOM guard and pure secret rules (M7)

**Files:**
- Create: `scripts/check-sw-no-dom.mjs`, `tests/unit/check-sw-no-dom.test.ts`, `src/lib/fields/sensitive-rules.ts`, `tests/unit/fields/sensitive-rules.test.ts`
- Modify: `src/lib/fields/sensitive.ts` (imports the moved rules), `package.json` (script `check:sw-no-dom`), `.github/workflows/ci.yml`

**Interfaces:**
- `node scripts/check-sw-no-dom.mjs <file>`:
  - Exits 1 and names each marker found. The markers are `HTMLInputElement`, `MutationObserver`, `getComputedStyle`, `elementFromPoint`, `execCommand`, `checkVisibility`, `Node.prototype` and `Element.prototype`.
  - Exits 2 when the file is missing or empty (fail closed), and 0 otherwise.
  - CI runs it on the worker file named by the built manifest's `background.service_worker` (`.output/chrome-mv3`), after the production build.
- `src/lib/fields/sensitive-rules.ts` has no runtime imports except types. Behaviour is unchanged in this task; it is a pure move. It exports:
  - `nameMatchesSensitive(raw: string | null): boolean`
  - `captchaLike(raw: string | null): boolean`
  - `sensitiveAutocomplete(raw: string | null): boolean`
  - `sigLooksSensitive(sig: Sig): boolean`: true when `sig.type` is `password`, `hidden` or `file`, when `sensitiveAutocomplete(sig.autocomplete)` holds, or when `nameMatchesSensitive` or `captchaLike` holds for `sig.name`, `sig.idStable` or `sig.labelText`.

- [ ] **Step 1: Failing tests.**
  - `check-sw-no-dom.test.ts`: one case per marker (exit 1, marker named), a clean file (exit 0), a missing or empty file (exit 2).
  - `sensitive-rules.test.ts`: `sigLooksSensitive` is true for each type, for `one-time-code` autocomplete, for name `confirmPassword` and for label `"verification code"`. It is false for `email`, `zip code` and `pinnacle`.
- [ ] **Step 2:** Run `pnpm vitest run tests/unit/check-sw-no-dom.test.ts tests/unit/fields/sensitive-rules.test.ts` → FAIL.
- [ ] **Step 3:** Implement. `tests/browser/fields/sensitive.test.ts` stays green untouched.
- [ ] **Step 4:** Run `pnpm test && pnpm test:browser && pnpm build && pnpm check:sw-no-dom` → all pass.
- [ ] **Step 5:** PR `chore(ci): worker bundle DOM guard; pure secret rules`.

---

### Task 2: Narrow the never-capture list to secrets (spec change)

**Files:**
- Modify: `src/lib/fields/sensitive-rules.ts`, `src/lib/fields/sensitive.ts`, `tests/unit/fields/sensitive-rules.test.ts`, `tests/browser/fields/sensitive.test.ts`, `tests/browser/fields/scan.test.ts`, `tests/browser/fill/fill.test.ts`
- Modify: spec §1.2 criterion 3, §1.4, §5.3, §6.2 step 5
- Modify: `docs/adr/0020-eligibility-and-sensitive-field-rules.md` (amendment), `docs/security/threat-model.md` (`fields/` and `fill/` rows)

**Interfaces:**
- **Removed** from the rules:
  - the `ssn`, `social security`, `card ?(number|num|no)` and `cc ?num(ber)?` words, and `cardnumber` in the compact form;
  - every `cc-*` autocomplete token except `cc-csc`;
  - `looksLikeCardNumber` and its card IIN and hint helpers, with their tests.
- **Kept:** everything listed under "Never captured, never filled" in Global Constraints. That includes `cvv`, `cvc`, `csc`, the card-code qualifiers (`card code`, `cc code`, `security code`), `pin`, `seed`, `mnemonic` and `recovery phrase`. `cc-csc` is listed explicitly.
- One rule set decides both sides. `isSensitive` (scan and fill) and `sigLooksSensitive` (worker) apply the same narrowed rules, so a card-number or SSN field is now scanned, matched and filled like any field.
- Spec text:
  - §1.2 criterion 3 becomes: "…passwords, one-time codes, card security codes (CVV) and hidden/CSRF fields are never stored."
  - §1.4: the non-goal is now "cross-origin payment iframes and card-number auto-detection (browser card autofill covers these)". Same-origin card fields are saved like any other.
  - §5.3: rewrite the list to match Global Constraints, and drop the card-drop and bank `ask` paragraphs.
  - §6.2 step 5: "Every field defaults to Fill it in; the user can set any to Don't save."
- ADR 0020 amendment: the user's decision (2026-10-27), why CVV stays excluded (sites ask for it because it should not be kept, and a card number together with its CVV is the complete fraud set), and that recovery phrases and PINs count as passwords.

- [ ] **Step 1: Failing tests.**
  - Not sensitive: names `card_number`, `cardNumber`, `ssn`; labels "Card number" and "Social Security Number"; autocomplete `cc-number`, `cc-exp` and `cc-name`.
  - Still sensitive: `cvv`, `x_card_code`, label "Security code", `cc-csc`, `card_pin`, `seed phrase`, `one-time-code`, `password`.
  - The scanner includes a "Card number" input, and `canFill` allows it.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement. Update the existing tests that assert the old exclusions, by moving their cases to the "not sensitive" table. Do not delete them.
- [ ] **Step 4:** PASS (`pnpm test && pnpm test:browser`). The Plan 2 e2e suite is still green.
- [ ] **Step 5:** PR `feat(fields)!: never capture only secrets (passwords, one-time codes, CVV)`.

---

### Task 3: Check the tab's origin before injecting (M2)

**Files:**
- Create: `src/lib/sites/tab.ts`, `tests/unit/sites/tab.test.ts`
- Modify: `src/lib/sites/handlers.ts` (`site-enable`), `src/lib/sites/reconcile.ts` (`onAdded`), `tests/unit/sites/{handlers,reconcile}.test.ts`, `docs/security/threat-model.md` (reconciler row)

**Interfaces:**
- `tabShowsOrigin(tabId: number, origin: string): Promise<boolean>` is `normalizeOrigin((await tabs.get(tabId)).url ?? "") === origin`. It never throws: it returns false when the tab is gone or the URL is unreadable.
- `site-enable` and the `onAdded` intent path inject only when `tabShowsOrigin` holds. The site record and reconcile happen either way.

- [ ] **Step 1: Failing tests:**
  - A tab that navigated to another origin → no `executeScript`, but the site is enabled.
  - A closed tab → the same.
  - A tab on the matching origin → injected.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement. In the threat-model reconciler row, say that injection checks the tab's current origin first, because `activeTab` alone would allow a tab that has navigated away.
- [ ] **Step 4:** PASS + lint/typecheck.
- [ ] **Step 5:** PR `fix(sites): inject only into a tab still showing the origin`.

---

### Task 4: Recorder model (pure)

**Files:**
- Create: `src/lib/recorder/{types,steps,fields,plan,profile}.ts`
- Test: `tests/unit/recorder/{steps,fields,plan,profile}.test.ts`

**Interfaces:**
- `types.ts`:
  - `interface RecStep { index: number; pathHint: string; fingerprint: string[] }`
  - `interface RecField { id: string; step: number; sig: Sig; kind: ControlKind; value: string; pageDefault: string; policy: FieldPolicy }`
  - `interface RecBody { steps: RecStep[]; current: number | null; lastDocument: string | null; fields: RecField[]; nextId: number }`
  - `emptyBody(): RecBody`
  - `seedBody(p: Profile): RecBody`: the profile's steps and fields (ids, policies and values kept), with `current: null`, `lastDocument: null`, and `nextId` past every `f<n>` id in use.
  - `interface Capture { sig: Sig; kind: ControlKind; value: string; pageDefault: string; fieldId: string | null }`. `fieldId` is the field Refill filled into this element during this recording, if any.
- `observePage(body: RecBody, keys: string[], documentId: string | null, pathname: string): RecBody | "full"`. It is pure, runs once per scan-report, and returns a new body.
  - No steps yet: create step 0 with `pathHint = pathname`.
  - **Same document** (`documentId !== null && documentId === body.lastDocument`): stay on the current step if `keys ⊇ current.fingerprint` (an accordion opening) or `jaccard ≥ 0.5`.
  - **Otherwise**, including a new document: take the step with the highest `jaccard(keys, step.fingerprint)`, if that is ≥ 0.5 (the latest step wins a tie). This covers Back, a reload and a failed-validation re-render.
  - **Else:** a new step, or `"full"` when there are already 10.

  Joining a step unions its fingerprint with `keys`, keeping the first 300 entries in order. The result sets `current` and `lastDocument`. A seeded step (`pathHint` from the saved profile) joins like any other. `jaccard` and the key format come from `match/match.ts`.
- `applyCapture(body: RecBody, c: Capture): { body: RecBody; result: "ok" | "full" | "no-step" }`, pure:
  - `current === null` → `"no-step"`.
  - **Ignored with `"ok"` (nothing stored):** `sigLooksSensitive(c.sig)`; a value over 4096; a radio whose value is not `"true"`; a checkbox whose value is not `"true"`/`"false"`.
  - **Target field:**
    - If `c.fieldId` names an existing field, that field.
    - Else a field in the current step with the same identity. Identity is `radio|<name>|<formAction>` for a radio, so choosing another option of the group replaces the group's field, and `<sigKey(sig, kind)>|<ordinal>` otherwise.
    - Else a new field: `id = "f" + nextId++`, `policy: "save"`, `step = current`.
  - **A revert** (`value === pageDefault`) removes the target field. This includes a seeded field, because clearing a saved value means "don't save it".
  - **Otherwise** the target takes the capture's `sig`, `kind`, `value`, `pageDefault` and `step = current`. The `id` and `policy` are kept.
  - A 201st field → `"full"`, with the body unchanged.
- `capturedCount(body: RecBody): number` is `body.fields.length`.
- `recordingPlan(body: RecBody, controls: ScanControl[]): FillItem[]`, pure, uses `matchControls(body.fields, body.steps, controls)` and returns items only for matched fields with `policy === "save"`. `FillItem` comes from `messaging/content-protocol.ts`.
- `defaultPathPrefix(paths: string[]): string`:
  - all equal → that path;
  - otherwise `"/" + common leading segments + "/"`, or `"/"` when none are shared;
  - never ends mid-segment.

  For example, `["/billpay/a", "/billpay/b"]` → `"/billpay/"`.
- `interface ReviewModel { origin: string; host: string; steps: { index: number; pathHint: string }[]; fields: { id: string; step: number; label: string; kind: ControlKind; value: string; policy: FieldPolicy }[]; name: string; pathPrefix: string; fillMode: "auto" | "gesture" }`
- `reviewModel(origin: string, body: RecBody, saved: Profile | null): ReviewModel`:
  - The label is `sig.labelText ?? sig.name ?? "Unlabeled field"`.
  - `name`, `pathPrefix` and `fillMode` come from `saved` when there is one. Otherwise they are the host, `defaultPathPrefix` of the steps' pathHints, and `"auto"`.
  - If a saved `pathPrefix` no longer covers every step, `defaultPathPrefix` is used instead.
- `buildProfile(input: { id: string; origin: string; name: string; pathPrefix: string; fillMode: "auto" | "gesture"; now: number; createdAt: number | null; body: RecBody; policies: Record<string, FieldPolicy> }): Profile | null`:
  - Every field needs a policy entry, and an unknown id → `null`.
  - The trimmed name must be 1..120 characters.
  - `pathPrefix` must satisfy `profileApplies` for every step's `pathHint`.
  - `createdAt` is `input.createdAt ?? now` and `lastUsedAt` is `null`.
  - The result goes through `parseProfile`.

- [ ] **Step 1: Failing tests:**
  - **Steps:**
    - an accordion in the same document → one step;
    - an SPA step change → a new step;
    - Back from step 2's keys to step 1's keys → step 1 (Review Focus 2);
    - a new document with the same keys → the same step (Review Focus 3);
    - a seeded body: the first page joins seeded step 0;
    - an 11th page → `"full"`.
  - **Captures:**
    - a revert removes the field (Review Focus 1), and reverting a seeded field removes it;
    - two radios of one group → one field;
    - the same label at two ordinals → two fields;
    - a password sig is ignored;
    - a card-number capture is stored;
    - a capture with `fieldId` of a seeded field whose sig differs (relabeled) updates that field and adds no new one (Review Focus 5);
    - the 201st field → `"full"`;
    - before any page → `"no-step"`.
  - **Plan:** step 1's captured fields are returned when the page shows step 1's controls again; `skip` and `ask` fields are never returned.
  - **Profile:** the `defaultPathPrefix` examples; `buildProfile` rejects a prefix that misses a step, a missing policy and an empty name; seeded `createdAt` is kept.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS. Add an ADR on the recorder model. It covers the step rule, field identity and the `fieldId` link, reverts, fill-from-session and seeding, and the path prefix default. It also settles the Plan 2 ledger's Task 7 notes (accordion fingerprints, per-segment prefix) and records dynamic label text in fingerprints as a known matcher limit.
- [ ] **Step 5:** PR `feat(recorder): recording model`.

---

### Task 5: Recording session store

**Files:**
- Create: `src/lib/recorder/session.ts`, `tests/unit/recorder/session.test.ts`
- Modify: `src/lib/crypto/aad.ts` (+ `recording`), `tests/unit/crypto/aad.test.ts`

**Interfaces:**
- `aad.recording(id: string, origin: string)` → `"refill/v1|recording|<id>|<origin>"`, using the `field()` guard.
- `export const RECORDING_TTL_MS = 1_800_000`.
- `interface SessionMeta { v: 1; id: string; tabId: number; origin: string; startedAt: number; expiresAt: number; finished: boolean; seededFrom: string | null }`, stored at the `storage.session` key `recorder:session` as `{ meta, body: Sealed }` (`Sealed` from `crypto/aead.ts`). `id` comes from `newId()`, and `seededFrom` is the id of the saved profile the session was seeded from.
- `startSession(tabId: number, origin: string, now: number, seed: Profile | null): Promise<SessionMeta>`:
  - The body is `seed ? seedBody(seed) : emptyBody()`.
  - Any previous session is discarded with reason `"replaced"`.
  - Sets the badge `"●"` on the tab and clears the tombstone.
  - Throws `LockedError` when locked.
- `withSession<T>(match: { tabId: number; origin: string } | { id: string }, now: number, fn: (meta: SessionMeta, body: RecBody) => { body?: RecBody; meta?: Partial<Pick<SessionMeta, "finished" | "expiresAt">>; result: T }): Promise<T | "off">`:
  - Serialized by a module-level promise chain.
  - `"off"` when there is no session, or it belongs to another tab, origin or id.
  - An expired session is discarded with `"expired"` → `"off"`. If the body can't be opened because the vault is locked, the session is discarded with `"locked"` → `"off"`.
  - A changed body is re-sealed with a fresh IV.
- `discardSession(reason: "locked" | "expired" | "cancelled" | "replaced" | "saved" | "tab-closed"): Promise<void>`:
  - Removes the record, clears the badge and nudges the tab.
  - `"locked"` and `"expired"` also write the tombstone `recorder:stopped` = `{ tabId, reason, at }`, valid for 30 min.
- `stoppedReason(tabId: number, now: number): Promise<"locked" | "expired" | null>` reads that tombstone.
- `nudge(tabId: number): Promise<void>` sends `tabs.sendMessage(tabId, { type: "refill-nudge" }, { frameId: 0 })`. Failures are ignored and logged by error name only.
- `installRecorderListeners(): void`, synchronous, at the top level:
  - `onLockChange(false)` → `discardSession("locked")`.
  - `tabs.onRemoved` discards only an **unfinished** session of that tab (`"tab-closed"`).

- [ ] **Step 1: Failing tests** (fakeBrowser, real vault at the test KDF floor):
  - no captured value appears in `JSON.stringify` of `storage.session`;
  - a body moved under another session id → `"off"`;
  - expiry at 30 min → `"off"` plus an `"expired"` tombstone;
  - a lock → discard plus a `"locked"` tombstone;
  - closing the tab of an unfinished session discards it, and a finished session is kept;
  - a second start replaces the first;
  - a seeded start contains the profile's fields;
  - 20 concurrent appends all persist;
  - the badge is set on start and cleared on discard.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS. Add an ADR on recording sessions: one at a time, the sealed body, seeding, tombstones, and discarding on lock.
- [ ] **Step 5:** PR `feat(recorder): sealed recording sessions`.

---

### Task 6: Content protocol and worker handlers for recording

**Files:**
- Create: `src/lib/recorder/handlers.ts` (content part), `tests/unit/recorder/content-handlers.test.ts`
- Modify: `src/lib/messaging/content-protocol.ts`, `src/lib/messaging/content-handlers.ts` (scan-report), `src/entrypoints/background.ts`, `tests/unit/messaging/{content-protocol,router}.test.ts`, spec §7

**Interfaces:**
- `ContentRequest` gains three types:
  - `{ type: "record-status" }`
  - `{ type: "record-capture"; kind: ControlKind; sig: Sig; value: string; pageDefault: string; fieldId: string | null }`: exact keys, value and pageDefault ≤ 4096, `fieldId` null or matching `ID_RE`.
  - `{ type: "record-finish" }`
- `type RecordState = { state: "off" } | { state: "on"; count: number } | { state: "full"; count: number } | { state: "stopped"; reason: "locked" | "expired" }`. `record-status` and `record-capture` answer a `RecordState`, and `record-finish` answers `{ ok: boolean }`.
- `createRecorderContentHandlers(now?: () => number)` returns the three handlers, keyed by `ctx.tabId` and `ctx.origin`. For any other tab or origin, or a finished session, they answer `off`, or `stopped` when a tombstone exists.
  - `record-capture` runs `applyCapture` inside `withSession`.
  - `record-finish` sets `finished`, sets `expiresAt = now + RECORDING_TTL_MS`, clears the badge, and opens `tabs.create({ url: runtime.getURL("/review.html") + "?session=" + id })`.
- `scan-report` with an active (unfinished) session for `ctx.tabId` and `ctx.origin` does three things:
  1. Runs `observePage` with `sigKey` keys, `ctx.documentId ?? null` and `ctx.pathname`.
  2. Answers `{ state: "fill", items: recordingPlan(body, controls) }`, or `{ state: "none" }` when there are no items. The stored profile is never loaded on this path, and `lastUsedAt` is never touched.
  3. When `observePage` is `"full"`, still answers the plan computed with the steps it has.

  Without a session, Plan 2's handler runs unchanged.
- The router rejects `record-start` from a content sender.
- The e2e seam wrapper in `background.ts` passes the new types through. It logs only `type` and the reply's `state`, never a value.
- Spec §7: add `record-status`, the worker→content `refill-nudge`, and the note that `scan-report` drives the recording.

- [ ] **Step 1: Failing tests:**
  - **Parsing:** extra keys, a 4097-char value, a bad `fieldId`, and `record-start` from content are all rejected.
  - **Scoping:** a capture or finish from another origin or another tab → `off`.
  - **Scan-report during recording:**
    - returns values captured in this session for a page showing those controls again;
    - never returns stored-profile values that are not in the session (the session is empty and the site has a profile → `none`);
    - does not touch `lastUsedAt`.
  - **Finish** opens the review URL.
  - **Status after a lock** → `stopped`/`locked`.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** PR `feat(recorder): content protocol and handlers for recording`.

---

### Task 7: Start, finish and cancel from extension pages

**Files:**
- Modify: `src/lib/recorder/handlers.ts` (page part), `src/lib/messaging/{protocol,page-handlers}.ts`, `src/lib/sites/{intent,handlers,reconcile,popup-flow}.ts`, `tests/unit/recorder/page-handlers.test.ts`, `tests/unit/sites/{intent,reconcile,handlers}.test.ts`

**Interfaces:**
- `IntentKind = "enable" | "record"`, and `site-intent` gains `kind`.
- `{ type: "record-start"; tabId: number; origin: string }` → `{ ok: true } | { ok: false; error: "locked" | "not-granted" | "invalid-origin" | "tab-moved" }`:
  1. Checks, in order: the vault is unlocked, `permissions.contains`, `tabShowsOrigin`.
  2. `upsertSite(origin, { accessRevoked: false })` and `reconcile()`.
  3. `startSession(tabId, origin, now, await loadProfileForOrigin(origin))`: Record again seeds from the saved form.
  4. `injectContentScript(tabId)`, then `nudge(tabId)`. The nudge is needed because a script that is already running ignores a second injection.
- `{ type: "record-state"; tabId: number }` → `{ state: "off" } | { state: "on" | "full"; origin: string; count: number; here: boolean }`.
- `{ type: "record-finish"; tabId: number }` → `{ ok: boolean }`, the same work as the content finish.
- `{ type: "record-cancel"; tabId: number }` → `{ ok: true }`, discarding with `"cancelled"`.
- `onAdded` with a `record` intent does the enable work, then starts a session (seeded the same way) only when the vault is unlocked and `tabShowsOrigin`.
- `requestSiteEnable(tabId, origin, kind: IntentKind)` sends `record-start` when the permission is already granted and `kind === "record"`. It returns `"granted-pending" | "enabled" | "recording" | "denied" | "locked"`. The synchronous call order is unchanged.

- [ ] **Step 1: Failing tests:**
  - **Refusals:** locked → `locked`; not granted → `not-granted`; navigated → `tab-moved` with no session.
  - **Success:** a session is created, injected and nudged.
  - **Record again:** the session is seeded from the stored profile, and `seededFrom` is set.
  - **Record intent** in `onAdded`: unlocked → a session; locked → enabled only.
  - **Cancel** discards the session.
  - `record-start` from a content sender is rejected.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** PR `feat(recorder): start, finish and cancel from extension pages`.

---

### Task 8: Content-side capture, in-recording fill and the pill (browser mode)

**Files:**
- Create: `src/lib/recorder/capture.ts`, `src/lib/content/recording.ts`, `src/lib/content/pill.ts`
- Modify: `src/lib/content/runner.ts`, `src/lib/content/chrome-api.ts`, `src/entrypoints/refill-content.ts`
- Test: `tests/browser/recorder/capture.test.ts`, `tests/browser/content/{recording,pill,chrome-api}.test.ts`, `tests/browser/content/runner.test.ts` (recording cases), `tests/browser/fields/scan.test.ts` (clobber fixture 8 in a shadow root)

**Interfaces:**
- `capture.ts`:
  - `readValue(el: FormControl, kind: ControlKind): string | null` reads through captured getters. Text → the value. Checkbox → `"true"`/`"false"`. Radio → `"true"` when checked, else `null`. Select → the value.
  - `class PageDefaults { note(controls: ScannedControl[]): void; get(el: FormControl, kind: ControlKind): string }`. `note` keeps the first value seen per element; it is called on every scan and runs before any fill of that scan. For an element no scan has seen, `get` falls back to `defaultValue`, `defaultChecked` or the `defaultSelected` option.
- `pill.ts`: `createPill(doc: Document, onFinish: () => void): { show(state: PillState): void; hide(): void; remove(): void; /** tests only */ root: ShadowRoot }`, where `PillState = { kind: "on" | "full"; count: number } | { kind: "stopped"; reason: "locked" | "expired" }`.
  - Placement: top right.
  - `onFinish` fires only on a trusted click.
  - Copy:
    - on: `● Recording · {n} field(s)` + **Finish**
    - full: `● Recording is full · {n} fields` + **Finish**
    - stopped (locked): `Recording stopped — vault locked`, hidden after 6 s
    - stopped (expired): `Recording stopped after 30 minutes`, hidden after 6 s
- `recording.ts`: `createRecording(env: { doc: Document; send(msg: ContentRequest): Promise<unknown>; latest(): ScanResult | null; rescan(): Promise<ScanResult | null>; filledField(el: Element): string | null; history: PasswordHistory; isTrusted?: (e: Event) => boolean }): { sync(): Promise<void>; observeRoot(root: ShadowRoot): void; noteScan(r: ScanResult): void; edited(el: Element): boolean; stop(): void }`
  - `sync()` asks `record-status`:
    - `on`/`full`: attach capture-phase `input`/`change` listeners on the document and each observed root, and show the pill.
    - `off`: detach and hide.
    - `stopped`: detach and show the stopped state.
  - On an event:
    1. Take `composedPath()[0]`. Require `isTrusted` and `!isFilling()`.
    2. Mark the element edited (a WeakSet for this document).
    3. Find the control in the latest scan, calling `rescan()` once if it is missing.
    4. Re-check `isEligible` and `!isSensitive` at event time.
    5. Send `{ value: readValue, pageDefault: PageDefaults.get, fieldId: env.filledField(el) }`.
  - Timing: `input` is debounced per element at 400 ms; `change` sends at once and cancels the pending send; `pagehide` flushes. Captures go out strictly in order, each after the `rescan()` it waited on has delivered. Every reply updates the pill.
- `runner.ts`:
  - `ContentRun` gains `rescan(): Promise<ScanResult | null>`.
  - The runner keeps a WeakMap of filled element → `fieldId` (exposed as `filledField`).
  - While recording is active, `apply` skips any element for which `recording.edited(el)` is true; these count as `skipped`.
  - The runner calls `noteScan` after each scan (before applying its plan) and `observeRoot` for each newly watched shadow root.
  - It calls `sync()` after the first scan, on a nudge and on a bfcache restore, and calls `stop()` from its own `stop()`.
- `ContentEnv` gains `onNudge?: (cb: () => void) => void`.
- `ChromeApi.onNudge(cb)` captures `runtime.onMessage.addListener`. It calls `cb` only for exactly `{ type: "refill-nudge" }` from `sender.id === runtime.id` with no `sender.tab`, and never replies.

- [ ] **Step 1: Failing tests.** A fake `send` records messages; it answers `on` for status and replays a given fill plan for scan-reports.
  - **Values:**
    - typed value + page default captured;
    - a revert sends value = default;
    - checkbox `"true"`/`"false"`;
    - a card-number field is captured.
  - **Ignored:**
    - an untrusted event;
    - edits made inside `withFillingGuard`;
    - password, show-password toggle, hidden, `-webkit-text-security`, CVV and one-time-code fields never send.
  - **In-recording fill:**
    - an empty control whose field is in the plan is filled;
    - a control the user edited in this document is not refilled after a re-scan, even when cleared (Review Focus 1);
    - a capture on a Refill-filled element carries that `fieldId` (Review Focus 5);
    - a filled value produces no capture.
  - **Shadow and ordering:**
    - a `change` inside an open shadow root is captured;
    - the capture follows the scan-report for a control added after the last scan;
    - debounce and the `change` flush.
  - **Pill:**
    - host is `:popover-open`;
    - shadow root is closed and has no `input`;
    - a synthetic `click` does not finish;
    - it renders under page CSS `* { all: unset }`.
  - **Other:**
    - a nudge from a tab sender is ignored;
    - clobber fixture 8 inside a shadow root.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS (`pnpm test:browser`). After `pnpm build`, `pnpm check:sw-no-dom` is clean. Add an ADR on content capture and the pill: trusted-only events, the event-time re-check, the page-default source, edited elements never refilled, the `fieldId` link, the debounce, and the closed root with CSSOM-only styles.
- [ ] **Step 5:** PR `feat(content): capture edits, fill from the recording, recording pill`.

---

### Task 9: Popup recording controls

**Files:**
- Modify: `src/entrypoints/popup/App.svelte`, `src/lib/sites/popup-site.ts`, `tests/unit/sites/popup-site.test.ts`
- Create: `tests/e2e/record.spec.ts` (popup part)

**Interfaces:**
- `SiteView` gains `hasProfile: boolean` and `recording: { state: "off" } | { state: "on" | "full"; count: number; here: boolean }`, read from `site-status` and `record-state`.
- Copy when unlocked:
  - **Off:** the existing enable button, plus **Record this site** with "Refill will ask Chrome for access to this site only, then remember what you type."
  - **On, no profile:** **Record this site**.
  - **On, with a profile:** **Record again**, with "Your saved form fills in as you go; change what's different."
  - **Recording here:** `Recording · {n} field(s)` + **Finish** + **Cancel recording**.
  - **Recording elsewhere:** "Refill is recording in another tab. Starting here stops it." + **Record this site**.
- Copy when locked: no record buttons, and "Unlock to record this site." for a site that is on or off.
- **Record this site** and **Record again** call `requestSiteEnable(..., "record")` as the first statement of the click handler (user activation). **Finish** sends `record-finish` and closes the popup. **Cancel recording** sends `record-cancel` and refreshes.

- [ ] **Step 1: Failing e2e** (pre-granted origin, popup opened as a tab):
  - Record this site → `Recording · 0 fields`.
  - Type in the fixture tab and reopen the popup → `Recording · 1 field`.
  - Cancel → back to Record this site.
  - Locked → no record button.

  Also unit tests for `viewOf` in every state.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** PR `feat(popup): record, finish and cancel`.

---

### Task 10: Review page

**Files:**
- Create: `src/entrypoints/review/{index.html,main.ts,App.svelte}`, `src/lib/recorder/review-flow.ts`, `tests/unit/recorder/{review-handlers,review-flow}.test.ts`
- Modify: `src/lib/recorder/handlers.ts`, `src/lib/messaging/protocol.ts`, `src/lib/profiles/store.ts` (M9), `tests/unit/profiles/store.test.ts`, `tests/e2e/record.spec.ts`, `tests/manifest/*` (only if the snapshot covers page entries)

**Interfaces:**
- `{ type: "review-load"; sessionId: string }` → `{ state: "ready"; model: ReviewModel; replacesProfile: boolean } | { state: "gone" }`. Only a **finished** session loads; a locked, expired or missing one is `gone`. The model is `reviewModel(origin, body, seededFrom ? stored profile : null)`.
- `{ type: "review-save"; sessionId: string; name: string; fillMode: "auto" | "gesture"; pathPrefix: string; policies: { fieldId: string; policy: FieldPolicy }[] }` → `{ ok: true } | { ok: false; error: "gone" | "invalid" }`:
  - Limits: name ≤ 120, prefix ≤ 256, ≤ 200 policies, `sessionId` matching `ID_RE`.
  - The profile id and `createdAt` are those of the site's current profile, or `newId()` and `now` when the site has none.
  - Then `buildProfile` → `saveProfile` → `discardSession("saved")`.
- `{ type: "review-discard"; sessionId: string }` → `{ ok: true }`.
- M9: `loadProfileForOrigin` reads the site index and the record within one `withStoreLock` through `tx`.
- Exact copy:
  - Heading: `Review what Refill recorded on {host}`.
  - Columns: Step · Field · Value · When I return.
  - Values are shown as `••••••` with a **Show**/**Hide** toggle (`aria-pressed`).
  - Policy select options: "Fill it in" (save), "Ask me" (ask), "Don't save" (skip).
  - Name, defaulting to the host or the saved name.
  - Fill mode radios: "Fill automatically when I open the page" (auto), "Fill only when I click Fill now in Refill" (gesture).
  - "Applies to pages under" (path prefix).
  - When `replacesProfile`: "Saving replaces the form saved for {host}."
  - Buttons: **Save**, **Discard**.
  - Saved: "Saved. Refill will fill this form the next time you open it."
  - Gone: "This recording is no longer available. Recordings end when Refill locks, after 30 minutes, or when you cancel them."
  - Empty: "Nothing was recorded. Type into the form while recording, then finish." with Discard only.
  - Errors: "Enter a name"; "The path must start with / and cover every recorded page".
- Session values render as text nodes only, never `{@html}`.

- [ ] **Step 1: Failing tests:**
  - **Unit:**
    - loading an unfinished session → `gone`;
    - saving after a lock → `gone`, and no `p:` write (Review Focus 4);
    - the saved profile carries the chosen policies;
    - Record again keeps the profile id and `createdAt`, keeps unreached seeded fields and replaces edited ones;
    - an invalid prefix → `invalid`;
    - a concurrent `loadProfileForOrigin` during a replace never returns `null` (M9).
  - **e2e:**
    - Finish from the popup opens the review tab, listing the typed fields masked;
    - Show reveals a value;
    - Save shows the saved copy;
    - the popup then shows Record again.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS. The manifest snapshot is unchanged, or deliberately updated if WXT lists the page.
- [ ] **Step 5:** PR `feat(review): review and save a recording`.

---

### Task 11: Record-to-fill e2e suite

**Files:**
- Create: `tests/e2e/sites/{never-capture.html,never-capture.js,strict-csp.html}`, and the remaining cases in `tests/e2e/record.spec.ts`
- Modify: `tests/e2e/sites/post-wizard.html` only if recording needs a stable step path. Do not weaken Plan 2's assertions.

**Interfaces:**
- `never-capture.html` has these fields: Email, Password (with a show toggle, `never-capture.js`), One-time code (`autocomplete="one-time-code"`), a hidden input set by script, Card number, Security code (CVV), SSN and Routing number.
- `strict-csp.html` has `<meta http-equiv="Content-Security-Policy" content="style-src 'none'; script-src 'none'">` and one text field.
- Every case records through the popup, types with Playwright (trusted input), finishes through the popup and saves on the review tab.

- [ ] **Step 1: Failing e2e:**
  - **SPA wizard:**
    1. Record step 1, go to step 2: step 2 is empty.
    2. Go Back: step 1 shows the recorded values (Review Focus 2).
    3. Finish, save and reload: step 1 fills, and advancing fills step 2.
  - **POST wizard** (full page loads):
    - recording step 1, posting to step 2, then using browser Back to step 1 shows step 1's values pre-filled;
    - one failed-validation round trip keeps a single step 1 in the review (Review Focus 3);
    - a later visit fills.
  - **Never-capture page:**
    - the review lists Email, Card number, SSN and Routing number, all defaulting to "Fill it in";
    - the password, one-time code, CVV and hidden values appear nowhere in the review page text;
    - a later visit fills the card number and leaves the CVV empty.
  - **Record again:**
    - the saved values fill during recording;
    - change one value, finish and save: the profile has the new value and keeps the untouched fields (Review Focus 5).
  - **Lock mid-recording** from the popup: the popup returns to Record this site, and the session's review URL shows the gone copy.
  - **Strict CSP:** the pill host is `:popover-open` with a box at least 100 px wide, and `cspViolations` is empty.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Fix what the suite finds.
- [ ] **Step 4:** PASS in 3 consecutive runs.
- [ ] **Step 5:** PR `test(e2e): record, review and fill`.

---

### Task 12: Plan 3 close-out

**Files:** Modify `docs/security/threat-model.md`, `docs/adr/0021-matcher-details.md` (M10), `README.md`, and spec §6.2 (one session at a time, the step rule, fill-from-recording, Record again seeding).

- [ ] **Step 1:** Rewrite the threat-model rows for `recorder/` and for "Content script, capture and toast" (control, proving test, ADR). Residuals:
  - Card numbers and SSNs are now stored (encrypted) by the user's choice, and CVV never is.
  - A same-origin script can fake typing only by stealing focus during a trusted user event.
  - The worker sees labels and names (structure).
  - The pill's host element is visible to the page.
  - A lock discards an unsaved recording.
  - During recording, session values fill under the normal fill rules.
- [ ] **Step 2:**
  - ADR 0021 wording (M10): "unconflicted claims skip Jaccard" applies to single-step profiles only, and fix the "rule below" pointer.
  - README: status Plan 3 of 7; profiles are created by recording; remove the note that no UI creates profiles.
- [ ] **Step 3:** PR `docs: Plan 3 threat model and README`. The controller then runs the whole-plan review and a manual Brave check of record → review → fill on a real site, and tags `v0.3.0-recorder`.
