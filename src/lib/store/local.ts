import { browser } from "wxt/browser";
import { createQueue } from "./queue";

export const KEYS = {
  header: "vault:header",
  integrity: "vault:integrity",
  sites: "sites",
  settings: "settings",
} as const;

export const profileKey = (id: string): string => "p:" + id;
export const draftKey = (id: string): string => "d:" + id;

// One queue shared by every write and by withStoreLock.
const enqueue = createQueue();

// True exactly while a withStoreLock job is running. The queue runs one job
// at a time, so a single flag suffices. Store calls made while it is set are
// treated as part of the held lock and run directly instead of queueing
// behind the job that is waiting on them (which would deadlock).
let lockHeld = false;

const exclusive = <T>(job: () => Promise<T>): Promise<T> =>
  lockHeld ? job() : enqueue(job);

/** Raw read; callers validate the shape. `undefined` when absent. */
export async function getItem(key: string): Promise<unknown> {
  const res = await browser.storage.local.get(key);
  return res[key];
}

/** All entries whose key starts with `prefix` (prefix match only). */
export async function getMany(
  prefix: string,
): Promise<Record<string, unknown>> {
  const all = await browser.storage.local.get(null);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(prefix)) out[k] = v;
  }
  return out;
}

export function setItems(items: Record<string, unknown>): Promise<void> {
  return exclusive(() => browser.storage.local.set(items));
}

export function removeItems(keys: string[]): Promise<void> {
  return exclusive(() => browser.storage.local.remove(keys));
}

/**
 * Runs `job` exclusively on the shared write queue so a read-modify-write
 * sequence is atomic with respect to other store writes. `setItems` and
 * `removeItems` (and a nested `withStoreLock`) called from inside the job run
 * directly. See ADR 0011 for the limitation of this approach.
 */
export function withStoreLock<T>(job: () => Promise<T>): Promise<T> {
  return exclusive(async () => {
    if (lockHeld) return job(); // nested: already holding the lock
    lockHeld = true;
    try {
      return await job();
    } finally {
      lockHeld = false;
    }
  });
}
