import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSites, upsertSite } from "../../../src/lib/sites";
import { createSiteHandlers } from "../../../src/lib/sites/handlers";
import { takeIntent } from "../../../src/lib/sites/intent";
import { requestSiteEnable } from "../../../src/lib/sites/popup-flow";
import {
  CONTENT_SCRIPT_FILE,
  CONTENT_SCRIPT_ID,
  reconcile,
} from "../../../src/lib/sites/reconcile";
import { KEYS, profileKey } from "../../../src/lib/store/local";
import { installShims } from "../helpers/browser-shims";

const A = "https://a.example";
const B = "https://b.example";
const PA = A + "/*";
const PB = B + "/*";
const NOW = 1_000_000;

let shims: ReturnType<typeof installShims>;
const h = () => createSiteHandlers(() => NOW);

beforeEach(() => {
  fakeBrowser.reset();
  shims = installShims();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("site-status", () => {
  it("is { origin: null } for anything that is not a canonical https origin", async () => {
    for (const o of [
      "http://a.example",
      "https://a.example/path",
      "https://A.example",
      "",
      "nonsense",
      "chrome-extension://abc",
    ]) {
      expect(
        await h()["site-status"]({ type: "site-status", origin: o }),
      ).toEqual({
        origin: null,
      });
    }
  });

  it("reports an unknown origin", async () => {
    expect(
      await h()["site-status"]({ type: "site-status", origin: A }),
    ).toEqual({
      origin: A,
      enabled: false,
      granted: false,
      accessRevoked: false,
      hasProfile: false,
    });
  });

  it("reports an enabled, granted site with a profile", async () => {
    await upsertSite(A, { profileId: "p1" });
    shims.grant(PA);
    expect(
      await h()["site-status"]({ type: "site-status", origin: A }),
    ).toEqual({
      origin: A,
      enabled: true,
      granted: true,
      accessRevoked: false,
      hasProfile: true,
    });
  });

  it("reports a revoked site", async () => {
    await upsertSite(A, { accessRevoked: true });
    expect(
      await h()["site-status"]({ type: "site-status", origin: A }),
    ).toMatchObject({ enabled: true, granted: false, accessRevoked: true });
  });
});

describe("site-enable", () => {
  it("is not-granted when the permission is missing, and changes nothing", async () => {
    expect(
      await h()["site-enable"]({ type: "site-enable", tabId: 1, origin: A }),
    ).toEqual({ ok: false, error: "not-granted" });
    expect(await readSites()).toEqual({});
    expect(shims.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("is invalid-origin for a non-canonical origin", async () => {
    shims.grant("http://a.example/*");
    expect(
      await h()["site-enable"]({
        type: "site-enable",
        tabId: 1,
        origin: "http://a.example",
      }),
    ).toEqual({ ok: false, error: "invalid-origin" });
  });

  it("when already granted: creates the site, registers, then injects into the tab", async () => {
    shims.grant(PA);
    expect(
      await h()["site-enable"]({ type: "site-enable", tabId: 9, origin: A }),
    ).toEqual({ ok: true });
    expect(Object.keys(await readSites())).toEqual([A]);
    expect(shims.scripts.get(CONTENT_SCRIPT_ID)!.matches).toEqual([PA]);
    expect(shims.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 9 },
      files: [CONTENT_SCRIPT_FILE],
    });
  });

  it("still succeeds when injection fails (tab closed)", async () => {
    shims.grant(PA);
    shims.scripting.executeScript.mockRejectedValue(new Error("No tab"));
    expect(
      await h()["site-enable"]({ type: "site-enable", tabId: 9, origin: A }),
    ).toEqual({ ok: true });
    expect(shims.scripts.size).toBe(1);
  });

  it("re-enabling a revoked site clears the flag", async () => {
    await upsertSite(A, { accessRevoked: true });
    shims.grant(PA);
    await h()["site-enable"]({ type: "site-enable", tabId: 9, origin: A });
    expect((await readSites())[A]!.accessRevoked).toBe(false);
  });
});

describe("site-remove", () => {
  async function seed() {
    await upsertSite(A, { profileId: "p1" });
    await upsertSite(B, { profileId: "p2" });
    shims.grant(PA);
    shims.grant(PB);
    await fakeBrowser.storage.local.set({
      [profileKey("p1")]: { v: 1, ct: "a" },
      [profileKey("p2")]: { v: 1, ct: "b" },
    });
    await reconcile();
  }

  it("removes the record, its profile record and the permission; keeps other sites", async () => {
    await seed();
    expect(
      await h()["site-remove"]({ type: "site-remove", origin: A }),
    ).toEqual({ ok: true });
    expect(Object.keys(await readSites())).toEqual([B]);
    const stored = await fakeBrowser.storage.local.get(null);
    expect(stored[profileKey("p1")]).toBeUndefined();
    expect(stored[profileKey("p2")]).toEqual({ v: 1, ct: "b" });
    expect(shims.permissions.remove).toHaveBeenCalledWith({ origins: [PA] });
    expect(shims.grants.has(PA)).toBe(false);
    expect(shims.scripts.get(CONTENT_SCRIPT_ID)!.matches).toEqual([PB]);
  });

  it("removing the last site unregisters the script", async () => {
    await upsertSite(A, {});
    shims.grant(PA);
    await reconcile();
    await h()["site-remove"]({ type: "site-remove", origin: A });
    expect(shims.scripts.size).toBe(0);
  });

  it("treats a permissions.remove failure as non-fatal", async () => {
    await seed();
    shims.permissions.remove.mockRejectedValue(
      new Error("You cannot remove required permissions"),
    );
    expect(
      await h()["site-remove"]({ type: "site-remove", origin: A }),
    ).toEqual({ ok: true });
    expect(Object.keys(await readSites())).toEqual([B]);
    expect(
      (await fakeBrowser.storage.local.get(profileKey("p1")))[profileKey("p1")],
    ).toBeUndefined();
    // The permission is still there (required), but with no record the script no longer matches it.
    expect(shims.scripts.get(CONTENT_SCRIPT_ID)!.matches).toEqual([PB]);
  });

  it("removing an unknown or invalid origin is a no-op success", async () => {
    await seed();
    for (const o of ["https://c.example", "http://x.example", "junk"]) {
      expect(
        await h()["site-remove"]({ type: "site-remove", origin: o }),
      ).toEqual({ ok: true });
    }
    expect(Object.keys(await readSites()).sort()).toEqual([A, B]);
    expect(
      (await fakeBrowser.storage.local.get(KEYS.sites))[KEYS.sites],
    ).toBeDefined();
  });

  it("does not need the vault to be unlocked (no decryption)", async () => {
    await seed(); // the vault is never created in this test file
    await expect(
      h()["site-remove"]({ type: "site-remove", origin: A }),
    ).resolves.toEqual({ ok: true });
  });
});

describe("site-intent", () => {
  it("writes a pending intent stamped by the service worker's clock", async () => {
    expect(
      await h()["site-intent"]({ type: "site-intent", tabId: 4, origin: A }),
    ).toEqual({ ok: true });
    expect(await takeIntent(A, NOW + 1)).toEqual({
      tabId: 4,
      origin: A,
      kind: "enable",
      ts: NOW,
    });
  });

  it("rejects an origin that does not normalize to itself, writing nothing", async () => {
    expect(
      await h()["site-intent"]({
        type: "site-intent",
        tabId: 4,
        origin: "https://a.example/x",
      }),
    ).toEqual({ ok: false, error: "invalid-origin" });
    expect(await takeIntent("https://a.example", NOW)).toBeNull();
  });
});

describe("requestSiteEnable", () => {
  // The popup helper talks to the service worker through runtime.sendMessage; route it to handlers.
  beforeEach(() => {
    const handlers = h();
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(
      (async (msg: { type: "site-enable" | "site-intent" }) =>
        handlers[msg.type](msg as never)) as never,
    );
  });

  it("writes the intent BEFORE permissions.request and returns granted-pending", async () => {
    let intentAtRequest: unknown = "unset";
    shims.permissions.request.mockImplementation(async () => {
      intentAtRequest = (await fakeBrowser.storage.session.get("sites:intent"))[
        "sites:intent"
      ];
      return true;
    });
    expect(await requestSiteEnable(3, A)).toBe("granted-pending");
    expect(shims.permissions.request).toHaveBeenCalledOnce();
    expect(intentAtRequest).toMatchObject({
      tabId: 3,
      origin: A,
      kind: "enable",
    });
    expect(shims.permissions.request).toHaveBeenCalledWith({ origins: [PA] });
    // The popup did not enable anything itself.
    expect(await readSites()).toEqual({});
  });

  it("returns denied when the user declines", async () => {
    shims.permissions.request.mockResolvedValue(false);
    expect(await requestSiteEnable(3, A)).toBe("denied");
  });

  it("returns denied when the request throws", async () => {
    shims.permissions.request.mockRejectedValue(new Error("no gesture"));
    expect(await requestSiteEnable(3, A)).toBe("denied");
  });

  it("when already granted: sends site-enable, requests nothing, writes no intent", async () => {
    shims.grant(PA);
    expect(await requestSiteEnable(3, A)).toBe("enabled");
    expect(shims.permissions.request).not.toHaveBeenCalled();
    expect(
      (await fakeBrowser.storage.session.get("sites:intent"))["sites:intent"],
    ).toBeUndefined();
    expect(Object.keys(await readSites())).toEqual([A]);
    expect(shims.scripting.executeScript).toHaveBeenCalledOnce();
  });

  it("does not request when the intent could not be written", async () => {
    expect(await requestSiteEnable(3, "https://a.example/path")).toBe("denied");
    expect(shims.permissions.request).not.toHaveBeenCalled();
  });
});
