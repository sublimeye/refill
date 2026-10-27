import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSites, upsertSite } from "../../../src/lib/sites";
import { writeIntent } from "../../../src/lib/sites/intent";
import {
  CONTENT_SCRIPT_FILE,
  CONTENT_SCRIPT_ID,
  installSiteListeners,
  reconcile,
} from "../../../src/lib/sites/reconcile";
import { installShims } from "../helpers/browser-shims";

const A = "https://a.example";
const B = "https://b.example:8443";
const PA = A + "/*";
const PB = B + "/*";

let shims: ReturnType<typeof installShims>;

beforeEach(() => {
  fakeBrowser.reset();
  shims = installShims();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("reconcile", () => {
  it("registers one script with exact matches for granted origins that have a record", async () => {
    await upsertSite(A, {});
    await upsertSite(B, {});
    shims.grant(PA);
    shims.grant(PB);
    await reconcile();
    expect(shims.scripts.size).toBe(1);
    expect(shims.scripts.get(CONTENT_SCRIPT_ID)).toEqual({
      id: "refill-content",
      js: [CONTENT_SCRIPT_FILE],
      matches: [PA, PB],
      allFrames: false,
      runAt: "document_idle",
      world: "ISOLATED",
      persistAcrossSessions: true,
    });
    expect(CONTENT_SCRIPT_FILE).toBe("/refill-content.js");
  });

  it("flags a record without permission as accessRevoked and does not register it", async () => {
    await upsertSite(A, {});
    await reconcile();
    expect((await readSites())[A]!.accessRevoked).toBe(true);
    expect(shims.scripts.size).toBe(0);
    expect(shims.scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it("clears accessRevoked when the permission is regained", async () => {
    await upsertSite(A, { accessRevoked: true });
    shims.grant(PA);
    await reconcile();
    expect((await readSites())[A]!.accessRevoked).toBe(false);
    expect(shims.scripts.get(CONTENT_SCRIPT_ID)!.matches).toEqual([PA]);
  });

  it("does not register a granted origin that has no record", async () => {
    shims.grant(PA);
    await reconcile();
    expect(shims.scripts.size).toBe(0);
  });

  it("updates the matches of an existing registration and unregisters when empty", async () => {
    await upsertSite(A, {});
    await upsertSite(B, {});
    shims.grant(PA);
    await reconcile();
    shims.grant(PB);
    await reconcile();
    expect(shims.scripting.updateContentScripts).toHaveBeenCalledOnce();
    expect(shims.scripts.get(CONTENT_SCRIPT_ID)!.matches).toEqual([PA, PB]);
    shims.grants.clear();
    await reconcile();
    expect(shims.scripting.unregisterContentScripts).toHaveBeenCalledWith({
      ids: [CONTENT_SCRIPT_ID],
    });
    expect(shims.scripts.size).toBe(0);
  });

  it("does not call unregister when nothing is registered and nothing is desired", async () => {
    await reconcile();
    expect(shims.scripting.unregisterContentScripts).not.toHaveBeenCalled();
  });

  it("treats a failing permissions.contains as not granted", async () => {
    await upsertSite(A, {});
    shims.grant(PA);
    shims.permissions.contains.mockRejectedValue(new Error("boom"));
    await reconcile();
    expect(shims.scripts.size).toBe(0);
    expect((await readSites())[A]!.accessRevoked).toBe(true);
  });

  it("concurrent calls never register twice", async () => {
    await upsertSite(A, {});
    shims.grant(PA);
    await Promise.all([reconcile(), reconcile(), reconcile(), reconcile()]);
    expect(shims.scripting.registerContentScripts).toHaveBeenCalledOnce();
    expect(shims.scripts.size).toBe(1);
  });

  it("re-runs once for a request that arrived mid-run, so its change is not missed", async () => {
    await upsertSite(A, {});
    shims.grant(PA);
    const first = reconcile();
    // The first run is in flight (awaiting the shim); change the world and ask again.
    await upsertSite(B, {});
    shims.grant(PB);
    const second = reconcile();
    const third = reconcile();
    await Promise.all([first, second, third]);
    expect(shims.scripts.get(CONTENT_SCRIPT_ID)!.matches).toEqual([PA, PB]);
    expect(shims.scripting.registerContentScripts).toHaveBeenCalledOnce();
    expect(shims.scripting.updateContentScripts).toHaveBeenCalledOnce();
  });

  it("a failed run does not wedge later runs", async () => {
    await upsertSite(A, {});
    shims.grant(PA);
    shims.scripting.getRegisteredContentScripts.mockRejectedValueOnce(
      new Error("boom"),
    );
    await expect(reconcile()).rejects.toThrow("boom");
    await reconcile();
    expect(shims.scripts.size).toBe(1);
  });
});

describe("installSiteListeners", () => {
  it("registers every listener synchronously", () => {
    const spies = [
      vi.spyOn(fakeBrowser.runtime.onInstalled, "addListener"),
      vi.spyOn(fakeBrowser.runtime.onStartup, "addListener"),
      vi.spyOn(shims.permissions.onAdded, "addListener"),
      vi.spyOn(shims.permissions.onRemoved, "addListener"),
    ];
    installSiteListeners();
    for (const s of spies) expect(s).toHaveBeenCalledOnce();
  });

  it("reconciles on install and on startup", async () => {
    await upsertSite(A, {});
    shims.grant(PA);
    installSiteListeners();
    fakeBrowser.runtime.onStartup.trigger();
    await vi.waitFor(() => expect(shims.scripts.size).toBe(1));
    shims.scripts.clear();
    await fakeBrowser.runtime.onInstalled.trigger({
      reason: "update",
    } as never);
    await vi.waitFor(() => expect(shims.scripts.size).toBe(1));
  });

  it("revoking access unregisters the script and flags the site, keeping its data", async () => {
    await upsertSite(A, { profileId: "x" });
    shims.grant(PA);
    await reconcile();
    expect(shims.scripts.size).toBe(1);
    installSiteListeners();
    shims.revoke(PA);
    await vi.waitFor(() => expect(shims.scripts.size).toBe(0));
    const rec = (await readSites())[A]!;
    expect(rec.accessRevoked).toBe(true);
    expect(rec.profileId).toBe("x");
  });

  it("onAdded with an intent creates the site, registers the script and injects into the intent's tab", async () => {
    installSiteListeners();
    await writeIntent({ tabId: 42, origin: A, kind: "enable", ts: Date.now() });
    shims.accept(PA);
    await vi.waitFor(() =>
      expect(shims.scripting.executeScript).toHaveBeenCalledOnce(),
    );
    expect(shims.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 42 },
      files: [CONTENT_SCRIPT_FILE],
    });
    expect(Object.keys(await readSites())).toEqual([A]);
    expect((await readSites())[A]!.accessRevoked).toBe(false);
    expect(shims.scripts.get(CONTENT_SCRIPT_ID)!.matches).toEqual([PA]);
  });

  it("registers before it injects", async () => {
    installSiteListeners();
    await writeIntent({ tabId: 1, origin: A, kind: "enable", ts: Date.now() });
    shims.scripting.executeScript.mockImplementation(async () => {
      expect(shims.scripts.size).toBe(1);
      return [];
    });
    shims.accept(PA);
    await vi.waitFor(() =>
      expect(shims.scripting.executeScript).toHaveBeenCalled(),
    );
  });

  it("an executeScript failure (closed tab) is swallowed", async () => {
    installSiteListeners();
    shims.scripting.executeScript.mockRejectedValue(
      new Error("No tab with id: 42 https://secret.example/"),
    );
    await writeIntent({ tabId: 42, origin: A, kind: "enable", ts: Date.now() });
    shims.accept(PA);
    await vi.waitFor(() =>
      expect(shims.scripting.executeScript).toHaveBeenCalled(),
    );
    await vi.waitFor(() => expect(shims.scripts.size).toBe(1));
    // Name only: the message (which could carry a URL) is never logged.
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("secret.example");
  });

  it("onAdded without an intent only reconciles: no site is created, nothing is injected", async () => {
    await upsertSite(B, {});
    shims.grant(PB);
    installSiteListeners();
    shims.accept(PA);
    await vi.waitFor(() => expect(shims.scripts.size).toBe(1));
    expect(shims.scripts.get(CONTENT_SCRIPT_ID)!.matches).toEqual([PB]);
    expect(Object.keys(await readSites())).toEqual([B]);
    expect(shims.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("an intent for another origin is not consumed by this grant", async () => {
    installSiteListeners();
    await writeIntent({ tabId: 5, origin: B, kind: "enable", ts: Date.now() });
    shims.accept(PA);
    await vi.waitFor(() =>
      expect(shims.scripting.getRegisteredContentScripts).toHaveBeenCalled(),
    );
    expect(await readSites()).toEqual({});
    expect(shims.scripting.executeScript).not.toHaveBeenCalled();
    shims.accept(PB);
    await vi.waitFor(() =>
      expect(shims.scripting.executeScript).toHaveBeenCalledWith({
        target: { tabId: 5 },
        files: [CONTENT_SCRIPT_FILE],
      }),
    );
  });

  it("ignores non-https and non-origin patterns in onAdded", async () => {
    installSiteListeners();
    await writeIntent({ tabId: 5, origin: A, kind: "enable", ts: Date.now() });
    shims.permissions.onAdded.fire({
      origins: ["http://a.example/*", "https://a.example/path/*", "<all_urls>"],
    });
    await vi.waitFor(() =>
      expect(shims.scripting.getRegisteredContentScripts).toHaveBeenCalled(),
    );
    expect(await readSites()).toEqual({});
  });
});
