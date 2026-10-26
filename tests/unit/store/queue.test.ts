import { describe, expect, it } from "vitest";
import { createQueue } from "../../../src/lib/store/queue";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createQueue", () => {
  it("runs jobs FIFO, one at a time, despite overlapping delays", async () => {
    const q = createQueue();
    const order: number[] = [];
    let running = 0;
    let maxRunning = 0;
    const job = (id: number, ms: number) => () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      return delay(ms).then(() => {
        order.push(id);
        running--;
        return id;
      });
    };
    const results = await Promise.all([
      q(job(1, 3)),
      q(job(2, 1)),
      q(job(3, 2)),
    ]);
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual([1, 2, 3]);
    expect(maxRunning).toBe(1);
  });

  it("a throwing job rejects its own promise and later jobs still run", async () => {
    const q = createQueue();
    const bad = q(async () => {
      throw new Error("boom");
    });
    const good = q(async () => "ok");
    await expect(bad).rejects.toThrow("boom");
    await expect(good).resolves.toBe("ok");
    await expect(q(async () => 2)).resolves.toBe(2);
  });

  it("a synchronously throwing job does not stall the queue", async () => {
    const q = createQueue();
    const bad = q(() => {
      throw new Error("sync");
    });
    await expect(bad).rejects.toThrow("sync");
    await expect(q(async () => 1)).resolves.toBe(1);
  });
});
