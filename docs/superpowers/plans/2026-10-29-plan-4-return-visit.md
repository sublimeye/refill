# Refill — Plan 4: Return visit (M4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Refill fills a page on a return visit, the user sees it. A small notice, in the same style as the recording pill, says `✓ Refill filled 2 fields` with an **Undo** button. The toolbar badge shows the count. On a "Fill on request" site, the notice says the fields are ready and the popup offers **Fill now**. While the vault is locked, a site with a saved form shows 🔒 on the badge and a notice with **Unlock**. After unlocking, open pages fill without a reload.

**Architecture:**
- **Content side:** the runner owns the page's one notice: the recording pill, generalized in `content/pill.ts`. It shows the return-visit states from the worker's fill plan. It keeps a per-document list of what it filled, for Undo and the count, and it outlines `ask` fields.
- **Worker side:**
  - The fill plan gains the `ask` control indices and the gesture plan's field ids, with no values.
  - A new content request, `toast-unlock-click`, calls `action.openPopup()`.
  - A new badge module sets the count, 🔒 or nothing per tab. On unlock it nudges every tab of a site with a saved form.
  - A nudge now also makes the content script report its page again. That is how unlock and **Fill now** reach a page that is already open.
  - **Fill now** is a page-only request that leaves a short-lived, one-time grant for the tab. The next scan of that tab consumes it.

