// DEK mirror in storage.session (RAM-only) so a suspended service worker can resume unlocked
// (spec §4.3, accepted risks §8.3). Readable by trusted extension contexts only: TRUSTED_CONTEXTS
// is Chrome's default access level for storage.session; nothing here changes it (Task 9 sets it
// explicitly at service-worker start).
import { browser } from "wxt/browser";
import { fromB64, toB64 } from "../crypto/bytes";

const KEY = "vault:session";
const DEK_BYTES = 32;

interface StoredSession {
  /** base64 raw DEK */
  dek: string;
  unlockedAt: number;
}

export function writeSession(
  dekRaw: Uint8Array,
  unlockedAt: number,
): Promise<void> {
  if (dekRaw.length !== DEK_BYTES) {
    return Promise.reject(new RangeError("DEK must be 32 bytes"));
  }
  const s: StoredSession = { dek: toB64(dekRaw), unlockedAt };
  return browser.storage.session.set({ [KEY]: s });
}

/** `null` when absent or malformed. The caller owns (and should zero) `dekRaw`. */
export async function readSession(): Promise<{
  dekRaw: Uint8Array;
  unlockedAt: number;
} | null> {
  const s = (await browser.storage.session.get(KEY))[KEY] as
    Partial<StoredSession> | null | undefined;
  if (s === null || typeof s !== "object" || !Number.isFinite(s.unlockedAt)) {
    return null;
  }
  let dekRaw: Uint8Array;
  try {
    dekRaw = fromB64(s.dek as string);
  } catch {
    return null;
  }
  if (dekRaw.length !== DEK_BYTES) return null;
  return { dekRaw, unlockedAt: s.unlockedAt! };
}

export function clearSession(): Promise<void> {
  return browser.storage.session.remove(KEY);
}
