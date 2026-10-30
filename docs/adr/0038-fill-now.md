# 0038 Fill now: a one-time grant that the tab's next scan consumes

## Context

A form saved with `fillMode: "gesture"` never fills a page on its own: the worker answers the page's
`scan-report` with `gesture` and the field ids, never values (spec §6.3, ADR 0036). The user fills it
from the popup with **Fill now**. A popup is not a place a value can go to a page from, and the
worker keeps no scans (ADR 0037), so the popup's click has to make the page ask again and make the
worker answer that one ask with the values.

The content script already answers every data-free `refill-nudge` by reporting its page again,
forced (ADR 0036). What is missing is a way for the worker to tell a Fill now report from an
ordinary one. The sender of that report is a page, so nothing in the report can carry the decision.

## Decision

### A grant in worker memory

`src/lib/sites/fill-now.ts` holds a map from tab id to `{ origin, grantedAt }`.

- `grantFill(tabId, origin, now)` replaces any grant for the tab.
- `takeGrant(tabId, origin, now)` is true at most once per grant, only for the same tab and origin,
  and only while `now < grantedAt + FILL_GRANT_MS` (10 s). Taking removes the grant; a grant for
  another origin is left alone and a stale one is dropped when the tab asks. The clock is the
  worker's own.
- Worker memory only. A worker that restarts loses its grants and the user presses Fill now again;
  nothing about it is written to storage.

### The page-only request

`fill-now` is `{ type, tabId, origin }`, exact keys, `origin` at most 256 characters, `tabId` a
non-negative safe integer. Only an extension page can send it; the content protocol has no such
message. It answers `{ ok: true }` or `{ ok: false, error }` and checks, in this order:

1. the origin is canonical (`invalid-origin`);
2. the vault is unlocked (`locked`);
3. the host permission is held, and the site is in the index and not revoked (`not-granted`);
4. the site has a `profileId` (`no-profile`);
5. the tab still shows the origin (`tab-moved`), because the popup names the tab and cannot be
   trusted to name one it does not show.

Then it calls `grantFill`, awaits `nudge(tabId)` and answers `ok`. A nudge that fails (no content
script) is logged by name in `nudge` and still answers `ok`: the grant stays for 10 s, and the page's
own next scan within that time takes it.

### Where the grant is taken

In `scanReport`, after the profile is matched and at least one `save` item is found, and only when
`profile.fillMode === "gesture"`: `takeGrant(ctx.tabId, ctx.origin, now())`. A grant turns the
answer into the same `fill` plan an auto profile gets (items, `ask`, `recording: false`) and records
use of the profile. Without a grant the answer stays `gesture`. `ctx.tabId` and `ctx.origin` come
from the router's sender context, so a page cannot take a grant of another tab or origin.

The take is synchronous and sits after the last lock-epoch check, before the return: no `await` is
added there, so a lock cannot land between the check and the reply.

A scan that matches nothing fillable answers `none` before the grant is looked at, so a page with
nothing to fill does not spend it. A grant is therefore consumed by the first report that has
something to fill, which is the forced report the nudge asks for; a path-scoped profile on a page it
does not apply to leaves the grant for the next page, until it expires.

### The popup

- **Fill now** sits next to View when the vault is unlocked, the saved form exists, its `fillMode`
  is `gesture` and the recording is `off`. `saved-summary` now carries `fillMode`, so the popup
  learns it without a value.
- `fillNowFor(target)` maps the reply to `ok | locked | tab-moved | error` and never throws. `ok`
  closes the popup; `locked` refreshes the popup and announces
  `Refill locked — unlock, then fill again.`; `tab-moved` uses the existing tab-moved wording;
  anything else the generic message.
- **Sequencing.** `loadSite` could resolve after a newer view had been assigned (for example after
  Cancel recording or Remove) and overwrite it. Every assignment to `site` now goes through one
  function that bumps a generation counter, and a `loadSite` that finds the counter moved while it
  waited drops its result.

## Consequences

- A value still reaches a page only in a `fill` plan, and a `gesture` plan still carries ids only.
  Fill now adds no new way for a value to leave the worker.
- A grant is bound to the tab, the origin and 10 s. A second Fill now replaces the first, and a
  grant that no scan takes expires unused.
- A page that reports twice within the 10 s (a single-page app that renders its form late) gets the
  fill on its first report that has something to fill; the second stays `gesture`. Pressing Fill now
  again fills it.
- The gesture notice (`N fields ready`) is unchanged; after a Fill now the page shows the ordinary
  filled notice with Undo.
- No permission, no manifest change and no stored state.

## Status

Accepted (2026-10-30, Plan 4, Task 5). Amends spec §6.3 (gesture), §6.6 (popup) and §7 (messaging).
Builds on ADR 0025 (lock-epoch discipline), ADR 0035 (popup saved form line), ADR 0036 and ADR 0037.