**Tech Stack:** As in Plan 3; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-26-refill-design.md`. Read §5.4 to §5.6, §6.2, §6.3, §6.5, §6.6, §7 and §8 before any task. The Plan 1, 2 and 3 Global Constraints still apply.

**Carried from Plan 3** (memory note `plan-3-carry-forward`; the user's Brave check on 2026-10-29 surfaced none of them):
- **Folded into this plan:**
  - the duplicated `fields(n)` copy (Task 1);
  - the popup's `loadSite` sequencing (Task 5);
  - the recording "gone" copy, which omits site removal (Task 7).
- **Still parked for M7 hardening:** every other item.

**Not in this plan:** the popup's full profile card (name, steps, last used) and Edit (spec §6.6) belong to the M6 design pass. Drafts are M5.

## Global Constraints

- **Earlier plans:** the Plan 1–3 Global Constraints hold, including:
  - permissions, CSP and no network;
  - `crypto.subtle` only in `src/lib/crypto/` and `storage.local` only in `src/lib/store/`;
  - exact versions, one PR per task, and an ADR for each meaningful decision;
  - the worker's own clock and `sender.origin` as the only origin;
  - exact keys plus size caps on every message;
  - a DOM-free worker bundle and no content-script logs.
- **Manifest:** the production manifest does not change, and there is still no `tabs` permission. `action.openPopup` (Chromium 127+), `action.setBadgeText`, `tabs.query` and `tabs.onUpdated` need no permission. `tab.url` is readable only for granted origins, which are exactly Refill's enabled sites.
- **The notice is the pill** (ADR 0032 rules):
  - a host element with a **closed** shadow root, shown with `popover="manual"`;
  - styles through CSSOM only;
  - text and at most one button: no input, never a field value and never the profile name;
  - a button acts only on a trusted click.
- **One notice per document,** shared by recording and return visits. No return-visit notice shows while the tab records, and a recording state change never hides a return-visit notice.
- **Worker → content:** still only the data-free `refill-nudge` and `refill-flush`. On a nudge, the content script now also reports its page again (forced, even if unchanged).
- **Values still reach a page only in a `fill` plan.** A `gesture` plan carries field ids, never values.
- **Undo** writes under the filling guard, with the fill technique (`restore`). It puts back only controls whose current value is still exactly what Refill wrote. A field Refill filled stays "filled" for the document after Undo (once per document, ADR 0026).
- **New messages:**
  - content `toast-unlock-click`, exactly `{ type }`;
  - page-only `fill-now`, exactly `{ type, tabId, origin }`.
- **Badge text:**
  - the count is `String(n)` for 1 ≤ n ≤ 200, else empty;
  - `●` while recording (unchanged, `BADGE_RECORDING`);
  - `🔒` while locked, on a tab whose site has a saved form.

  Nothing but a recording sets or clears `●`.
- **Timing:**
  - `NOTICE_MS = 6000`: every notice except the recording states hides after 6 s, and stays while hovered or focused;
  - `FILL_GRANT_MS = 10_000`.

## Review Focus

1. **The user edits a filled field, then clicks Undo.** Their edit stays. Only fields still holding Refill's value go back, and nothing refills them in that document. Tests in Task 3 and Task 6.
2. **An SPA wizard fills step 2 after step 1.** The notice and the badge count both steps (4), and Undo covers both. In gesture mode, step 2 announces its own fields, never step 1's again. Tests in Task 3 and Task 6.
3. **A page opened while locked, then unlocked from the popup.** It fills without a reload, the 🔒 goes and the count shows. An enabled site without a saved form shows no notice and no 🔒 while locked. Tests in Task 2, Task 4 and Task 6.
4. **Recording on a site that has a saved form.** No fill notice and no count badge appear. The pill keeps its count, and the badge keeps `●`. The recording's `off` answer does not hide a fill notice that was already showing. Tests in Task 3, Task 4 and Task 6.
5. **A reload or a navigation after a fill.** The badge shows the new document's count, never the old page's, and a recording tab keeps `●`. Tests in Task 4 and Task 6.

---

## File Structure

```
src/
  entrypoints/
    background.ts            + badge listeners; e2e wrapper for toast-unlock-click
    refill-content.ts        + e2e-only notice marker
    popup/App.svelte         + Fill now; loadSite sequencing
  lib/
    copy.ts                  fields(n), shared by the pill and the popup (new, pure)
    content/pill.ts          the page notice: recording and return-visit states
    content/outline.ts       the `ask` outline (new, DOM)
    content/runner.ts        owns the notice; Undo list; ask outline; re-report on nudge
    content/recording.ts     uses the runner's pill; hides only recording states
    fill/fill.ts             + undo(records)
    messaging/content-protocol.ts   fill plan ask + gesture fieldIds; toast-unlock-click
    messaging/content-handlers.ts   ask indices; locked only with a saved form; grant; badge
    messaging/protocol.ts    + fill-now; SavedSummary.fillMode
    sites/badge.ts           per-tab badge; lock/unlock passes (new)
    sites/fill-now.ts        one-shot fill grants (new)
    sites/popup-site.ts      + fillNowFor; SavedForm.fillMode
