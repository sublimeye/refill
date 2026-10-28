// The review page's requests (spec §6.2): load a finished recording, save it as the site's profile,
// discard it, or check that the page may still show it. Only an extension page reaches these, and
// only a finished session is answered. A save re-checks the session and the vault at save time, so
// a lock while the page is open ends it with nothing written (Review Focus 4), and the page asks
// `review-check` before every reveal (ruling P15). Decisions: ADR 0033.
import type { PageHandlers } from "../messaging/router";
import { loadProfileForOrigin, newId, saveProfile } from "../profiles/store";
import type { FieldPolicy, Profile } from "../profiles/types";
import { LockedError } from "../vault/types";
import { lockEpoch, status } from "../vault/vault";
import { buildProfile, reviewModel } from "./profile";
import { discardSession, peekSession, withSession } from "./session";
import type { RecBody } from "./types";

const GONE = { state: "gone" } as const;
const SAVE_GONE = { ok: false, error: "gone" } as const;
// The page shows `invalid` as the path error: it checks the name itself, and the policies come from
// the model. A new cause of `invalid` must update that mapping (`saveReview` in review-flow.ts).
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
  "review-load" | "review-save" | "review-discard" | "review-check"
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
      // The saved form lends its name, prefix and fill mode only to the recording it seeded: a form
      // saved under another id since then is replaced (and warned about), not borrowed from.
      const model = reviewModel(
        rec.origin,
        rec.body,
        current !== null && current.id === rec.seededFrom ? current : null,
      );
      if (lockEpoch() !== epoch) return GONE;
      return { state: "ready", model, replacesProfile: current !== null };
    },

    "review-save": async (req) => {
      const t = now();
      const epoch = lockEpoch();
      const rec = await finished(req.sessionId, t);
      if (rec === null) return SAVE_GONE;
      // Nothing recorded is nothing to save: an empty form must never replace a saved one. The page
      // offers only Discard then, so it never shows this `invalid` (see INVALID).
      if (rec.body.fields.length === 0) return INVALID;
      const policies = policyMap(req.policies);
      if (policies === null) return INVALID; // see INVALID
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
      if (profile === null) return INVALID; // see INVALID
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

    // Before every reveal and when the page becomes visible again (ruling P15): unlocked, and the
    // session of that id is still there and finished. No body is opened, so it costs one session
    // read and the vault status, and no value moves.
    "review-check": async ({ sessionId }) => {
      const epoch = lockEpoch();
      if ((await status()).state !== "unlocked") return GONE;
      const meta = await peekSession(sessionId, now());
      if (meta === null || !meta.finished || lockEpoch() !== epoch) return GONE;
      return { state: "ready" };
    },

    "review-discard": async ({ sessionId }) => {
      await discardSession("cancelled", sessionId);
      return { ok: true };
    },
  };
}
