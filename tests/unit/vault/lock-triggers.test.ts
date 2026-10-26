import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newKdfParams } from "../../../src/lib/crypto/kdf";
import { KEYS, getItem, setItems } from "../../../src/lib/store/local";
import {
  HARD_MAX_ALARM,
  enforceOnWake,
  installLockTriggers,
} from "../../../src/lib/vault/lock-triggers";
import { readSession, writeSession } from "../../../src/lib/vault/session";
import type { VaultHeader } from "../../../src/lib/vault/types";
import {
  __resetForTests,
  createVault,
  lock,
  onLockChange,
  status,
  unlockWithPassphrase,
} from "../../../src/lib/vault/vault";

const P = "correct horse battery staple";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SLOW = { timeout: 30_000 };

// WXT's fakeBrowser has no working `idle` (every member throws "not mocked"), so this minimal shim
// replaces it: a recording setDetectionInterval and an event with a `trigger` like the other fake
// events. Reinstalled before each test, because fakeBrowser.reset() does not know about it.
type IdleListener = (state: string) => void;
function installIdleShim() {
  const listeners = new Set<IdleListener>();
  const idle = {
    setDetectionInterval: vi.fn(),
    onStateChanged: {
      addListener: (cb: IdleListener) => void listeners.add(cb),
      removeListener: (cb: IdleListener) => void listeners.delete(cb),
      hasListener: (cb: IdleListener) => listeners.has(cb),
      trigger: (state: string) => {
        for (const cb of [...listeners]) cb(state);
      },
    },
  };
  (fakeBrowser as unknown as { idle: typeof idle }).idle = idle;
  return idle;
}

let idle: ReturnType<typeof installIdleShim>;
let snapshot: Record<string, unknown> | undefined;

/** A locked vault; Argon2 runs once per file for creation, later calls restore a snapshot. */
async function lockedVault(): Promise<void> {
  if (snapshot === undefined) {
    await createVault(P, newKdfParams());
    snapshot = structuredClone(await fakeBrowser.storage.local.get(null));
  } else {
    await fakeBrowser.storage.local.set(structuredClone(snapshot));
  }
  await lock();
}

/** Unlocked at the real time, with the triggers installed first so the unlock arms them. */
async function unlockedVault(): Promise<number> {
  await lockedVault();
  installLockTriggers();
  expect(await unlockWithPassphrase(P)).toEqual({ ok: true });
  const s = await status();
  if (s.state !== "unlocked") throw new Error("expected unlocked");
  await vi.waitFor(async () =>
    expect(await fakeBrowser.alarms.get(HARD_MAX_ALARM)).toBeDefined(),
  );
  return s.unlockedAt;
}

const stateAt = async (now: number) => (await status(now)).state;

beforeEach(() => {
  fakeBrowser.reset();
  __resetForTests();
  idle = installIdleShim();
});

describe("idle and screen lock", () => {
  it("screen lock locks the vault", SLOW, async () => {
    const t = await unlockedVault();
    idle.onStateChanged.trigger("locked");
    await vi.waitFor(async () => expect(await stateAt(t)).toBe("locked"));
    expect(await readSession()).toBeNull();
  });

  it("idle locks the vault", SLOW, async () => {
    const t = await unlockedVault();
    idle.onStateChanged.trigger("idle");
    await vi.waitFor(async () => expect(await stateAt(t)).toBe("locked"));
  });

  it("active does not lock", SLOW, async () => {
    const t = await unlockedVault();
    const seen = vi.fn();
    onLockChange(seen);
    idle.onStateChanged.trigger("active");
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).not.toHaveBeenCalled();
    expect(await stateAt(t)).toBe("unlocked");
  });

  it(
    "sets the idle detection interval from the policy (900 s by default)",
    SLOW,
    async () => {
      await unlockedVault();
      expect(idle.setDetectionInterval).toHaveBeenCalledTimes(1);
      expect(idle.setDetectionInterval).toHaveBeenCalledWith(900);
    },
  );
});