docs/adr/0036-page-notice.md, 0037-badge-and-unlock-refill.md, 0038-fill-now.md
tests/e2e/return.spec.ts
```

---

### Task 1: The page notice (pill states)

**Files:**
- Create: `src/lib/copy.ts`, `docs/adr/0036-page-notice.md`
- Modify: `src/lib/content/pill.ts`, `src/lib/content/recording.ts` (new `createPill` signature only), `src/lib/sites/popup-site.ts` (import `fields`)
- Test: `tests/browser/content/pill.test.ts`, `tests/unit/sites/popup-site.test.ts`

**Interfaces:**
- `src/lib/copy.ts` (no imports): `fields(n: number): string` returns `"1 field"`, otherwise `"<n> fields"`.
- `src/lib/content/pill.ts`:
  ```ts
  export type PillState =
    | { kind: "on" | "full"; count: number }
    | { kind: "stopped"; reason: "locked" | "expired" }
    | { kind: "filled"; count: number; ask: number }
    | { kind: "undone" }
    | { kind: "ready"; count: number }
    | { kind: "locked"; fallback: boolean }
    | { kind: "updated" };
  export interface PillActions { finish(): void; undo(): void; unlock(): void }
  export const NOTICE_MS = 6000; // replaces STOPPED_PILL_MS
  export function createPill(
    doc: Document,
    actions: PillActions,
    onChange?: (kind: PillState["kind"] | null) => void, // tests and e2e only
  ): Pill;
  // Pill keeps show, hide, remove, host, root and gains:
  showing(): PillState["kind"] | null;
  ```
- Exact copy. `·` is U+00B7 and `—` is U+2014. `needs you` is `1 needs you`, else `<n> need you`.

  | kind | glyph (colour) | text | button → action |
  |---|---|---|---|
  | on | `●` (#ff453a) | `Recording · {fields}` | Finish → finish |
  | full | `●` (#ff453a) | `Recording is full · {fields}` | Finish → finish |
  | stopped | — | unchanged from Plan 3 | — |
  | filled | `✓` (#30d158) | `Refill filled {fields}` + (ask > 0 ? ` · {needs you}` : "") | Undo → undo |
  | undone | — | `Fill undone` | — |
  | ready | — | `{fields} ready — open Refill to fill` | — |
  | locked, fallback false | — | `Refill has a saved form for this site — unlock from the toolbar icon` | Unlock → unlock |
  | locked, fallback true | — | same text | — |
  | updated | — | `Refill was updated — reload this page` | — |

- Every kind except `on` and `full` hides `NOTICE_MS` after its `show`. `pointerenter` or `focusin` on the host stops that timer. `pointerleave` or `focusout` restarts the full `NOTICE_MS` once neither hover nor focus is inside.
- `onChange` is called with the kind on every show and with `null` on every hide, the timer's included.
- Palette: the pill's own, in light and dark schemes alike (the user's choice of 2026-10-29). The bar gains `border: 1px solid rgba(255, 255, 255, 0.16)`, so it stays visible on dark pages. No transitions or animations, so `prefers-reduced-motion` has nothing to reduce.

- [ ] **Step 1: Failing tests.**
  - `pill.test.ts`:
    - one case per row of the table: the text through `root`, the button label, or no visible button;
    - a trusted `userEvent.click` on Undo calls `undo` once, and on Unlock calls `unlock` once;
    - `button.click()` and `host.dispatchEvent(new MouseEvent("click"))` call nothing;
    - with `vi.useFakeTimers()`, `filled` is gone after 6000 ms and `on` is still open after 60 s;
    - hovering keeps `filled` open past 6000 ms, and unhovering closes it 6000 ms later;
    - `showing()` and `onChange` follow show, hide and the timer.
  - `popup-site.test.ts`: `savedLine` still reads `Saved form · 1 field`.
  - The existing pill tests (strict CSP, `all: unset`) stay green.
- [ ] **Step 2:** `pnpm test:browser tests/browser/content/pill.test.ts` → FAIL.
- [ ] **Step 3:** Implement. `recording.ts` passes `{ finish, undo: () => {}, unlock: () => {} }` for now; Task 3 moves the pill into the runner. Write ADR 0036 covering the states, copy, timing, palette and the one-notice rule.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:browser` → all pass.
- [ ] **Step 5:** PR `feat(content): page notice states for the return visit`.

---

### Task 2: Fill plan, locked state and `toast-unlock-click` (worker)

**Files:**
- Modify: `src/lib/messaging/content-protocol.ts`, `src/lib/messaging/content-handlers.ts`, `src/entrypoints/background.ts` (e2e wrapper), spec §6.3 and §7
- Test: `tests/unit/messaging/content-protocol.test.ts`, `tests/unit/messaging/content-handlers.test.ts`, `tests/unit/messaging/background.test.ts`

**Interfaces:**
- **`FillPlan`:**
  ```ts
  | { state: "locked" }
  | { state: "none" }
  | { state: "gesture"; fieldIds: string[] }           // replaces count; ids only, no values
  | { state: "fill"; items: FillItem[]; ask: number[] } // ask: control indices `i`
  ```
  - `ask` holds the control index of every matched field whose policy is `ask`.
  - `fieldIds` holds the ids of the matched `save` fields.
  - When there are no `save` items, the plan is still `none`, whatever `ask` holds.
  - A recording's plan is `{ state: "fill", items, ask: [] }`.
