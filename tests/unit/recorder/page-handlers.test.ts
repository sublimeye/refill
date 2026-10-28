// The page side of recording in the worker: record-start, record-state, record-finish and
// record-cancel, the record intent on a permission grant, and the recording scan path's writes
// (spec §3.1, §6.2, §7; ADR 0031).
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { newKdfParams } from "../../../src/lib/crypto/kdf";
import { createContentHandlers } from "../../../src/lib/messaging/content-handlers";
import { createPageHandlers } from "../../../src/lib/messaging/page-handlers";
import { parsePageRequest } from "../../../src/lib/messaging/protocol";
import type {
  PageRequest,
  RecordPageState,
} from "../../../src/lib/messaging/protocol";
import { createRouter } from "../../../src/lib/messaging/router";
import { saveProfile } from "../../../src/lib/profiles/store";
import {
  createRecorderPageHandlers,
  finishSession,
} from "../../../src/lib/recorder/handlers";
import {
  FLUSH_TIMEOUT_MS,
  RECORDING_TTL_MS,
  installRecorderListeners,
  cancelUnfinished,
  startSession,
  withSession,
} from "../../../src/lib/recorder/session";
import * as startModule from "../../../src/lib/recorder/start";
import { readSites } from "../../../src/lib/sites";
import { takeIntent, writeIntent } from "../../../src/lib/sites/intent";
import {
  CONTENT_SCRIPT_FILE,
  CONTENT_SCRIPT_ID,
  installSiteListeners,
} from "../../../src/lib/sites/reconcile";
import {
  __resetForTests,
  createVault,
  lock,
  unlockWithPassphrase,
} from "../../../src/lib/vault/vault";
import { installShims } from "../helpers/browser-shims";
import { ORIGIN, ctrl, page, savedProfile } from "./helpers";

const P = "correct horse battery staple";
const TAB = 7;
const T0 = 1_700_000_000_000;
const PATTERN = ORIGIN + "/*";
const OTHER = "https://other.example";
const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";

let snapshot: Record<string, unknown>;
let shims: ReturnType<typeof installShims>;
let clock: number;
const now = () => clock;
let sendMessage: ReturnType<typeof vi.fn>;
let create: ReturnType<typeof vi.fn>;
const h = () => createRecorderPageHandlers(now);

beforeAll(async () => {
  fakeBrowser.reset();
  await createVault(P, newKdfParams());
  snapshot = structuredClone(await fakeBrowser.storage.local.get(null));
}, 30_000);

beforeEach(async () => {
  fakeBrowser.reset();
  __resetForTests();
  await fakeBrowser.storage.local.set(structuredClone(snapshot));
  expect((await unlockWithPassphrase(P)).ok).toBe(true);
  clock = T0;
  shims = installShims();
  vi.spyOn(console, "error").mockImplementation(() => {});
  sendMessage = vi.fn(async () => undefined);
  (fakeBrowser.tabs as unknown as { sendMessage: unknown }).sendMessage =
    sendMessage;
  create = vi.fn(async () => ({}));
  (fakeBrowser.tabs as unknown as { create: unknown }).create = create;
  installRecorderListeners();
});

afterEach(() => vi.restoreAllMocks());

const start = (tabId = TAB, origin = ORIGIN) =>
  h()["record-start"]({ type: "record-start", tabId, origin });
const state = (tabId = TAB) =>
  h()["record-state"]({
    type: "record-state",
    tabId,
  }) as Promise<RecordPageState>;
const finish = (tabId = TAB) =>
  h()["record-finish"]({ type: "record-finish", tabId });
const cancel = (tabId = TAB) =>
  h()["record-cancel"]({ type: "record-cancel", tabId });

/** The session as stored, whichever it is. */
const peek = () =>
  withSession({ any: true }, clock, (meta, body) => ({
    result: { meta, body },
  }));

function ready(tabUrl = ORIGIN + "/billpay/one") {
  shims.grant(PATTERN);
  shims.setTab(TAB, tabUrl);
}

