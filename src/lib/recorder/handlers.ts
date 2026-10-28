// The worker side of recording (spec §6.2, §7): what a content script may ask while its tab
// records, how a scan-report files the page into the session, and what an extension page may ask
// (start, query, finish, cancel). Content requests are scoped to the session whose tabId and
// origin equal the sender's (router context, never the message), and the clock is the worker's
// own. Values leave the worker only in a scan-report fill plan built from the session itself,
// never from the stored profile. Decisions: ADR 0030, ADR 0031.
import { browser, type PublicPath } from "wxt/browser";
import { sigKey } from "../match/match";
import type {
  ContentRequest,
  FillItem,
  RecordState,
  ScanControl,
} from "../messaging/content-protocol";
import type { RecordPageState } from "../messaging/protocol";
import type {
  ContentContext,
  ContentHandlers,
  PageHandlers,
} from "../messaging/router";
import { LIMITS } from "../profiles/types";
import { normalizeOrigin, originPattern } from "../sites/origin";
import { upsertSite } from "../sites";
import { takeIntent } from "../sites/intent";
import { injectContentScript, reconcile } from "../sites/reconcile";
import { tabShowsOrigin } from "../sites/tab";
import { status } from "../vault/vault";
import { applyCapture, capturedCount } from "./fields";
import { recordingPlan } from "./plan";
import {
  RECORDING_TTL_MS,
  clearBadge,
  cancelUnfinished,
  nudge,
  stoppedReason,
  withSession,
  type SessionMatch,
} from "./session";
import { beginRecording } from "./start";
import { observePage } from "./steps";
import type { RecBody } from "./types";

const OFF: RecordState = { state: "off" };
// The review entrypoint lands in Task 10; until then WXT's generated path union lacks it.
const REVIEW_PAGE = "/review.html" as PublicPath;

/**
 * `full` when nothing more can be captured here: the body holds the most fields a profile can, or
 * the page is an eleventh step (no current step, every step slot used). Else `on`.
 */
export function recordState(
  body: RecBody,
): Extract<RecordState, { state: "on" | "full" }> {
  const count = capturedCount(body);
  const full =
    body.fields.length >= LIMITS.fields ||
    (body.current === null && body.steps.length >= LIMITS.steps);
  return { state: full ? "full" : "on", count };
}

/** `off`, or `stopped` while this tab's session ended in a lock or an expiry not long ago. */
async function offOrStopped(
  tabId: number,
  origin: string,
  now: number,
): Promise<RecordState> {
  const reason = await stoppedReason(tabId, origin, now);
  return reason === null ? OFF : { state: "stopped", reason };
}

const scope = (ctx: ContentContext): SessionMatch => ({
  tabId: ctx.tabId,
  origin: ctx.origin,
});

/**
 * Files a scanned page into the active (unfinished) session of this tab and origin and returns
 * the session's fill plan for it, or `null` when there is no such session (Plan 2's fill applies).
 * The caller re-checks the lock epoch before it replies with the items.
 */
export async function recordingScan(
  controls: ScanControl[],
  ctx: ContentContext,
  now: number,
): Promise<FillItem[] | null> {
  const keys = controls.map((c) => sigKey(c.sig, c.kind));
  const documentId = ctx.documentId ?? null;
  const items = await withSession(scope(ctx), now, (meta, body) => {
    if (meta.finished) return { result: null };
    const observed = observePage(body, keys, documentId, ctx.pathname);
    // An eleventh step is not filed (ADR 0028). No current step, so captures on this page answer
    // `full` instead of landing in the previous step; the plan still uses the steps there are.
    const next: RecBody =
      observed === "full"
        ? body.current === null && body.lastDocument === documentId
          ? body
          : { ...body, current: null, lastDocument: documentId }
        : observed;
    const result = recordingPlan(next, controls);
    // An unchanged body (a re-scan of the same page) is not sealed and written again (ADR 0029).
    return next === body ? { result } : { body: next, result };
  });
  return items === "off" ? null : items;
}

/**
 * Finishes the session `match` names: marks it finished, resets its TTL to 30 min from `now`,
 * clears the tab's badge and opens the review page. `false` when there is no such unfinished
 * session. With `reopen`, a session that is already finished is opened again instead (its TTL is
 * reset to 30 min from `now`): a closed or failed review tab can be reopened from the popup, and
 * Finish stays idempotent (ADR 0031). A content script never reopens.
 */
