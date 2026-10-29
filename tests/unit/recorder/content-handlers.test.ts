// The content side of recording in the worker: record-status, record-capture, record-finish, and
// scan-report while a session is active (spec §6.2, §7; ADR 0030).
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
import type {
  ContentRequest,
  ScanControl,
} from "../../../src/lib/messaging/content-protocol";
import type { ContentContext } from "../../../src/lib/messaging/router";
import {
  loadProfileForOrigin,
  saveProfile,
} from "../../../src/lib/profiles/store";
import type { Profile } from "../../../src/lib/profiles/types";
import {
  RECORDING_TTL_MS,
  installRecorderListeners,
  startSession,
  withSession,
  type SessionMeta,
} from "../../../src/lib/recorder/session";
import { recordState } from "../../../src/lib/recorder/handlers";
import { emptyBody, type RecBody } from "../../../src/lib/recorder/types";
import { profileKey } from "../../../src/lib/store/local";
import {
  __resetForTests,
  createVault,
  lock,
  unlockWithPassphrase,
} from "../../../src/lib/vault/vault";
import { ORIGIN, ctrl, keys, page, savedProfile } from "./helpers";

const P = "correct horse battery staple";
const TAB = 7;
const T0 = 1_700_000_000_000;
const KEY = "recorder:session";
const OTHER_ORIGIN = "https://other.example";
const OFF = { state: "off" };
const NONE = { state: "none" };

let snapshot: Record<string, unknown>;
let clock: number;
const now = () => clock;
let create: ReturnType<typeof vi.fn>;

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
  // fakeBrowser implements neither tabs.sendMessage (the nudge) nor a useful tabs.create.
  (fakeBrowser.tabs as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    async () => undefined,
  );
  create = vi.fn(async () => ({}));
  (fakeBrowser.tabs as unknown as { create: unknown }).create = create;
  installRecorderListeners();
});

afterEach(() => vi.restoreAllMocks());

const ctx = (o: Partial<ContentContext> = {}): ContentContext => ({
  origin: ORIGIN,
  pathname: "/billpay/one",
  tabId: TAB,
  documentId: "doc1",
  ...o,
});

const scan = (
  controls: ScanControl[],
): Extract<ContentRequest, { type: "scan-report" }> => ({
  type: "scan-report",
  controls,
  truncated: false,
});

const cap = (
  c: ScanControl,
  value: string,
  o: Partial<Extract<ContentRequest, { type: "record-capture" }>> = {},
): Extract<ContentRequest, { type: "record-capture" }> => ({
  type: "record-capture",
  kind: c.kind,
  sig: c.sig,
  value,
  pageDefault: "",
  fieldId: null,
  ...o,
});

const STATUS = { type: "record-status" } as const;
const FINISH = { type: "record-finish" } as const;

/** The session's body and meta as stored (or "off"). */
const peek = () =>
  withSession({ tabId: TAB, origin: ORIGIN }, clock, (meta, body) => ({
    result: { meta, body },
  }));
