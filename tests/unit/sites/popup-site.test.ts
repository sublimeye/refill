import { readFileSync } from "node:fs";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSite } from "../../../src/lib/sites";
import { createSiteHandlers } from "../../../src/lib/sites/handlers";
import type {
  RecordPageState,
  SavedSummary,
} from "../../../src/lib/messaging/protocol";
import {
  cancelRecordingFor,
  enableSite,
  fillNowFor,
  finishRecordingFor,
  loadSiteView,
  recordSite,
  recordingLine,
  removeSiteFor,
  resolveTarget,
  savedLine,
  sequencedSite,
  viewOf,
  viewSavedFor,
  type SiteView,
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
// The saved form's summary needs a sealed profile; the popup only needs the worker's answer.
let summary: SavedSummary | Error;
let summaryCalls: unknown[];
// The worker's answer to Fill now, and what it was asked.
let fillNowReply: { ok: true } | { ok: false; error: string } | Error;
let fillNowCalls: unknown[];

beforeEach(() => {
  fakeBrowser.reset();
  shims = installShims();
  recordState = OFF;
  recordCalls = [];
  recordStart = { ok: true };
  summary = { state: "none" };
  summaryCalls = [];
  fillNowReply = { ok: true };
  fillNowCalls = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  const handlers = createSiteHandlers(() => 1_000_000);
  vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(((msg: {
    type: string;
    tabId?: number;
    origin?: string;
  }) => {
    if (msg.type === "saved-summary") {
      summaryCalls.push(msg);
      return summary instanceof Error
        ? Promise.reject(summary)
        : Promise.resolve(summary);
    }
    if (msg.type === "fill-now") {
      fillNowCalls.push(msg);
      return fillNowReply instanceof Error
        ? Promise.reject(fillNowReply)
        : Promise.resolve(fillNowReply);
    }
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

  it("an enabled site with a saved form: the popup learns its id and field count (ADR 0035)", async () => {
    shims.grant(PA);
    await enableSite(target);
    // No saved form: the summary is not asked for.
    expect(await loadSiteView(target)).toMatchObject({ saved: null });
    expect(summaryCalls).toEqual([]);
    await upsertSite(A, { profileId: "p1" });
    summary = { state: "saved", profileId: "p1", count: 2, fillMode: "auto" };
    const view = await loadSiteView(target);
    expect(view).toMatchObject({
      kind: "on",
      hasProfile: true,
      saved: { profileId: "p1", count: 2, fillMode: "auto" },
    });
    expect(summaryCalls).toEqual([{ type: "saved-summary", origin: A }]);
    // Locked (or gone meanwhile): no line.
    summary = { state: "none" };
    expect(await loadSiteView(target)).toMatchObject({ saved: null });
    // A failed summary costs the line, not the site section.
    summary = new Error("x");
    expect(await loadSiteView(target)).toMatchObject({
      kind: "on",
      saved: null,
    });
  });

  it("viewOf keeps the summary only for a site that is on", () => {
    const saved: SavedSummary = {
      state: "saved",
      profileId: "p1",
      count: 3,
      fillMode: "gesture",
    };
    const on = status({ enabled: true, granted: true, hasProfile: true });
    expect(viewOf(target, on, OFF, saved)).toMatchObject({
      saved: { profileId: "p1", count: 3, fillMode: "gesture" },
    });
    expect(viewOf(target, on, OFF)).toMatchObject({ saved: null });
    expect(
      viewOf(target, status({ enabled: true, hasProfile: true }), OFF, saved),
    ).toMatchObject({ kind: "revoked", saved: null });
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

describe("savedLine and View (ADR 0035)", () => {
  it("counts fields with the same plural rule as the recording line", () => {
    expect(savedLine(1)).toBe("Saved form · 1 field");
    expect(savedLine(2)).toBe("Saved form · 2 fields");
    expect(savedLine(0)).toBe("Saved form · 0 fields");
  });

  const saved = { profileId: "p1", count: 2, fillMode: "auto" } as const;

  it("View opens the review page in saved mode for that profile id", async () => {
    const create = vi
      .spyOn(fakeBrowser.tabs, "create")
      .mockResolvedValue({} as never);
    expect(await viewSavedFor(saved)).toBe(true);
    expect(create).toHaveBeenCalledWith({
      url: "chrome-extension://test-extension-id/review.html?saved=p1",
    });
    create.mockRejectedValue(new Error("x"));
    expect(await viewSavedFor(saved)).toBe(false);
  });

  it("the popup shows the line and View only while unlocked, through savedLine", () => {
    const src = readFileSync("src/entrypoints/popup/App.svelte", "utf8");
    expect(src).toMatch(/\{savedLine\(s\.saved\.count\)\}/);
    expect(src).toMatch(/view === "unlocked" && s\.saved/);
  });
});

describe("fillNowFor (ADR 0038)", () => {
  const target = { tabId: 3, origin: A };

  it("asks the worker to fill the tab, with exactly the tab and origin", async () => {
    expect(await fillNowFor(target)).toBe("ok");
    expect(fillNowCalls).toEqual([{ type: "fill-now", tabId: 3, origin: A }]);
  });

  it("maps locked and tab-moved, and every other refusal to error", async () => {
    fillNowReply = { ok: false, error: "locked" };
    expect(await fillNowFor(target)).toBe("locked");
    fillNowReply = { ok: false, error: "tab-moved" };
    expect(await fillNowFor(target)).toBe("tab-moved");
    for (const error of ["invalid-origin", "not-granted", "no-profile"]) {
      fillNowReply = { ok: false, error };
      expect(await fillNowFor(target)).toBe("error");
    }
  });

  it("never throws: an unreachable worker is error", async () => {
    fillNowReply = new Error("x");
    expect(await fillNowFor(target)).toBe("error");
    vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue(undefined);
    expect(await fillNowFor(target)).toBe("error");
  });

  it("the popup shows Fill now only for a gesture form while nothing records", () => {
    const src = readFileSync("src/entrypoints/popup/App.svelte", "utf8");
    expect(src).toMatch(
      /\{#if s\.saved\.fillMode === "gesture" && rec\.state === "off"\}/,
    );
    // Inside the block that needs an unlocked vault and a saved form.
    expect(src.indexOf('view === "unlocked" && s.saved')).toBeLessThan(
      src.indexOf('s.saved.fillMode === "gesture"'),
    );
  });
});

describe("sequencedSite", () => {
  const view = (host: string): SiteView =>
    ({ kind: "unsupported", host }) as never;
  const setup = () => {
    let shown: SiteView | null = null;
    const seq = sequencedSite((v) => (shown = v));
    return { seq, shown: () => shown };
  };
  const gate = () => {
    let release!: (v: SiteView) => void;
    const p = new Promise<SiteView>((r) => (release = r));
    return { p, release };
  };

  it("a load that resolves after a newer assignment does not overwrite it", async () => {
    const { seq, shown } = setup();
    const slow = gate();
    const pending = seq.load(() => slow.p);
    seq.set(view("newer"));
    slow.release(view("late"));
    await pending;
    expect(shown()).toEqual(view("newer"));
  });

  it("of two loads, the later one wins whichever resolves last", async () => {
    const { seq, shown } = setup();
    const first = gate();
    const second = gate();
    const p1 = seq.load(() => first.p);
    const p2 = seq.load(() => second.p);
    second.release(view("second"));
    await p2;
    first.release(view("first"));
    await p1;
    expect(shown()).toEqual(view("second"));
  });

  it("a load with nothing after it assigns", async () => {
    const { seq, shown } = setup();
    await seq.load(async () => view("only"));
    expect(shown()).toEqual(view("only"));
  });

  it("the popup assigns site only through the sequence", () => {
    const src = readFileSync("src/entrypoints/popup/App.svelte", "utf8");
    const direct = src.match(/(?<!let )\bsite = /g) ?? [];
    expect(direct).toHaveLength(1); // the sequence's own apply
    expect(src).toMatch(/sequencedSite\(\(v\) => \(site = v\)\)/);
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
