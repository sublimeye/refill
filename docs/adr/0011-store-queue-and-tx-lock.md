# 0011 — Store write queue and transaction-handle lock

## Context

All `storage.local` access lives in `src/lib/store/` (Semgrep-enforced). Read-modify-write sequences (for example `createVault`: check that no header exists, then write header and integrity) must be atomic with respect to every other store write, including a second identical call that arrives while the first is mid-flight. In a service worker each message, alarm or idle event starts its own async flow, so such arrivals are normal.

A job that holds the queue and then awaits a public write deadlocks, because the write queues behind the job. The first attempt (PR #10, commit 734d5a9) avoided this with a module-level `lockHeld` flag that made store calls run directly while a lock job was active. That is wrong: JavaScript has no async-local context, so the flag cannot tell a call from inside the job apart from an unrelated call. A second `withStoreLock`, or any unrelated `setItems`, issued during a held lock bypassed the queue and interleaved with the job (reproduced: two staggered `createVault` jobs both succeeded; 10 staggered increments gave 6).

## Decision

- `createQueue()` chains jobs on a promise tail: FIFO, one at a time, a rejected (or synchronously throwing) job rejects only its own promise.
- Public `setItems` and `removeItems` are always enqueued. Public `getItem` and `getMany` read storage directly (unqueued). `getMany(prefix)` keeps keys that start with `prefix`.
- `withStoreLock(job: (tx: StoreTx) => Promise<T>)` runs `job` as one queue slot. `StoreTx` has `getItem`, `getMany`, `setItems`, `removeItems`, which hit storage directly. The job is given its authority explicitly instead of the module guessing it.
- `tx` is closed when the job settles (resolve or reject): any later `tx` call rejects with an error, so a leaked handle cannot write outside the lock.
- Exclusivity guarantee: while a lock job runs, no other queued write and no other lock job runs. Reads and `tx` calls are not queued.

## Consequences

- Inside a job, write only through `tx`. Calling the public `setItems`/`removeItems`, or nesting `withStoreLock`, inside a job deadlocks (it queues behind the job awaiting it). There is no async context to detect this, so it is a documented rule, not a runtime guard.
- Reads are unqueued, so a reader outside the lock can observe the state between two `tx` writes of one job. Use `tx.getItem` for a consistent read inside the lock, and write related keys in one `tx.setItems` call (one `storage.local.set` is atomic).
- Callers that need to write encrypted records inside a lock must seal first and write via `tx.setItems`, or take a writer parameter (Task 8/9).
- A zero-argument job still type-checks against `(tx) => Promise<T>`.
- `getMany` loads the whole local store; acceptable for the expected data size.

## Status

Accepted
