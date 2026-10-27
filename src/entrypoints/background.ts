import { calibrate } from "../lib/crypto/kdf";
import { createContentHandlers } from "../lib/messaging/content-handlers";
import { createPageHandlers } from "../lib/messaging/page-handlers";
import type { FillPlan } from "../lib/messaging/content-protocol";
import {
  createRouter,
  toRuntimeListener,
  type ContentContext,
} from "../lib/messaging/router";
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
  let content = createContentHandlers();
  // E2E seam (ADR 0022, ADR 0026): lets Playwright seed a profile through `worker.evaluate` and read
  // what content scripts reported (signatures, plan state and fill counts, never values). `MODE`
  // is folded at build time, so the production bundle has neither the marker nor this code.
  if (import.meta.env.MODE === "e2e") {
    const contentLog: Record<string, unknown>[] = [];
    (globalThis as Record<string, unknown>).__refillE2E = {
      saveProfile,
      contentLog,
    };
    const inner = content;
    const where = (ctx: ContentContext) => ({
      origin: ctx.origin,
      pathname: ctx.pathname,
      tabId: ctx.tabId,
      documentId: ctx.documentId,
    });
    content = {
      "scan-report": async (req, ctx) => {
        const plan = (await inner["scan-report"](req, ctx)) as FillPlan;
        contentLog.push({
          type: req.type,
          ...where(ctx),
          controls: req.controls,
          truncated: req.truncated,
          plan: plan.state,
          items: plan.state === "fill" ? plan.items.length : 0,
        });
        return plan;
      },
      "fill-result": async (req, ctx) => {
        contentLog.push({ ...req, ...where(ctx) });
        return inner["fill-result"](req, ctx);
      },
    };
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
      createRouter({
        page: createPageHandlers(() => calibrate()),
        content,
      }),
    ),
  );
});
