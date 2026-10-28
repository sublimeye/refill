# ADR 0032: Content-side capture, in-recording fill and the recording pill

## Context
While a session records a tab (ADR 0029, ADR 0030), the content script must report what the user
types, pre-fill what was already recorded when the user returns to a page, and show the pill
`● Recording · N fields · Finish` (spec 6.2). The page is hostile: it can dispatch events, change a
field between scan and edit, style or remove anything in its DOM, and read whatever Refill writes
into it. Plan 3 Task 8 fixes the interfaces (`recorder/capture.ts`, `content/recording.ts`,
`content/pill.ts`) and the binding rules (trusted events only, never during a fill, eligibility and
secrecy at event time, closed shadow root, CSSOM-only styles). Ruling P12 adds: when recording
starts, the page is reported again even if unchanged. This ADR records how, and the choices the
brief left open.

## Decision
### Capture (`src/lib/content/recording.ts`)
- **Trusted only.** Capture-phase `input` and `change` listeners on the document and on every shadow
  root the runner watches (`change` is not composed, so it never leaves a shadow tree; a document
  listener sees an event from a closed tree retargeted to its host). The target is
  `composedPath()[0]` (captured `Event.prototype.composedPath`). An event that is not `isTrusted`, or
  that fires while `isFilling()` (Refill's own fill, including the trusted events of its
  `insertText` fallback), is ignored completely: it neither captures nor marks the element edited.
  One event seen by two listeners (document and an open root) is handled once (a `WeakSet` of
  events). Listeners exist only while the tab records.
- **Event-time re-check.** At the event, the control must pass `isEligible` and not
  `isSensitive` (signature built fresh, the password history of the document), whatever the scan
  said: a field flipped to `password` and back, or masked with `-webkit-text-security`, keeps its
  signature but is a secret now. The value and the page default are read **at the event**, through
  captured prototype getters, so a value a page script writes after the user's last keystroke is
  not what gets recorded.
- **Page defaults** (`PageDefaults` in `recorder/capture.ts`): the first value each scan saw per
  element (`String(checked)` for toggles), noted before that scan's fill plan is applied, so neither
  Refill's fill nor the user's edits change it. An element no scan has seen falls back to the
  markup: `defaultValue`, `defaultChecked`, the `selected` option, else the first option (what a
  single-line select shows), else `""`.
- **Edited elements are never refilled** (Review Focus 1). Every trusted edit outside a fill adds the
  element to a per-document `WeakSet`; while recording, the runner's `apply` counts such an element
  as `skipped` before `canFill`. A user who clears a field or puts its original value back keeps
  what they typed.
- **The `fieldId` link** (Review Focus 5). The runner keeps a `WeakMap` of element → field id for
  each `filled` outcome; a capture on that element carries the id, so the worker updates that field
  even when the page changed its label since.
- **Which signature, and ordering.** A capture carries the kind and signature from the runner's
  latest scan, so the worker files it under the page it last saw. When the element is not in that
  scan (added since), or no longer means its scanned signature (`stillMeans`, now shared in
  `content/still-means.ts`: a framework re-used the input for the next step), the capture waits for
  `rescan()`, which resolves only once that scan's report was delivered, then uses the new scan or
  is dropped. Captures and Finish run on one promise chain, in the user's order.
