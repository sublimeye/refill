# 0037 Badge and unlock refill: the worker owns the per-tab badge

## Context

Plan 4 (the return visit) shows a fill on the page itself (ADR 0036) and also on the toolbar icon:
how many fields Refill filled in this tab, and a lock on a tab whose site has a saved form while the
vault is locked. Spec §6.3 also said that after an unlock the service worker "re-runs matching on the
active tab's latest `scan-report`". The worker keeps no scans (a scan is signatures of a page, and
holding them would be state the worker would have to bound, expire and protect), so that sentence
could not be built as written.

The recorder already owns one badge value, `●` while a tab records (`BADGE_RECORDING`), and clears it
when the session ends. Whatever else the worker writes must not take that over. There is no `tabs`
permission and the manifest does not change: `tab.url` is readable only on granted origins, which are
exactly Refill's enabled sites.

## Decision

### Where the badge is set

`src/lib/sites/badge.ts` holds all return-visit badge writes.

- **Count.** The `fill-result` handler calls `showFillCount(ctx.tabId, req.filled)`. `filled` is the
  document's running total of fields Refill filled and has not undone (ADR 0036), so a nudge's second
  report does not double it and an Undo (`filled: 0`) clears it. The text is `String(n)` for
  1 <= n <= 200, else empty (`badgeCount`). A locked vault sets nothing: a count from before a lock
  must not outlive it, and the lock pass owns the badge then.
- **Lock.** A `scan-report` answered `locked` (a site with a saved form, ADR 0025) also calls
  `showLocked(ctx.tabId)`. A site without a saved form answers `none` and gets no badge.
- **Navigation.** `tabs.onUpdated` with `status: "loading"` clears the tab's badge: the count belongs
  to the document being left. The new document's `fill-result` or `locked` answer sets it again.
- **Lock pass.** `onLockChange(false)` calls `showLocked` for each tab in `profileTabs()`: the tabs
  whose URL origin is an enabled, not revoked site with a saved form, from `tabs.query({})` and the
  plaintext site index. A tab without a readable `url` is skipped, which is every tab outside the
  granted origins.
- **Unlock pass.** `onLockChange(true)` clears each tab in `profileTabs()` and sends it the data-free
  `refill-nudge`. The content script answers a nudge by reporting its page again (ADR 0036, Task 3),
  so the worker, now unlocked, answers with a plan and the page fills. This replaces "re-runs
  matching on the active tab's latest `scan-report`": the worker keeps no scans, the page is the one
  that knows its controls, and every open tab refills, not only the active one.

The listeners are registered by `installBadgeListeners()` in the worker's first turn, next to the
other installers, and it is idempotent in its lock subscription.

### The recording badge is not touched

Every write goes through one helper that first asks for the tab's session metadata
(`peekMeta({ tab })`, no key needed) and writes nothing when the session is unfinished. Nothing but
a recording sets or clears `●`. `BADGE_RECORDING` is exported from the session module so the tests
name it, not so this module can write it.

Chrome clears a tab's badge text on a cross-document navigation, so `●` set at the start would be
gone after a reload or the next step. The recorder sets it again itself: its `record-status` handler,
which every new document asks after its first scan, calls `showRecordingBadge` when it answers `on`
or `full` for the session's tab. That is one session-chain job (a Finish or discard that lands first
wins), idempotent, logged by error name only, and it never changes the reply.

A `scan-report` answered from a recording session is a `fill` plan marked `recording: true`; the
content script's `fill-result` then carries that plan's own count. Because the tab's session is
unfinished, `showFillCount` skips it and the count never reaches the badge.

### Failures

A badge failure (a closed tab, a storage error) is logged by error name only and never changes a
reply: `fill-result` still answers `{ ok: true }` and `scan-report` still answers `locked`. A failing
`tabs.query` or site-index read ends a lock or unlock pass, logged by error name. In the same spirit
a site index that cannot be read while locked now makes `scan-report` answer `none` rather than
reject the request: the page is told nothing is saved, which is the safe reading.

## Consequences

- No permission, no manifest change, no stored state: the badge is derived from the page's report,
  the site index and the session metadata.
- A tab whose URL the extension cannot read, or whose site was removed, is not badged by the passes.
  Its own page still sets `🔒` when it reports.
- **Accepted residual.** If a lock lands while a tab records, that tab may end with no badge rather
  than `🔒`: the lock pass skips it because its session is still there when the pass looks, or the
  session drop's clear runs after the pass wrote. The pill says `Recording stopped — vault locked`,
  and the next page report sets `🔒`.
- Between an unlock and the nudged page's report a tab shows no badge. The nudge costs one extra
  scan per profile tab per unlock.
- A count of 0 and a count over 200 both show nothing, so the badge is never a number the user cannot
  read at a glance; the pill still says how many.

## Status

Accepted (2026-10-30, Plan 4, Task 4). Amends spec §6.3 (unlock) and §6.5 (badge). Builds on ADR 0025
(locked answer), ADR 0026 (once per document), ADR 0029 (recording sessions) and ADR 0036.