describe("record-start", () => {
  it("refuses while the vault is locked, and changes nothing", async () => {
    ready();
    await lock();
    expect(await start()).toEqual({ ok: false, error: "locked" });
    expect(await readSites()).toEqual({});
    expect(await peek()).toBe("off");
    expect(shims.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("checks the vault before the permission", async () => {
    shims.setTab(TAB, ORIGIN + "/");
    await lock();
    expect(await start()).toEqual({ ok: false, error: "locked" });
  });

  it("refuses without the host permission, and changes nothing", async () => {
    shims.setTab(TAB, ORIGIN + "/");
    expect(await start()).toEqual({ ok: false, error: "not-granted" });
    expect(await readSites()).toEqual({});
    expect(await peek()).toBe("off");
  });

  it("refuses a tab that navigated to another origin: no session, no site, no injection", async () => {
    ready(OTHER + "/");
    expect(await start()).toEqual({ ok: false, error: "tab-moved" });
    expect(await readSites()).toEqual({});
    expect(await peek()).toBe("off");
    expect(shims.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("refuses a closed tab", async () => {
    shims.grant(PATTERN);
    expect(await start()).toEqual({ ok: false, error: "tab-moved" });
    expect(await peek()).toBe("off");
  });

  it("refuses an origin that is not canonical https", async () => {
    ready();
    for (const origin of [
      ORIGIN + "/path",
      "http://pay.example.com",
      "https://*",
    ]) {
      expect(await start(TAB, origin)).toEqual({
        ok: false,
        error: "invalid-origin",
      });
    }
    expect(await peek()).toBe("off");
  });

  it("starts an empty session, enables the site, registers, injects, then nudges", async () => {
    ready();
    const order: string[] = [];
    shims.scripting.executeScript.mockImplementation(async () => {
      order.push("inject");
      return [];
    });
    sendMessage.mockImplementation(async () => void order.push("nudge"));
    expect(await start()).toEqual({ ok: true });

    const got = await peek();
    if (got === "off") throw new Error("no session");
    expect(got.meta).toMatchObject({
      tabId: TAB,
      origin: ORIGIN,
      startedAt: T0,
      expiresAt: T0 + RECORDING_TTL_MS,
      finished: false,
      seededFrom: null,
    });
    expect(got.body.fields).toEqual([]);
    expect(Object.keys(await readSites())).toEqual([ORIGIN]);
    expect(shims.scripts.get(CONTENT_SCRIPT_ID)!.matches).toEqual([PATTERN]);
    expect(shims.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: TAB },
      files: [CONTENT_SCRIPT_FILE],
    });
    expect(sendMessage).toHaveBeenCalledWith(
      TAB,
      { type: "refill-nudge" },
      { frameId: 0 },
    );
    expect(order).toEqual(["inject", "nudge"]);
    expect(await fakeBrowser.action.getBadgeText({ tabId: TAB })).toBe("●");
  });

  it("clears an access-revoked flag", async () => {
    ready();
    const { upsertSite } = await import("../../../src/lib/sites");
    await upsertSite(ORIGIN, { accessRevoked: true });
    expect(await start()).toEqual({ ok: true });
    expect((await readSites())[ORIGIN]!.accessRevoked).toBe(false);
  });

  it("Record again: the session is seeded from the stored profile", async () => {
    ready();
    await saveProfile(savedProfile());
    expect(await start()).toEqual({ ok: true });
    const got = await peek();
    if (got === "off") throw new Error("no session");
    expect(got.meta.seededFrom).toBe("p1");
    expect(got.body.fields.map((f) => [f.id, f.value])).toEqual([
      ["f1", "12345"],
      ["f4", "45.12"],
    ]);
    expect(got.body.steps).toHaveLength(2);
  });

  it("another origin's profile is never used as a seed", async () => {
    await saveProfile(savedProfile({ origin: OTHER }));
    ready();
    expect(await start()).toEqual({ ok: true });
    const got = await peek();
    if (got === "off") throw new Error("no session");
    expect(got.meta.seededFrom).toBeNull();
    expect(got.body.fields).toEqual([]);
  });

  it("consumes the pending intent for the origin", async () => {
    ready();
    await writeIntent({ tabId: TAB, origin: ORIGIN, kind: "record", ts: T0 });
    await start();
    expect(await takeIntent(ORIGIN, T0)).toBeNull();
  });

  it("keeps the intent when it refused (the grant path may still need it)", async () => {
    ready();
    await lock();
    await writeIntent({ tabId: TAB, origin: ORIGIN, kind: "record", ts: T0 });
    await start();
    expect(await takeIntent(ORIGIN, T0)).not.toBeNull();
  });

  it("replaces a session on another tab", async () => {
    ready();
    await startSession(99, OTHER, T0, null);
    await start();
    const got = await peek();
    if (got === "off") throw new Error("no session");
    expect(got.meta.tabId).toBe(TAB);
  });

  it("an ungranted tab that also navigated is not-granted (permission before tab)", async () => {
    shims.setTab(TAB, OTHER + "/");
    expect(await start()).toEqual({ ok: false, error: "not-granted" });
  });

  it("a lock after the checks answers locked, but the enabled site still gets its script", async () => {
    ready();
    vi.spyOn(startModule, "beginRecording").mockResolvedValue(false);
    expect(await start()).toEqual({ ok: false, error: "locked" });
    expect(Object.keys(await readSites())).toEqual([ORIGIN]);
    expect(shims.scripting.executeScript).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled(); // no session to ask about
    expect(await peek()).toBe("off");
  });

  it("a second start on the same tab and origin keeps the first session", async () => {
    ready();
    await start();
    const first = await peek();
    if (first === "off") throw new Error("no session");
    expect(await start()).toEqual({ ok: true });
    const second = await peek();
    if (second === "off") throw new Error("no session");
    expect(second.meta.id).toBe(first.meta.id);
    expect(second.meta.startedAt).toBe(first.meta.startedAt);
    // Still injects and nudges.
    expect(shims.scripting.executeScript).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("a finished or expired session of the same tab is replaced", async () => {
    ready();
    await start();
    await finish();
    const done = await peek();
    if (done === "off") throw new Error("no session");
    await start();
    const next = await peek();
    if (next === "off") throw new Error("no session");
    expect(next.meta.id).not.toBe(done.meta.id);
    expect(next.meta.finished).toBe(false);
  });

  it("a session of the same tab on another origin is replaced", async () => {
    ready();
    await startSession(TAB, OTHER, T0, null);
    await start();
    const got = await peek();
    if (got === "off") throw new Error("no session");
    expect(got.meta.origin).toBe(ORIGIN);
  });

  it("an executeScript failure does not fail the start", async () => {
    ready();
    shims.scripting.executeScript.mockRejectedValue(new Error("no tab"));
    expect(await start()).toEqual({ ok: true });
    expect(await peek()).not.toBe("off");
  });
});

describe("record-state", () => {
  it("is off without a session", async () => {
    expect(await state()).toEqual({ state: "off" });
  });

  it("reports the origin, the count and whether the session is this tab's", async () => {
    ready();
    await start();
    const one = page("acct", "zip");
    const w = createContentHandlers(now);
    await w["scan-report"](
      { type: "scan-report", controls: one, truncated: false },
      { origin: ORIGIN, pathname: "/one", tabId: TAB, documentId: "d1" },
    );
    await w["record-capture"](
      {
        type: "record-capture",
        kind: "text",
        sig: one[0]!.sig,
        value: "12345",
        pageDefault: "",
        fieldId: null,
      },
      { origin: ORIGIN, pathname: "/one", tabId: TAB, documentId: "d1" },
    );
    expect(await state(TAB)).toEqual({
      state: "on",
      origin: ORIGIN,
      count: 1,
      here: true,
    });
    expect(await state(TAB + 1)).toEqual({
      state: "on",
      origin: ORIGIN,
      count: 1,
      here: false,
    });
  });

  it("is off once the session expired", async () => {
    ready();
    await start();
    clock = T0 + RECORDING_TTL_MS;
    expect(await state()).toEqual({ state: "off" });
  });

  it("is off after a lock", async () => {
    ready();
    await start();
    await lock();
    await vi.waitFor(async () =>
      expect(await state()).toEqual({ state: "off" }),
    );
  });

  it("reports a finished session as review", async () => {
    ready();
    await start();
    await finish();
    expect(await state()).toEqual({
      state: "review",
      origin: ORIGIN,
      count: 0,
      here: true,
    });
    expect(await state(TAB + 1)).toMatchObject({
      state: "review",
      here: false,
    });
  });
});

describe("record-finish", () => {
  it("is false without a session or for another tab, and opens nothing", async () => {
    expect(await finish()).toEqual({ ok: false });
    ready();
    await start();
    expect(await finish(TAB + 1)).toEqual({ ok: false });
    expect(create).not.toHaveBeenCalled();
    expect((await state()).state).toBe("on");
  });

  it("finishes: resets the TTL, clears the badge and opens the review page", async () => {
    ready();
    await start();
    clock = T0 + 60_000;
    expect(await finish()).toEqual({ ok: true });
    const got = await peek();
    if (got === "off") throw new Error("no session");
    expect(got.meta).toMatchObject({
      finished: true,
      expiresAt: clock + RECORDING_TTL_MS,
    });
    expect(await fakeBrowser.action.getBadgeText({ tabId: TAB })).toBe("");
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0].url).toMatch(
      new RegExp(`/review\\.html\\?session=${got.meta.id}$`),
    );
  });

  it("on an already finished session it opens the review page again (idempotent)", async () => {
    ready();
    await start();
    await finish();
    clock = T0 + 120_000;
    expect(await finish()).toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0]).toEqual(create.mock.calls[0]![0]);
    const got = await peek();
    if (got === "off") throw new Error("no session");
    expect(got.meta.expiresAt).toBe(clock + RECORDING_TTL_MS);
  });

  it("asks the tab to flush its pending captures and finishes only after the ack", async () => {
    ready();
    await start();
    sendMessage.mockClear();
    const seen: unknown[] = [];
    sendMessage.mockImplementation(
      async (_tab: number, msg: { type: string }) => {
        if (msg.type !== "refill-flush") return undefined;
        // A capture still on its way lands now: the session must not be finished yet.
        const got = await peek();
        seen.push(got === "off" ? "off" : got.meta.finished);
        return { ok: true };
      },
    );
    expect(await finish()).toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledWith(
      TAB,
      { type: "refill-flush" },
      { frameId: 0 },
    );
    expect(seen).toEqual([false]);
    expect((await state()).state).toBe("review");
    expect(create).toHaveBeenCalledOnce();
  });

  it("a flush that never answers delays the finish by at most FLUSH_TIMEOUT_MS", async () => {
    ready();
    await start();
    sendMessage.mockImplementation((_tab: number, msg: { type: string }) =>
      msg.type === "refill-flush"
        ? new Promise(() => undefined)
        : Promise.resolve(undefined),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const done = finish();
      await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS - 1);
      expect(create).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await done).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
    expect(create).toHaveBeenCalledOnce();
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      "[refill] flush failed:",
      "timeout",
    );
  });

  it("no content script to flush: still finishes, logging the error name only", async () => {
    ready();
    await start();
    sendMessage.mockImplementation((_tab: number, msg: { type: string }) =>
      msg.type === "refill-flush"
        ? Promise.reject(new TypeError("Could not establish connection"))
        : Promise.resolve(undefined),
    );
    expect(await finish()).toEqual({ ok: true });
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      "[refill] flush failed:",
      "TypeError",
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "connection",
    );
  });

  it("reopening a finished session sends no flush", async () => {
    ready();
    await start();
    await finish();
    sendMessage.mockClear();
    expect(await finish()).toEqual({ ok: true });
    expect(sendMessage).not.toHaveBeenCalledWith(
      TAB,
      { type: "refill-flush" },
      { frameId: 0 },
    );
  });

  it("a failing tabs.create is an internal error, and the session stays finished", async () => {
    ready();
    await start();
    create.mockRejectedValueOnce(new Error("no window"));
    await expect(finish()).rejects.toThrow();
    expect((await state()).state).toBe("review");
    expect(await finish()).toEqual({ ok: true });
  });
});

