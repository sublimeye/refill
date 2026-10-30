import { calibrate } from "../lib/crypto/kdf";
import { createContentHandlers } from "../lib/messaging/content-handlers";
import { createPageHandlers } from "../lib/messaging/page-handlers";
import type { FillPlan, RecordState } from "../lib/messaging/content-protocol";
import {
  createRouter,
  toRuntimeListener,
  type ContentContext,
} from "../lib/messaging/router";
import { loadProfileForOrigin, saveProfile } from "../lib/profiles/store";
import { installRecorderListeners } from "../lib/recorder/session";
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
  // E2E seam (ADR 0022, ADR 0026, ADR 0030): lets Playwright seed a profile through
  // `worker.evaluate`, read back the site's saved profile (what a review saved), read what content
  // scripts reported (signatures, plan state and fill counts;
  // for recording requests only the type and the reply's state, never a captured value; `boot` and
  // `seq` order entries across a worker restart), and hold scan-report replies until released, to
  // change the page between scan and fill on purpose. `MODE` is folded at build time, so the production bundle has
  // neither the marker nor this code.
  if (import.meta.env.MODE === "e2e") {
    const contentLog: Record<string, unknown>[] = [];
    const boot = crypto.randomUUID();
    let seq = 0;
    let held: Promise<void> | null = null;
    let release: () => void = () => undefined;
    const seam = {
      saveProfile,
      loadProfile: loadProfileForOrigin,
      contentLog,
      boot,
      holdReplies: () => {
        held ??= new Promise<void>((r) => (release = r));
      },
      releaseReplies: () => {
        release();
        held = null;
      },
    };
    (globalThis as Record<string, unknown>).__refillE2E = seam;
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
          boot,
          seq: ++seq,
          type: req.type,
          ...where(ctx),
          controls: req.controls,
          truncated: req.truncated,
          plan: plan.state,
          items: plan.state === "fill" ? plan.items.length : 0,
        });
        if (held !== null) await held;
        return plan;
      },
      "fill-result": async (req, ctx) => {
        contentLog.push({ boot, seq: ++seq, ...req, ...where(ctx) });
        return inner["fill-result"](req, ctx);
      },
      // A capture carries the value the user typed: log its type, never the request.
      "record-status": async (req, ctx) => {
        const reply = (await inner["record-status"](req, ctx)) as RecordState;
        contentLog.push({
          boot,
          seq: ++seq,
          type: req.type,
          ...where(ctx),
          state: reply.state,
        });
        return reply;
      },
      "record-capture": async (req, ctx) => {
        const reply = (await inner["record-capture"](req, ctx)) as RecordState;
        contentLog.push({
          boot,
          seq: ++seq,
          type: req.type,
          ...where(ctx),
          state: reply.state,
        });
        return reply;
      },
      "toast-unlock-click": async (req, ctx) => {
        const reply = (await inner["toast-unlock-click"](req, ctx)) as {
          ok: boolean;
        };
        contentLog.push({
          boot,
          seq: ++seq,
          type: req.type,
          ...where(ctx),
          ok: reply.ok,
        });
        return reply;
      },
      "record-finish": async (req, ctx) => {
        const reply = (await inner["record-finish"](req, ctx)) as {
          ok: boolean;
        };
        contentLog.push({
          boot,
          seq: ++seq,
          type: req.type,
          ...where(ctx),
          state: reply.ok ? "finished" : "off",
        });
        return reply;
      },
    };
  }
  installLockTriggers();
  installSiteListeners();
  installRecorderListeners();
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
