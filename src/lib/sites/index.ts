import { KEYS, getItem, withStoreLock, type StoreTx } from "../store/local";
import { normalizeOrigin } from "./origin";

export interface SiteRecord {
  profileId: string | null;
  drafts: boolean;
  /** Milliseconds, or null for no expiry. */
  ttl: number | null;
  accessRevoked: boolean;
}

export const DEFAULT_TTL_MS = 604_800_000;

const FIELDS = [
  "profileId",
  "drafts",
  "ttl",
  "accessRevoked",
] as const satisfies readonly (keyof SiteRecord)[];

function isSiteRecord(v: unknown): v is SiteRecord {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length !== FIELDS.length || !FIELDS.every((k) => keys.includes(k))) {
    return false;
  }
  return (
    (r.profileId === null || typeof r.profileId === "string") &&
    typeof r.drafts === "boolean" &&
    (r.ttl === null ||
      (typeof r.ttl === "number" && Number.isFinite(r.ttl) && r.ttl > 0)) &&
    typeof r.accessRevoked === "boolean"
  );
}

/** Never throws on garbage: invalid entries are dropped, a non-object root is `{}`. */
export async function readSites(
  tx?: StoreTx,
): Promise<Record<string, SiteRecord>> {
  const raw = await (tx ? tx.getItem(KEYS.sites) : getItem(KEYS.sites));
  const out: Record<string, SiteRecord> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [origin, rec] of Object.entries(raw)) {
    if (normalizeOrigin(origin) === origin && isSiteRecord(rec)) {
      out[origin] = {
        profileId: rec.profileId,
        drafts: rec.drafts,
        ttl: rec.ttl,
        accessRevoked: rec.accessRevoked,
      };
    }
  }
  return out;
}

/**
 * Read-modify-write of the site index. With `tx` it runs inside the caller's
 * `withStoreLock` job; without, it takes its own lock. Never nests locks (ADR 0011).
 */
function mutate<T>(
  tx: StoreTx | undefined,
  fn: (sites: Record<string, SiteRecord>) => T,
): Promise<T> {
  const job = async (t: StoreTx): Promise<T> => {
    const sites = await readSites(t);
    const result = fn(sites);
    await t.setItems({ [KEYS.sites]: sites });
    return result;
  };
  return tx ? job(tx) : withStoreLock(job);
}

function assertCanonicalOrigin(origin: string): void {
  if (normalizeOrigin(origin) !== origin) {
    throw new TypeError("origin must be a canonical https origin");
  }
}

/** Throws TypeError on a non-canonical origin or a patch that yields an invalid record. */
export async function upsertSite(
  origin: string,
  patch: Partial<SiteRecord>,
  tx?: StoreTx,
): Promise<SiteRecord> {
  assertCanonicalOrigin(origin);
  return mutate(tx, (sites) => {
    const base: SiteRecord = Object.hasOwn(sites, origin)
      ? sites[origin]!
      : {
          profileId: null,
          drafts: false,
          ttl: DEFAULT_TTL_MS,
          accessRevoked: false,
        };
    const rec: unknown = { ...base, ...patch };
    if (!isSiteRecord(rec)) throw new TypeError("invalid site record");
    // origin is canonical https, so it cannot be "__proto__" or "constructor".
    sites[origin] = rec;
    return { ...rec };
  });
}

export async function removeSite(origin: string, tx?: StoreTx): Promise<void> {
  assertCanonicalOrigin(origin);
  await mutate(tx, (sites) => {
    delete sites[origin];
  });
}
