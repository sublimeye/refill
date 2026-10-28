import { readFileSync } from "node:fs";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSiteHandlers } from "../../../src/lib/sites/handlers";
import type { RecordPageState } from "../../../src/lib/messaging/protocol";
import {
  cancelRecordingFor,
  enableSite,
  finishRecordingFor,
  loadSiteView,
  recordSite,
  recordingLine,
  removeSiteFor,
  resolveTarget,
  viewOf,
} from "../../../src/lib/sites/popup-site";
import { installShims } from "../helpers/browser-shims";

const A = "https://a.example";
const PA = A + "/*";

const OFF: RecordPageState = { state: "off" };

let shims: ReturnType<typeof installShims>;
// The recorder's page handlers need a sealed session; the popup only needs their answers.
let recordState: RecordPageState;
let recordCalls: { type: string; tabId?: number; origin?: string }[];
let recordStart: { ok: true } | { ok: false; error: string };

beforeEach(() => {
  fakeBrowser.reset();
  shims = installShims();
  recordState = OFF;
  recordCalls = [];
  recordStart = { ok: true };
  vi.spyOn(console, "error").mockImplementation(() => {});
  const handlers = createSiteHandlers(() => 1_000_000);
  vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(((msg: {
    type: string;
    tabId?: number;
    origin?: string;
  }) => {
    if (msg.type.startsWith("record-")) {
      recordCalls.push(msg);
      switch (msg.type) {
        case "record-state":
          return Promise.resolve(recordState);
        case "record-start":
          return Promise.resolve(recordStart);
        default:
          return Promise.resolve({ ok: true });
      }
    }
    return Promise.resolve(
      handlers[msg.type as keyof typeof handlers](msg as never),
    );
  }) as never);
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
    expect(viewOf(target, status({}), OFF)).toMatchObject({
      kind: "off",
      host: "a.example",
    });
    expect(
      viewOf(target, status({ enabled: true, granted: true }), OFF),
    ).toMatchObject({
      kind: "on",
    });
    expect(
      viewOf(target, status({ enabled: true, granted: false }), OFF),
    ).toMatchObject({
      kind: "revoked",
    });
    expect(
      viewOf(
        { tabId: 3, origin: "https://localhost:4510" },
        { ...status({}), origin: "https://localhost:4510" },
        OFF,
      ),
    ).toMatchObject({ host: "localhost:4510" });
  });

  it("a granted but not enabled origin is off (enable completes the work)", () => {
    expect(viewOf(target, status({ granted: true }), OFF)).toMatchObject({
      kind: "off",
    });
  });

  it("carries whether the site has a saved form", () => {
    expect(viewOf(target, status({}), OFF)).toMatchObject({
      hasProfile: false,
    });
    expect(viewOf(target, status({ hasProfile: true }), OFF)).toMatchObject({
      hasProfile: true,
    });
  });

  it("carries the recording state in every state", () => {
    const on = status({ enabled: true, granted: true });
    expect(viewOf(target, on, OFF)).toMatchObject({
      recording: { state: "off" },
    });
    const here = (state: "on" | "full" | "review", count: number) =>
      viewOf(target, on, { state, origin: A, count, here: true });
    expect(here("on", 0)).toMatchObject({
      recording: { state: "on", count: 0, here: true },
    });
    expect(here("full", 200)).toMatchObject({
      recording: { state: "full", count: 200, here: true },
    });
    expect(here("review", 4)).toMatchObject({
      recording: { state: "review", count: 4, here: true },
    });
    // Recording in another tab: the session's origin is not the popup's business.
    expect(
      viewOf(target, on, {
        state: "on",
        origin: "https://b.example",
        count: 2,
        here: false,
      }),
    ).toEqual(
      expect.objectContaining({
        recording: { state: "on", count: 2, here: false },
      }),
    );
  });

  it("loadSiteView reads the site status and the recording state", async () => {
    shims.grant(PA);
    await enableSite(target);
    recordState = { state: "on", origin: A, count: 3, here: true };
    expect(await loadSiteView(target)).toMatchObject({
      kind: "on",
      hasProfile: false,
      recording: { state: "on", count: 3, here: true },
    });
    expect(recordCalls).toContainEqual({ type: "record-state", tabId: 3 });
  });

  it("is unsupported without an https origin, and never asks the service worker", async () => {
    expect(viewOf({ tabId: 3, origin: null }, { origin: null }, OFF)).toEqual({
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

describe("recordSite", () => {
  const target = { tabId: 3, origin: A };
  const grantOnRequest = () =>
    shims.permissions.request.mockImplementation(async (p) => {
      for (const o of p.origins ?? []) shims.grants.add(o);
      return true;
    });

  // ADR 0018: the same user-activation rule as enableSite.
  it("calls permissions.request in the caller's synchronous turn, before any await", async () => {
    shims.permissions.request.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return true;
    });
    const p = recordSite(target);
    expect(shims.permissions.request).toHaveBeenCalledOnce();
    expect(shims.permissions.request).toHaveBeenCalledWith({ origins: [PA] });
    await p;
  });

  it("asks for the record intent and starts the session: outcome recording, fresh view", async () => {
    grantOnRequest();
    recordState = { state: "on", origin: A, count: 0, here: true };
    const res = await recordSite(target);
    expect(res.outcome).toBe("recording");
    expect(recordCalls).toContainEqual({
      type: "record-start",
      tabId: 3,
      origin: A,
    });
    expect(res.view).toMatchObject({
      recording: { state: "on", count: 0, here: true },
    });
  });

  it("denied: no session is started", async () => {
    shims.permissions.request.mockResolvedValue(false);
    const res = await recordSite(target);
    expect(res.outcome).toBe("denied");
    expect(recordCalls.map((c) => c.type)).not.toContain("record-start");
  });

  it.each([
    ["locked", "locked"],
    ["tab-moved", "tab-moved"],
    ["not-granted", "granted-pending"],
  ] as const)(
    "a refused start (%s) is the %s outcome",
    async (error, outcome) => {
      grantOnRequest();
      recordStart = { ok: false, error };
      expect((await recordSite(target)).outcome).toBe(outcome);
    },
  );

  it("the Svelte click handler calls recordSite as its first statement, before any await", () => {
    const src = readFileSync("src/entrypoints/popup/App.svelte", "utf8");
    const from = src.indexOf("function record(");
    expect(from, "record() handler not found").toBeGreaterThan(-1);
    const body = src.slice(from, src.indexOf("async function settleRecord"));
    const statements = body
      .split("{")[1]!
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("//"));
    expect(statements[0]).toBe("const flow = recordSite(s);");
    expect(body).not.toMatch(/\bawait\b/);
  });
});

describe("finishRecordingFor / cancelRecordingFor", () => {
  const target = { tabId: 3, origin: A };

  it("finish sends record-finish for the tab and reports the answer", async () => {
    expect(await finishRecordingFor(target)).toBe(true);
    expect(recordCalls).toEqual([{ type: "record-finish", tabId: 3 }]);
  });

  it("finish is false when the worker cannot be reached", async () => {
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockRejectedValue(
      new Error("x"),
    );
    expect(await finishRecordingFor(target)).toBe(false);
  });

  it("cancel sends record-cancel and returns the fresh view", async () => {
    recordState = OFF;
    const res = await cancelRecordingFor(target);
    expect(res.ok).toBe(true);
    expect(recordCalls[0]).toEqual({ type: "record-cancel", tabId: 3 });
    expect(res.view).toMatchObject({ recording: { state: "off" } });
  });

  it("cancel reports failure but still returns a view", async () => {
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockRejectedValueOnce(
      new Error("x"),
    );
    const res = await cancelRecordingFor(target);
    expect(res.ok).toBe(false);
    expect(res.view.kind).not.toBe("error");
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

describe("recordingLine (M5)", () => {
  it("says the recording is full, as the pill does", () => {
    expect(recordingLine({ state: "full", count: 200 })).toBe(
      "Recording is full · 200 fields",
    );
    expect(recordingLine({ state: "full", count: 1 })).toBe(
      "Recording is full · 1 field",
    );
  });

  it("says Recording while on, and finished while in review", () => {
    expect(recordingLine({ state: "on", count: 0 })).toBe(
      "Recording · 0 fields",
    );
    expect(recordingLine({ state: "on", count: 1 })).toBe(
      "Recording · 1 field",
    );
    expect(recordingLine({ state: "review", count: 3 })).toBe(
      "Recording finished · 3 fields",
    );
  });

  it("is what the popup shows for a recording on this tab", () => {
    const src = readFileSync("src/entrypoints/popup/App.svelte", "utf8");
    expect(src.match(/\{recordingLine\(rec\)\}/g)).toHaveLength(2);
    expect(src).not.toMatch(/Recording · \{/);
  });
});
