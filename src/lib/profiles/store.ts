// Encrypted profile records. A profile is sealed under AAD "refill/v1|profile|<id>|<origin>" at
// storage key "p:<id>", and the site index points at it by id.
import { aad } from "../crypto/aad";
import { DecryptError } from "../crypto/aead";
import { randomBytes, toB64 } from "../crypto/bytes";
import { profileKey, withStoreLock } from "../store/local";
import { normalizeOrigin } from "../sites/origin";
import { readSites, upsertSite } from "../sites";
import { getEncrypted, putEncrypted } from "../vault/records";
import { ID_RE, parseProfile, type Profile } from "./types";

/** 128 random bits as base64url without padding (22 chars, never contains "|"). */
export function newId(): string {
  return toB64(randomBytes(16))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * Validates, seals and stores `p`, points the origin's site record at it, and removes the origin's
 * previous profile record when the id changed. One store lock, so a reader never sees the site
 * pointing at a missing record. Throws `TypeError` for an invalid profile or an id already used
 * by another origin, `LockedError` when locked (nothing is written then).
 */
export async function saveProfile(p: Profile): Promise<void> {
  const profile = parseProfile(p);
  if (!profile) throw new TypeError("invalid profile");
  await withStoreLock(async (tx) => {
    const sites = await readSites(tx);
    for (const [origin, site] of Object.entries(sites)) {
      if (origin !== profile.origin && site.profileId === profile.id) {
        throw new TypeError("profile id already belongs to another site");
      }
    }
    const previous = Object.hasOwn(sites, profile.origin)
      ? sites[profile.origin]!.profileId
      : null;
    await putEncrypted(
      profileKey(profile.id),
      aad.profile(profile.id, profile.origin),
      profile,
      tx,
    );
    await upsertSite(profile.origin, { profileId: profile.id }, tx);
    if (previous !== null && previous !== profile.id) {
      await tx.removeItems([profileKey(previous)]);
    }
  });
}

/**
 * The profile attached to `origin`, or `null` when there is none or it cannot be trusted
 * (undecryptable, malformed, or sealed for another origin). Throws `LockedError` when locked.
 */
export async function loadProfileForOrigin(
  origin: string,
): Promise<Profile | null> {
  if (normalizeOrigin(origin) !== origin) return null;
  const sites = await readSites();
  const id = Object.hasOwn(sites, origin) ? sites[origin]!.profileId : null;
  if (id === null || !ID_RE.test(id)) return null;
  let raw: unknown;
  try {
    raw = await getEncrypted<unknown>(profileKey(id), aad.profile(id, origin));
  } catch (err) {
    // SyntaxError: authenticated plaintext that is not JSON (cannot happen without our own bug).
    if (err instanceof DecryptError || err instanceof SyntaxError) {
      console.error("[refill] profile record unreadable:", err.name);
      return null;
    }
    throw err;
  }
  if (raw === undefined) return null;
  const profile = parseProfile(raw);
  if (!profile || profile.id !== id || profile.origin !== origin) {
    console.error("[refill] profile record invalid:", "ProfileParseError");
    return null;
  }
  return profile;
}