- **Debounce.** `input` waits 400 ms of quiet per element (`CAPTURE_DEBOUNCE_MS`); a `change`
  sends at once and replaces the element's pending send; `pagehide` and Finish flush every pending
  send first. A value or page default over 4096 characters (the worker's cap, `LIMITS.value`) is
  not sent: the worker would reject the whole message.
- **State.** `sync()` sends `record-status` after the runner's first scan (also on a page with no
  controls: a wizard's last page needs Finish), on a nudge and on a bfcache restore. `on`/`full`
  attaches the listeners and shows the pill; `off` detaches and hides it; `stopped` detaches. Only
  `sync` can start capturing; a capture's reply can update the count or end the recording. A failed
  send keeps the current state. On a pill Finish, the pending edits go first, then `record-finish`;
  `{ ok: true }` turns the recording off in this document, anything else re-reads the state.
- **Starting re-reports the page (P12).** When `sync` moves from not recording to `on`/`full`, it
  calls `rescan(true)`: the runner forgets the delivered fingerprint (as a bfcache restore does) and
  scans, so the worker has filed the current page before any capture (it answers a capture
  `no-step` until then). The runner's `filled` ids keep the second plan from writing again.
- **The "stopped" notice once per document (open choice).** The worker answers `stopped` for 30
  minutes after a lock or expiry (the tombstone, ADR 0029). Shown on every nudge or restore, the
  notice would reappear for half an hour; it is shown the first time this document hears it, and
  later `stopped` answers only keep the pill hidden.

### Runner (`src/lib/content/runner.ts`)
- `ContentRun.rescan()`; `scan()` now returns the promise of the running scan loop, so a caller that
  asks during a scan waits for the extra pass it requested. `noteScan` runs right after every
  `scanDocument`, before the fingerprint check; `observeRoot` for every newly watched shadow root;
  `stop()` stops the recording and removes the pill.
- The pill's host is skipped when the scan asks for shadow roots (`ownsHost`): the closed root that
  `dom.openOrClosedShadowRoot` would expose holds no control, and observing it would turn every
  count update into a re-scan.

### Nudge (`src/lib/content/chrome-api.ts`)
`runtime.onMessage` and its `addListener` are read once at capture, checked like `sendMessage`
(a plain object and a real function, never page markup), and a bad or missing one makes `onNudge` a
no-op. The listener calls back only for a message that is exactly `{ type: "refill-nudge" }` (a
plain object with that one key) from `sender.id === runtime.id` with no `sender.tab` (another
content script of Refill, in any tab, cannot wake this one), and returns `undefined` without
calling `sendResponse`: a nudge never gets a reply.

### Pill (`src/lib/content/pill.ts`)
- A `div` host built and given its **closed** shadow root before it is attached, so page code never
  sees it without one, and a `div` cannot be upgraded by a page-defined custom element.
  `popover="manual"` and `showPopover()` put it in the top layer; it is appended to the document
  element only while shown and removed on hide.
- **CSSOM only.** Every declaration goes through the captured `CSSStyleDeclaration.setProperty`
  with `important`: no style attribute in markup, no `<style>`, no `innerHTML`, no constructed
  sheet. Inline important declarations beat any page rule, so the host starts with `all: initial`
  and then sets everything it needs (position fixed, 12 px from the top right, font, colours, the
  popover's own `inset`/`margin`, which page CSS such as `* { all: unset }` would otherwise reset).
  Page styles do not reach inside the shadow root; inheritance is cut by `all: initial`. CSP does
  not govern CSSOM, so this renders under `style-src 'none'` (browser test with a CSP'd frame).
- Text and one button only, through captured `createElement`/`createTextNode`/`textContent`.
  Copy: `● Recording · {n} field(s)` + **Finish**; `● Recording is full · {n} field(s)` + **Finish**;
  `Recording stopped — vault locked` and `Recording stopped after 30 minutes`, hidden after 6 s.
  The plural follows `n` in both active states (the brief writes `{n} fields` for `full`; "1
  fields" would be wrong on an eleventh page with one field).
- Finish acts only on an `isTrusted` click; a click the page dispatches on the button or the host
  does nothing.

## Consequences
- A page can always hide or remove the pill, or swallow the click on Finish (it owns the DOM and the
  event path); Finish stays available in the popup. It cannot read the pill's nodes, make it
  finish, or make a capture out of its own events.
- An edit made less than 400 ms before a navigation that skips `pagehide` (a crash) is lost. A
  capture queued behind a `rescan()` when the page unloads may not get out.
- A page that rewrites a value right after the user's keystroke has the user's keystroke recorded,
  and its rewrite only if the following `change` carries it.
- Text inside a closed root that is only reachable through `dom.openOrClosedShadowRoot` is captured
  only once a scan has entered that root (its listeners are attached then).
- The stopped notice is not repeated in the same document; a new document in the same tab and
  origin shows it once more while the tombstone lasts.

## Status
Accepted (2026-10-27).