- **`locked`:** returned only when the sender's site record (`readSites()`) has a non-null `profileId`. Otherwise a locked vault answers `none`.
- **`fill-result`:** the shape is unchanged. Its meaning changes: `filled` is now the document's running total of fields Refill filled and has not undone, while `skipped` and `unsupported` stay per plan. The handler still answers `{ ok: true }`; Task 4 adds the badge.
- **New `{ type: "toast-unlock-click" }`:**
  - exact keys;
  - answers `{ ok: boolean }`: `true` when `browser.action.openPopup()` resolved, `false` when it threw (logged by error name);
  - `ContentResponse` maps it accordingly;
  - the e2e wrapper logs `{ type, ok }` plus `where(ctx)`.

- [ ] **Step 1: Failing tests.**
  - `content-protocol.test.ts`: `toast-unlock-click` parses, and any extra key is rejected.
  - `content-handlers.test.ts`:
    - a profile with one `save` field and one `ask` field, both matched, gives `fill` with one item and `ask: [<ask control i>]`;
    - in gesture mode it gives `{ state: "gesture", fieldIds: [<save id>] }`, and the plan has no `value` anywhere (`JSON.stringify` check);
    - while locked: an enabled site with a saved form gives `locked`, and one without gives `none`;
    - a recording scan gives `ask: []`;
    - `toast-unlock-click` gives `ok: true` with `openPopup` resolving and `ok: false` with it rejecting.
  - `background.test.ts`: the e2e wrapper covers the new type.
- [ ] **Step 2:** `pnpm vitest run tests/unit/messaging` → FAIL.
- [ ] **Step 3:** Implement. Amend the spec:
  - **§7:** the content list gains `toast-unlock-click`.
  - **§6.3:** the locked state applies only to a site with a saved form, and the gesture plan carries field ids.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:browser` → all pass. The runner's `fillItems` ignores the new keys, so Plan 2 and Plan 3 behaviour is unchanged.
- [ ] **Step 5:** PR `feat(fill): ask indices, gesture ids, locked only with a saved form, unlock click`.

---

### Task 3: Return-visit notice, Undo and the `ask` outline (content)

**Files:**
- Create: `src/lib/content/outline.ts`
- Modify:
  - `src/lib/content/runner.ts`, `src/lib/content/recording.ts`, `src/lib/fill/fill.ts`;
  - `src/entrypoints/refill-content.ts`;
  - `docs/adr/0036-page-notice.md`, plus an amendment to ADR 0026;
  - spec §5.6, §6.3 and §7.
- Test: `tests/browser/content/runner.test.ts`, `tests/browser/content/recording.test.ts`, `tests/browser/fill/fill.test.ts`, `tests/browser/content/outline.test.ts`

**Interfaces:**
- **`fill.ts`:**
  ```ts
  export interface FillRecord { before: FillSnapshot["entries"][number]; written: string }
  /**
   * Restores each record whose control still reads exactly `written` (text and select: the value;
   * checkbox and radio: String(checked)), with `restore`, under the guard. Returns how many it
   * restored.
   */
  export function undo(records: FillRecord[]): number;
  ```
- **`outline.ts`:**
  ```ts
  export interface Outlines {
    /** Outlines `el` (once per element). False when it already was or the write failed. */
    add(el: FormControl): boolean;
    /** Removes it and puts back the page's own inline outline declarations. */
    release(el: Element): void;
    count(): number;
    clear(): void;
  }
  export function createOutlines(): Outlines;
  ```
  - The outline is `outline: 2px solid #0a84ff` and `outline-offset: 2px`, both set `important` through CSSOM.
  - The page's own inline values and priorities are saved first.
