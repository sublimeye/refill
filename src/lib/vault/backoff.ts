// Failed-unlock backoff (spec §4.1): 1 s doubling to 60 s, kept in storage.session so it survives
// a service-worker restart but not a browser restart. Slows casual guessing on an unattended
// machine; offline attacks are bounded by Argon2id only. Callers serialize check/record through
// the vault's store lock.
import { browser } from "wxt/browser";

const KEY = "vault:backoff";
const MAX_DELAY_MS = 60_000;

interface BackoffState {
  failures: number;
  nextAllowedAt: number;
}

export function delayFor(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(MAX_DELAY_MS, 1000 * 2 ** (failures - 1)); // 2 ** huge = Infinity -> cap
}

/** Malformed state (only this module writes it) reads as "no failures". */
async function read(): Promise<BackoffState> {
  const s = (await browser.storage.session.get(KEY))[KEY] as
    Partial<BackoffState> | null | undefined;
  if (
    s !== null &&
    typeof s === "object" &&
    Number.isSafeInteger(s.failures) &&
    (s.failures as number) >= 0 &&
    Number.isFinite(s.nextAllowedAt)
  ) {
    return { failures: s.failures!, nextAllowedAt: s.nextAllowedAt! };
  }
  return { failures: 0, nextAllowedAt: 0 };
}

function write(s: BackoffState): Promise<void> {
  return browser.storage.session.set({ [KEY]: s });
}

/** Milliseconds until the next attempt is allowed (0 = now). */
export async function checkBackoff(now: number): Promise<number> {
  const s = await read();
  if (s.nextAllowedAt - now > MAX_DELAY_MS) {
    // Stored deadline beyond any possible delay: the clock moved back. Clamp and persist so the
    // wait cannot exceed 60 s.
    s.nextAllowedAt = now + MAX_DELAY_MS;
    await write(s);
  }
  return Math.max(0, s.nextAllowedAt - now);
}

export async function recordFailure(now: number): Promise<void> {
  const s = await read();
  const failures = s.failures + 1;
  await write({ failures, nextAllowedAt: now + delayFor(failures) });
}

export function resetBackoff(): Promise<void> {
  return browser.storage.session.remove(KEY);
}
