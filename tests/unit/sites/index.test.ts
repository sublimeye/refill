import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TTL_MS,
  readSites,
  removeSite,
  upsertSite,
} from "../../../src/lib/sites";
import {
  KEYS,
  getItem,
  setItems,
  withStoreLock,
} from "../../../src/lib/store/local";

const A = "https://a.example";
const B = "https://b.example";
const DEFAULT = {
  profileId: null,
  drafts: false,
  ttl: DEFAULT_TTL_MS,
  accessRevoked: false,
};

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

describe("readSites", () => {
  it("is empty when nothing stored", async () => {
    expect(await readSites()).toEqual({});
  });

  it("drops garbage entries, extra keys and non-https origin keys", async () => {
    await setItems({
      [KEYS.sites]: {
        [A]: DEFAULT,
        "https://b.example": "x",
        "https://c.example": {
          profileId: 5,
          drafts: false,
          ttl: null,
          accessRevoked: false,
        },
        "https://d.example": { ...DEFAULT, extra: 1 },
        "http://e.example": DEFAULT,
        "https://f.example/path": DEFAULT,
        "https://g.example": { ...DEFAULT, ttl: -1 },
        "https://h.example": { ...DEFAULT, ttl: "1" },
        "https://i.example": null,
        "https://j.example": { ...DEFAULT, profileId: "p1", ttl: null },
      },
    });
    expect(await readSites()).toEqual({
      [A]: DEFAULT,
      "https://j.example": { ...DEFAULT, profileId: "p1", ttl: null },
    });
  });

  it.each([null, "x", 5, ["a"], true])(
    "returns {} for root %j",
    async (root) => {
      await setItems({ [KEYS.sites]: root });
      expect(await readSites()).toEqual({});
    },
  );
});

describe("upsertSite / removeSite", () => {
  it("creates with defaults then applies the patch", async () => {
    const rec = await upsertSite(A, { profileId: "p1", drafts: true });
    expect(rec).toEqual({ ...DEFAULT, profileId: "p1", drafts: true });
    expect(await readSites()).toEqual({ [A]: rec });
  });

  it("patches an existing record, keeping other fields", async () => {
    await upsertSite(A, { profileId: "p1" });
    const rec = await upsertSite(A, { ttl: null });
    expect(rec).toEqual({ ...DEFAULT, profileId: "p1", ttl: null });
  });

  it("removes a site and keeps others", async () => {
    await upsertSite(A, {});
    await upsertSite(B, {});
    await removeSite(A);
    expect(Object.keys(await readSites())).toEqual([B]);
  });

  it("removing an unknown site is a no-op", async () => {
    await removeSite(A);
    expect(await readSites()).toEqual({});
  });

  it("concurrent upserts for two origins both persist", async () => {
    await Promise.all([
      upsertSite(A, { drafts: true }),
      upsertSite(B, { profileId: "p2" }),
    ]);
    const sites = await readSites();
    expect(Object.keys(sites).sort()).toEqual([A, B]);
    expect(sites[A]!.drafts).toBe(true);
    expect(sites[B]!.profileId).toBe("p2");
  });

  it("upsert and remove inside a caller's withStoreLock via tx do not deadlock", async () => {
    await withTimeout(
      withStoreLock(async (tx) => {
        await upsertSite(A, { drafts: true }, tx);
        await upsertSite(B, {}, tx);
        expect(Object.keys(await readSites(tx)).sort()).toEqual([A, B]);
        await removeSite(B, tx);
      }),
    );
    expect(Object.keys(await readSites())).toEqual([A]);
    expect(await getItem(KEYS.sites)).toEqual({
      [A]: { ...DEFAULT, drafts: true },
    });
  });

  it("upsert drops garbage siblings when it rewrites", async () => {
    await setItems({
      [KEYS.sites]: { [A]: DEFAULT, "http://x.example": "junk" },
    });
    await upsertSite(B, {});
    expect(await getItem(KEYS.sites)).toEqual({ [A]: DEFAULT, [B]: DEFAULT });
  });
});
