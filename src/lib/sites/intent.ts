import { browser } from "wxt/browser";

export type IntentKind = "enable";

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
    i.kind === "enable" &&
    typeof i.ts === "number" &&
    Number.isFinite(i.ts)
  );
}

export function writeIntent(i: PendingIntent): Promise<void> {
  return browser.storage.session.set({ [KEY]: i });
}

/**
 * Returns and removes the pending intent for `origin`. An intent for another origin
 * is kept; an expired one is removed and yields null.
 */
export async function takeIntent(
  origin: string,
  now: number = Date.now(),
): Promise<PendingIntent | null> {
  const raw = (await browser.storage.session.get(KEY))[KEY];
  if (!isIntent(raw)) return null;
  if (raw.origin !== origin) return null;
  await browser.storage.session.remove(KEY);
  if (now - raw.ts > INTENT_TTL_MS) return null;
  return raw;
}
