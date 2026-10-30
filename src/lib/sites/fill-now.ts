// The one-time permission to fill a page that is set to fill on request (spec §6.3, ADR 0038).
// Worker memory only: a worker that restarts loses its grants, and the user presses Fill now again.

/** How long a Fill now stays valid for the tab's next matching scan. */
export const FILL_GRANT_MS = 10_000;

const grants = new Map<number, { origin: string; grantedAt: number }>();

/** Replaces any grant for the tab. */
export function grantFill(tabId: number, origin: string, now: number): void {
  grants.set(tabId, { origin, grantedAt: now });
}

/**
 * True at most once per grant, only for the same tab and origin, and only while
 * `now < grantedAt + FILL_GRANT_MS`. An expired grant is dropped; a grant for another origin
 * stays until it expires or is replaced.
 */
export function takeGrant(tabId: number, origin: string, now: number): boolean {
  const g = grants.get(tabId);
  if (g === undefined || g.origin !== origin) return false;
  grants.delete(tabId);
  return now < g.grantedAt + FILL_GRANT_MS;
}
