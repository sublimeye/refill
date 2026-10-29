# 0035 View the saved form: the popup's line and the review page's saved mode

## Context

After a recording is saved, the review tab closes and nothing shows the user what Refill keeps for a
site, or lets them change it (a fill mode set to "auto" by mistake, a prefix that is too wide, a
field they now want Refill to ask about). Record again is the only way back, and it means walking
the whole form again.

Controller ruling F2: a popup line plus a saved mode of the review page. The page edits the
policies, the name, the fill mode and the prefix. A "Don't save" field cannot be re-enabled without
Record again. A lock or a removal hides the values through the existing data-free worker signal.
Cost if wrong: one more page-only message pair.

## Decision

### Popup

- **Line.** On a site that is on, with a saved form, and with nothing recording in this tab, the
  popup shows `Saved form · {n} field(s)` and a **View** button above Record again. The count uses
  the recording line's plural helper (`fields` in `popup-site.ts`, through `savedLine`).
  - It counts every field of the saved form, "Don't save" ones included. That is the number of rows
    View shows, and the same count as "Recording finished · N fields".
  - The line shows only while the popup is unlocked. A Lock now in the popup hides it at once,
    without reloading the site view.
- **`saved-summary { origin }`.** Page-only. The answer is
  `{ state: "saved", profileId, count }` or `{ state: "none" }`, and it carries no value.
  - The count is inside the sealed record, so a locked vault answers `none`.
  - `loadSiteView` asks for it only for an enabled, granted site whose status says `hasProfile`, so a
    site without a form costs no decryption.
  - A failed request costs only the line, never the site section.
- **View** opens `review.html?saved=<profile id>` in a new tab (`viewSavedFor`) and closes the popup.

### Keying: the profile id

The page is keyed by the saved form's profile id, the smallest safe key:

- The id is 128 random bits. The site index maps it to exactly one origin, because `saveProfile`
  refuses an id that belongs to another site.
- The worker finds the origin in its own index (`originOfProfile`, plaintext, lock-free). The page
  never names an origin.
- The URL, and so the history entry, does not show the site.
- Record again keeps the profile id (ADR 0033), so an open saved page stays valid across one.
- A site removal ends the page. So would a replace under another id, which only the e2e seam does.

An origin key was the alternative. It shows the site in the history, and it would silently move the
page to whatever form the site holds later.

`pageKeyFrom` accepts exactly one `session` or one `saved` parameter holding an `ID_RE` id. Anything
else, both parameters included, is the gone copy.

### Messages (extension page → worker, page-only)

- `saved-load { profileId }` → `{ state: "ready", model }` or `{ state: "gone" }`.
- `saved-check { profileId }` → `{ state: "ready" }` or `{ state: "gone" }`.
- `saved-save { profileId, name, fillMode, pathPrefix, policies }` → `{ ok: true }` or
  `{ ok: false, error: "gone" | "invalid" }`.

They have exact keys and `profileId` must match `ID_RE`. The editable part has the same caps as
`review-save` and is parsed by the same function (`parseFormEdit`): `name` ≤ 120, `pathPrefix` ≤
256, `fillMode` `auto` or `gesture`, and at most 200 `{ fieldId, policy }` entries. As for every
page request, `parseContentRequest` never accepts them and the router refuses them from a content
sender. The handlers live in `review-handlers.ts`, beside `review-*`.

### Load

1. `lockEpoch()` is read first.
2. The origin comes from `originOfProfile(id)`, then `loadProfileForOrigin(origin)` loads the form,
   and its id must equal the requested one.
3. The model is `savedModel(p)`: `reviewModel` over the saved form seeded as a recording body, with
   every "Don't save" field's value and page default blanked, even one stored before C1 (ADR 0033).
   The stored prefix is shown as it is, never replaced by a default.
4. The epoch is checked again before the reply.

A missing site or form, a `LockedError` (the vault is locked when the page opens) or a changed
epoch answers `gone`, and no value goes out.

### Check before every reveal

`saved-check` works like `review-check` (ruling P15). The page sends it before every Show, on a
return to the page (`visibilitychange`), and on the worker's signal (below).

- It reads the epoch, requires `status()` to be `unlocked`, requires a site to still point at the id,
  and requires the epoch to be unchanged.
- It reads only the plaintext index, so no record is opened.
- `gone` drops the model, the form and every shown value, and shows the gone copy.

### Save

`saved-save` runs `editProfile(origin, id, edit)`, a new compare-and-set in `profiles/store.ts`. It is
one store-lock job, like `touchLastUsed`:

- The site record and the sealed profile are read through `tx`.
- `gone` when the site is missing or points at another id, or when the record is missing or
  unreadable. A removal queued before the save therefore wins, and no site is recreated, unlike
  `saveProfile`, which upserts the site.
