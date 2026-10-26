import { calibrate } from "../lib/crypto/kdf";
import { createPageHandlers } from "../lib/messaging/page-handlers";
import { createRouter, toRuntimeListener } from "../lib/messaging/router";
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
  installLockTriggers();
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
