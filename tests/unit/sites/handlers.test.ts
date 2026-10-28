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
    shims.setTab(9, A + "/signup");
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

  it("a tab that navigated to another origin is not injected, but the site is enabled", async () => {
    shims.grant(PA);
    shims.grant(PB);
    shims.setTab(9, B + "/");
    expect(
      await h()["site-enable"]({ type: "site-enable", tabId: 9, origin: A }),
    ).toEqual({ ok: true });
    expect(Object.keys(await readSites())).toEqual([A]);
    expect(shims.scripts.get(CONTENT_SCRIPT_ID)!.matches).toEqual([PA]);
    expect(shims.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("a closed tab is not injected, but the site is enabled", async () => {
    shims.grant(PA);
    expect(
      await h()["site-enable"]({ type: "site-enable", tabId: 9, origin: A }),
    ).toEqual({ ok: true });
    expect(Object.keys(await readSites())).toEqual([A]);
    expect(shims.scripts.size).toBe(1);
    expect(shims.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("a tab whose URL is unreadable is not injected, but the site is enabled", async () => {
    shims.grant(PA);
    shims.setTab(9, undefined);
    expect(
      await h()["site-enable"]({ type: "site-enable", tabId: 9, origin: A }),
    ).toEqual({ ok: true });
    expect(Object.keys(await readSites())).toEqual([A]);
    expect(shims.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("still succeeds when injection fails (tab closed)", async () => {
    shims.grant(PA);
    shims.setTab(9, A + "/");
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

describe("pending intents are consumed (P8)", () => {
  const intent = (origin: string) => ({
    tabId: 4,
    origin,
    kind: "enable" as const,
    ts: NOW,
  });
  const put = (origin: string) =>
    fakeBrowser.storage.session.set({ "sites:intent": intent(origin) });

  it("site-enable consumes the pending intent for its origin", async () => {
    shims.grant(PA);
    await put(A);
    await h()["site-enable"]({ type: "site-enable", tabId: 4, origin: A });
    expect(await takeIntent(A, NOW)).toBeNull();
  });

  it("site-enable keeps an intent for another origin, and one when not granted", async () => {
    shims.grant(PA);
    await put(B);
    await h()["site-enable"]({ type: "site-enable", tabId: 4, origin: A });
    expect(await takeIntent(B, NOW)).toEqual(intent(B));

    await put(B);
    await h()["site-enable"]({ type: "site-enable", tabId: 4, origin: B });
    expect(await takeIntent(B, NOW)).toEqual(intent(B)); // not granted: nothing was handled
  });

  it("site-remove consumes the pending intent, so a later grant cannot resurrect the site", async () => {
    await upsertSite(A, {});
    shims.grant(PA);
    await put(A);
    await h()["site-remove"]({ type: "site-remove", origin: A });
    expect(await takeIntent(A, NOW)).toBeNull();
  });

  it("site-remove consumes the intent even when no site record exists", async () => {
    await put(A);
    await h()["site-remove"]({ type: "site-remove", origin: A });
    expect(await takeIntent(A, NOW)).toBeNull();
  });

  it("site-remove keeps an intent for another origin", async () => {
    await put(B);
    await h()["site-remove"]({ type: "site-remove", origin: A });
    expect(await takeIntent(B, NOW)).toEqual(intent(B));
  });
});

describe("wildcard origins", () => {
  const W = ["https://*", "https://*.example.com", "https://%2A.example.com"];

  it("never reach a grant, a record, an intent or a registration", async () => {
    shims.grant("https://*/*");
    for (const origin of W) {
      expect(await h()["site-status"]({ type: "site-status", origin })).toEqual(
        { origin: null },
      );
      expect(
        await h()["site-enable"]({ type: "site-enable", tabId: 1, origin }),
      ).toEqual({ ok: false, error: "invalid-origin" });
      expect(
        await h()["site-intent"]({
          type: "site-intent",
          tabId: 1,
          origin,
          kind: "enable",
        }),
      ).toEqual({ ok: false, error: "invalid-origin" });
    }
    expect(await readSites()).toEqual({});
    expect(shims.scripts.size).toBe(0);
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
      await h()["site-intent"]({
        type: "site-intent",
        tabId: 4,
        origin: A,
        kind: "enable",
      }),
    ).toEqual({ ok: true });
    expect(await takeIntent(A, NOW + 1)).toEqual({
      tabId: 4,
      origin: A,
      kind: "enable",
      ts: NOW,
    });
  });

  it("stores the kind it is given", async () => {
    await h()["site-intent"]({
      type: "site-intent",
      tabId: 4,
      origin: A,
      kind: "record",
    });
    expect(await takeIntent(A, NOW + 1)).toMatchObject({ kind: "record" });
  });

  it("rejects an origin that does not normalize to itself, writing nothing", async () => {
    expect(
      await h()["site-intent"]({
        type: "site-intent",
        tabId: 4,
        origin: "https://a.example/x",
        kind: "enable",
      }),
    ).toEqual({ ok: false, error: "invalid-origin" });
    expect(await takeIntent("https://a.example", NOW)).toBeNull();
  });
});

describe("requestSiteEnable", () => {
  // The popup helper talks to the service worker through runtime.sendMessage; route it to handlers.
  let sent: string[];
  beforeEach(() => {
    sent = [];
    shims.setTab(3, A + "/");
    const handlers = h();
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(
      (async (msg: { type: "site-enable" | "site-intent" }) => {
        sent.push(msg.type);
        return handlers[msg.type](msg as never);
      }) as never,
    );
  });

  it("starts the intent write and calls permissions.request in the caller's synchronous turn", async () => {
    let settled = false;
    shims.permissions.request.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return true;
    });
    // No await between the call and these assertions: the click handler's turn.
    const p = requestSiteEnable(3, A, "enable");
    void p.then(() => (settled = true));
    expect(shims.permissions.request).toHaveBeenCalledOnce();
    expect(shims.permissions.request).toHaveBeenCalledWith({ origins: [PA] });
    expect(sent).toEqual(["site-intent"]); // the write was started, not awaited
    expect(settled).toBe(false);
    await p;
  });

  it("the intent is stored while the permission dialog is open", async () => {
    let intentAtRequest: unknown = "unset";
    shims.permissions.request.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      intentAtRequest = (await fakeBrowser.storage.session.get("sites:intent"))[
        "sites:intent"
      ];
      return true;
    });
    await requestSiteEnable(3, A, "enable");
    expect(intentAtRequest).toMatchObject({
      tabId: 3,
      origin: A,
      kind: "enable",
    });
  });

  it("request true with the popup alive: sends site-enable and returns enabled", async () => {
    shims.permissions.request.mockImplementation(async (p) => {
      for (const o of p.origins ?? []) shims.grants.add(o);
      return true;
    });
    expect(await requestSiteEnable(3, A, "enable")).toBe("enabled");
    expect(sent).toEqual(["site-intent", "site-enable"]);
    expect(Object.keys(await readSites())).toEqual([A]);
    expect(shims.scripting.executeScript).toHaveBeenCalledOnce();
  });

  it("already granted: request resolves true at once and site-enable completes", async () => {
    shims.grant(PA);
    expect(await requestSiteEnable(3, A, "enable")).toBe("enabled");
    expect(shims.permissions.request).toHaveBeenCalledOnce();
    expect(shims.scripting.executeScript).toHaveBeenCalledOnce();
  });

  it("returns granted-pending when granted but the service worker declines site-enable", async () => {
    // request says true but the permission is not actually held: site-enable answers not-granted.
    expect(await requestSiteEnable(3, A, "enable")).toBe("granted-pending");
  });

  it("returns denied when the user declines, and does not send site-enable", async () => {
    shims.permissions.request.mockResolvedValue(false);
    expect(await requestSiteEnable(3, A, "enable")).toBe("denied");
    expect(sent).toEqual(["site-intent"]);
  });

  it("never throws: a rejecting request is denied", async () => {
    shims.permissions.request.mockRejectedValue(new Error("no gesture"));
    expect(await requestSiteEnable(3, A, "enable")).toBe("denied");
  });

  it("never throws: a synchronously throwing request is denied", async () => {
    shims.permissions.request.mockImplementation(() => {
      throw new Error("bad pattern");
    });
    expect(await requestSiteEnable(3, A, "enable")).toBe("denied");
  });

  it("never throws: a messaging failure on site-enable is denied", async () => {
    shims.permissions.request.mockResolvedValue(true);
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockRejectedValue(
      new Error("no receiver"),
    );
    expect(await requestSiteEnable(3, A, "enable")).toBe("denied");
  });

  it("never throws: a router error on site-enable is denied", async () => {
    shims.permissions.request.mockResolvedValue(true);
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue({
      ok: false,
      error: "internal",
    } as never);
    expect(await requestSiteEnable(3, A, "enable")).toBe("denied");
  });

  it("a failed intent write does not block the request or leave an unhandled rejection", async () => {
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockRejectedValue(
      new Error("no receiver"),
    );
    shims.permissions.request.mockResolvedValue(false);
    expect(await requestSiteEnable(3, A, "enable")).toBe("denied");
    expect(shims.permissions.request).toHaveBeenCalledOnce();
  });

  describe("kind record", () => {
    let recordReply: unknown;
    beforeEach(() => {
      recordReply = { ok: true };
      const handlers = h();
      vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(
        (async (msg: { type: string }) => {
          sent.push(msg.type);
          if (msg.type === "record-start") return recordReply;
          return handlers[msg.type as "site-intent"](msg as never);
        }) as never,
      );
    });

    it("stores a record intent and calls permissions.request in the synchronous turn", async () => {
      const p = requestSiteEnable(3, A, "record");
      expect(shims.permissions.request).toHaveBeenCalledOnce();
      expect(sent).toEqual(["site-intent"]);
      await p;
      shims.permissions.request.mockClear();
    });

    it("the stored intent has kind record", async () => {
      let intent: unknown;
      shims.permissions.request.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 5));
        intent = (await fakeBrowser.storage.session.get("sites:intent"))[
          "sites:intent"
        ];
        return true;
      });
      await requestSiteEnable(3, A, "record");
      expect(intent).toMatchObject({ tabId: 3, origin: A, kind: "record" });
    });

    it("sends record-start instead of site-enable and returns recording", async () => {
      expect(await requestSiteEnable(3, A, "record")).toBe("recording");
      expect(sent).toEqual(["site-intent", "record-start"]);
    });

    it("a locked vault is locked", async () => {
      recordReply = { ok: false, error: "locked" };
      expect(await requestSiteEnable(3, A, "record")).toBe("locked");
    });

    it.each([
      ["not-granted", "granted-pending"],
      ["tab-moved", "tab-moved"],
      ["invalid-origin", "denied"],
    ])("record-start %s is %s", async (error, outcome) => {
      recordReply = { ok: false, error };
      expect(await requestSiteEnable(3, A, "record")).toBe(outcome);
    });

    it("a declined request sends nothing more", async () => {
      shims.permissions.request.mockResolvedValue(false);
      expect(await requestSiteEnable(3, A, "record")).toBe("denied");
      expect(sent).toEqual(["site-intent"]);
    });

    it("a router error on record-start is denied", async () => {
      recordReply = { ok: false, error: "internal" };
      // `internal` is a RouterError: sendToSw throws it.
      expect(await requestSiteEnable(3, A, "record")).toBe("denied");
    });
  });

  it("an invalid origin is denied without requesting anything", async () => {
    expect(await requestSiteEnable(3, "https://a.example/path", "enable")).toBe(
      "denied",
    );
    expect(await requestSiteEnable(3, "https://*", "enable")).toBe("denied");
    expect(shims.permissions.request).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});
