// The worker side of recording (spec §6.2, §7): what a content script may ask while its tab
// records, and how a scan-report files the page into the session. Every request is scoped to the
// session whose tabId and origin equal the sender's (router context, never the message), and the
// clock is the worker's own. Values leave the worker only in a scan-report fill plan built from
// the session itself, never from the stored profile. Decisions: ADR 0030.
import { browser, type PublicPath } from "wxt/browser";
import { sigKey } from "../match/match";
import type {
  ContentRequest,
  FillItem,
  RecordState,
  ScanControl,
} from "../messaging/content-protocol";
import type { ContentContext, ContentHandlers } from "../messaging/router";
import { LIMITS } from "../profiles/types";
import { applyCapture, capturedCount } from "./fields";
import { recordingPlan } from "./plan";
import {
  RECORDING_TTL_MS,
  clearBadge,
  stoppedReason,
  withSession,
  type SessionMatch,
} from "./session";
import { observePage } from "./steps";
import type { RecBody } from "./types";

const OFF: RecordState = { state: "off" };
// The review entrypoint lands in Task 10; until then WXT's generated path union lacks it.
const REVIEW_PAGE = "/review.html" as PublicPath;

/**
 * `full` when nothing more can be captured here: the body holds the most fields a profile can, or
 * the page is an eleventh step (no current step, every step slot used). Else `on`.
 */
export function recordState(body: RecBody): RecordState {
  const count = capturedCount(body);
  const full =
    body.fields.length >= LIMITS.fields ||
    (body.current === null && body.steps.length >= LIMITS.steps);
  return { state: full ? "full" : "on", count };
}

/** `off`, or `stopped` while this tab's session ended in a lock or an expiry not long ago. */
async function offOrStopped(tabId: number, now: number): Promise<RecordState> {
  const reason = await stoppedReason(tabId, now);
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
        ? { ...body, current: null, lastDocument: documentId }
        : observed;
    return { body: next, result: recordingPlan(next, controls) };
  });
  return items === "off" ? null : items;
}

/**
 * Finishes the session `match` names: marks it finished, resets its TTL to 30 min from `now`,
 * clears the tab's badge and opens the review page. `false` when there is no such unfinished
 * session. Shared with the popup's Finish (Task 7).
 */
export async function finishSession(
  match: SessionMatch,
  now: number,
): Promise<boolean> {
  const done = await withSession(match, now, (meta) =>
    meta.finished
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
    return state === "off" ? offOrStopped(ctx.tabId, t) : state;
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
    return state === "off" ? offOrStopped(ctx.tabId, t) : state;
  }

  return {
    "record-status": (_req, ctx) => status(ctx),
    "record-capture": (req, ctx) => capture(req, ctx),
    "record-finish": async (_req, ctx) => ({
      ok: await finishSession(scope(ctx), now()),
    }),
  };
}