describe("record-cancel", () => {
  it("discards the tab's session as cancelled: badge cleared, tab nudged, no tombstone", async () => {
    ready();
    await start();
    sendMessage.mockClear();
    expect(await cancel()).toEqual({ ok: true });
    expect(await peek()).toBe("off");
    expect(await fakeBrowser.action.getBadgeText({ tabId: TAB })).toBe("");
    expect(sendMessage).toHaveBeenCalledWith(
      TAB,
      { type: "refill-nudge" },
      { frameId: 0 },
    );
    expect(
      (await fakeBrowser.storage.session.get("recorder:stopped"))[
        "recorder:stopped"
      ],
    ).toBeUndefined();
  });

  it("does not discard a session that was finished before the cancel ran (one job)", async () => {
    ready();
    await start();
    // A finish lands first; the guarded discard sees a finished session and leaves it.
    await finish();
    await cancelUnfinished({ tab: TAB });
    expect((await state()).state).toBe("review");
  });

  it("a cancel and a finish racing in the chain: whichever runs second respects the first", async () => {
    ready();
    await start();
    const [a, b] = await Promise.all([
      finishSession({ tab: TAB }, clock, true),
      cancel(),
    ]);
    expect(a).toBe(true);
    expect(b).toEqual({ ok: true });
    // Finish queued first: the cancel found it finished and left it.
    expect((await state()).state).toBe("review");
  });

  it("a cancel that lands while a popup Finish waits for the tab's flush wins: nothing opens", async () => {
    ready();
    await start();
    const [a, b] = await Promise.all([finish(), cancel()]);
    expect(a).toEqual({ ok: false });
    expect(b).toEqual({ ok: true });
    expect(create).not.toHaveBeenCalled();
    expect(await peek()).toBe("off");
  });

  it("is ok with nothing to cancel", async () => {
    expect(await cancel()).toEqual({ ok: true });
  });

  it("leaves another tab's session alone", async () => {
    ready();
    await start();
    expect(await cancel(TAB + 1)).toEqual({ ok: true });
    expect((await state()).state).toBe("on");
  });

  it("leaves a finished session to its review page", async () => {
    ready();
    await start();
    await finish();
    expect(await cancel()).toEqual({ ok: true });
    expect((await state()).state).toBe("review");
  });
});

