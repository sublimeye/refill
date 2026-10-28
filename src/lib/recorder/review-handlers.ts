// The review page's requests (spec §6.2): load a finished recording, save it as the site's profile,
// or discard it. Only an extension page reaches these, and only a finished session is answered. A
// save re-checks the session and the vault at save time, so a lock while the page is open ends it
// with nothing written (Review Focus 4). Decisions: ADR 0033.
import type { PageHandlers } from "../messaging/router";
import { loadProfileForOrigin, newId, saveProfile } from "../profiles/store";
import type { FieldPolicy, Profile } from "../profiles/types";
import { LockedError } from "../vault/types";
import { lockEpoch } from "../vault/vault";
import { buildProfile, reviewModel } from "./profile";
import { discardSession, withSession } from "./session";
import type { RecBody } from "./types";

const GONE = { state: "gone" } as const;
const SAVE_GONE = { ok: false, error: "gone" } as const;
const INVALID = { ok: false, error: "invalid" } as const;

interface Finished {
  origin: string;
  seededFrom: string | null;
  body: RecBody;
}

/** The finished session `id`, opened; `null` when it is missing, unfinished, expired or locked. */
async function finished(id: string, now: number): Promise<Finished | null> {
  const got = await withSession({ id }, now, (meta, body) => ({
    result: meta.finished
      ? { origin: meta.origin, seededFrom: meta.seededFrom, body }
      : null,
  }));
  return got === "off" ? null : got;
}

/** The site's saved form, or `"locked"` when the vault locked meanwhile. */
async function currentProfile(
  origin: string,
): Promise<Profile | null | "locked"> {
  try {
    return await loadProfileForOrigin(origin);
  } catch (err) {
    if (err instanceof LockedError) return "locked";
    throw err;
  }
}

/** One policy per field id; `null` for a repeated id. Own keys only (`__proto__` stays a key). */
function policyMap(
  list: { fieldId: string; policy: FieldPolicy }[],
): Record<string, FieldPolicy> | null {
  const map: Record<string, FieldPolicy> = Object.create(null) as Record<
    string,
    FieldPolicy
  >;
  for (const { fieldId, policy } of list) {
    if (Object.hasOwn(map, fieldId)) return null;
    map[fieldId] = policy;
  }
  return map;
}

type ReviewPageHandlers = Pick<
  PageHandlers,
  "review-load" | "review-save" | "review-discard"
>;

/** `now` is injected for tests; it is the worker's clock and never comes from a message. */
export function createReviewPageHandlers(
  now: () => number = Date.now,
): ReviewPageHandlers {
  return {
    "review-load": async ({ sessionId }) => {
      // Before the session is opened: values go out only if no lock landed since (ADR 0029).
      const epoch = lockEpoch();
      const rec = await finished(sessionId, now());
      if (rec === null) return GONE;
      const current = await currentProfile(rec.origin);
      if (current === "locked") return GONE;
      // The saved form lends its name, prefix and fill mode only to the recording it seeded.
      const model = reviewModel(
        rec.origin,
        rec.body,
        rec.seededFrom !== null ? current : null,
      );
      if (lockEpoch() !== epoch) return GONE;
      return { state: "ready", model, replacesProfile: current !== null };
    },

    "review-save": async (req) => {
      const t = now();
      const epoch = lockEpoch();
      const rec = await finished(req.sessionId, t);
      if (rec === null) return SAVE_GONE;
      // Nothing recorded is nothing to save: an empty form must never replace a saved one.
      if (rec.body.fields.length === 0) return INVALID;
      const policies = policyMap(req.policies);
      if (policies === null) return INVALID;
      const current = await currentProfile(rec.origin);
      if (current === "locked") return SAVE_GONE;
      // The site keeps one form: replacing it keeps its id and creation time (Record again).
      const profile = buildProfile({
        id: current?.id ?? newId(),
        origin: rec.origin,
        name: req.name,
        pathPrefix: req.pathPrefix,
        fillMode: req.fillMode,
        now: t,
        createdAt: current?.createdAt ?? null,
        body: rec.body,
        policies,
      });
      if (profile === null) return INVALID;
      // At save time: the same session is still there and finished, and the vault never locked
      // since it was opened. A lock discards the session (ADR 0029), so a save after one is gone.
      if ((await finished(req.sessionId, now())) === null) return SAVE_GONE;
      if (lockEpoch() !== epoch) return SAVE_GONE;
      try {
        await saveProfile(profile);
      } catch (err) {
        if (err instanceof LockedError) return SAVE_GONE;
        throw err;
      }
      await discardSession("saved", req.sessionId);
      return { ok: true };
    },

    "review-discard": async ({ sessionId }) => {
      await discardSession("cancelled", sessionId);
      return { ok: true };
    },
  };
}