const body = async (): Promise<RecBody> => {
  const got = await peek();
  if (got === "off") throw new Error("no session");
  return got.body;
};
const badge = () => fakeBrowser.action.getBadgeText({ tabId: TAB });
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("recording content handlers", { timeout: 30_000 }, () => {
  describe("scan-report during recording", () => {
    it("Back to a recorded page (a new document) fills the values captured there", async () => {
      await startSession(TAB, ORIGIN, T0, null);
      const h = createContentHandlers(now);
      const one = page("acct", "zip", "name");
      const two = page("amount", "memo");
      const d = (documentId: string, pathname: string) =>
        ctx({ documentId, pathname });

      expect(await h["scan-report"](scan(one), d("d1", "/one"))).toEqual(NONE);
      expect(
        await h["record-capture"](cap(one[0]!, "12345"), d("d1", "/one")),
      ).toEqual({ state: "on", count: 1 });
      expect(
        await h["record-capture"](cap(one[2]!, "Jane"), d("d1", "/one")),
      ).toEqual({ state: "on", count: 2 });
      expect(await h["scan-report"](scan(two), d("d2", "/two"))).toEqual(NONE);
      expect(
        await h["record-capture"](cap(two[0]!, "45.12"), d("d2", "/two")),
      ).toEqual({ state: "on", count: 3 });

      expect(await h["scan-report"](scan(one), d("d3", "/one"))).toEqual({
        state: "fill",
        items: [
          {
            fieldId: "f1",
            i: 0,
            kind: "text",
            value: "12345",
            pageDefault: "",
          },
          { fieldId: "f2", i: 2, kind: "text", value: "Jane", pageDefault: "" },
        ],
      });
      expect(await h["scan-report"](scan(two), d("d4", "/two"))).toEqual({
        state: "fill",
        items: [
          {
            fieldId: "f3",
            i: 0,
            kind: "text",
            value: "45.12",
            pageDefault: "",
          },
        ],
      });
      // Back joined the existing steps: no duplicate step was filed.
      expect((await body()).steps.map((s) => s.pathHint)).toEqual([
        "/one",
        "/two",
      ]);
    });

    it("an empty session never returns stored-profile values, and the profile is never loaded", async () => {
      await saveProfile(savedProfile());
      const h = createContentHandlers(now);
      const onePage = page("acct", "zip");
      // Control: without a session, Plan 2 fills this page from the saved profile.
      expect(await h["scan-report"](scan(onePage), ctx())).toMatchObject({
        state: "gesture",
      });

      await startSession(TAB, ORIGIN, T0, null);
      const get = vi.spyOn(fakeBrowser.storage.local, "get");
      const reply = await h["scan-report"](scan(onePage), ctx());
      expect(reply).toEqual(NONE);
      expect(JSON.stringify(reply)).not.toContain("12345");
      const read = get.mock.calls.flat();
      expect(read).not.toContain("sites");
      expect(read).not.toContain(profileKey("p1"));
    });

    it("fills from a seeded session (Record again) without touching lastUsedAt", async () => {
      await saveProfile(savedProfile({ lastUsedAt: null }));
      await startSession(TAB, ORIGIN, T0, savedProfile({ lastUsedAt: null }));
      const reply = await createContentHandlers(now)["scan-report"](
        scan(page("acct", "zip")),
        ctx(),
      );
      // Auto, whatever the saved fill mode (gesture): the user is recording on this page.
      expect(reply).toEqual({
        state: "fill",
        items: [
          {
            fieldId: "f1",
            i: 0,
            kind: "text",
            value: "12345",
            pageDefault: "",
          },
        ],
      });
      await settle();
      expect((await loadProfileForOrigin(ORIGIN))?.lastUsedAt).toBeNull();
    });

    it("an eleventh step is not filed: captures there answer full, the plan still fills from the steps it has", async () => {
      await startSession(TAB, ORIGIN, T0, null);
      const h = createContentHandlers(now);
      const pages = Array.from({ length: 10 }, (_, k) =>
        page(`s${k}a`, `s${k}b`),
      );
      for (const [k, p] of pages.entries()) {
        expect(
          await h["scan-report"](scan(p), ctx({ documentId: `d${k}` })),
        ).toEqual(NONE);
      }
      expect(
        await h["record-capture"](
          cap(pages[9]![0]!, "v9"),
          ctx({ documentId: "d9" }),
        ),
      ).toEqual({ state: "on", count: 1 });

      // The eleventh page shares one control with step 9, too little to be that step.
      const eleventh = [
        ctrl(0, "s9a"),
        ctrl(1, "xa"),
        ctrl(2, "xb"),
        ctrl(3, "xc"),
      ];
      const at11 = ctx({ documentId: "d10" });
      expect(await h["scan-report"](scan(eleventh), at11)).toEqual({
        state: "fill",
        items: [
          { fieldId: "f1", i: 0, kind: "text", value: "v9", pageDefault: "" },
        ],
      });
      let b = await body();
      expect(b.steps).toHaveLength(10);
      expect(b.current).toBeNull();
      expect(b.lastDocument).toBe("d10");
      expect(
        await h["record-capture"](cap(eleventh[1]!, "lost"), at11),
      ).toEqual({ state: "full", count: 1 });
      expect(await h["record-status"](STATUS, at11)).toEqual({
        state: "full",
        count: 1,
      });
      b = await body();
      expect(b.fields.map((f) => f.value)).toEqual(["v9"]);

      // Back on a known step, recording goes on.
      const back = ctx({ documentId: "d11" });
      expect(await h["scan-report"](scan(pages[3]!), back)).toEqual(NONE);
      expect(await h["record-status"](STATUS, back)).toEqual({
        state: "on",
        count: 1,
      });
    });

    it("a lock landing after the session job: locked, no values", async () => {
      await startSession(TAB, ORIGIN, T0, savedProfile());
      const session = fakeBrowser.storage.session;
      const original = session.set.bind(session);
      // The lock lands while the job writes the observed body: after the job's own check.
      vi.spyOn(session, "set").mockImplementation((async (
        items: Record<string, unknown>,
      ) => {
        if (KEY in items) await lock();
        return original(items);
      }) as never);
      const reply = await createContentHandlers(now)["scan-report"](
        scan(page("acct", "zip")),
        ctx(),
      );
      expect(reply).toEqual({ state: "locked" });
      expect(JSON.stringify(reply)).not.toContain("12345");
    });

    it("a locked vault answers locked and the session stops", async () => {
      await startSession(TAB, ORIGIN, T0, savedProfile());
      await lock();
      const h = createContentHandlers(now);
      expect(await h["scan-report"](scan(page("acct", "zip")), ctx())).toEqual({
        state: "locked",
      });
      expect(await h["record-status"](STATUS, ctx())).toEqual({
        state: "stopped",
        reason: "locked",
      });
    });

    it("another tab or origin, and a finished session, get Plan 2's fill", async () => {
      await saveProfile(savedProfile({ fillMode: "auto" }));
      await startSession(TAB, ORIGIN, T0, null);
      const h = createContentHandlers(now);
      const onePage = scan(page("acct", "zip"));
      const stored = {
        state: "fill",
        items: [expect.objectContaining({ fieldId: "f1", value: "12345" })],
      };
      expect(await h["scan-report"](onePage, ctx({ tabId: TAB + 1 }))).toEqual(
        stored,
      );
      expect(await h["scan-report"](onePage, ctx())).toEqual(NONE);
      expect(await h["record-finish"](FINISH, ctx())).toEqual({ ok: true });
      expect(await h["scan-report"](onePage, ctx())).toEqual(stored);
    });
  });

  describe("record-capture", () => {
    it("answers the count, never a value, and re-checks secrets", async () => {
      await startSession(TAB, ORIGIN, T0, null);
      const h = createContentHandlers(now);
      const controls = [
        ctrl(0, "card"),
        ctrl(1, "otp", { autocomplete: "one-time-code" }),
      ];
      await h["scan-report"](scan(controls), ctx());
      const reply = await h["record-capture"](
        cap(controls[0]!, "4111-VALUE"),
        ctx(),
      );
      expect(reply).toEqual({ state: "on", count: 1 });
      expect(
        await h["record-capture"](cap(controls[1]!, "123456"), ctx()),
      ).toEqual({ state: "on", count: 1 });
      expect((await body()).fields.map((f) => f.value)).toEqual(["4111-VALUE"]);
    });

    it("joins the session chain in the call itself, so captures apply in the order they arrive (ruling F4)", async () => {
      await startSession(TAB, ORIGIN, T0, null);
      const h = createContentHandlers(now);
      const acct = page("acct");
      await h["scan-report"](scan(acct), ctx());
      // The router enters capture handlers in arrival order (ADR 0032); nothing may reorder them
      // between that call and the session chain.
      const older = h["record-capture"](cap(acct[0]!, "older"), ctx());
      const between = peek(); // queued in the same task, right after the first capture
      const newer = h["record-capture"](cap(acct[0]!, "newer"), ctx());
      await Promise.all([older, newer]);
      const seen = await between;
      if (seen === "off") throw new Error("no session");
      expect(seen.body.fields.map((f) => f.value)).toEqual(["older"]);
      expect((await body()).fields.map((f) => f.value)).toEqual(["newer"]);
    });

    it("before any scan the capture is not filed and the state is on", async () => {
      await startSession(TAB, ORIGIN, T0, null);
      expect(
        await createContentHandlers(now)["record-capture"](
          cap(ctrl(0, "acct"), "x"),
          ctx(),
        ),
      ).toEqual({ state: "on", count: 0 });
      expect((await body()).fields).toEqual([]);
    });

    it("a capture that changes nothing leaves the sealed body alone", async () => {
      await startSession(TAB, ORIGIN, T0, null);
      const h = createContentHandlers(now);
      await h["scan-report"](scan(page("acct")), ctx());
      const before = JSON.stringify(await fakeBrowser.storage.session.get(KEY));
      expect(
        await h["record-capture"](
          cap(ctrl(0, "pin", { type: "password" }), "1234"),
          ctx(),
        ),
      ).toEqual({ state: "on", count: 0 });
      expect(JSON.stringify(await fakeBrowser.storage.session.get(KEY))).toBe(
        before,
      );
    });
  });

  describe("scoping", () => {
    it.each([
      ["another tab", { tabId: TAB + 1 }],
      ["another origin", { origin: OTHER_ORIGIN }],
    ])("%s: status, capture and finish answer off", async (_n, patch) => {
      await startSession(TAB, ORIGIN, T0, null);
      const h = createContentHandlers(now);
      await h["scan-report"](scan(page("acct")), ctx());
      const there = ctx(patch);
      expect(await h["record-status"](STATUS, there)).toEqual(OFF);
      expect(
        await h["record-capture"](cap(ctrl(0, "acct"), "x"), there),
      ).toEqual(OFF);
      expect(await h["record-finish"](FINISH, there)).toEqual({ ok: false });
      expect(create).not.toHaveBeenCalled();
      const got = await peek();
      if (got === "off") throw new Error("session gone");
      expect(got.meta.finished).toBe(false);
      expect(got.body.fields).toEqual([]);
      expect(await badge()).toBe("●");
    });

    it("with no session at all: off and ok false", async () => {
      const h = createContentHandlers(now);
      expect(await h["record-status"](STATUS, ctx())).toEqual(OFF);
      expect(
        await h["record-capture"](cap(ctrl(0, "acct"), "x"), ctx()),
      ).toEqual(OFF);
      expect(await h["record-finish"](FINISH, ctx())).toEqual({ ok: false });
    });
  });

  describe("recordState", () => {
    const steps = (n: number) =>
      Array.from({ length: n }, (_, index) => ({
        index,
        pathHint: "/",
        fingerprint: [],
      }));
    const fields = (n: number) =>
      Array.from({ length: n }, (_, k) => ({
        id: `f${k + 1}`,
        step: 0,
        sig: ctrl(0, `c${k}`).sig,
        kind: "text" as const,
        value: "v",
        pageDefault: "",
        policy: "save" as const,
      }));

    it("full at 200 fields, or on an eleventh page; on otherwise", () => {
      const b = { ...emptyBody(), steps: steps(1), current: 0 };
      expect(recordState({ ...b, fields: fields(199) })).toEqual({
        state: "on",
        count: 199,
      });
      expect(recordState({ ...b, fields: fields(200) })).toEqual({
        state: "full",
        count: 200,
      });
      expect(
        recordState({ ...emptyBody(), steps: steps(10), current: null }),
      ).toEqual({ state: "full", count: 0 });
      expect(
        recordState({ ...emptyBody(), steps: steps(10), current: 9 }),
      ).toEqual({ state: "on", count: 0 });
      expect(
        recordState({ ...emptyBody(), steps: steps(9), current: null }),
      ).toEqual({ state: "on", count: 0 });
    });
  });

  describe("record-status", () => {
    it("on with the count", async () => {
      await startSession(TAB, ORIGIN, T0, savedProfile());
      expect(
        await createContentHandlers(now)["record-status"](STATUS, ctx()),
      ).toEqual({ state: "on", count: 2 });
    });

    it("after a lock: stopped, locked (this tab only)", async () => {
      await startSession(TAB, ORIGIN, T0, null);
      await lock();
      await vi.waitFor(async () =>
        expect(
          (await fakeBrowser.storage.session.get(KEY))[KEY],
        ).toBeUndefined(),
      );
      const h = createContentHandlers(now);
      expect(await h["record-status"](STATUS, ctx())).toEqual({
        state: "stopped",
        reason: "locked",
      });
      expect(await h["record-status"](STATUS, ctx({ tabId: 9 }))).toEqual(OFF);
      expect(
        await h["record-capture"](cap(ctrl(0, "acct"), "x"), ctx()),
      ).toEqual({ state: "stopped", reason: "locked" });
    });

    it("after the TTL: stopped, expired", async () => {
      await startSession(TAB, ORIGIN, T0, null);
      clock = T0 + RECORDING_TTL_MS;
      expect(
        await createContentHandlers(now)["record-status"](STATUS, ctx()),
      ).toEqual({ state: "stopped", reason: "expired" });
    });
  });

  describe("record-finish", () => {
    it("finishes, resets the TTL, clears the badge and opens the review page", async () => {
      const meta: SessionMeta = await startSession(TAB, ORIGIN, T0, null);
      expect(await badge()).toBe("●");
      clock = T0 + 60_000;
      const h = createContentHandlers(now);
      expect(await h["record-finish"](FINISH, ctx())).toEqual({ ok: true });
      expect(create).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledWith({
        url: `${fakeBrowser.runtime.getURL("/review.html")}?session=${meta.id}`,
      });
      expect(await badge()).toBe("");
      const got = await withSession({ id: meta.id }, clock, (m) => ({
        result: m,
      }));
      expect(got).toEqual({
        ...meta,
        finished: true,
        expiresAt: clock + RECORDING_TTL_MS,
      });
      // Finished: the content script no longer records, and a second finish does nothing.
      expect(await h["record-status"](STATUS, ctx())).toEqual(OFF);
      expect(
        await h["record-capture"](cap(ctrl(0, "acct"), "x"), ctx()),
      ).toEqual(OFF);
      expect(await h["record-finish"](FINISH, ctx())).toEqual({ ok: false });
      expect(create).toHaveBeenCalledOnce();
    });
  });

  it("Review Focus 5: Record again after a relabel fills the saved value, and the edit replaces that field (no duplicate)", async () => {
    const before = [
      ctrl(0, "postal", { autocomplete: "postal-code", labelText: "ZIP" }),
      ctrl(1, "acct"),
      ctrl(2, "name"),
      ctrl(3, "city"),
    ];
    const later = page("amount", "memo");
    const saved: Profile = savedProfile({
      steps: [
        { index: 0, pathHint: "/billpay/one", fingerprint: keys(before) },
        { index: 1, pathHint: "/billpay/two", fingerprint: keys(later) },
      ],
      fields: [
        {
          id: "f1",
          sig: before[0]!.sig,
          step: 0,
          kind: "text",
          value: "12345",
          pageDefault: "",
          policy: "save",
        },
        {
          id: "f2",
          sig: before[2]!.sig,
          step: 0,
          kind: "text",
          value: "Jane",
          pageDefault: "",
          policy: "save",
        },
        {
          id: "f4",
          sig: later[0]!.sig,
          step: 1,
          kind: "text",
          value: "45.12",
          pageDefault: "",
          policy: "save",
        },
      ],
    });
    await saveProfile(saved);
    await startSession(TAB, ORIGIN, T0, saved);
    const h = createContentHandlers(now);

    // The site relabelled the postal code since the first recording.
    const now1 = [
      ctrl(0, "postal", {
        autocomplete: "postal-code",
        labelText: "Postal code",
      }),
      ...before.slice(1),
    ];
    expect(
      await h["scan-report"](scan(now1), ctx({ documentId: "d1" })),
    ).toEqual({
      state: "fill",
      items: [
        { fieldId: "f1", i: 0, kind: "text", value: "12345", pageDefault: "" },
        { fieldId: "f2", i: 2, kind: "text", value: "Jane", pageDefault: "" },
      ],
    });
    // The user changes the filled postal code: linked by the filled field id, not by signature.
    expect(
      await h["record-capture"](
        cap(now1[0]!, "99999", { fieldId: "f1" }),
        ctx({ documentId: "d1" }),
      ),
    ).toEqual({ state: "on", count: 3 });

    const b = await body();
    expect(b.fields.map((f) => [f.id, f.step, f.value])).toEqual([
      ["f1", 0, "99999"],
      ["f2", 0, "Jane"],
      ["f4", 1, "45.12"], // not reached: stays as saved
    ]);
    expect(b.fields[0]!.sig.labelText).toBe("Postal code");
    expect(b.steps).toHaveLength(2);

    // Back to the page: one claimant, so the edit fills (a duplicate would make both drop).
    expect(
      await h["scan-report"](scan(now1), ctx({ documentId: "d2" })),
    ).toMatchObject({
      state: "fill",
      items: [{ fieldId: "f1", value: "99999" }, { fieldId: "f2" }],
    });
  });
});
