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
} from "../../../src/lib/store/local";

const withTimeout = <T>(p: Promise<T>, ms = 1000): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error("timed out (deadlock?)")), ms),
    ),
  ]);

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

  it("withStoreLock read-modify-write from 50 concurrent increments yields 50", async () => {
    await setItems({ n: 0 });
    await Promise.all(
      Array.from({ length: 50 }, () =>
        withStoreLock(async () => {
          const n = (await getItem("n")) as number;
          await Promise.resolve();
          await setItems({ n: n + 1 });
        }),
      ),
    );
    expect(await getItem("n")).toBe(50);
  });

  it("setItems and removeItems inside a withStoreLock job do not deadlock", async () => {
    await withTimeout(
      withStoreLock(async () => {
        await setItems({ a: 1, b: 2 });
        await removeItems(["b"]);
      }),
    );
    expect(await getItem("a")).toBe(1);
    expect(await getItem("b")).toBeUndefined();
  });

  it("a nested withStoreLock does not deadlock", async () => {
    const r = await withTimeout(
      withStoreLock(async () => withStoreLock(async () => "inner")),
    );
    expect(r).toBe("inner");
  });

  it("the lock is released after a job throws", async () => {
    await expect(
      withStoreLock(async () => {
        await setItems({ a: 1 });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await withTimeout(setItems({ a: 2 }));
    expect(await getItem("a")).toBe(2);
  });
});
