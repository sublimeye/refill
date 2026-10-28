// Starting a session for a tab (spec §3.1, §6.2), shared by the extension-page request and the
// permission-grant path. Decisions: ADR 0031.
import { loadProfileForOrigin } from "../profiles/store";
import { LockedError } from "../vault/types";
import { status } from "../vault/vault";
import { startSession } from "./session";

/**
 * Starts a session for `tabId` on `origin`, seeded from the origin's saved form when it has one
 * (Record again). `false` when the vault is locked, before or during the start; nothing changes
 * then. The caller has checked that the tab still shows `origin`.
 */
export async function beginRecording(
  tabId: number,
  origin: string,
  now: number,
): Promise<boolean> {
  if ((await status()).state !== "unlocked") return false;
  try {
    const profile = await loadProfileForOrigin(origin);
    await startSession(tabId, origin, now, profile);
    return true;
  } catch (err) {
    if (err instanceof LockedError) return false;
    throw err;
  }
}
