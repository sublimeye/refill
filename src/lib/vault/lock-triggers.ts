// Lock triggers: screen lock, idle and the hard-max alarm lock the vault; unlock schedules them
// (spec §4.3). `installLockTriggers` only registers listeners, so it must run synchronously at
// service-worker top level or MV3 drops events that woke the worker. Decisions: ADR 0013.
import { browser } from "wxt/browser";
import { lock, lockIfExpired, onLockChange, status } from "./vault";

export const HARD_MAX_ALARM = "refill-hard-max";

const HOUR_MS = 3_600_000;

let unsubscribe: (() => void) | null = null;
/** Bumped on every lock-state change: an arm that began before one must not schedule anything. */
let generation = 0;

/** Never logs the error message or stack: a storage or crypto error could carry key material. */
function logFailure(what: string, err: unknown): void {
  console.error(
    `[refill] ${what} failed:`,
    err instanceof Error ? err.name : "error",
  );
}

function lockAndLog(why: string): void {
  lock().catch((err: unknown) => logFailure(`lock on ${why}`, err));
}

/**
 * While unlocked: idle detection at the policy's idle limit and the hard-max alarm at
 * `unlockedAt + maxHours`. Reads the state through `status`, so it arms nothing for a vault that
 * has since locked (or is already past its hard max, which `status` locks).
 */
async function arm(now: number): Promise<void> {
  const g = generation;
  const s = await status(now);
  if (g !== generation || s.state !== "unlocked") return;
  // Chrome's minimum is 15 s; the header bounds keep idleMinutes * 60 at 60 s or more.
  browser.idle.setDetectionInterval(s.lock.idleMinutes * 60);
  await browser.alarms.create(HARD_MAX_ALARM, {
    when: s.unlockedAt + s.lock.maxHours * HOUR_MS,
  });
}

/** Idempotent: a second call replaces the first call's lock-change subscription. */
export function installLockTriggers(): void {
  browser.idle.onStateChanged.addListener((state) => {
    if (state === "locked" || state === "idle")
      lockAndLog(`idle state ${state}`);
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HARD_MAX_ALARM) lockAndLog("hard-max alarm");
  });
  unsubscribe?.();
  unsubscribe = onLockChange((unlocked) => {
    generation++;
    if (unlocked) {
      arm(Date.now()).catch((err: unknown) =>
        logFailure("arming lock triggers", err),
      );
    } else {
      // Fires on every lock(), also when nothing was scheduled: clearing a missing alarm is a no-op.
      Promise.resolve(browser.alarms.clear(HARD_MAX_ALARM)).catch(
        (err: unknown) => logFailure("clearing the hard-max alarm", err),
      );
    }
  });
}

/**
 * Service-worker start: locks a session that is genuinely past its hard max or passphrase limit,
 * and otherwise re-arms the triggers (idle detection and the alarm do not necessarily survive a
 * worker restart). An unexpired session stays unlocked. `now` is a test seam: never pass a value
 * received in a message.
 */
export async function enforceOnWake(now = Date.now()): Promise<void> {
  if (await lockIfExpired(now)) return;
  await arm(now);
}
