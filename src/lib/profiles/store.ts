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

/** How often a load follows a moved pointer before it gives up (each needs a write in between). */
const MAX_REREADS = 3;

async function profileIdOf(origin: string): Promise<string | null> {
  const sites = await readSites();
  const id = Object.hasOwn(sites, origin) ? sites[origin]!.profileId : null;
  return id !== null && ID_RE.test(id) ? id : null;
}

/**
 * The profile attached to `origin`, or `null` when there is none or it cannot be trusted
 * (undecryptable, malformed, or sealed for another origin). Throws `LockedError` when locked.
 *
 * Lock-free, so a held store lock (an unlock's KDF) never delays a scan-report (ADR 0025). A record
 * that is missing after the index was read is re-checked against the index: every writer that
 * removes `p:<id>` (a replace, a site removal) first moves the site's pointer in the same store-lock
 * job, so a reader that finds the record gone and the pointer moved follows the pointer instead of
 * answering a spurious `null` (Plan 2 review M9, ADR 0033).
 */
export async function loadProfileForOrigin(
  origin: string,
): Promise<Profile | null> {
  if (normalizeOrigin(origin) !== origin) return null;
  let id = await profileIdOf(origin);
  let raw: unknown;
  for (let rereads = 0; ; rereads++) {
    if (id === null) return null;
    try {
      raw = await getEncrypted<unknown>(
        profileKey(id),
        aad.profile(id, origin),
      );
    } catch (err) {
      // SyntaxError: authenticated plaintext that is not JSON (cannot happen without our own bug).
      if (err instanceof DecryptError || err instanceof SyntaxError) {
        console.error("[refill] profile record unreadable:", err.name);
        return null;
      }
      throw err;
    }
    if (raw !== undefined) break;
    // Gone: either a dangling pointer, or a writer removed it after moving the pointer.
    if (rereads === MAX_REREADS) return null;
    const next = await profileIdOf(origin);
    if (next === id) return null;
    id = next;
  }
  const profile = parseProfile(raw);
  if (!profile || profile.id !== id || profile.origin !== origin) {
    console.error("[refill] profile record invalid:", "ProfileParseError");
    return null;
  }
  return profile;
}

/**
 * Sets `lastUsedAt` to `t` on the profile `id` of `origin`, as one compare-and-set under the store
 * lock: the site record and the profile are read through `tx`, so a removal, revocation, profile
 * replacement or edit that ran first is seen and kept. Writes nothing (and never creates a site
 * record) when the site is missing or revoked, points at another profile, or the record is missing
 * or unreadable. Throws `LockedError` when locked (nothing is written then). ADR 0025.
 */
export async function touchLastUsed(
  origin: string,
  id: string,
  t: number,
): Promise<void> {
  if (normalizeOrigin(origin) !== origin || !ID_RE.test(id)) return;
  await withStoreLock(async (tx) => {
    const sites = await readSites(tx);
    const site = Object.hasOwn(sites, origin) ? sites[origin]! : null;
    if (site === null || site.accessRevoked || site.profileId !== id) return;
    const key = profileKey(id);
    const ad = aad.profile(id, origin);
    let raw: unknown;
    try {
      raw = await getEncrypted<unknown>(key, ad, tx);
    } catch (err) {
      if (err instanceof DecryptError || err instanceof SyntaxError) return;
      throw err;
    }
    const profile = raw === undefined ? null : parseProfile(raw);
    if (!profile || profile.id !== id || profile.origin !== origin) return;
    const next = parseProfile({ ...profile, lastUsedAt: t });
    if (!next) return; // `t` not a valid timestamp
    await putEncrypted(key, ad, next, tx);
  });
}