- **`RecordingEnv`** gains `pill(): Pill`, the runner's one notice. `Recording.ownsHost` is removed, and the runner checks `pill.host` itself.
  - Recording shows only `on`, `full` and `stopped`.
  - On `off`, it hides the pill only when `showing()` is one of those three kinds.
- **`ContentEnv`** gains `onNotice?: (kind: PillState["kind"] | null) => void`, passed through as the pill's `onChange`. `refill-content.ts` sets `document.documentElement.dataset.refillNotice = kind ?? ""` in MODE `e2e` only, as the existing e2e block does.
- **Runner rules.** All of these apply only while `recording.active()` is false.
  - **`fill` plan:**
    - Take `snapshot([item])` right before each `fillControl`.
    - On `"filled"`, push `{ before, written: item.value }` to the document's `records`.
    - Then, for each `ask` index whose control is a text or select reading `""`, or is a checkbox or radio, call `outlines.add`.
    - If `records` grew, show `filled { count: records.length, ask: outlines.count() }`.
    - The `fill-result` sent after the plan carries `filled: records.length`.
  - **`gesture` plan:** `n` is the number of `fieldIds` not yet in `filled`. Show `ready { count: n }` when `n > 0` and `n` differs from the last `ready` count shown in this document.
  - **`locked` plan:** show `locked { fallback: false }` once per document. A bfcache restore is the same document.
  - **Unlock action:** send `toast-unlock-click`. On `{ ok: true }`, hide the notice. On anything else, show `locked { fallback: true }`.
  - **Undo action:** `undo(records)`, then empty `records`, show `undone`, and send `fill-result { filled: 0, skipped: 0, unsupported: 0 }`. The ids stay in `filled`.
  - **Outline release:** a trusted `input` or `change` whose deepest target is outlined (a capture listener on the document) releases it. `stop()` clears every outline.
  - **Nudge:** the callback runs `sync()` and, independently, `rescan(true)`.
  - **Extension gone:** when `send` finds the extension gone, the run stops as before. If Refill filled, recorded or showed a notice in this document, it first shows `updated` and leaves that notice to its own timer, so `stop()` does not remove it on this path.

- [ ] **Step 1: Failing tests.**
  - `fill.test.ts`, `undo()`:
    - restores only records still holding `written`, and leaves a field the user changed after the fill;
    - returns the count;
    - `isFilling()` is true inside it;
    - a detached control is skipped.
  - `outline.test.ts`: add sets the outline, and release restores a page's own `outline: 1px dotted red !important`. A second `add` gives false.
  - `runner.test.ts`, using the existing fake `send`, `isTrusted` and `onNotice`:
    - a plan with 2 items shows `filled` 2 and sends `fill-result` `filled: 2`;
    - a second plan with 2 new ids (SPA step 2) shows `filled` 4;
    - Undo after the user edits one filled field leaves that edit, restores the other three, shows `undone`, sends `filled: 0`, and a later plan with the same ids writes nothing;
    - `gesture` with ids `[a, b, c]` shows `ready` 3 once; a repeat with the same ids shows nothing; after a fill of `a` and `b`, the ids `[a, b, c, d]` show `ready` 2;
    - `locked` shows `locked`. A trusted Unlock click sends `toast-unlock-click`, and the reply `{ ok: false }` shows `locked` with no button;
    - `ask: [i]` on an empty input outlines it and the notice reads `· 1 needs you`. A non-empty one is not outlined, and a trusted input on the outlined one releases it;
    - while recording, a `fill` plan shows no `filled` notice; a `filled` notice shown before a nudge whose `record-status` answers `off` is still showing after it;
    - a nudge on an unchanged page sends a second `scan-report`;
    - `send` rejecting with "Extension context invalidated" after a fill leaves `updated` showing and sends nothing more.
  - `recording.test.ts`: the existing pill cases pass with the runner's pill.
