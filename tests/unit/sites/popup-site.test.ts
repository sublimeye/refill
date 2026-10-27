import { readFileSync } from "node:fs";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSiteHandlers } from "../../../src/lib/sites/handlers";
import {
  enableSite,
  loadSiteView,
  removeSiteFor,
  resolveTarget,
  viewOf,
} from "../../../src/lib/sites/popup-site";
import { installShims } from "../helpers/browser-shims";

const A = "https://a.example";
const PA = A + "/*";

let shims: ReturnType<typeof installShims>;

beforeEach(() => {
  fakeBrowser.reset();
  shims = installShims();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const handlers = createSiteHandlers(() => 1_000_000);
  vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(((msg: {
    type: keyof typeof handlers;
  }) => Promise.resolve(handlers[msg.type](msg as never))) as never);
});

describe("resolveTarget", () => {
  // fakeBrowser has no window model, so the tab list is stubbed.
  const tabs = (list: { id?: number; url?: string }[]) =>
    vi.spyOn(fakeBrowser.tabs, "query").mockResolvedValue(list as never);

  it("is the active tab of the current window, with its https origin", async () => {
    const query = tabs([{ id: 5, url: "https://a.example:8443/x?y#z" }]);
    expect(await resolveTarget("")).toEqual({
      tabId: 5,
      origin: "https://a.example:8443",
    });
    expect(query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  });

  it("has a null origin for a non-https tab", async () => {
    tabs([{ id: 5, url: "http://a.example/" }]);
    expect((await resolveTarget(""))?.origin).toBeNull();
  });

  it("has a null origin when the URL is not readable", async () => {
    tabs([{ id: 5 }]);
    expect(await resolveTarget("")).toEqual({ tabId: 5, origin: null });
  });

  it("is null when there is no usable tab or the query fails", async () => {
    tabs([]);
    expect(await resolveTarget("")).toBeNull();
    tabs([{ url: "https://a.example/" }]);
    expect(await resolveTarget("")).toBeNull();
    vi.spyOn(fakeBrowser.tabs, "query").mockRejectedValue(new Error("x"));
    expect(await resolveTarget("")).toBeNull();
  });

  it("ignores the e2e override query params outside the e2e build", async () => {
    tabs([{ id: 5, url: "https://b.example/" }]);
    const t = await resolveTarget(
      `?__refillE2E_tabId=77&__refillE2E_url=${encodeURIComponent(A)}`,
    );
    expect(t).toEqual({ tabId: 5, origin: "https://b.example" }); // MODE is "test" here
  });
});

describe("viewOf / loadSiteView", () => {
  const target = { tabId: 3, origin: A };
  const status = (
    o: Partial<Extract<Parameters<typeof viewOf>[1], { enabled: boolean }>>,
  ) => ({
    origin: A,
    enabled: false,
    granted: false,
    accessRevoked: false,
    hasProfile: false,
    ...o,
  });

  it("maps off / on / revoked and shows host[:port]", () => {
    expect(viewOf(target, status({}))).toMatchObject({
      kind: "off",
      host: "a.example",
    });
    expect(
      viewOf(target, status({ enabled: true, granted: true })),
    ).toMatchObject({
      kind: "on",
    });
    expect(
      viewOf(target, status({ enabled: true, granted: false })),
    ).toMatchObject({
      kind: "revoked",
    });
    expect(
      viewOf(
        { tabId: 3, origin: "https://localhost:4510" },
        { ...status({}), origin: "https://localhost:4510" },
      ),
    ).toMatchObject({ host: "localhost:4510" });
  });

  it("a granted but not enabled origin is off (enable completes the work)", () => {
    expect(viewOf(target, status({ granted: true }))).toMatchObject({
      kind: "off",
    });
  });

  it("is unsupported without an https origin, and never asks the service worker", async () => {
    expect(viewOf({ tabId: 3, origin: null }, { origin: null })).toEqual({
      kind: "unsupported",
    });
    const spy = vi.spyOn(fakeBrowser.runtime, "sendMessage");
    spy.mockClear();
    expect(await loadSiteView({ tabId: 3, origin: null })).toEqual({
      kind: "unsupported",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("is the error view when the service worker cannot be reached", async () => {
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockRejectedValue(
      new Error("x"),
    );
    expect(await loadSiteView(target)).toEqual({ kind: "error" });
  });
});

describe("enableSite", () => {
  const target = { tabId: 3, origin: A };

  // ADR 0018 / P6: Chrome honors permissions.request only inside the click's user activation.
  it("calls permissions.request in the caller's synchronous turn, before any await", async () => {
    shims.permissions.request.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return true;
    });
    const p = enableSite(target); // no await between this and the assertions
    expect(shims.permissions.request).toHaveBeenCalledOnce();
    expect(shims.permissions.request).toHaveBeenCalledWith({ origins: [PA] });
    await p;
  });

  it("enabled: re-queries and returns the enabled view", async () => {
    shims.permissions.request.mockImplementation(async (p) => {
      for (const o of p.origins ?? []) shims.grants.add(o);
      return true;
    });
    const res = await enableSite(target);
    expect(res.outcome).toBe("enabled");
    expect(res.view).toMatchObject({ kind: "on", origin: A, tabId: 3 });
  });

  it("denied: the view stays off", async () => {
    shims.permissions.request.mockResolvedValue(false);
    const res = await enableSite(target);
    expect(res.outcome).toBe("denied");
    expect(res.view).toMatchObject({ kind: "off" });
  });

  it("the Svelte click handler calls enableSite as its first statement, before any await", () => {
    const src = readFileSync("src/entrypoints/popup/App.svelte", "utf8");
    const from = src.indexOf("function enable(");
    expect(from, "enable() handler not found").toBeGreaterThan(-1);
    const body = src.slice(from, src.indexOf("async function settleEnable"));
    const statements = body
      .split("{")[1]!
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("//"));
    expect(statements[0]).toBe("const flow = enableSite(s);");
    expect(body).not.toMatch(/\bawait\b/);
  });
});

describe("removeSiteFor", () => {
  it("removes and returns the off view", async () => {
    shims.grant(PA);
    await enableSite({ tabId: 3, origin: A });
    const res = await removeSiteFor({ tabId: 3, origin: A });
    expect(res.ok).toBe(true);
    expect(res.view).toMatchObject({ kind: "off" });
  });

  it("reports failure but still returns a fresh view", async () => {
    const spy = vi.spyOn(fakeBrowser.runtime, "sendMessage");
    spy.mockRejectedValueOnce(new Error("x"));
    const res = await removeSiteFor({ tabId: 3, origin: A });
    expect(res.ok).toBe(false);
    expect(res.view.kind).not.toBe("error");
  });
});
