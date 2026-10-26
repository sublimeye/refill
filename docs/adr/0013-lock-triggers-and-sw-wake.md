# 0013 — Lock triggers and service-worker wake

## Context

Task 9 wires the vault's automatic locks (spec §4.3): screen lock and idle, a hard-max alarm, and a check when the service worker starts. The plan fixes the events and their effects. This ADR records the details it leaves open. ADR 0012 already makes `status` and `getDek` hard-max backstops that never act on a stale read, and says `enforceOnWake` must lock only a genuinely expired session.

## Decision

- **Wake check through the vault, not around it.** `enforceOnWake(now)` calls a new vault export, `lockIfExpired(now)`, and does not read the session itself. It locks only when a session exists and either `now >= unlockedAt + maxHours` or `now - lastPassphraseAt > passphraseEveryDays` (strictly greater, as in the plan). A locked vault, an unreadable header or an unexpired session is left alone: uncertainty never locks. The lock goes through `lockIfStillExpired`, so a wake that read an expired session does not wipe an unlock that replaced it. The header is read after the session, because an unlock writes the header before its mirror.
- **Residual window, inherited from ADR 0012.** An unlock that has written its header but not yet its mirror is not visible to the stale-read check. A wake landing exactly there can lock it; the unlock then returns `locked-during-unlock` and the user retries. This needs an expired old session to still be present at the time of a new unlock, and `status` has the same window.
- **Arming reads `status`.** On `onLockChange(true)` the triggers call `status()` for `unlockedAt` and the lock policy, then `idle.setDetectionInterval(idleMinutes * 60)` and `alarms.create(HARD_MAX_ALARM, { when: unlockedAt + maxHours * 3_600_000 })`. A generation counter, bumped on every lock-state change, stops an arm that began before a lock from scheduling an alarm afterwards. `idleMinutes * 60` is at least 60 under the header bounds, above Chrome's 15 s minimum.
- **Clearing is idempotent.** `onLockChange(false)` fires on every `lock()`, so it calls `alarms.clear`, which is a no-op for a missing alarm.
- **`enforceOnWake` re-arms.** When it does not lock and the vault is unlocked, it sets the idle interval and recreates the alarm. Whether Chrome keeps the idle detection interval across a worker restart is not documented, so the safe choice is to set it again; recreating the alarm under the same name replaces it.
- **Alarm and idle events call `lock()` unconditionally** (the plan's behavior). A stale alarm cannot outlive its unlock: a new unlock recreates the alarm under the same name.
- **Registration is synchronous.** `background.ts` calls `storage.session.setAccessLevel`, `installLockTriggers()` and `enforceOnWake()` at the top level of the `defineBackground` callback, with no `await` before the listeners. `installLockTriggers` is idempotent for its vault subscription. `enforceOnWake` runs fire-and-forget; failures are logged by error name only, never message or stack, so nothing derived from keys or passphrases reaches the console.
- **`now` is a test seam.** `enforceOnWake` and `lockIfExpired` default to `Date.now()`; the Task 10 router must never forward a `now` from a message.
- **Test shim.** WXT's `fakeBrowser` implements `alarms` but not `idle` (every member throws "not mocked"), so the unit test installs a minimal `idle` object with a recording `setDetectionInterval` and a triggerable `onStateChanged`.

## Consequences

- The vault module gains one export, `lockIfExpired`. All session and epoch logic stays in `vault.ts`.
- With passphrase-only unlock, `lastPassphraseAt` equals the unlock time, so the passphrase-days limit can only bite for sessions longer than that limit; it starts to matter when Touch ID unlock exists.
- Idle detection is re-armed on every worker start; the cost is one `setDetectionInterval` call.

## Status

Accepted
