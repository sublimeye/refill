# 0011 — Store write queue and re-entrant lock

## Context

All `storage.local` access lives in `src/lib/store/` (Semgrep-enforced). Read-modify-write sequences (for example, add a site and update the profile list) must be atomic with respect to other store writes, and `withStoreLock` must share the same queue as `setItems`/`removeItems`. A job that holds the queue and then awaits `setItems`, which also queues, would deadlock. The interface (`withStoreLock(job: () => Promise<T>)`) passes the job no transaction handle.

## Decision

- `createQueue()` chains jobs on a promise tail: FIFO, one at a time, a rejected (or synchronously throwing) job rejects only its own promise.
- `setItems`, `removeItems` and `withStoreLock` all go through one module-level queue. Reads (`getItem`, `getMany`) are not queued.
- A module-level `lockHeld` flag is true exactly while a `withStoreLock` job runs (the queue guarantees there is at most one). While it is set, `setItems`, `removeItems` and a nested `withStoreLock` run directly instead of queueing. The flag is cleared in `finally`, so a throwing job releases the lock.
- `getMany(prefix)` reads all entries and keeps keys that start with `prefix`.

## Consequences

- No deadlock for writes issued inside a lock job; covered by tests with a timeout guard.
- Limitation: JavaScript has no async-local context, so a write from an unrelated caller that happens to be issued while a lock job runs also bypasses the queue and can interleave with that job. Code that needs atomicity must put all of its writes inside `withStoreLock`. If this proves too weak, the job can later be given an explicit transaction argument (compatible with the current `() => Promise<T>` signature).
- `getMany` loads the whole local store; acceptable for the expected data size.

## Status

Accepted