- `edit` is synchronous and does no IO (ADR 0011).
- `invalid` when `edit` refuses, or returns a profile that does not parse or has another id or
  origin. Nothing is written then.
- A `LockedError` means nothing was written, and the handler answers `gone`.

`edit` is `editSaved(p, …)`:

- It refuses (`invalid`) a field stored as "Don't save" set to "Fill it in". That field holds no
  value, so only Record again can capture one.
- It allows "Don't save" ⇄ "Ask me", and the value stays empty: the edit starts from the same
  blanked body as the model, so "Ask me" never revives a value stored before C1.
- `buildProfile` then checks the policies (one per field, no unknown id), the trimmed name and the
  prefix coverage (case-insensitive, ADR 0034). A field newly set to "Don't save" loses its value.
- It keeps the id, origin, steps, signatures, values, `createdAt` and `lastUsedAt` (`buildProfile`
  takes an optional `lastUsedAt`).

On the page, an `invalid` answer is shown as the path error, as in the recording review. The page
checks the name itself and never offers "Fill it in" for a "Don't save" field.

The save checks no epoch. It carries no value, it writes only under an unlocked DEK, and a lock
while the page is open has already ended the page (below).

### The page

The same component and the same `review-flow.ts` helpers serve both modes, with the page key
deciding the request. Only these differ:

- **Heading and title.** "Saved form for {host}", and the tab title "Saved form · Refill".
- **Table.** As in the recording review. A field stored as "Don't save" reads "Not saved" and has no
  Show button (`notSaved`; `toggleValue` refuses it too).
  - Its "Fill it in" option is disabled.
  - The hint "Record again to capture it" is tied to its select through `aria-describedby`.
- **Close** replaces Discard. It drops the model and every shown value, then closes the tab (a tab
  with one history entry may close itself). If the tab cannot close, it shows "Closed. Nothing was
  changed."
- **Copy.** After Save: "Saved. Refill uses your changes the next time you open this form." The gone
  copy (lock, removal, locked at open): "This saved form is no longer shown. Refill hides it when it
  locks or when the site is removed. Unlock, then open it again from the Refill button."
- Name, fill mode, "Fills on pages under" and its hint work as in the recording review (ADR 0034).

### The worker's signal: on every lock and site removal, and from the worker only

The data-free signal of ADR 0033 (I3) is renamed `{ type: "refill-recheck" }`. It moved to
`src/lib/messaging/recheck.ts`, which imports neither the vault nor the DOM, so both bundles can use
it.

The worker sends it:

- on every session discard, as before (`drop`);
- on **every lock**, with or without a recording (the lock listener in `installRecorderListeners`).
  The vault already reads as locked when listeners run, so the check answers `gone`;
- **after** `site-remove`'s store job, so the check it prompts finds no site.

A profile is removed in only two places:

- `site-remove`, covered above;
- a replace under another id. Product code never does that, because Record again keeps the id. If a
  `review-save` ever did, the session drop that follows its write would signal too.

Pages accept the signal only from this extension's service worker. The sender must have this
extension's id, the worker script's URL (from the manifest's `background.service_worker`), no
`tab` and no `documentId`. Every extension page has a document id, and a tab when opened as one,
so the popup or another page can no longer pass for the worker. In Chromium a message from the
worker arrives with exactly `{ id, url: "chrome-extension://<id>/background.js" }`; this was checked
with a probe, and the e2e lock tests pass under the strict check.

The message still proves nothing: it only prompts a check. Pages still never watch
`storage.onChanged`, whose `session` events carry the DEK mirror (spec §4.3).

## Consequences

- The user can see and adjust a saved form without walking it again. Values leave the worker only in
  `saved-load`'s reply, under an unchanged epoch, and reach the DOM only on Show after a
  `saved-check`, as in the recording review.
- A lock (Lock now, idle, the hard maximum) or a site removal hides a revealed value with no action
  on the page. An open page whose form was removed in another way is noticed at its next check:
  a Show, a return to the page or a signal.
- Each popup open on a site with a saved form costs one record decryption (`saved-summary`).
- Two saved pages for one form, or a saved page next to a Record again review, are last-writer-wins
  on name, fill mode, prefix and policies. If Record again changed the field set, a stale saved
  page's Save is `invalid` and reads as the path error. Its next Show or return to the page does not
  catch that, because the id is unchanged. The user reloads the page.
- Saved mode cannot change values, add or delete fields, or delete the form. Record again and Remove
  site do those.

## Status

Accepted (2026-10-28, Plan 3 follow-up, ruling F2). Amends ADR 0033 (the review page gains saved
mode, and its signal is renamed `refill-recheck` with the sender limited to the service worker) and
ADR 0029 (the signal's name, and that it is also sent on every lock).
