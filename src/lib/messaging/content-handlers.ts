// Content-request handlers: the worker side of the fill protocol (spec §5.4, §6.3). The scan
// carries signatures only; the answer carries values only for controls matched on this page whose
// field policy is `save`. The origin and path come from the router's sender context, never from
// the message, and the clock is the worker's own. Decisions: ADR 0025.
import { matchControls, profileApplies } from "../match/match";
import { loadProfileForOrigin, saveProfile } from "../profiles/store";
import type { Profile } from "../profiles/types";
import { LockedError } from "../vault/types";
import { status } from "../vault/vault";
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
   * delays the answer. Re-reads the profile first so the write carries the newest record (a
   * dashboard edit made since the scan is kept), and calls `saveProfile` outside any store lock
   * because it takes its own (ADR 0011).
   */
  function touch(id: string, origin: string): void {
    const t = now();
    const prev = lastTouched.get(id);
    if (prev !== undefined && t - prev < LAST_USED_THROTTLE_MS) return;
    lastTouched.set(id, t);
    void (async () => {
      const current = await loadProfileForOrigin(origin);
      if (current === null || current.id !== id) return;
      await saveProfile({ ...current, lastUsedAt: t });
    })().catch((err: unknown) => {
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
    if ((await status()).state !== "unlocked") return LOCKED;
    const profile = await loadOrLocked(ctx.origin);
    if (profile === "locked") return LOCKED;
    if (
      profile === null ||
      !profileApplies(profile, ctx.origin, ctx.pathname)
    ) {
      return NONE;
    }
    // Every field takes part in matching, whatever its policy: an `ask` or `skip` field that is the
    // better claimant for a control must keep a `save` field from taking it.
    const matched = matchControls(profile.fields, profile.steps, controls);
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
  };
}