- [ ] **Step 2:** `pnpm test:browser tests/browser/content tests/browser/fill` → FAIL.
- [ ] **Step 3:** Implement. Amend the spec:
  - **§5.6:** Undo restores only fields still holding Refill's value.
  - **§6.3:** the copy in the Task 1 table. The profile name is dropped: one form per site makes it redundant, and the user asked for the short form.
  - **§7:** a nudge also makes the content script report its page again.

  Then extend ADR 0036 and amend ADR 0026 (the nudge re-report, and filled ids staying filled after Undo).
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:browser && pnpm test:e2e` → all pass. Plan 3's record e2e must stay green.
- [ ] **Step 5:** PR `feat(content): return-visit notice with Undo, ask outline, updated notice`.

---

### Task 4: Badge and unlock refill (worker)

**Files:**
- Create: `src/lib/sites/badge.ts`, `docs/adr/0037-badge-and-unlock-refill.md`
- Modify:
  - `src/lib/recorder/session.ts` (export `BADGE_RECORDING`);
  - `src/lib/messaging/content-handlers.ts` (`fill-result` and `locked` set the badge);
  - `src/entrypoints/background.ts` (`installBadgeListeners()` at top level, synchronously);
  - spec §6.3 and §6.5.
- Test: `tests/unit/sites/badge.test.ts`, `tests/unit/messaging/content-handlers.test.ts`

**Interfaces:**
```ts
export const BADGE_LOCKED = "🔒";
export function badgeCount(n: number): string; // "" unless 1 <= n <= 200
/** Skips a tab with an unfinished recording session (`peekMeta({ tab })`) and a locked vault. */
export function showFillCount(tabId: number, filled: number): Promise<void>;
/** Skips a tab with an unfinished recording session. */
export function showLocked(tabId: number): Promise<void>;
/** Tab ids whose URL origin is an enabled, not revoked site with a profileId (`tabs.query({})`). */
export function profileTabs(): Promise<number[]>;
/**
 * tabs.onUpdated with status "loading": clear the badge unless the tab records.
 * onLockChange(false): showLocked for each profileTabs() tab.
 * onLockChange(true): for each profileTabs() tab, clear its badge (unless it records) and nudge it.
 * Registers listeners only; must run in the worker's first turn.
 */
export function installBadgeListeners(): void;
```
- The `fill-result` handler calls `showFillCount(ctx.tabId, req.filled)`.
- `scan-report` calls `showLocked(ctx.tabId)` whenever it answers `locked` and there is no recording.
- Badge failures are logged by error name only and never change a reply.
- Accepted residual (ADR 0037): if a lock lands while a tab records, that tab may end with no badge rather than 🔒, depending on whether the session drop's clear runs first.

- [ ] **Step 1: Failing tests** (`badge.test.ts`, with the browser fakes the unit suite already uses).
  - `badgeCount`: 0 gives `""`, 1 gives `"1"`, 200 gives `"200"` and 201 gives `""`.
  - `showFillCount` sets `"3"`; on a recording tab it leaves `"●"`; while locked it sets nothing.
  - `profileTabs` lists only the tabs of an enabled site with a saved form, and leaves out a revoked one and a tab whose `url` is undefined.
  - A lock gives 🔒 on those tabs only. An unlock clears them and nudges exactly those tabs.
  - `onUpdated` with `loading` clears a count, and leaves `●` on a recording tab.
  - `content-handlers.test.ts`: `fill-result { filled: 2 }` sets `"2"`, and a locked scan on a profile site sets 🔒.
- [ ] **Step 2:** `pnpm vitest run tests/unit/sites/badge.test.ts tests/unit/messaging` → FAIL.
- [ ] **Step 3:** Implement. Amend the spec:
  - **§6.5:** the count is cleared on navigation, and the lock and unlock passes run as above.
  - **§6.3:** after unlock, the worker nudges each open tab of a site with a saved form, and the page reports again. This replaces "re-runs matching on the active tab's latest scan-report": the worker keeps no scans.

  Write ADR 0037.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm check:sw-no-dom` → all pass.
