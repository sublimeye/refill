// Page-request handlers for site enablement (spec §3.1). Decisions: ADR 0018.
import { browser } from "wxt/browser";
import { profileKey, withStoreLock } from "../store/local";
import type { PageHandlers } from "../messaging/router";
import { normalizeOrigin, originPattern } from "./origin";
import { readSites, removeSite, upsertSite } from "./index";
import { takeIntent, writeIntent } from "./intent";
import { injectContentScript, reconcile } from "./reconcile";

type SiteHandlers = Pick<
  PageHandlers,
  "site-status" | "site-enable" | "site-remove" | "site-intent"
>;

async function granted(origin: string): Promise<boolean> {
  return browser.permissions.contains({ origins: [originPattern(origin)] });
}

/** `now` is the service worker's clock; it never comes from a message. */
export function createSiteHandlers(now: () => number = Date.now): SiteHandlers {
  return {
    "site-status": async ({ origin }) => {
      if (normalizeOrigin(origin) !== origin) return { origin: null };
      const rec = (await readSites())[origin]; // canonical https origin: never a prototype key
      return {
        origin,
        enabled: rec !== undefined,
        granted: await granted(origin),
        accessRevoked: rec?.accessRevoked ?? false,
        hasProfile: rec?.profileId != null,
      };
    },

    // The popup's already-granted path: `permissions.onAdded` will not fire, so do its work here.
    "site-enable": async ({ tabId, origin }) => {
      if (normalizeOrigin(origin) !== origin) {
        return { ok: false, error: "invalid-origin" };
      }
      if (!(await granted(origin))) return { ok: false, error: "not-granted" };
      // This call does the intent's work; drop it so it cannot be replayed later (P8). Discarded.
      await takeIntent(origin, now());
      await upsertSite(origin, { accessRevoked: false });
      await reconcile();
      await injectContentScript(tabId, origin);
      return { ok: true };
    },

    "site-remove": async ({ origin }) => {
      if (normalizeOrigin(origin) !== origin) return { ok: true }; // nothing can exist for it
      // A removal is deliberate: an unconsumed intent must not re-enable the site if access is
      // granted again within its TTL (P8). Taken first, result discarded.
      await takeIntent(origin, now());
      await withStoreLock(async (tx) => {
        const rec = (await readSites(tx))[origin];
        await removeSite(origin, tx);
        // The profile record is removed by key: no decryption, so this works while locked.
        if (rec?.profileId != null) {
          await tx.removeItems([profileKey(rec.profileId)]);
        }
      });
      try {
        await browser.permissions.remove({ origins: [originPattern(origin)] });
      } catch (err) {
        // Required permissions (the e2e build) and already-removed ones cannot be removed; the
        // site is gone from Refill either way.
        console.error(
          "[refill] permissions.remove skipped:",
          err instanceof Error ? err.name : "error",
        );
      }
      await reconcile();
      return { ok: true };
    },

    // Written BEFORE permissions.request; the popup may be gone by the time the grant lands (ADR 0007).
    "site-intent": async ({ tabId, origin }) => {
      if (normalizeOrigin(origin) !== origin) {
        return { ok: false, error: "invalid-origin" };
      }
      await writeIntent({ tabId, origin, kind: "enable", ts: now() });
      return { ok: true };
    },
  };
}
