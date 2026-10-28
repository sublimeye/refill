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
- **Page defaults** (`PageDefaults` in `recorder/capture.ts`): the first value a scan saw per
  element **and meaning** (`String(checked)` for toggles), noted with the scan's signature before
  that scan's fill plan is applied, so neither Refill's fill nor the user's edits change it. When
  `stillMeans` fails against the noted signature (an SPA re-used the input for another field), the
  entry is stale and the next scan notes the first value under the new meaning (ruling P13). An
  element with no current entry at edit time falls back to the markup: `defaultValue`,
  `defaultChecked`, the `selected` option, else the first option (what a single-line select shows),
  else `""`; that value is then kept for the current meaning, so a scan that only runs after the
  edit does not take the typed value for the page's own.
- **Edited elements are never refilled** (Review Focus 1). Every trusted edit outside a fill records
  the element with its signature at the edit; while recording, the runner's `apply` counts such an
  element as `skipped` before `canFill`. A user who clears a field or puts its original value back
  keeps what they typed. The mark holds only while the element still means that signature
  (`stillMeans`, ruling P13): an input the page re-used for step 2's field is not "edited" for that
  field, so step 2's recorded value pre-fills it.
- **The `fieldId` link** (Review Focus 5). The runner keeps a `WeakMap` of element → `{ fieldId,
  sig }` for each `filled` outcome. A capture on that element carries the id only while the element
  still means the signature it was filled under. The worker trusts the link and moves the linked
  field to the current step, so a stale id on a re-used input would carry step 1's field to step 2
  and lose its saved value; without the id, the edit is matched by its own signature. When the page
  relabels the field after the fill and before the edit, the id is not sent either, and the edit is
  matched by its signature; the link covers a label changed since the field was recorded, as long as
  the fill and the edit see the same label.
- **Which signature, and ordering.** A capture carries the kind and signature from the runner's
  latest scan, so the worker files it under the page it last saw. When the element is not in that
  scan (added since), or no longer means its scanned signature (`stillMeans`, now shared in
  `content/still-means.ts`: a framework re-used the input for the next step), the capture waits for
  `rescan()`, which resolves only once that scan's report was delivered, then uses the new scan or
  is dropped. Captures and Finish run on one promise chain, in the user's order.
- **Debounce.** `input` waits 400 ms of quiet per element (`CAPTURE_DEBOUNCE_MS`); a `change`
  sends at once and replaces the element's pending send; `pagehide` and Finish flush every pending
  send first.
- **Over the 4096-character cap** (the worker's, `LIMITS.value`, which rejects the whole message).
  A value over the cap is sent as a revert (`value = pageDefault`, same signature and `fieldId`), so
  the worker drops the field instead of keeping a shorter value captured earlier. A page default
  over the cap sends nothing.
- **State.** `sync()` sends `record-status` after the runner's first scan (also on a page with no
  controls: a wizard's last page needs Finish), on a nudge and on a bfcache restore. `on`/`full`
  attaches the listeners and shows the pill; `off` detaches and hides it; `stopped` detaches. Only
  `sync` can start capturing; a capture's reply can update the count or end the recording. A failed
  send keeps the current state. On a pill Finish, the pending edits go first, then `record-finish`;
  `{ ok: true }` turns the recording off in this document, anything else re-reads the state.
- **Starting re-reports the page (P12).** When `sync` moves from not recording to `on`/`full`, it
  calls `rescan(true)`: the runner forgets the delivered fingerprint (as a bfcache restore does) and
  scans, so the worker has filed the current page before any capture (it answers a capture
  `no-step` until then). The listeners are live from that moment, so in the same task the capture
  chain is made to wait for that report: an edit during the report's round trip is sent after it.
  The runner's `filled` ids keep the second plan from writing again.
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

### Flush before a popup Finish (ruling P17, Task 11)
The e2e suite found that a Finish from the popup lost an edit made less than 400 ms before it: the
capture was still in the debounce (the field kept focus, so no `change`), the worker marked the
session finished, and the late capture got `off`. The pill's Finish flushes first; the popup could
not reach the debounce.
- **`refill-flush`**, a content-bound message: exactly `{ type: "refill-flush" }`, with the nudge's
  sender checks (`sender.id === runtime.id`, no `sender.tab`). Unlike the nudge it gets a
  **data-free ack** `{ ok: true }`. The listener calls `Recording.flushed()`, which sends every
  debounced edit and resolves once the capture chain queued so far has settled (at once when not
  recording), then replies; it returns `true` so the reply can be async. Any other message still
  gets no reply, and **the nudge still never gets one**.
- **Worker:** the popup's `record-finish` reads the tab's session metadata (`peekMeta`, no DEK);
  for an unfinished one it sends `refill-flush` to frame 0 of the tab (`flushTab`) and awaits the
  ack, bounded at **1 s** (`FLUSH_TIMEOUT_MS`), then runs `finishSession`. The wait is outside any
  session job: the captures it waits for queue on that chain. A failure (no content script) or a
  timeout only ends the wait, logged by error name only. Reopening a finished session sends no
  flush. The pill's own Finish is unchanged.
- A Cancel that lands while a popup Finish waits for the ack wins: the Finish answers `{ ok: false }`.

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
- Known limits (accepted by the controller): edits made before the first `record-status` answer
  arrives (well under a second after load) are neither captured nor marked edited, so a plan
  answered in that window may still fill such a field if it is empty or at its page default. The
  nudge listener stays registered on `runtime.onMessage` after `stop()` (the captured API has no
  removal); its callback checks the stopped flag and does nothing.
- A frozen or busy page delays a popup Finish by at most 1 s (`FLUSH_TIMEOUT_MS`); its pending
  edits are then lost, as before this decision.
- An input whose label changes only in wording (a validation message inside the label) looks like a
  re-use: it loses its edited mark, its page default and its `fieldId`, and its next capture is
  matched by signature.

## Status
Accepted (2026-10-27). Amended by the Task 8 review (fix round 1): meaning-bound edited marks, page defaults and `fieldId` link; over-cap reverts; captures wait for the P12 report. Amended by Task 11 (ruling P17): `refill-flush` before a popup Finish.
