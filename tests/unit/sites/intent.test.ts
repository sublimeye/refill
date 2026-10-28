import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it } from "vitest";
import {
  INTENT_TTL_MS,
  takeIntent,
  writeIntent,
  type PendingIntent,
} from "../../../src/lib/sites/intent";

const A = "https://a.example";
const intent: PendingIntent = {
  tabId: 7,
  origin: A,
  kind: "enable",
  ts: 1_000_000,
};

beforeEach(() => {
  fakeBrowser.reset();
});

describe("pending intent", () => {
  it("has a 120 s TTL", () => {
    expect(INTENT_TTL_MS).toBe(120_000);
  });

  it("keeps the kind: enable and record both round-trip, any other is garbage", async () => {
    await writeIntent({ ...intent, kind: "record" });
    expect(await takeIntent(A, intent.ts)).toEqual({
      ...intent,
      kind: "record",
    });
    await fakeBrowser.storage.session.set({
      "sites:intent": { ...intent, kind: "other" },
    });
    expect(await takeIntent(A, intent.ts)).toBeNull();
  });

  it("is taken once", async () => {
    await writeIntent(intent);
    expect(await takeIntent(A, intent.ts + 1000)).toEqual(intent);
    expect(await takeIntent(A, intent.ts + 1000)).toBeNull();
  });

  it("is still valid exactly at the TTL", async () => {
    await writeIntent(intent);
    expect(await takeIntent(A, intent.ts + INTENT_TTL_MS)).toEqual(intent);
  });

  it("expires after 121 s and is removed", async () => {
    await writeIntent(intent);
    expect(await takeIntent(A, intent.ts + 121_000)).toBeNull();
    expect(await takeIntent(A, intent.ts + 1000)).toBeNull();
  });

  it("returns null for another origin and keeps the intent", async () => {
    await writeIntent(intent);
    expect(await takeIntent("https://b.example", intent.ts + 1000)).toBeNull();
    expect(await takeIntent(A, intent.ts + 1000)).toEqual(intent);
  });

  it("a newer write replaces the pending one", async () => {
    await writeIntent(intent);
    const newer = {
      ...intent,
      origin: "https://b.example",
      tabId: 9,
      ts: intent.ts + 5,
    };
    await writeIntent(newer);
    expect(await takeIntent(A, intent.ts + 10)).toBeNull();
    expect(await takeIntent("https://b.example", intent.ts + 10)).toEqual(
      newer,
    );
  });

  it("returns null when nothing or garbage is stored", async () => {
    expect(await takeIntent(A, 1)).toBeNull();
    await fakeBrowser.storage.session.set({ "sites:intent": { tabId: "x" } });
    expect(await takeIntent(A, 1)).toBeNull();
  });

  it("defaults now to Date.now()", async () => {
    await writeIntent({ ...intent, ts: Date.now() });
    expect(await takeIntent(A)).not.toBeNull();
  });

  it("two concurrent takes: exactly one gets the intent", async () => {
    await writeIntent(intent);
    const [x, y] = await Promise.all([
      takeIntent(A, intent.ts + 1000),
      takeIntent(A, intent.ts + 1000),
    ]);
    expect([x, y].filter((r) => r !== null)).toEqual([intent]);
  });

  it("treats an intent stamped more than 60 s in the future as expired", async () => {
    await writeIntent(intent);
    expect(await takeIntent(A, intent.ts - 60_001)).toBeNull();
    expect(await takeIntent(A, intent.ts)).toBeNull();
  });

  it("accepts an intent stamped up to 60 s in the future", async () => {
    await writeIntent(intent);
    expect(await takeIntent(A, intent.ts - 60_000)).toEqual(intent);
  });
});