describe("hard-max alarm", () => {
  it("unlock schedules it at unlockedAt + 12 h", SLOW, async () => {
    const t = await unlockedVault();
    const alarm = await fakeBrowser.alarms.get(HARD_MAX_ALARM);
    expect(alarm?.scheduledTime).toBe(t + 12 * HOUR);
  });

  it("firing the alarm locks the vault", SLOW, async () => {
    const t = await unlockedVault();
    fakeBrowser.alarms.onAlarm.trigger({
      name: HARD_MAX_ALARM,
      scheduledTime: t + 12 * HOUR,
      persistAcrossSessions: true,
    });
    await vi.waitFor(async () => expect(await stateAt(t)).toBe("locked"));
  });

  it("ignores other alarms", SLOW, async () => {
    const t = await unlockedVault();
    fakeBrowser.alarms.onAlarm.trigger({
      name: "other",
      scheduledTime: t,
      persistAcrossSessions: true,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(await stateAt(t)).toBe("unlocked");
  });

  it(
    "lock clears the alarm, and clearing twice is harmless",
    SLOW,
    async () => {
      await unlockedVault();
      await lock();
      await vi.waitFor(async () =>
        expect(await fakeBrowser.alarms.get(HARD_MAX_ALARM)).toBeUndefined(),
      );
      await lock(); // onLockChange(false) again, nothing to clear
      expect(await fakeBrowser.alarms.get(HARD_MAX_ALARM)).toBeUndefined();
    },
  );

  it("installing twice arms once per unlock", SLOW, async () => {
    await lockedVault();
    installLockTriggers();
    installLockTriggers();
    await unlockWithPassphrase(P);
    await vi.waitFor(() =>
      expect(idle.setDetectionInterval).toHaveBeenCalled(),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(idle.setDetectionInterval).toHaveBeenCalledTimes(1);
  });
});

describe("enforceOnWake", () => {
  it(
    "a service-worker restart while unlocked keeps it unlocked",
    SLOW,
    async () => {
      const t = await unlockedVault();
      __resetForTests(); // memory gone, session mirror kept
      await enforceOnWake(t + 60_000);
      expect((await status(t + 60_000)).state).toBe("unlocked");
      expect(await readSession()).not.toBeNull();
    },
  );

  it("re-arms idle detection and the alarm after a restart", SLOW, async () => {
    const t = await unlockedVault();
    __resetForTests();
    await fakeBrowser.alarms.clearAll();
    idle.setDetectionInterval.mockClear();
    await enforceOnWake(t + 60_000);
    expect(idle.setDetectionInterval).toHaveBeenCalledWith(900);
    expect((await fakeBrowser.alarms.get(HARD_MAX_ALARM))?.scheduledTime).toBe(
      t + 12 * HOUR,
    );
  });

  it("a wake after the hard max locks", SLOW, async () => {
    const t = await unlockedVault();
    __resetForTests();
    await enforceOnWake(t + 12 * HOUR + 1);
    expect(await readSession()).toBeNull();
    expect(await stateAt(t)).toBe("locked");
  });

  it(
    "a wake exactly at the hard max locks, one ms before does not",
    SLOW,
    async () => {
      const t = await unlockedVault();
      await enforceOnWake(t + 12 * HOUR - 1);
      expect(await readSession()).not.toBeNull();
      await enforceOnWake(t + 12 * HOUR);
      expect(await readSession()).toBeNull();
    },
  );

  it(
    "locks when the passphrase limit is exceeded, not at the limit",
    SLOW,
    async () => {
      const t = await unlockedVault();
      const header = (await getItem(KEYS.header)) as VaultHeader;
      await setItems({
        [KEYS.header]: { ...header, lastPassphraseAt: t - 14 * DAY },
      });
      await enforceOnWake(t); // exactly 14 days: not exceeded
      expect(await readSession()).not.toBeNull();
      await enforceOnWake(t + 1);
      expect(await readSession()).toBeNull();
    },
  );

  it("does nothing for a locked vault or no vault", SLOW, async () => {
    const seen = vi.fn();
    onLockChange(seen);
    await enforceOnWake(); // no vault
    await lockedVault();
    seen.mockClear();
    await enforceOnWake(Date.now() + 365 * DAY);
    expect(seen).not.toHaveBeenCalled();
    expect(idle.setDetectionInterval).not.toHaveBeenCalled();
  });

  it("does not lock on an unreadable header", SLOW, async () => {
    const t = await unlockedVault();
    await setItems({ [KEYS.header]: { v: 1 } });
    await enforceOnWake(t + 100 * DAY);
    expect(await readSession()).not.toBeNull();
  });

  it(
    "does not wipe a fresh unlock that lands after it read an expired session",
    SLOW,
    async () => {
      const t = await unlockedVault();
      __resetForTests(); // the wake works from the session mirror
      const stale = await readSession();
      // Hold the wake's header read; meanwhile a fresh unlock replaces the mirror.
      const real = fakeBrowser.storage.local.get.bind(
        fakeBrowser.storage.local,
      );
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let reached!: () => void;
      const atRead = new Promise<void>((r) => (reached = r));
      const spy = vi
        .spyOn(fakeBrowser.storage.local, "get")
        .mockImplementationOnce(async (...args: unknown[]) => {
          reached();
          await held;
          return (real as (...a: unknown[]) => Promise<unknown>)(...args);
        });
      const wake = enforceOnWake(t + 13 * HOUR);
      await atRead;
      await writeSession(stale!.dekRaw, t + 13 * HOUR - 1);
      release();
      await wake;
      spy.mockRestore();
      expect((await readSession())?.unlockedAt).toBe(t + 13 * HOUR - 1);
    },
  );
});
