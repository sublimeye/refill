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
import { applyCapture } from "../../../src/lib/recorder/fields";
import {
  RECORDING_TTL_MS,
  clearBadge,
  discardSession,
  installRecorderListeners,
  startSession,
  stoppedReason,
  withSession,
  type SessionMeta,
} from "../../../src/lib/recorder/session";
import { observePage } from "../../../src/lib/recorder/steps";
import type { RecBody } from "../../../src/lib/recorder/types";
import { LockedError } from "../../../src/lib/vault/types";
import {
  __resetForTests,
  createVault,
  lock,
  unlockWithPassphrase,
} from "../../../src/lib/vault/vault";
import { ORIGIN, capture, keys, page, savedProfile } from "./helpers";

const P = "correct horse battery staple";
const TAB = 7;
const T0 = 1_700_000_000_000;
const SECRET = "4111-SECRET-VALUE";
const KEY = "recorder:session";
const TOMB = "recorder:stopped";

let snapshot: Record<string, unknown>;
let sendMessage: ReturnType<typeof vi.fn>;

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
  // fakeBrowser does not implement tabs.sendMessage.
  sendMessage = vi.fn(async () => undefined);
  (fakeBrowser.tabs as unknown as { sendMessage: unknown }).sendMessage =
    sendMessage;
  installRecorderListeners();
});

afterEach(() => vi.restoreAllMocks());

const at = { tabId: TAB, origin: ORIGIN };
const badge = (tabId: number) => fakeBrowser.action.getBadgeText({ tabId });
const sessionStore = () => fakeBrowser.storage.session.get(null);

/** Puts the session on a one-control page and captures `value` there. */
function captureOn(meta: SessionMeta, value: string, now = T0) {
  const controls = page("card");
  return withSession({ id: meta.id }, now, (_m, body) => {
    const onPage = observePage(body, keys(controls), "doc1", "/pay");
    if (onPage === "full") throw new Error("full");
    const r = applyCapture(onPage, capture(controls[0]!, value));
    return { body: r.body, result: r.result };
  });
}

const read = (match: Parameters<typeof withSession>[0], now = T0) =>
  withSession(match, now, (meta, body) => ({ result: { meta, body } }));

