# ADR 0033: Review page (load, save, discard; values shown on request) and the M9 profile load

## Context
Finish opens `review.html?session=<id>` in a new tab (spec §6.2 step 4, ADR 0030, ADR 0031). The
page lists what the recording captured, lets the user pick a policy per field, name the form,
choose the fill mode and the path prefix, and save it as the site's encrypted profile or discard
it. It is the only place where captured values leave the worker for display, and the vault can lock
while it is open (Review Focus 4). The Plan 2 final review deferred M9 to this task:
`loadProfileForOrigin` read the site index and then the record, so a replace in flight could answer
one spurious "no profile".

## Decision
### Messages (extension page → worker, page-only)
`parseContentRequest` never accepts them, and the router refuses them from a content sender.
Exact keys; `sessionId` must match `ID_RE`.
- `review-load { sessionId }` → `{ state: "ready", model, replacesProfile }` or `{ state: "gone" }`.
- `review-save { sessionId, name, fillMode, pathPrefix, policies }` → `{ ok: true }` or
  `{ ok: false, error: "gone" | "invalid" }`. `name` ≤ 120, `pathPrefix` ≤ 256, `fillMode` `auto` or
  `gesture`, at most 200 `{ fieldId, policy }` entries with exact keys, `fieldId` matching `ID_RE`,
  `policy` `save`, `ask` or `skip`.
- `review-discard { sessionId }` → `{ ok: true }`.
- `review-check { sessionId }` → `{ state: "ready" }` or `{ state: "gone" }` (ruling P15, below).

The handlers live in `src/lib/recorder/review-handlers.ts`, beside `handlers.ts` (which already
holds the content and recording page handlers).

### What the page can and cannot do
- It reaches only the session whose id it was opened with (`withSession({ id })`). The origin is
  the session's own, never the page's: the page cannot save a recording under another site.
- Only a **finished** session answers. A missing, unfinished, expired or locked one is `gone`, and
  loading never ends or changes a recording.
- It cannot start, extend or resume a recording, and it sends no timestamp: `createdAt` and the
  expiry checks use the worker's clock.

### Load
The model is `reviewModel(origin, body, current?.id === seededFrom ? current : null)` (ADR 0028),
where `current` is the site's saved form: it lends its name, prefix and fill mode only to the
recording it seeded. A form saved under another id since the recording started lends nothing.
`replacesProfile` is `current !== null`, so a site whose form was saved after the recording started
still gets the replace warning. `lockEpoch()` is read before the session is opened and checked again
right before replying; a lock in between answers `gone` (ADR 0029: a caller that replies with values
re-checks the epoch).

### Save
1. The session is opened; not finished (or missing) → `gone`. A recording with no fields →
   `invalid`: the page offers only Discard then, and an empty form must never replace a saved one.
2. The policies become a null-prototype map; a repeated field id → `invalid`.
3. The site's current form is loaded (`LockedError` → `gone`). Its id and `createdAt` are kept, or
   `newId()` and the worker's `now` are used when the site has none. Record again therefore keeps the
   profile id, and so does a plain recording on a site that already has a form: the site has one form.
4. `buildProfile` (ADR 0028) checks the policies against the fields, the trimmed name and the prefix
   coverage → `invalid` when it returns null. An invalid save writes nothing and keeps the session, so
   the user can correct it and save again.
5. **At save time** the session is opened again: it must still be there and finished, and
   `lockEpoch()` must not have changed since step 1, else `gone`. A lock discards the session
   (ADR 0029), so a save after a lock, even after an unlock, is `gone` and writes nothing (Review
   Focus 4).
6. `saveProfile` (one store lock, ADR 0022) replaces the site's record; a `LockedError` there →
   `gone`, with nothing written (the record is sealed before anything is written). A residual
   window remains: a lock that lands after `putEncrypted`'s `getDek()`, while it seals, still writes
   the profile. The ordering stays consistent: that save counts as completed before the lock, as if
   the user had clicked Save a moment earlier.
7. `discardSession("saved", id)`: the id-guarded discard, so it never ends a newer session.

### Discard
`discardSession("cancelled", id)`: badge cleared, tab nudged, no tombstone, and only while the stored
session still has that id.

