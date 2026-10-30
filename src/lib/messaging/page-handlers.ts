// Page-request handlers backed by the vault. None of them forwards a timestamp or any other
// value from a message into the vault except the passphrase (ADR 0012 / 0014).
import { browser } from "wxt/browser";
import type { KdfParams } from "../crypto/kdf";
import { meetsMinLength } from "../passphrase/rules";
import { createRecorderPageHandlers } from "../recorder/handlers";
import { createReviewPageHandlers } from "../recorder/review-handlers";
import { nudge } from "../recorder/session";
import { readSites } from "../sites";
import { grantFill } from "../sites/fill-now";
import { createSiteHandlers } from "../sites/handlers";
import { normalizeOrigin, originPattern } from "../sites/origin";
import { tabShowsOrigin } from "../sites/tab";
import {
  createVault,
  lock,
  status,
  unlockWithPassphrase,
} from "../vault/vault";
import type { PageHandlers } from "./router";

/**
 * Fill now (spec §6.3, ADR 0038): leaves a one-time grant for the tab's next matching scan and
 * nudges the tab, whose page reports again. The popup names the tab and cannot be trusted to name
 * one it does not show, so the last check is the tab.
 */
function createFillNowHandler(
  now: () => number,
): Pick<PageHandlers, "fill-now"> {
  return {
    "fill-now": async ({ tabId, origin }) => {
      if (normalizeOrigin(origin) !== origin) {
        return { ok: false, error: "invalid-origin" };
      }
      if ((await status()).state !== "unlocked") {
        return { ok: false, error: "locked" };
      }
      const rec = (await readSites())[origin]; // canonical https origin: never a prototype key
      if (
        rec === undefined ||
        rec.accessRevoked ||
        !(await browser.permissions.contains({
          origins: [originPattern(origin)],
        }))
      ) {
        return { ok: false, error: "not-granted" };
      }
      if (rec.profileId === null) return { ok: false, error: "no-profile" };
      if (!(await tabShowsOrigin(tabId, origin))) {
        return { ok: false, error: "tab-moved" };
      }
      grantFill(tabId, origin, now());
      await nudge(tabId);
      return { ok: true };
    },
  };
}

/**
 * `calibrate` is injected: production measures this device, tests use the fast floor. `now` is the
 * worker's clock (the grant's), never a value from a message.
 */
export function createPageHandlers(
  calibrate: () => Promise<KdfParams>,
  now: () => number = Date.now,
): PageHandlers {
  return {
    ...createFillNowHandler(now),
    ...createSiteHandlers(),
    ...createRecorderPageHandlers(),
    ...createReviewPageHandlers(),
    "vault-status": () => status(),
    "vault-create": async ({ passphrase }) => {
      // Cheap checks first: an invalid create must not burn seconds of Argon2 calibration.
      // createVault repeats both authoritatively.
      if ((await status()).state !== "none")
        return { ok: false, error: "exists" };
      if (!meetsMinLength(passphrase)) return { ok: false, error: "weak" };
      try {
        await createVault(passphrase, await calibrate());
        return { ok: true };
      } catch (err) {
        if (err instanceof Error) {
          if (err.message === "exists") return { ok: false, error: "exists" };
          if (err.message === "weak") return { ok: false, error: "weak" };
        }
        throw err;
      }
    },
    "vault-unlock": ({ passphrase }) => unlockWithPassphrase(passphrase),
    "vault-lock": async () => {
      await lock();
      return { ok: true };
    },
  };
}
