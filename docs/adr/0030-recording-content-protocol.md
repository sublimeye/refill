# ADR 0030: Recording content protocol (status, capture, finish; scan-report drives the recording)

## Context
While a session records a tab (ADR 0029), the content script on that tab must learn whether it is
recording, report each trusted edit, and let the user finish. Step tracking and the in-recording fill
reuse Plan 2's `scan-report` (Plan 3 architecture): going back to a recorded page must pre-fill what
was captured there, from the session and never from the stored profile (spec §6.2). The model is
ADR 0028 and the store is ADR 0029; this ADR covers the messages and the worker handlers.

## Decision
### Messages (content → worker, `src/lib/messaging/content-protocol.ts`)
- `{ type: "record-status" }` and `{ type: "record-finish" }`: exactly that one key.
- `{ type: "record-capture", kind, sig, value, pageDefault, fieldId }`: exact keys. `kind` is one of
  the four control kinds, `sig` goes through the same `parseSig` as a scan (every string at most
  256 characters), `value` and `pageDefault` are strings of at most 4096 characters
  (`MAX_CAPTURE_VALUE` = the profile value limit), and `fieldId` is `null` or matches `ID_RE`.
- `record-start` never parses as a content message: only an extension page can start a recording.
- Replies: `record-status` and `record-capture` answer a `RecordState`:
  `off`, `on` with the count, `full` with the count, or `stopped` with `locked`/`expired`.
  `record-finish` answers `{ ok: boolean }`. No reply carries a value.
- Worker → content: the data-free `{ type: "refill-nudge" }` (ADR 0029), which makes the content
  script ask `record-status`.

### Scope
Every handler uses the session that matches `{ tabId, origin }` from the router's sender context.
A finished session is `off` for the content script: it belongs to its review page. When no session
matches, the answer is `stopped` if this tab and origin have a tombstone (ADR 0029), else `off`.
The tombstone holds the origin it ended on (Task 7, ruling P10), so only that origin in that tab
sees `stopped`.

### `full` (the plan left this open)
`recordState(body)` answers `full` when nothing more can be captured on this page:
- the body holds 200 fields, the profile limit (an edit of an existing field still applies); or
- the page is an eleventh step: no current step and all 10 step slots used.

Otherwise it answers `on`. Back on a known step after an eleventh page, the answer is `on` again.

### scan-report while recording (`recordingScan` in `src/lib/recorder/handlers.ts`)
`createContentHandlers`' scan-report handler runs these steps:
1. It reads `lockEpoch()` and answers `locked` unless `status()` is unlocked, as in Plan 2.
2. It calls `recordingScan`. With an active, unfinished session for this tab and origin, the job:
   - runs `observePage` with the controls' `sigKey` keys, `ctx.documentId ?? null` and
     `ctx.pathname`;
   - on `"full"`, stores the body with `current: null` and `lastDocument` set to this document
     (Plan 3 ruling P4), so captures on that page get `"no-step"` and answer `full`;
   - returns `recordingPlan` over the body it stores; when `observePage` returns the body unchanged
     (the same page again: same step, no new key, same document), the job returns no body, so
     nothing is sealed or written (Task 7, ruling P10). The reply is the same. A new step has no fields yet, and the matcher's
     step gate keeps other steps' fields off it.
3. With a plan, it re-checks `lockEpoch()` synchronously and then answers `{ state: "fill", items }`,
   or `none` when there are no items.
   - The stored profile is never loaded on this path, and `lastUsedAt` is never touched.
   - The answer is `fill` whatever the saved profile's fill mode: the user is filling this page by
     hand, and the content script never refills an element the user edited (Task 8).
4. Without such a session, Plan 2's handler runs unchanged. A finished session counts as none: the
   tab fills from the stored profile again.

### record-capture
`applyCapture` runs inside `withSession`. A capture that leaves the body as it was (a secret, no
current step, the field limit) writes nothing. The answer is `recordState` of the resulting body.
The worker never logs a captured value. A capture with no matching session is answered and dropped.

### record-finish (`finishSession(match, now)`, shared with the popup's Finish)
1. One `withSession` job sets `finished` and `expiresAt = now + RECORDING_TTL_MS`. A finished or
   missing session answers `{ ok: false }`.
2. Then `clearBadge(tabId)` (exported by the store), and
   `tabs.create({ url: runtime.getURL("/review.html") + "?session=" + id })`.
- The badge is cleared after the job, outside the chain. A start for the same tab that lands in
  between would lose its badge. Only an extension page can start a session, so a start must follow
  the Finish click within that gap; this is accepted.
- If `tabs.create` fails, the router answers `internal`. The session stays finished until its TTL,
  and the user can record again.
- `REVIEW_PAGE` is cast to WXT's `PublicPath` until the review entrypoint exists (Task 10).

### Wiring and the e2e seam
`createContentHandlers` spreads `createRecorderContentHandlers(now)` into its handlers, so one
factory gives the router every content handler. The e2e seam in `background.ts` wraps the three
new handlers. It logs the type, the sender context (origin, path, tab, document) and the reply's
state. For a finish, the state is `finished` or `off`. It never logs a capture request.

## Consequences
- A capture is the one content message that carries a value the user typed (spec §6.2). It is
  parsed with exact keys and size caps like every other message. It is stored only sealed (ADR
  0029), and only in the session of the sender's own tab and origin.
- Each scan-report while recording costs one session job: one open and one seal.
- Recording and filling share the matcher: what the plan fills while recording is what the saved
  profile will fill (ADR 0028).

## Status
Accepted (2026-10-27). Amended by Task 7 (2026-10-27): the tombstone is per origin, and an unchanged
page is not written again. `finishSession` takes `reopen` for the extension page (ADR 0031).
