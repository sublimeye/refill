// Content-request handlers: the worker side of the fill protocol (spec §5.4, §6.3). The scan
// carries signatures only; the answer carries values only for controls matched on this page whose
// field policy is `save`. While a session records the tab, the scan is filed into the session and
// answered from it instead (spec §6.2). The origin and path come from the router's sender context,
// never from the message, and the clock is the worker's own. Decisions: ADR 0025, ADR 0030,
// ADR 0034.
import { matchControls, pathScope } from "../match/match";
import { loadProfileForOrigin, touchLastUsed } from "../profiles/store";
import type { Profile } from "../profiles/types";
import {
  createRecorderContentHandlers,
  recordingScan,
} from "../recorder/handlers";
import { LockedError } from "../vault/types";
import { lockEpoch, status } from "../vault/vault";
import type { FillItem, FillPlan, ScanControl } from "./content-protocol";
import type { ContentContext, ContentHandlers } from "./router";

/** `lastUsedAt` is written at most once per this interval per profile (worker memory). */
export const LAST_USED_THROTTLE_MS = 60_000;

const LOCKED: FillPlan = { state: "locked" };
const NONE: FillPlan = { state: "none" };

/** `"locked"` when the vault locked after `status()` said unlocked (the key is gone by now). */
async function loadOrLocked(
  origin: string,
): Promise<Profile | null | "locked"> {
  try {
    return await loadProfileForOrigin(origin);
  } catch (err) {
    if (err instanceof LockedError) return "locked";
    throw err;
  }
}

/** `now` is injected for tests; it is the worker's clock and never comes from a message. */
export function createContentHandlers(
  now: () => number = Date.now,
): ContentHandlers {
  const lastTouched = new Map<string, number>();

  /**
   * Records use of the profile, off the reply path: a failure or a slow store never changes or
   * delays the answer. `touchLastUsed` is one compare-and-set under the store lock, so a removal or
   * edit that lands first is kept (ruling P22). A lock in the meantime just skips the write.
   */
  function touch(id: string, origin: string): void {
    const t = now();
    const prev = lastTouched.get(id);
    if (prev !== undefined && t - prev < LAST_USED_THROTTLE_MS) return;
    lastTouched.set(id, t);
    touchLastUsed(origin, id, t).catch((err: unknown) => {
      if (err instanceof LockedError) return;
      console.error(
        "[refill] lastUsedAt update failed:",
        err instanceof Error ? err.name : "error",
      );
    });
  }

  async function scanReport(
    controls: ScanControl[],
    ctx: ContentContext,
  ): Promise<FillPlan> {
    // Read before status(): the DEK used by the load below may be captured before a lock() that
    // lands during the storage read or decrypt, and would still open the record (ADR 0025).
    const epoch = lockEpoch();
    if ((await status()).state !== "unlocked") return LOCKED;
    // Recording this tab and origin: the plan comes from the session, never the stored profile,
    // and the profile's lastUsedAt is not touched. Always auto: the user is filling this page.
    const recorded = await recordingScan(controls, ctx, now());
    if (recorded !== null) {
      // Synchronous from here to the return, as below.
      if (lockEpoch() !== epoch) return LOCKED;
      return recorded.length === 0 ? NONE : { state: "fill", items: recorded };
    }
    const profile = await loadOrLocked(ctx.origin);
    if (profile === "locked") return LOCKED;
    if (profile === null) return NONE;
    // Under the prefix as before; elsewhere on the origin only fields whose step looks like this
    // page may claim (ADR 0034). Any other origin: nothing.
    const scope = pathScope(profile, ctx.origin, ctx.pathname);
    if (scope === null) return NONE;
    // Every field takes part in matching, whatever its policy: an `ask` or `skip` field that is the
    // better claimant for a control must keep a `save` field from taking it.
    const matched = matchControls(profile.fields, profile.steps, controls, {
      offPath: scope === "off-path",
    });
    // Synchronous from here to the return: no lock can land between this check and the reply.
    if (lockEpoch() !== epoch) return LOCKED;
    const items: FillItem[] = [];
    for (const field of profile.fields) {
      const i = matched.get(field.id);
      if (i === undefined || field.policy !== "save") continue;
      items.push({
        fieldId: field.id,
        i,
        kind: field.kind,
        value: field.value,
        pageDefault: field.pageDefault,
      });
    }
    // Nothing fillable is the same as no profile here: no toast, no badge count, no write.
    if (items.length === 0) return NONE;
    if (profile.fillMode === "gesture") {
      return { state: "gesture", count: items.length };
    }
    touch(profile.id, profile.origin);
    return { state: "fill", items };
  }

  return {
    "scan-report": (req, ctx) => scanReport(req.controls, ctx),
    // Plan 2 records nothing: the counts feed the badge and toast in Plan 4.
    "fill-result": async () => ({ ok: true }),
    ...createRecorderContentHandlers(now),
  };
}
