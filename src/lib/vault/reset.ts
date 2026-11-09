// "Forgot passphrase": returns Refill to a fresh install without removing the extension (ADR 0039).
// Nothing is recovered: the data is erased, not decrypted, so no passphrase is needed.
import { browser } from "wxt/browser";
import { clearBadge, discardSession } from "../recorder/session";
import { profileTabs } from "../sites/badge";
import { reconcile } from "../sites/reconcile";
import { eraseVault } from "./vault";

function logFailure(what: string, err: unknown): void {
  console.error(
    "[refill]",
    what,
    "failed:",
    err instanceof Error ? err.name : "error",
  );
}

/** Every granted host permission, not only the indexed sites': a fresh install has none. */
async function removeHostPermissions(): Promise<void> {
  const { origins = [] } = await browser.permissions.getAll();
  await Promise.all(
    origins.map(async (origin) => {
      try {
        await browser.permissions.remove({ origins: [origin] });
      } catch (err) {
        // Required permissions (the e2e build) cannot be removed.
        logFailure("permissions.remove", err);
      }
    }),
  );
}

/**
 * Rejects only if the data could not be erased. Once it is gone, what is left is tidying that the
 * next start repeats or that no longer matters, so those failures are logged and the reset stands.
 */
export async function resetEverything(): Promise<void> {
  // Read first: the site index that says which tabs show a badge is about to go.
  const tabs = await profileTabs().catch((err: unknown) => {
    logFailure("badge pass", err);
    return [] as number[];
  });
  // Before the erase, whose lock would otherwise tell the page "Recording stopped: locked".
  await discardSession("site-removed");
  await eraseVault();
  await browser.storage.session.clear();
  await Promise.all(tabs.map(clearBadge));
  try {
    await removeHostPermissions();
    await reconcile();
  } catch (err) {
    logFailure("reset cleanup", err);
  }
}
