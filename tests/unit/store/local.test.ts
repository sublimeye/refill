import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it } from "vitest";
import {
  KEYS,
  draftKey,
  getItem,
  getMany,
  profileKey,
  removeItems,
  setItems,
  withStoreLock,
  type StoreTx,
} from "../../../src/lib/store/local";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const withTimeout = async <T>(p: Promise<T>, ms = 1000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        timer = setTimeout(() => rej(new Error("timed out (deadlock?)")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

beforeEach(() => {
  fakeBrowser.reset();
});

describe("keys", () => {
  it("exposes fixed keys and prefixed builders", () => {
    expect(KEYS).toEqual({
      header: "vault:header",
      integrity: "vault:integrity",
      sites: "sites",
      settings: "settings",
    });
    expect(profileKey("x")).toBe("p:x");
    expect(draftKey("y")).toBe("d:y");
  });
});

describe("local store", () => {
  it("round-trips items and returns undefined for a missing key", async () => {
    expect(await getItem("a")).toBeUndefined();
    await setItems({ a: { n: 1 }, b: "two" });
    expect(await getItem("a")).toEqual({ n: 1 });
    expect(await getItem("b")).toBe("two");
  });

  it("getMany returns only keys starting with the prefix", async () => {
    await setItems({
      "p:1": 1,
      "p:2": 2,
      "d:1": 3,
      "xp:3": 4,
      "a:p:5": 5,
      sites: 6,
    });
    expect(await getMany("p:")).toEqual({ "p:1": 1, "p:2": 2 });
  });

  it("removeItems deletes the listed keys only", async () => {
    await setItems({ a: 1, b: 2, c: 3 });
    await removeItems(["a", "c"]);
    expect(await getItem("a")).toBeUndefined();
    expect(await getItem("b")).toBe(2);
    expect(await getItem("c")).toBeUndefined();
  });

  it("50 synchronously issued locked increments yield 50", async () => {
    await setItems({ n: 0 });
    await Promise.all(
      Array.from({ length: 50 }, () =>
        withStoreLock(async (tx) => {
          const n = (await tx.getItem("n")) as number;
          await Promise.resolve();
          await tx.setItems({ n: n + 1 });
        }),
      ),
    );
    expect(await getItem("n")).toBe(50);
  });

  it("10 staggered locked increments yield 10", async () => {
    await setItems({ n: 0 });
    const ps: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      ps.push(
        withStoreLock(async (tx) => {
          const n = (await tx.getItem("n")) as number;
          await delay(2);
          await tx.setItems({ n: n + 1 });
        }),
      );
      await delay(1);
    }
    await Promise.all(ps);
    expect(await getItem("n")).toBe(10);
  });

  it("two staggered createVault-shaped check-then-write jobs: exactly one wins", async () => {
    const create = (id: string) =>
      withStoreLock(async (tx) => {
        if ((await tx.getItem(KEYS.header)) !== undefined) {
          throw new Error("exists");
        }
        await delay(5);
        await tx.setItems({ [KEYS.header]: id, [KEYS.integrity]: id });
      });
    const a = create("A");
    await delay(1); // B arrives while A's job holds the lock
    const b = create("B");
    const r = await Promise.allSettled([a, b]);
    expect(r.map((x) => x.status)).toEqual(["fulfilled", "rejected"]);
    expect(await getItem(KEYS.header)).toBe("A");
    expect(await getItem(KEYS.integrity)).toBe("A");
  });

  it("an unrelated public setItems arriving during a lock job completes after it", async () => {
    const order: string[] = [];
    const locked = withStoreLock(async (tx) => {
      await delay(5);
      await tx.setItems({ k: "locked" });
      order.push("lock");
    });
    await delay(1);
    const outside = setItems({ k: "outside" }).then(() => order.push("write"));
    await Promise.all([locked, outside]);
    expect(order).toEqual(["lock", "write"]);
    expect(await getItem("k")).toBe("outside");
  });

  it("tx.setItems, tx.removeItems and tx reads inside a job do not deadlock", async () => {
    await setItems({ b: 2, "p:1": 1, "d:1": 9 });
    const seen = await withTimeout(
      withStoreLock(async (tx) => {
        await tx.setItems({ a: 1 });
        await tx.removeItems(["b"]);
        return tx.getMany("p:");
      }),
    );
    expect(seen).toEqual({ "p:1": 1 });
    expect(await getItem("a")).toBe(1);
    expect(await getItem("b")).toBeUndefined();
  });

  it("a leaked tx rejects after the job settles", async () => {
    let leaked!: StoreTx;
    await withStoreLock(async (tx) => {
      leaked = tx;
    });
    await expect(leaked.setItems({ a: 1 })).rejects.toThrow(/after/);
    await expect(leaked.removeItems(["a"])).rejects.toThrow(/after/);
    await expect(leaked.getItem("a")).rejects.toThrow(/after/);
    await expect(leaked.getMany("a")).rejects.toThrow(/after/);
    expect(await getItem("a")).toBeUndefined();
  });

  it("the lock is released after a job throws", async () => {
    await expect(
      withStoreLock(async (tx) => {
        await tx.setItems({ a: 1 });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await withTimeout(setItems({ a: 2 }));
    expect(await getItem("a")).toBe(2);
  });
});
