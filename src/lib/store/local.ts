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

// One queue shared by every public write and by withStoreLock.
const enqueue = createQueue();

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

/** Queued: waits for any running `withStoreLock` job and earlier writes. */
export function setItems(items: Record<string, unknown>): Promise<void> {
  return enqueue(() => browser.storage.local.set(items));
}

/** Queued: waits for any running `withStoreLock` job and earlier writes. */
export function removeItems(keys: string[]): Promise<void> {
  return enqueue(() => browser.storage.local.remove(keys));
}

/**
 * Storage access handed to a `withStoreLock` job. Methods hit storage
 * directly (they are already inside the queue slot) and reject once the job
 * has settled.
 */
export interface StoreTx {
  getItem(key: string): Promise<unknown>;
  getMany(prefix: string): Promise<Record<string, unknown>>;
  setItems(items: Record<string, unknown>): Promise<void>;
  removeItems(keys: string[]): Promise<void>;
}

/**
 * Runs `job` exclusively on the shared queue: no other queued write or lock
 * job runs until it settles, so a read-modify-write through `tx` is atomic
 * with respect to every other store write.
 *
 * Inside the job, write ONLY through `tx`. Calling the public `setItems` /
 * `removeItems` or nesting `withStoreLock` inside a job DEADLOCKS: it queues
 * behind the job that is awaiting it, and JavaScript has no async context to
 * tell it apart from an unrelated caller (see ADR 0011).
 */
export function withStoreLock<T>(job: (tx: StoreTx) => Promise<T>): Promise<T> {
  return enqueue(async () => {
    let open = true;
    const live = <A extends unknown[], R>(
      fn: (...args: A) => Promise<R>,
    ): ((...args: A) => Promise<R>) => {
      return async (...args: A) => {
        if (!open) {
          throw new Error("store tx used after withStoreLock job settled");
        }
        return fn(...args);
      };
    };
    const tx: StoreTx = {
      getItem: live(getItem),
      getMany: live(getMany),
      setItems: live((items: Record<string, unknown>) =>
        browser.storage.local.set(items),
      ),
      removeItems: live((keys: string[]) => browser.storage.local.remove(keys)),
    };
    try {
      return await job(tx);
    } finally {
      open = false;
    }
  });
}