export async function finishSession(
  match: SessionMatch,
  now: number,
  reopen = false,
): Promise<boolean> {
  const done = await withSession(match, now, (meta) =>
    meta.finished && !reopen
      ? { result: null }
      : {
          meta: { finished: true, expiresAt: now + RECORDING_TTL_MS },
          result: { id: meta.id, tabId: meta.tabId },
        },
  );
  if (done === "off" || done === null) return false;
  await clearBadge(done.tabId);
  await browser.tabs.create({
    url: `${browser.runtime.getURL(REVIEW_PAGE)}?session=${done.id}`,
  });
  return true;
}

type RecorderContentHandlers = Pick<
  ContentHandlers,
  "record-status" | "record-capture" | "record-finish"
>;

/** `now` is injected for tests; it is the worker's clock and never comes from a message. */
export function createRecorderContentHandlers(
  now: () => number = Date.now,
): RecorderContentHandlers {
  async function status(ctx: ContentContext): Promise<RecordState> {
    const t = now();
    const state = await withSession(scope(ctx), t, (meta, body) => ({
      result: meta.finished ? OFF : recordState(body),
    }));
    return state === "off" ? offOrStopped(ctx.tabId, ctx.origin, t) : state;
  }

  async function capture(
    req: Extract<ContentRequest, { type: "record-capture" }>,
    ctx: ContentContext,
  ): Promise<RecordState> {
    const t = now();
    const state = await withSession(scope(ctx), t, (meta, body) => {
      if (meta.finished) return { result: OFF };
      const { body: next } = applyCapture(body, {
        sig: req.sig,
        kind: req.kind,
        value: req.value,
        pageDefault: req.pageDefault,
        fieldId: req.fieldId,
      });
      // A secret, a `"no-step"` and a `"full"` capture return the body as it was: nothing to write.
      return next === body
        ? { result: recordState(body) }
        : { body: next, result: recordState(next) };
    });
    return state === "off" ? offOrStopped(ctx.tabId, ctx.origin, t) : state;
  }

  return {
    "record-status": (_req, ctx) => status(ctx),
    "record-capture": (req, ctx) => capture(req, ctx),
    "record-finish": async (_req, ctx) => ({
      ok: await finishSession(scope(ctx), now()),
    }),
  };
}

type RecorderPageHandlers = Pick<
  PageHandlers,
  "record-start" | "record-state" | "record-finish" | "record-cancel"
>;

/**
 * What an extension page asks (spec §3.1, §6.2). Only a page reaches these: the content protocol
 * has no such message. `tabId` comes from the popup, which cannot be trusted to name a tab it does
 * not show, so a start re-checks the tab's origin. `now` is the worker's clock.
 */
export function createRecorderPageHandlers(
  now: () => number = Date.now,
): RecorderPageHandlers {
  return {
    "record-start": async ({ tabId, origin }) => {
      if (normalizeOrigin(origin) !== origin) {
        return { ok: false, error: "invalid-origin" };
      }
      if ((await status()).state !== "unlocked") {
        return { ok: false, error: "locked" };
      }
      if (
        !(await browser.permissions.contains({
          origins: [originPattern(origin)],
        }))
      ) {
        return { ok: false, error: "not-granted" };
      }
      if (!(await tabShowsOrigin(tabId, origin))) {
        return { ok: false, error: "tab-moved" };
      }
      // This call does the pending intent's work; drop it so it cannot be replayed (as site-enable).
      await takeIntent(origin, now());
      await upsertSite(origin, { accessRevoked: false });
      await reconcile();
      const started = await beginRecording(tabId, origin, now());
      // The site is enabled either way: a vault that locked meanwhile still gets its script.
      await injectContentScript(tabId, origin);
      if (!started) return { ok: false, error: "locked" };
      // A script that is already running ignores a second injection: tell it to ask for the state.
      await nudge(tabId);
      return { ok: true };
    },

    "record-state": async ({ tabId }) => {
      const state = await withSession<RecordPageState>(
        { any: true },
        now(),
        (meta, body) => {
          const here = meta.tabId === tabId;
          const count = capturedCount(body);
          if (meta.finished) {
            return {
              result: {
                state: "review" as const,
                origin: meta.origin,
                count,
                here,
              },
            };
          }
          return {
            result: {
              state: recordState(body).state,
              origin: meta.origin,
              count,
              here,
            },
          };
        },
      );
      return state === "off" ? OFF : state;
    },

    "record-finish": async ({ tabId }) => ({
      ok: await finishSession({ tab: tabId }, now(), true),
    }),

    "record-cancel": async ({ tabId }) => {
      // Only the tab's own, unfinished session: a finished one belongs to its review page. One job,
      // so a Finish that lands first is kept.
      await cancelUnfinished({ tab: tabId });
      return { ok: true };
    },
  };
}
