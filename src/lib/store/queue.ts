/**
 * FIFO async queue: one job at a time, in submission order. A rejected job
 * rejects only its own promise; later jobs still run.
 */
export function createQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    // `then` (never a direct call) so even a synchronously throwing job
    // becomes a rejection and a job never starts inside the caller's frame.
    const run = tail.then(() => job());
    tail = run.catch(() => undefined);
    return run;
  };
}
