# ADR 0029: Recording sessions (one at a time, sealed body, seeding, tombstones, discard on lock)

## Context
Spec §6.2 keeps a recording in `storage.session` for at most 30 minutes, and captured values must
never be plaintext at rest (§4.3: decrypted records are never put in `storage.session`). The worker
receives captures from a content script in bursts, so read-modify-write updates race unless they
are ordered. A lock must end the recording, and the pill must be able to say why recording stopped
even after the session is gone. The model that changes a body is ADR 0028; this ADR covers where
and how a body is kept.

## Decision
`src/lib/recorder/session.ts` owns the store.
- **One session at a time.** The record is `storage.session["recorder:session"] = { meta, body }`.
  - `meta` is plaintext and holds no page data: `v`, `id` (`newId()`), `tabId`, `origin`,
    `startedAt`, `expiresAt`, `finished` and `seededFrom`.
  - `body` is the `RecBody` sealed as JSON with `seal(getDek(), …)` under
    `aad.recording(id, origin)` = `"refill/v1|recording|<id>|<origin>"`. The plaintext buffer is
    zeroed after sealing and after opening, as in `vault/records.ts`.
  - A body moved under another id or origin fails to open.
  - Starting a session discards the previous one with reason `"replaced"`.
- **Seeding (Record again).** A start with a saved profile seals `seedBody(profile)` and sets
  `seededFrom` to the profile id. Otherwise the body is `emptyBody()`.
- **Serialization.** Every job that reads or writes the record runs on one module-level promise
  chain: start, `withSession`, discard and the tab-close check. A failed job does not break the
  chain. A job never awaits another job, and the nudge is fired without being awaited: the content
  script answers a nudge by messaging the worker, and that handler queues behind the current job.
- **`withSession(match, now, fn)`.** `fn` is synchronous and returns an optional new body, an optional
  `finished`/`expiresAt` patch and a result.
  - A changed body is re-sealed with a fresh IV. A meta-only change keeps the sealed body. With
    neither, nothing is written. If `fn` throws, nothing is written.
  - Expiry is checked before the match: a session expires whoever asks.
  - The answer is `"off"` when there is no session, when `match` names another tab, origin or id,
    and when the record does not parse.
  - **Locked.** If `getDek()` throws `LockedError`, the session is discarded as `"locked"`. This
    covers a lock event that never reached the listener: after a lock the DEK is gone, so the body
    can never open again.
- **Expiry.** `RECORDING_TTL_MS` = 30 min from start. Task 6 resets `expiresAt` to 30 min from
  Finish through the meta patch. A session at or past `expiresAt` is discarded as `"expired"`.
- **Discard on lock and on tab close.** `installRecorderListeners()` registers synchronously at the
  worker's top level.
  - `onLockChange(false)` discards the session as `"locked"`, a finished one included (Review Focus
    4).
  - `tabs.onRemoved` discards the session only when it belongs to that tab and is unfinished. A
    finished session belongs to its review tab.
  - Calling the installer again replaces its vault listener instead of adding a second one.
- **Tombstones.** `"locked"` and `"expired"` write `storage.session["recorder:stopped"]` =
  `{ tabId, reason, at }`, which holds no page data. `stoppedReason(tabId, now)` answers that reason
  for 30 min, so the content handlers can answer `stopped`. A new start clears it.
- **Badge and nudge.** A start sets the tab's badge to `●`. A discard clears the badge and sends
  `{ type: "refill-nudge" }` to frame 0 of the tab. Badge and nudge failures are logged by error name
  only and never fail the job.
- **Untrusted read-back.** `storage.session` is writable by every trusted extension context, so the
  record and the tombstone are parsed strictly. Exact keys are required, `id` and `seededFrom` must
  match `ID_RE`, `tabId` must be a non-negative safe integer, `origin` must be canonical https, the
  times must be finite, and the `Sealed` must have a 12-byte IV and at least a tag. A record that
  does not parse is removed.

### Choices the plan left open
- **A body that fails to open under an unlocked vault** (tampered, or moved under another id) is
  dropped with reason `"cancelled"`: the badge is cleared, the tab is nudged and no tombstone is
  written. The plan names no reason for this case. Such a record can never be used again, and a
  tombstone would show a false "vault locked" or "expired".
- **A `"tab-closed"` discard** neither clears the badge nor nudges, because the tab no longer exists.
  Doing either would only log a failure for every closed tab.
- **`startSession` validates its arguments.** A tab id that is not a non-negative integer, or an
  origin that is not canonical https, throws `TypeError`. The DEK is fetched before anything is
  discarded, so a locked start throws `LockedError` and changes nothing.
- **The tombstone at** is the job's `now` for an expiry and the worker clock (`Date.now()`) for a
  lock, because the lock listener receives no time.

## Consequences
- A captured value is at rest only as AES-GCM ciphertext under the DEK, and only while the vault is
  unlocked. A lock removes the ciphertext as well.
- Every session operation waits for the one before it. Each job is one storage read, one AES-GCM open,
  at most one seal and one write, so a burst of captures is answered in order, one job at a time.
- There is only one tombstone. A lock or expiry on another tab overwrites it, which is enough because
  there is only one session.
- The store runs in the worker and imports no DOM module, so `check:sw-no-dom` still holds.

## Status
Accepted (2026-10-27).