### Check before every reveal (ruling P15)
A loaded page holds the model, values included, in memory. Without a check, a lock, expiry or
cancel would leave every value one Show away, indefinitely, on an unattended browser (spec §4.3
relies on idle lock and Lock now there). So the page asks `review-check` before every Show and
whenever it becomes visible again (`visibilitychange`). The handler reads `lockEpoch()`, requires
`status()` to be `unlocked`, reads the session metadata through `peekSession(id, now)`, and requires
the session to be finished and the epoch unchanged. `peekSession` is one session-chain job that
opens no body and uses no DEK; an expired session is discarded as in `withSession`. On `gone` the
page drops the model, the form and every shown value, and shows the gone copy. A messaging failure
reveals nothing and keeps the page. Hide needs no check. The page never listens to
`storage.session`: pages must not read the DEK mirror (spec §4.3).

### The page (`src/entrypoints/review/`, logic in `src/lib/recorder/review-flow.ts`)
- Values are masked as `••••••`. Each row has a **Show**/**Hide** button that, after the check
  above, puts that one value into the DOM as a text node; there is no `{@html}`. A hidden value is
  not in the DOM at all. The visible label changes, so the button has no `aria-pressed` (ruling P16:
  a pressed toggle keeps one label, WAI-ARIA APG). Its accessible name is "Show {label}" or "Hide
  {label}", so each button says which field it reveals.
- Checkbox values read "Checked" or "Not checked" and radio values "Selected", not "true" or
  "false". They are masked and revealed like any other value.
- The replace notice appears only above a recording with fields: an empty recording can only be
  discarded.
- After Save, a `gone` answer or Discard, the page drops the model, so nothing of the recording stays
  in the page.
- The page checks a blank name and a prefix that does not start with "/" itself. An `invalid` answer
  after those checks can only be a prefix that misses a recorded page (the policies come from the
  model), so it is shown as the path error. Errors are tied to their input (`aria-invalid`,
  `aria-describedby`) and focus moves to it. Outcomes (saved, gone, discarded) take focus as a status
  message, as in the popup.
- A step is numbered by its place in the recording, not by its stored index (a seeded profile's
  indexes need not be 0..n-1).
- The page is a plain WXT unlisted page: not in the manifest, under the extension-page CSP
  (ADR 0016), with styles compiled to a CSS file.

### M9: a profile load during a replace
`loadProfileForOrigin` stays lock-free. When the record the index pointed at is missing, it reads
the index again and follows a moved pointer (at most 3 times); an unchanged pointer means a dangling
one, and the answer is `null`. Every writer that removes `p:<id>` moves the pointer first, in the same
store-lock job: a replace writes the new record, then the pointer, then removes the old record, and a
site removal removes the site before its record. A reader that finds the record gone therefore finds
the pointer already moved: to the new profile, or to no site.

The brief asked for both reads in one `withStoreLock`. That would make every scan-report wait behind
any store-lock job, including an unlock attempt's or a passphrase change's Argon2id, and ADR 0025
promises that a held store lock never delays or changes the scan-report answer (tested in Plan 2).
The re-read fixes the spurious `null` without that cost: a load costs one extra index read only when
a record is missing.

### Choices the brief left open (copy added)
- "Discarded. Nothing was saved." after Discard.
- "Fill mode" as the legend of the two fill-mode radios, "Name" as the name field's label.
- "Review recording · Refill" as the tab title.
- "Checked", "Not checked" and "Selected" for checkbox and radio values.
- A load or messaging failure reuses the popup's "Something went wrong — try again" (and its "Try
  again" button for a failed load).

## Consequences
- A captured value reaches a page only for a finished session, on that page's request, and is put
  into the DOM only when the user presses Show.
- A value already revealed stays on screen after a lock until the page is used again: the next
  Show, a return to the page (`visibilitychange`), Save or Discard ends the review and drops it.
  A page left visible and untouched is not polled.
- `review-save` needs one more session open than a plain save (the re-check at save time); each open
  is one `storage.session` read and one AES-GCM open. `review-check` costs one `storage.session`
  read and the vault status, and opens nothing.

## Status
Accepted (2026-10-27). Fix round 1 (2026-10-27): `review-check` before every reveal and on return to
the page (ruling P15), no `aria-pressed` (ruling P16), the seed-id rule for the model, words for
checkbox and radio values. Amends ADR 0022: `loadProfileForOrigin` follows a moved pointer when the
record is missing (M9).