- [ ] **Step 5:** PR `feat(worker): fill count and lock badge; unlock refills open tabs`.

---

### Task 5: Fill now

**Files:**
- Create: `src/lib/sites/fill-now.ts`, `docs/adr/0038-fill-now.md`
- Modify:
  - `src/lib/messaging/protocol.ts`, `src/lib/messaging/page-handlers.ts`, `src/lib/messaging/content-handlers.ts`;
  - `src/lib/recorder/review-handlers.ts` (`saved-summary` adds `fillMode`);
  - `src/lib/sites/popup-site.ts`, `src/entrypoints/popup/App.svelte`;
  - spec §6.3, §6.6 and §7.
- Test: `tests/unit/sites/fill-now.test.ts`, `tests/unit/messaging/*`, `tests/unit/sites/popup-site.test.ts`, `tests/unit/recorder/review-handlers.test.ts`

**Interfaces:**
- **`sites/fill-now.ts`**, in worker memory: a lost grant just means pressing Fill now again.
  ```ts
  export const FILL_GRANT_MS = 10_000;
  export function grantFill(tabId: number, origin: string, now: number): void; // replaces any grant for the tab
  /** True at most once per grant, only for the same tab and origin, only while now < grantedAt + FILL_GRANT_MS. */
  export function takeGrant(tabId: number, origin: string, now: number): boolean;
  ```
- **Page request `{ type: "fill-now"; tabId: number; origin: string }`** answers `{ ok: true } | { ok: false; error: "locked" | "invalid-origin" | "not-granted" | "no-profile" | "tab-moved" }`. It checks, in order:
  1. the origin is canonical;
  2. the vault is unlocked;
  3. the host permission is held and the site is enabled and not revoked;
  4. the site has a `profileId`;
  5. `tabShowsOrigin`.

  Then it calls `grantFill`, then `await nudge(tabId)`, and answers `ok`.
- **`scanReport`:** when `profile.fillMode === "gesture"` and `items.length > 0`, `takeGrant(ctx.tabId, ctx.origin, now())` turns the answer into `fill` (with `touch`). Without a grant, the answer stays `gesture`.
- **`SavedSummary`** saved becomes `{ state: "saved"; profileId; count; fillMode: "auto" | "gesture" }`. `SavedForm` gains `fillMode`.
- **`popup-site.ts`:** `fillNowFor(target: Target & { origin: string }): Promise<"ok" | "locked" | "tab-moved" | "error">`, which never throws.
- **Popup:**
  - **Fill now** sits next to View when the vault is unlocked, the saved form exists, `s.saved.fillMode === "gesture"` and the recording is `off`.
  - `ok` closes the popup.
  - `locked` refreshes and announces `Refill locked — unlock, then fill again.`
  - `tab-moved` uses the existing tab-moved copy; anything else gets `GENERIC`.
  - **`loadSite` sequencing:** a generation counter, bumped by every assignment to `site`, so an older `loadSite` that resolves late never overwrites a newer view.

- [ ] **Step 1: Failing tests.**
  - `fill-now.test.ts`:
    - `takeGrant` succeeds once, then false;
    - false for another origin or tab, and false at `grantedAt + 10_000`;
    - a new grant replaces the old one.
  - Protocol: `fill-now` exact keys, tabId and origin caps.
  - Handler: each error in order, then `ok` with one nudge.
  - `content-handlers.test.ts`: a gesture profile with a grant answers `fill`, and the next scan answers `gesture`. A grant for another origin is ignored.
  - `popup-site.test.ts`: `viewOf` carries `fillMode`, and `fillNowFor` maps each reply.
- [ ] **Step 2:** `pnpm vitest run tests/unit` → FAIL.
- [ ] **Step 3:** Implement. Amend the spec:
  - **§6.3 and §6.6:** Fill now leaves a one-time grant, valid for 10 s, that the tab's next matching scan consumes.
  - **§7:** `fill-now` is page-only.

  Write ADR 0038.
