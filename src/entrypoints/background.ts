import { calibrate } from "../lib/crypto/kdf";
import { createPageHandlers } from "../lib/messaging/page-handlers";
import { createRouter, toRuntimeListener } from "../lib/messaging/router";
import { saveProfile } from "../lib/profiles/store";
import { installSiteListeners } from "../lib/sites/reconcile";
import { enforceOnWake, installLockTriggers } from "../lib/vault/lock-triggers";

export default defineBackground(() => {
  // Everything up to the listeners is synchronous: MV3 only delivers the event that woke the
  // worker to listeners registered during the first turn of the event loop.
  browser.storage.session
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch((err: unknown) => {
      console.error(
        "[refill] storage.session access level failed:",
        err instanceof Error ? err.name : "error",
      );
    });
  // E2E seam (ADR 0022): lets Playwright seed a profile through `worker.evaluate`. `MODE` is
  // folded at build time, so the production bundle has neither the marker nor this import.
  if (import.meta.env.MODE === "e2e") {
    (globalThis as Record<string, unknown>).__refillE2E = { saveProfile };
  }
  installLockTriggers();
  installSiteListeners();
  enforceOnWake().catch((err: unknown) => {
    console.error(
      "[refill] wake check failed:",
      err instanceof Error ? err.name : "error",
    );
  });
  // First run: send the user to onboarding. Updates and browser updates open nothing.
  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason !== "install") return;
    browser.tabs
      .create({ url: browser.runtime.getURL("/onboarding.html") })
      .catch((err: unknown) => {
        console.error(
          "[refill] opening onboarding failed:",
          err instanceof Error ? err.name : "error",
        );
      });
  });
  // Internal messages only: no onMessageExternal (externally_connectable is empty).
  browser.runtime.onMessage.addListener(
    toRuntimeListener(
      createRouter({ page: createPageHandlers(() => calibrate()) }),
    ),
  );
});
