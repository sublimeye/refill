import { browser } from "wxt/browser";

export type IntentKind = "enable" | "record";

export interface PendingIntent {
  tabId: number;
  origin: string;
  kind: IntentKind;
  ts: number;
}

export const INTENT_TTL_MS = 120_000;

// storage.session (RAM-only). Holds at most one pending intent; a newer write replaces it.
const KEY = "sites:intent";

function isIntent(v: unknown): v is PendingIntent {
  if (v === null || typeof v !== "object") return false;
  const i = v as Record<string, unknown>;
  return (
    typeof i.tabId === "number" &&
    typeof i.origin === "string" &&
    (i.kind === "enable" || i.kind === "record") &&
    typeof i.ts === "number" &&
    Number.isFinite(i.ts)
  );
}

export function writeIntent(i: PendingIntent): Promise<void> {
  return browser.storage.session.set({ [KEY]: i });
}

/** An intent stamped further ahead than this is treated as expired (clock skew / tamper). */
const MAX_FUTURE_SKEW_MS = 60_000;

// Serializes takes so two concurrent callers cannot both consume the same intent.
let takeChain: Promise<unknown> = Promise.resolve();

/**
 * Returns and removes the pending intent for `origin`. An intent for another origin
 * is kept; an expired one (or one stamped more than 60 s in the future) is removed
 * and yields null.
 */
export function takeIntent(
  origin: string,
  now: number = Date.now(),
): Promise<PendingIntent | null> {
  const run = takeChain.then(() => takeNow(origin, now));
  takeChain = run.catch(() => undefined);
  return run;
}

async function takeNow(
  origin: string,
  now: number,
): Promise<PendingIntent | null> {
  const raw = (await browser.storage.session.get(KEY))[KEY];
  if (!isIntent(raw)) return null;
  if (raw.origin !== origin) return null;
  await browser.storage.session.remove(KEY);
  const age = now - raw.ts;
  if (age > INTENT_TTL_MS || age < -MAX_FUTURE_SKEW_MS) return null;
  return raw;
}