describe("page protocol", () => {
  const sender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html` };
  const contentSender = {
    id: EXT_ID,
    url: ORIGIN + "/form",
    origin: ORIGIN,
    frameId: 0,
    tab: { id: TAB, url: ORIGIN + "/form" },
  };
  const router = () => {
    (fakeBrowser.runtime as { id: string }).id = EXT_ID;
    return createRouter({
      page: createPageHandlers(async () => newKdfParams()),
      content: createContentHandlers(now),
    });
  };
  const REJECTED = { ok: false, error: "rejected" };

  it("record-start from a content script is rejected and starts nothing", async () => {
    ready();
    await upsertGrantedSite();
    for (const msg of [
      { type: "record-start", tabId: TAB, origin: ORIGIN },
      { type: "record-state", tabId: TAB },
      { type: "record-finish", tabId: TAB },
      { type: "record-cancel", tabId: TAB },
    ]) {
      expect(await router()(msg, contentSender as never)).toEqual(REJECTED);
    }
    expect(await peek()).toBe("off");
  });

  it("record-start from an extension page runs", async () => {
    ready();
    expect(
      await router()(
        { type: "record-start", tabId: TAB, origin: ORIGIN },
        sender as never,
      ),
    ).toEqual({ ok: true });
    expect(await peek()).not.toBe("off");
  });

  it("parses exact keys only", () => {
    const ok: PageRequest[] = [
      { type: "record-start", tabId: 1, origin: ORIGIN },
      { type: "record-state", tabId: 1 },
      { type: "record-finish", tabId: 1 },
      { type: "record-cancel", tabId: 1 },
      { type: "site-intent", tabId: 1, origin: ORIGIN, kind: "record" },
      { type: "site-intent", tabId: 1, origin: ORIGIN, kind: "enable" },
    ];
    for (const r of ok) expect(parsePageRequest({ ...r })).toEqual(r);
    const bad: unknown[] = [
      { type: "record-start", tabId: 1 },
      { type: "record-start", tabId: -1, origin: ORIGIN },
      { type: "record-start", tabId: 1.5, origin: ORIGIN },
      { type: "record-start", tabId: "1", origin: ORIGIN },
      { type: "record-state", tabId: 1, origin: ORIGIN },
      { type: "record-finish" },
      { type: "record-cancel", tabId: 1, extra: 1 },
      { type: "site-intent", tabId: 1, origin: ORIGIN },
      { type: "site-intent", tabId: 1, origin: ORIGIN, kind: "other" },
      { type: "site-intent", tabId: 1, origin: ORIGIN, kind: "record", x: 1 },
    ];
    for (const b of bad) expect(parsePageRequest(b)).toBeNull();
  });
});

async function upsertGrantedSite(): Promise<void> {
  const { upsertSite } = await import("../../../src/lib/sites");
  await upsertSite(ORIGIN, {});
}

describe("a record intent on a permission grant", () => {
  const grant = async () => {
    installSiteListeners();
    shims.accept(PATTERN);
    await vi.waitFor(() => expect(shims.scripts.size).toBe(1));
    await vi.waitFor(() =>
      expect(shims.scripting.getRegisteredContentScripts).toHaveBeenCalled(),
    );
    // The handler ends with the final reconcile; give the chain time to settle.
    await new Promise((r) => setTimeout(r, 50));
  };

  it("unlocked: enables the site and starts a session, seeded from the saved form", async () => {
    shims.setTab(TAB, ORIGIN + "/billpay/one");
    await saveProfile(savedProfile());
    await writeIntent({
      tabId: TAB,
      origin: ORIGIN,
      kind: "record",
      ts: Date.now(),
    });
    await grant();
    const got = await withSession({ any: true }, Date.now(), (meta, body) => ({
      result: { meta, body },
    }));
    if (got === "off") throw new Error("no session");
    expect(got.meta).toMatchObject({
      tabId: TAB,
      origin: ORIGIN,
      seededFrom: "p1",
    });
    expect(got.body.fields).toHaveLength(2);
    expect(shims.scripting.executeScript).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      TAB,
      { type: "refill-nudge" },
      { frameId: 0 },
    );
  });

  it("locked: only enables the site", async () => {
    shims.setTab(TAB, ORIGIN + "/");
    await lock();
    await writeIntent({
      tabId: TAB,
      origin: ORIGIN,
      kind: "record",
      ts: Date.now(),
    });
    await grant();
    expect(Object.keys(await readSites())).toEqual([ORIGIN]);
    expect(await peek()).toBe("off");
    expect(shims.scripting.executeScript).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("a tab that moved to another origin: only enables the site", async () => {
    shims.setTab(TAB, OTHER + "/");
    await writeIntent({
      tabId: TAB,
      origin: ORIGIN,
      kind: "record",
      ts: Date.now(),
    });
    await grant();
    expect(Object.keys(await readSites())).toEqual([ORIGIN]);
    expect(await peek()).toBe("off");
  });

  it("a failing recording start does not stop the enable work", async () => {
    shims.setTab(TAB, ORIGIN + "/");
    vi.spyOn(startModule, "beginRecording").mockRejectedValue(
      new TypeError("boom https://secret.example/"),
    );
    await writeIntent({
      tabId: TAB,
      origin: ORIGIN,
      kind: "record",
      ts: Date.now(),
    });
    await grant();
    expect(Object.keys(await readSites())).toEqual([ORIGIN]);
    expect(shims.scripts.size).toBe(1);
    expect(shims.scripting.executeScript).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain("secret.example");
  });

  it("grant, then the page is filed, then the popup's record-start: the step and captures survive", async () => {
    shims.setTab(TAB, ORIGIN + "/billpay/one");
    await writeIntent({
      tabId: TAB,
      origin: ORIGIN,
      kind: "record",
      ts: Date.now(),
    });
    await grant();
    const w = createContentHandlers();
    const one = page("acct", "zip");
    const c = {
      origin: ORIGIN,
      pathname: "/billpay/one",
      tabId: TAB,
      documentId: "d1",
    };
    await w["scan-report"](
      { type: "scan-report", controls: one, truncated: false },
      c,
    );
    await w["record-capture"](
      {
        type: "record-capture",
        kind: "text",
        sig: one[0]!.sig,
        value: "12345",
        pageDefault: "",
        fieldId: null,
      },
      c,
    );
    // The popup was alive: its record-start arrives after the grant path started the session.
    expect(await start()).toEqual({ ok: true });
    const got = await withSession({ any: true }, Date.now(), (meta, body) => ({
      result: { meta, body },
    }));
    if (got === "off") throw new Error("no session");
    expect(got.body.current).toBe(0);
    expect(got.body.fields.map((f) => f.value)).toEqual(["12345"]);
    // A capture after the second start still lands in the step.
    expect(
      await w["record-capture"](
        {
          type: "record-capture",
          kind: "text",
          sig: one[1]!.sig,
          value: "90210",
          pageDefault: "",
          fieldId: null,
        },
        c,
      ),
    ).toEqual({ state: "on", count: 2 });
  });

  it("an enable intent never starts a session", async () => {
    shims.setTab(TAB, ORIGIN + "/");
    await writeIntent({
      tabId: TAB,
      origin: ORIGIN,
      kind: "enable",
      ts: Date.now(),
    });
    await grant();
    expect(await peek()).toBe("off");
    expect(shims.scripting.executeScript).toHaveBeenCalledOnce();
  });
});

describe("the recording scan writes only when the body changed", () => {
  const ctx = (documentId: string) => ({
    origin: ORIGIN,
    pathname: "/one",
    tabId: TAB,
    documentId,
  });
  const scan = (controls: ReturnType<typeof page>) => ({
    type: "scan-report" as const,
    controls,
    truncated: false,
  });
  const writes = () => vi.spyOn(fakeBrowser.storage.session, "set");

  it("a re-scan of the same page in the same document seals and writes nothing", async () => {
    await startSession(TAB, ORIGIN, T0, null);
    const w = createContentHandlers(now);
    const controls = page("acct", "zip");
    await w["scan-report"](scan(controls), ctx("d1"));
    const set = writes();
    await w["scan-report"](scan(controls), ctx("d1"));
    await w["scan-report"](scan(controls), ctx("d1"));
    expect(set).not.toHaveBeenCalled();
  });

  it("a new document, a grown page and a new step do write", async () => {
    await startSession(TAB, ORIGIN, T0, null);
    const w = createContentHandlers(now);
    const controls = page("acct", "zip");
    await w["scan-report"](scan(controls), ctx("d1"));
    const set = writes();
    await w["scan-report"](scan(controls), ctx("d2")); // lastDocument changed
    expect(set).toHaveBeenCalledTimes(1);
    await w["scan-report"](scan([...controls, ctrl(2, "extra")]), ctx("d2"));
    expect(set).toHaveBeenCalledTimes(2); // fingerprint grew
  });

  it("an unchanged page still answers its fill plan from the session", async () => {
    await startSession(TAB, ORIGIN, T0, savedProfile());
    const w = createContentHandlers(now);
    const one = page("acct", "zip");
    const first = await w["scan-report"](scan(one), {
      ...ctx("d1"),
      pathname: "/billpay/one",
    });
    const again = await w["scan-report"](scan(one), {
      ...ctx("d1"),
      pathname: "/billpay/one",
    });
    expect(first).toMatchObject({ state: "fill" });
    expect(again).toEqual(first);
  });
});

describe("the stopped tombstone is per origin", () => {
  it("record-status answers stopped only for the origin that was recording", async () => {
    await startSession(TAB, ORIGIN, T0, null);
    const w = createContentHandlers(now);
    await lock();
    await vi.waitFor(async () =>
      expect(
        (await fakeBrowser.storage.session.get("recorder:stopped"))[
          "recorder:stopped"
        ],
      ).toBeDefined(),
    );
    const here = { origin: ORIGIN, pathname: "/", tabId: TAB, documentId: "d" };
    expect(await w["record-status"]({ type: "record-status" }, here)).toEqual({
      state: "stopped",
      reason: "locked",
    });
    expect(
      await w["record-status"](
        { type: "record-status" },
        { ...here, origin: OTHER },
      ),
    ).toEqual({ state: "off" });
  });
});