- [ ] **Step 4:** Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:browser` → all pass.
- [ ] **Step 5:** PR `feat: Fill now for sites set to fill on request`.

---

### Task 6: Return-visit e2e

**Files:**
- Create: `tests/e2e/return.spec.ts`
- Modify: `tests/e2e/content-helpers.ts`. It gains:
  - `badgeText(context, tabId)`, through the worker's `chrome.action.getBadgeText`;
  - `noticeOf(page)`, which reads `dataset.refillNotice`.

**Interfaces:** It uses the existing seams: `saveProfile`, `profileFrom`, `setUp`, `lockVault`, `unlockInPopup`, `tabIdOf` and the popup opened as a tab. Profiles are seeded with the existing fixture sites (`index.html` form, `spa-wizard.html`).

- [ ] **Step 1: Write the cases.**
  1. **Auto mode.** After the seeded fields fill:
     - `noticeOf` is `filled`, the host is `:popover-open`, and the badge is `"2"`;
     - a reload gives `"2"` again (that document's own fill);
     - navigating the tab to an enabled page with no saved form gives `""`.
  2. **SPA wizard.** Step 1 gives `"2"`. After Next, step 2 fills and gives `"4"`.
  3. **Gesture mode.** The notice is `ready`, the fields stay empty and the badge is `""`. The popup shows **Fill now**. After clicking it, the fields fill, the notice is `filled` and the badge is `"2"`. A reload then gives `ready` again.
  4. **Locked.**
     - Opening the site gives notice `locked`, badge `🔒` and empty fields.
     - An enabled site without a saved form, in a second tab, gives no notice and badge `""`.
     - `unlockInPopup` fills the first tab without a reload: notice `filled`, badge `"2"`. The second tab stays `""`.
  5. **Recording.** **Record again** on the auto site: the badge is `●`, `noticeOf` never becomes `filled`, and the pill is open.

  The Unlock and Undo buttons sit in a closed root that Playwright cannot click reliably. Tasks 1 to 3 cover them with trusted clicks in browser mode, and the real `openPopup` is in the manual Brave check (Task 7).
- [ ] **Step 2:** `pnpm test:e2e tests/e2e/return.spec.ts` → PASS. Then run the whole e2e suite 3 times in a row, all green.
- [ ] **Step 3:** PR `test(e2e): return visit notice, badge, Fill now and unlock`.

---

### Task 7: Docs, threat model and the carried copy fix

**Files:**
- Modify:
  - `docs/security/threat-model.md`;
  - `README.md` ("What works now" and the manual Brave check);
  - `src/entrypoints/review/App.svelte` and the test that pins the recording "gone" copy.
- Test: the existing review tests.

**Interfaces:**
- **Threat model rows:**
  - **`content/`:** the notice; Undo; the `ask` outline writes inline styles on page controls, so a page learns which controls are set to Ask; `updated`.
  - **`messaging/`:**
    - `toast-unlock-click`: only a trusted click sends it, and the worst a forgery does is open Refill's popup;
    - `fill-now`: page-only, one-time grant.
  - **`sites/`:**
    - the badge reveals nothing to pages;
    - `tab.url` is read for granted origins only;
    - unlock nudges only the tabs of sites with a saved form.
- **Recording "gone" copy:** `This recording is no longer available. Recordings end when Refill locks, after 30 minutes, when you cancel them, or when the site is removed.`
- **README:** the return-visit notice, Undo, badge and Fill now. Add manual checks for:
  - the real `openPopup` from the locked notice in Brave;
  - the notice on a dark page;
  - Undo after editing one field.

- [ ] **Step 1:** Update the copy test first → FAIL. Then change the copy → PASS.
- [ ] **Step 2:** Update the docs. Run `pnpm lint && pnpm format:check && pnpm test && pnpm test:browser` → all pass.
- [ ] **Step 3:** PR `docs: Plan 4 threat model and README; recording gone copy`.