describe("recording session", { timeout: 30_000 }, () => {
  it("starts empty, sealed, with plaintext metadata only", async () => {
    const meta = await startSession(TAB, ORIGIN, T0, null);
    expect(meta).toEqual({
      v: 1,
      id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      tabId: TAB,
      origin: ORIGIN,
      startedAt: T0,
      expiresAt: T0 + RECORDING_TTL_MS,
      finished: false,
      seededFrom: null,
    });
    expect(RECORDING_TTL_MS).toBe(1_800_000);
    const got = await read(at);
    expect(got).not.toBe("off");
    expect((got as { body: RecBody }).body).toEqual({
      steps: [],
      current: null,
      lastDocument: null,
      fields: [],
      nextId: 1,
    });
    const stored = (await sessionStore())[KEY] as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["body", "meta"]);
    expect(stored.meta).toEqual(meta);
  });

  it("never stores a captured value in plaintext", async () => {
    const meta = await startSession(TAB, ORIGIN, T0, null);
    expect(await captureOn(meta, SECRET)).toBe("ok");
    const got = (await read(at)) as { body: RecBody };
    expect(got.body.fields.map((f) => f.value)).toEqual([SECRET]);
    const all = JSON.stringify(await sessionStore());
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("SECRET");
  });

  it("re-seals a changed body with a fresh IV and leaves an unchanged one alone", async () => {
    const meta = await startSession(TAB, ORIGIN, T0, null);
    const iv = async () =>
      ((await sessionStore())[KEY] as { body: { iv: string } }).body.iv;
    const first = await iv();
    await read(at);
    expect(await iv()).toBe(first);
    await captureOn(meta, "a");
    const second = await iv();
    expect(second).not.toBe(first);
    await withSession(at, T0, (_m, body) => ({ body, result: null }));
    expect(await iv()).not.toBe(second);
  });

  it("answers off for another tab, origin or id, and when there is no session", async () => {
    expect(await read(at)).toBe("off");
    const meta = await startSession(TAB, ORIGIN, T0, null);
    expect(await read({ tabId: TAB + 1, origin: ORIGIN })).toBe("off");
    expect(await read({ tabId: TAB, origin: "https://other.example" })).toBe(
      "off",
    );
    expect(await read({ id: "someone-else" })).toBe("off");
    expect(await read({ id: meta.id })).not.toBe("off");
    // A mismatch is not a discard.
    expect(await read(at)).not.toBe("off");
  });

  it("answers off for a body moved under another session id", async () => {
    const one = await startSession(TAB, ORIGIN, T0, null);
    await captureOn(one, SECRET);
    const moved = (await sessionStore())[KEY] as { body: unknown };
    const two = await startSession(TAB, ORIGIN, T0, null);
    await fakeBrowser.storage.session.set({
      [KEY]: { meta: two, body: moved.body },
    });
    expect(await read({ id: two.id })).toBe("off");
    expect(await read({ id: one.id })).toBe("off");
    expect(await read(at)).toBe("off");
  });

  it("answers off for a malformed record", async () => {
    const meta = await startSession(TAB, ORIGIN, T0, null);
    const stored = (await sessionStore())[KEY] as {
      meta: SessionMeta;
      body: unknown;
    };
    for (const bad of [
      null,
      "x",
      { meta: { ...stored.meta, tabId: "7" }, body: stored.body },
      { meta: { ...stored.meta, v: 2 }, body: stored.body },
      { meta: stored.meta, body: { iv: "x", ct: "y" } },
      { meta: stored.meta },
    ]) {
      await fakeBrowser.storage.session.set({ [KEY]: bad });
      expect(await read({ id: meta.id })).toBe("off");
    }
  });

  it("applies finished and expiresAt from the callback", async () => {
    const meta = await startSession(TAB, ORIGIN, T0, null);
    await withSession(at, T0 + 1000, () => ({
      meta: { finished: true, expiresAt: T0 + 1000 + RECORDING_TTL_MS },
      result: null,
    }));
    const got = (await read(at, T0 + RECORDING_TTL_MS + 500)) as {
      meta: SessionMeta;
    };
    expect(got.meta).toEqual({
      ...meta,
      finished: true,
      expiresAt: T0 + 1000 + RECORDING_TTL_MS,
    });
  });

  it("expires at 30 min: off, an expired tombstone, badge cleared", async () => {
    await startSession(TAB, ORIGIN, T0, null);
    expect(await read(at, T0 + RECORDING_TTL_MS - 1)).not.toBe("off");
    const end = T0 + RECORDING_TTL_MS;
    expect(await read(at, end)).toBe("off");
    expect((await sessionStore())[KEY]).toBeUndefined();
    expect(await stoppedReason(TAB, end)).toBe("expired");
    expect(await stoppedReason(TAB + 1, end)).toBeNull();
    expect(await badge(TAB)).toBe("");
    expect(sendMessage).toHaveBeenCalledWith(
      TAB,
      { type: "refill-nudge" },
      { frameId: 0 },
    );
  });

  it("expires even when another tab asks", async () => {
    await startSession(TAB, ORIGIN, T0, null);
    const end = T0 + RECORDING_TTL_MS;
    expect(await read({ tabId: 99, origin: ORIGIN }, end)).toBe("off");
    expect((await sessionStore())[KEY]).toBeUndefined();
    expect(await stoppedReason(TAB, end)).toBe("expired");
  });

  it("keeps a tombstone for 30 min", async () => {
    await startSession(TAB, ORIGIN, T0, null);
    const end = T0 + RECORDING_TTL_MS;
    await read(at, end);
    expect(await stoppedReason(TAB, end + 30 * 60_000 - 1)).toBe("expired");
    expect(await stoppedReason(TAB, end + 30 * 60_000)).toBeNull();
  });

  it("discards on lock with a locked tombstone, also a finished session", async () => {
    const meta = await startSession(TAB, ORIGIN, Date.now(), null);
    await withSession(at, Date.now(), () => ({
      meta: { finished: true },
      result: null,
    }));
    await captureOn(meta, SECRET, Date.now());
    await lock();
    await vi.waitFor(async () =>
      expect((await sessionStore())[KEY]).toBeUndefined(),
    );
    expect(await stoppedReason(TAB, Date.now())).toBe("locked");
    expect(await badge(TAB)).toBe("");
    expect(sendMessage).toHaveBeenCalledWith(
      TAB,
      { type: "refill-nudge" },
      { frameId: 0 },
    );
    expect(await read(at, Date.now())).toBe("off");
  });

  it("discards as locked when the body cannot be opened under a locked vault", async () => {
    // The lock event was missed (a worker restart): the record is still there, the DEK is gone.
    const now = Date.now();
    await startSession(TAB, ORIGIN, now, null);
    await fakeBrowser.storage.session.remove("vault:session");
    __resetForTests();
    expect(await read(at, now)).toBe("off");
    expect((await sessionStore())[KEY]).toBeUndefined();
    expect(await stoppedReason(TAB, now)).toBe("locked");
  });

  it("refuses to start while locked", async () => {
    await lock();
    await expect(
      startSession(TAB, ORIGIN, Date.now(), null),
    ).rejects.toBeInstanceOf(LockedError);
    expect((await sessionStore())[KEY]).toBeUndefined();
  });

  it("closing the tab discards an unfinished session", async () => {
    await startSession(TAB, ORIGIN, T0, null);
    await fakeBrowser.tabs.onRemoved.trigger(TAB + 1, {
      windowId: 1,
      isWindowClosing: false,
    });
    expect(await read(at)).not.toBe("off");
    await fakeBrowser.tabs.onRemoved.trigger(TAB, {
      windowId: 1,
      isWindowClosing: false,
    });
    await vi.waitFor(async () =>
      expect((await sessionStore())[KEY]).toBeUndefined(),
    );
    expect(await stoppedReason(TAB, T0)).toBeNull();
  });

  it("closing the tab keeps a finished session (the review page needs it)", async () => {
    const meta = await startSession(TAB, ORIGIN, T0, null);
    await withSession(at, T0, () => ({ meta: { finished: true }, result: 0 }));
    await fakeBrowser.tabs.onRemoved.trigger(TAB, {
      windowId: 1,
      isWindowClosing: false,
    });
    // Let the listener's serialized job run.
    await read({ id: meta.id });
    expect(await read({ id: meta.id })).not.toBe("off");
  });

  it("a second start replaces the first", async () => {
    const one = await startSession(TAB, ORIGIN, T0, null);
    await captureOn(one, "first");
    const two = await startSession(TAB + 1, "https://b.example", T0, null);
    expect(two.id).not.toBe(one.id);
    expect(await read({ id: one.id })).toBe("off");
    expect(await read(at)).toBe("off");
    const got = (await read({ id: two.id })) as { body: RecBody };
    expect(got.body.fields).toEqual([]);
    expect(await badge(TAB)).toBe("");
    expect(await badge(TAB + 1)).toBe("●");
    expect(sendMessage).toHaveBeenCalledWith(
      TAB,
      { type: "refill-nudge" },
      { frameId: 0 },
    );
    expect(await stoppedReason(TAB, T0)).toBeNull();
  });

  it("a seeded start contains the profile's steps and fields", async () => {
    const p = savedProfile();
    const meta = await startSession(TAB, ORIGIN, T0, p);
    expect(meta.seededFrom).toBe(p.id);
    const got = (await read(at)) as { body: RecBody };
    expect(got.body.fields.map((f) => [f.id, f.value, f.policy])).toEqual([
      ["f1", "12345", "save"],
      ["f4", "45.12", "ask"],
    ]);
    expect(got.body.steps).toEqual(p.steps);
    expect(got.body.nextId).toBe(5);
    expect(JSON.stringify(await sessionStore())).not.toContain("45.12");
  });

  it("starting clears a tombstone", async () => {
    await startSession(TAB, ORIGIN, T0, null);
    const end = T0 + RECORDING_TTL_MS;
    await read(at, end);
    expect(await stoppedReason(TAB, end)).toBe("expired");
    await startSession(TAB, ORIGIN, end, null);
    expect(await stoppedReason(TAB, end)).toBeNull();
  });

  it("20 concurrent appends all persist", async () => {
    await startSession(TAB, ORIGIN, T0, null);
    const names = Array.from({ length: 20 }, (_, i) => `field${i}`);
    const controls = page(...names);
    const onPage = await withSession(at, T0, (_m, body) => {
      const b = observePage(body, keys(controls), "doc1", "/pay");
      if (b === "full") throw new Error("full");
      return { body: b, result: "ok" };
    });
    expect(onPage).toBe("ok");
    const results = await Promise.all(
      controls.map((c, i) =>
        withSession(at, T0, (_m, body) => {
          const r = applyCapture(body, capture(c, `v${i}`));
          return { body: r.body, result: r.result };
        }),
      ),
    );
    expect(results).toEqual(Array(20).fill("ok"));
    const got = (await read(at)) as { body: RecBody };
    expect(got.body.fields.map((f) => f.value).sort()).toEqual(
      names.map((_, i) => `v${i}`).sort(),
    );
  });

  it("a throwing callback writes nothing and does not block the next call", async () => {
    await startSession(TAB, ORIGIN, T0, null);
    const before = JSON.stringify(await sessionStore());
    await expect(
      withSession(at, T0, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(JSON.stringify(await sessionStore())).toBe(before);
    expect(await read(at)).not.toBe("off");
  });

  it("sets the badge on start and clears it on discard", async () => {
    await startSession(TAB, ORIGIN, T0, null);
    expect(await badge(TAB)).toBe("●");
    await discardSession("cancelled");
    expect(await badge(TAB)).toBe("");
    expect((await sessionStore())[KEY]).toBeUndefined();
    expect((await sessionStore())[TOMB]).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith(
      TAB,
      { type: "refill-nudge" },
      { frameId: 0 },
    );
  });

  it("only locked and expired leave a tombstone", async () => {
    for (const reason of [
      "cancelled",
      "replaced",
      "saved",
      "tab-closed",
    ] as const) {
      await startSession(TAB, ORIGIN, T0, null);
      await discardSession(reason);
      expect(await stoppedReason(TAB, T0)).toBeNull();
    }
  });

  it("a failed nudge is logged by error name only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sendMessage.mockImplementation(async () => {
      throw new TypeError(`no receiver for ${SECRET}`);
    });
    await startSession(TAB, ORIGIN, T0, null);
    await discardSession("cancelled");
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain(SECRET);
  });

  it.each([
    ["a negative tab id", -1, ORIGIN],
    ["a fractional tab id", 1.5, ORIGIN],
    ["a NaN tab id", NaN, ORIGIN],
    ["a string tab id", "7" as unknown as number, ORIGIN],
    ["an http origin", TAB, "http://pay.example.com"],
    ["a non-canonical origin", TAB, "https://Pay.example.com"],
    ["an origin with a path", TAB, `${ORIGIN}/`],
    ["not a URL", TAB, "nope"],
  ])(
    "start refuses %s with TypeError and changes nothing",
    async (_n, tabId, origin) => {
      await startSession(TAB, ORIGIN, T0, null);
      const before = JSON.stringify(await sessionStore());
      await expect(
        startSession(tabId, origin, T0, null),
      ).rejects.toBeInstanceOf(TypeError);
      expect(JSON.stringify(await sessionStore())).toBe(before);
      expect(await badge(TAB)).toBe("●");
    },
  );

  it("discarding a malformed record removes it without badge or nudge", async () => {
    await fakeBrowser.storage.session.set({ [KEY]: { meta: "x" } });
    await discardSession("cancelled");
    expect((await sessionStore())[KEY]).toBeUndefined();
    expect((await sessionStore())[TOMB]).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("discarding by id leaves a newer session alone", async () => {
    const one = await startSession(TAB, ORIGIN, T0, null);
    const two = await startSession(TAB, ORIGIN, T0, null);
    sendMessage.mockClear();
    await discardSession("cancelled", one.id);
    expect(await read({ id: two.id })).not.toBe("off");
    expect(await badge(TAB)).toBe("●");
    expect(sendMessage).not.toHaveBeenCalled();
    await discardSession("cancelled", two.id);
    expect(await read({ id: two.id })).toBe("off");
    expect(await badge(TAB)).toBe("");
  });

  it("a lock landing between getDek() and the write: off, nothing written, a locked tombstone", async () => {
    const t = Date.now();
    await startSession(TAB, ORIGIN, t, null);
    const set = vi.spyOn(fakeBrowser.storage.session, "set");
    const controls = page("card");
    const got = await withSession(at, t, (_m, body) => {
      void lock(); // bumps the lock epoch synchronously, as a lock landing mid-job would
      const onPage = observePage(body, keys(controls), "doc1", "/pay");
      if (onPage === "full") throw new Error("full");
      const r = applyCapture(onPage, capture(controls[0]!, SECRET));
      return { body: r.body, result: "written" };
    });
    expect(got).toBe("off");
    expect(set.mock.calls.some(([items]) => KEY in (items as object))).toBe(
      false,
    );
    await vi.waitFor(async () =>
      expect((await sessionStore())[KEY]).toBeUndefined(),
    );
    expect(await stoppedReason(TAB, t)).toBe("locked");
  });

  it("refuses an expiresAt past now + 30 min and writes nothing", async () => {
    await startSession(TAB, ORIGIN, T0, null);
    const before = JSON.stringify(await sessionStore());
    const now = T0 + 5000;
    await expect(
      withSession(at, now, () => ({
        meta: { expiresAt: now + RECORDING_TTL_MS + 1 },
        result: null,
      })),
    ).rejects.toThrow(TypeError);
    expect(JSON.stringify(await sessionStore())).toBe(before);
    await withSession(at, now, () => ({
      meta: { expiresAt: now + RECORDING_TTL_MS },
      result: null,
    }));
    const got = (await read(at, now)) as { meta: SessionMeta };
    expect(got.meta.expiresAt).toBe(now + RECORDING_TTL_MS);
  });

  it("the callback gets a copy of the metadata", async () => {
    const meta = await startSession(TAB, ORIGIN, T0, null);
    await withSession(at, T0, (m, body) => {
      m.finished = true;
      m.expiresAt = T0 + 1;
      m.tabId = 99;
      return { body, result: null }; // a re-seal writes the metadata too
    });
    const got = (await read(at)) as { meta: SessionMeta };
    expect(got.meta).toEqual(meta);
  });

  it("clearBadge clears the tab's badge and logs a failure by name only", async () => {
    await startSession(TAB, ORIGIN, T0, null);
    await clearBadge(TAB);
    expect(await badge(TAB)).toBe("");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(fakeBrowser.action, "setBadgeText").mockRejectedValue(
      new RangeError(`No tab ${SECRET}`),
    );
    await clearBadge(TAB);
    expect(JSON.stringify(log.mock.calls)).toContain("RangeError");
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
  });
});
