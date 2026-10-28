# ADR 0031: Recording page requests (start, state, finish, cancel; the record intent)

## Context
Recording is started and ended from extension pages (spec §3.1, §6.2). The first time on a site, the
popup must ask for the host permission inside the click and then start recording, even if the
permission dialog closes the popup (ADR 0007, ADR 0018). The content protocol (ADR 0030) deliberately
has no way to start a session: a web page, or a script on it, must never be able to begin capturing.

## Decision
### Messages (extension page → worker, `src/lib/messaging/protocol.ts`)
All four are page-only: `parseContentRequest` never accepts them, and the router refuses them from a
content sender. Exact keys, `tabId` a non-negative safe integer, `origin` at most 256 characters.
- `record-start { tabId, origin }` → `{ ok: true }` or `{ ok: false, error }` with `locked`,
  `not-granted`, `invalid-origin` or `tab-moved`.
- `record-state { tabId }` → `off`, or `on | full | review` with `origin`, `count` and `here`. There
  is one session, and `here` says whether it is the asked tab's. A finished session is `review`
  (ruling P11).
- `record-finish { tabId }` → `{ ok }`.
- `record-cancel { tabId }` → `{ ok: true }`.
- `site-intent` gains `kind: "enable" | "record"`, and the stored intent too (`IntentKind`).

### record-start
1. The origin is canonical https, else `invalid-origin`.
2. In this order: the vault is unlocked (`locked`), the host permission is held (`not-granted`), the
   tab still shows the origin (`tab-moved`). Nothing changes on a refusal.
3. The pending intent for the origin is taken (the work is being done; it cannot be replayed), the
   site is upserted with `accessRevoked: false` and the content script is reconciled.
4. `beginRecording` (`recorder/start.ts`) loads the origin's saved profile and calls
   `startSession(tabId, origin, now, profile, true)`. A saved form seeds the session (Record again).
   **An unfinished, unexpired session of the same tab and origin is kept, not replaced**: the
   check and the start are one session-chain job. Otherwise a start after the grant path's (the
   popup's `record-start` on a fresh grant, a double click, a second popup) would drop a session
   whose page is already filed and leave `current` unset, so captures there would be dropped as
   `no-step`. A finished or expired session, or one on another origin, is replaced.
5. `injectContentScript(tabId, origin)`, then, when a session runs, `nudge(tabId)`. A script that is
   already running ignores a second injection, so it is told to ask for the state. Injection also
   happens when a lock hit between the checks and the start: the site is enabled either way, and
   the answer is `locked`.

### record-finish and record-cancel
- Finish does the content finish's work (`finishSession`) on the session of the asked tab, any
  origin. With `reopen`, a session that is already finished opens the review page again and resets
  its TTL to 30 min from now (ruling P11): a closed or failed review tab can be reopened from the
  popup, and a second Finish is not an error. The content script's finish never reopens.
- Cancel discards the asked tab's session with reason `cancelled` (badge cleared, tab nudged, no
  tombstone), in one chain job (`cancelUnfinished`) that checks `finished` itself, so a Finish that
  lands first is kept. A **finished** session is not cancelled from the popup, and another tab's session is
  never touched: both belong elsewhere (the review page). The answer is `{ ok: true }` either way.

### The record intent
`requestSiteEnable(tabId, origin, kind)` (`kind` is required) writes the intent with its kind, then calls
`permissions.request`, in the caller's synchronous turn as before (ADR 0007). After the await it
only returns:
- kind `enable`: `site-enable`, as before.
- kind `record`: `record-start`. It does the enable work too, so no `site-enable` is sent. Result
  `recording`; `locked` (the site is enabled and injected, but the vault is locked, so no
  session); `tab-moved` (the tab left the origin: nothing started and nothing will start later);
  `granted-pending` (`not-granted`: the grant path completes it); or `denied` (`invalid-origin`,
  which cannot occur after the popup's own check, and every failure).

The popup cannot tell a fresh grant from an already granted origin, so `record-start` is sent after
every granted request. On a fresh grant `onAdded` may have started a session already, and its page may
already be filed; the second start keeps that session (see `record-start`, step 4). With the popup
gone, `onAdded` takes the intent, enables the site, and for kind `record` starts a session only if
the vault is unlocked and the tab still shows the origin; then injects and nudges. Locked means
enabled only. A failure while starting the session is logged by error name and does not stop the
enable work (upsert, reconcile, inject).

### Choices the plan left open
- `tab-moved` is its own outcome, not `granted-pending`: the latter promises that the worker
  finishes later, and for a moved tab it will not (`onAdded` would also refuse it).
- A refused `record-start` keeps the pending intent, so a fresh grant's `onAdded` can still enable
  the site for a locked vault. In the already-granted case an intent lingers until its 120 s TTL; it
  can only be used by a later grant of the same origin within that time.
- Stopped tombstones are per origin and an unchanged page is not rewritten (ruling P10, ADR 0029 and
  ADR 0030 amended).

## Consequences
- Only an extension page can start, finish from the popup, or cancel a recording; a web page cannot
  reach any of it.
- `record-state` reveals the origin and the captured count of the session to any extension page,
  which is no more than the popup shows. It carries no value.
- `recorder/start.ts` holds the shared start so `sites/reconcile.ts` need not import
  `recorder/handlers.ts` (which imports `reconcile`).

## Status
Accepted (2026-10-27).
