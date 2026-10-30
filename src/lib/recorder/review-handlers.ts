// The review page's requests (spec §6.2): load a finished recording, save it as the site's profile,
// discard it, or check that the page may still show it. Only an extension page reaches these, and
// only a finished session is answered. A save re-checks the session and the vault at save time, so
// a lock while the page is open ends it with nothing written (Review Focus 4), and the page asks
// `review-check` before every reveal (ruling P15). Decisions: ADR 0033.
//
// Saved mode (ADR 0035): the same page shows the site's saved form, keyed by its profile id. The
// popup learns the id and the field count (`saved-summary`, no value); the page loads the form
// (`saved-load`), checks before every reveal (`saved-check`) and saves a new name, fill mode,
// prefix and policies (`saved-save`), never a value.
import type { PageHandlers } from "../messaging/router";
import {
  editProfile,
  loadProfileForOrigin,
  newId,
  originOfProfile,
  saveProfile,
} from "../profiles/store";
import type { FieldPolicy, Profile } from "../profiles/types";
import { normalizeOrigin } from "../sites/origin";
import { LockedError } from "../vault/types";
import { lockEpoch, status } from "../vault/vault";
import { buildProfile, editSaved, reviewModel, savedModel } from "./profile";
import { discardSession, peekSession, withSession } from "./session";
import type { RecBody } from "./types";

const GONE = { state: "gone" } as const;
const READY = { state: "ready" } as const;
const NONE = { state: "none" } as const;
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

/** Whether `policies` names exactly the fields of `p` (own keys only). */
function sameFieldIds(
  p: Profile,
  policies: Record<string, FieldPolicy>,
): boolean {
  return (
    Object.keys(policies).length === p.fields.length &&
    p.fields.every((f) => Object.hasOwn(policies, f.id))
  );
}

/** The saved form `id`, or `null` when no site points at it, or `"locked"`. */
async function savedById(id: string): Promise<Profile | null | "locked"> {
  const origin = await originOfProfile(id);
  if (origin === null) return null;
  const p = await currentProfile(origin);
  return p === "locked" || (p !== null && p.id === id) ? p : null;
}

type ReviewPageHandlers = Pick<
  PageHandlers,
  | "review-load"
  | "review-save"
  | "review-discard"
  | "review-check"
  | "saved-summary"
  | "saved-load"
  | "saved-save"
  | "saved-check"
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

    // The popup's "Saved form · N fields" line: the id it opens the page with and a count, no value.
    // The count is inside the sealed record, so a locked vault answers `none`.
    "saved-summary": async ({ origin }) => {
      if (normalizeOrigin(origin) !== origin) return NONE;
      const p = await currentProfile(origin);
      if (p === null || p === "locked") return NONE;
      return {
        state: "saved",
        profileId: p.id,
        count: p.fields.length,
        fillMode: p.fillMode,
      };
    },

    // As review-load: values go out only if no lock landed between the epoch read and the reply.
    "saved-load": async ({ profileId }) => {
      const epoch = lockEpoch();
      const p = await savedById(profileId);
      if (p === null || p === "locked") return GONE;
      const model = savedModel(p);
      if (lockEpoch() !== epoch) return GONE;
      return { state: "ready", model };
    },

    // Before every reveal, on a return to the page and on the worker's signal: unlocked, and a site
    // still points at the id. The plaintext index only: no record is opened.
    "saved-check": async ({ profileId }) => {
      const epoch = lockEpoch();
      if ((await status()).state !== "unlocked") return GONE;
      const origin = await originOfProfile(profileId);
      if (origin === null || lockEpoch() !== epoch) return GONE;
      return READY;
    },

    // One compare-and-set under the store lock: the stored form is re-read there, so a removal or a
    // Record again queued first is seen (gone or invalid), and no removed site is recreated.
    "saved-save": async (req) => {
      const origin = await originOfProfile(req.profileId);
      if (origin === null) return SAVE_GONE;
      const policies = policyMap(req.policies);
      if (policies === null) return INVALID; // see INVALID
      // The page edits the fields it loaded. A Record again saved since then (same id) may have
      // changed them: that page is stale, so it ends (`gone`) instead of reading as a path error.
      let stale = false;
      let out;
      try {
        out = await editProfile(origin, req.profileId, (p) => {
          stale = !sameFieldIds(p, policies);
          if (stale) return null;
          return editSaved(p, {
            name: req.name,
            fillMode: req.fillMode,
            pathPrefix: req.pathPrefix,
            policies,
          });
        });
      } catch (err) {
        if (err instanceof LockedError) return SAVE_GONE;
        throw err;
      }
      if (out === "saved") return { ok: true };
      if (out === "gone" || stale) return SAVE_GONE;
      // `invalid` here is the prefix (see INVALID), or a field that holds nothing set to save,
      // which the page does not offer.
      return INVALID;
    },
  };
}
