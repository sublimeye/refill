// Saved mode of the review page in the worker (ADR 0035): saved-summary for the popup, then
// saved-load, saved-check and saved-save for the page. Page-only, keyed by profile id; values go out
// only to saved-load, under an unchanged lock epoch, and a "Don't save" field never regains a value.
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
import * as aead from "../../../src/lib/crypto/aead";
import { newKdfParams } from "../../../src/lib/crypto/kdf";
import { createPageHandlers } from "../../../src/lib/messaging/page-handlers";
import {
  parsePageRequest,
  type PageRequest,
  type ReviewSaveResult,
  type SavedLoadResult,
} from "../../../src/lib/messaging/protocol";
import * as store from "../../../src/lib/profiles/store";
import {
  loadProfileForOrigin,
  saveProfile,
} from "../../../src/lib/profiles/store";
import type { Profile } from "../../../src/lib/profiles/types";
import { createReviewPageHandlers } from "../../../src/lib/recorder/review-handlers";
import { readSites, removeSite } from "../../../src/lib/sites";
import * as vault from "../../../src/lib/vault/vault";
import {
  __resetForTests,
  createVault,
  lock,
  unlockWithPassphrase,
} from "../../../src/lib/vault/vault";
import { ORIGIN, page, savedProfile } from "./helpers";

const P = "correct horse battery staple";
const T0 = 1_700_000_100_000;

let snapshot: Record<string, unknown>;
const h = () => createReviewPageHandlers(() => T0);

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
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

/** The helpers' saved form plus a "Don't save" field f5, saved as Plan 3 saves one (no value). */
function stored(over: Partial<Profile> = {}): Profile {
  const p = savedProfile(over);
  return {
    ...p,
    fields: [
      ...p.fields,
      {
        id: "f5",
        sig: page("acct", "zip")[1]!.sig,
        step: 0,
        kind: "text",
        value: "",
        pageDefault: "",
        policy: "skip",
      },
    ],
  };
}

const summary = (origin: string) =>
  h()["saved-summary"]({ type: "saved-summary", origin });
const load = (profileId: string) =>
  h()["saved-load"]({
    type: "saved-load",
    profileId,
  }) as Promise<SavedLoadResult>;
const check = (profileId: string) =>
  h()["saved-check"]({ type: "saved-check", profileId });

type SaveReq = Extract<PageRequest, { type: "saved-save" }>;
const POLICIES: SaveReq["policies"] = [
  { fieldId: "f1", policy: "save" },
  { fieldId: "f4", policy: "ask" },
  { fieldId: "f5", policy: "skip" },
];
const save = (over: Partial<SaveReq> = {}) =>
  h()["saved-save"]({
    type: "saved-save",
    profileId: "p1",
    name: "Bill pay",
    fillMode: "gesture",
    pathPrefix: "/billpay/",
    policies: POLICIES,
    ...over,
  }) as Promise<ReviewSaveResult>;

const profileWrites = (set: { mock: { calls: unknown[][] } }) =>
  set.mock.calls.filter(([items]) =>
    Object.keys(items as object).some((k) => k.startsWith("p:")),
  );

describe("saved-summary (the popup's line)", () => {
  it("the site's saved form: its id and how many fields it has, no value", async () => {
    await saveProfile(stored());
    const res = await summary(ORIGIN);
    expect(res).toEqual({ state: "saved", profileId: "p1", count: 3 });
  });

  it("none: no site, no saved form, a non-canonical origin, or a locked vault", async () => {
    expect(await summary(ORIGIN)).toEqual({ state: "none" });
    await saveProfile(stored());
    expect(await summary(`${ORIGIN}/`)).toEqual({ state: "none" });
    expect(await summary("https://other.example")).toEqual({ state: "none" });
    await lock();
    expect(await summary(ORIGIN)).toEqual({ state: "none" });
  });
});

describe("saved-load", () => {
  it("the saved form as the review model; a Don't save field has no value", async () => {
    await saveProfile(stored());
    const res = await load("p1");
    expect(res).toMatchObject({
      state: "ready",
      model: {
        origin: ORIGIN,
        host: "pay.example.com",
        name: "Bill pay",
        pathPrefix: "/billpay/",
        fillMode: "gesture",
      },
    });
    if (res.state !== "ready") return;
    expect(Object.keys(res).sort()).toEqual(["model", "state"]);
    expect(
      res.model.fields.map((f) => [f.id, f.label, f.value, f.policy]),
    ).toEqual([
      ["f1", "acct", "12345", "save"],
      ["f4", "amount", "45.12", "ask"],
      ["f5", "zip", "", "skip"],
    ]);
  });

  it("gone: an unknown id, a removed site, a locked vault", async () => {
    expect(await load("p1")).toEqual({ state: "gone" });
    await saveProfile(stored());
    await lock();
    expect(await load("p1")).toEqual({ state: "gone" });
    expect((await unlockWithPassphrase(P)).ok).toBe(true);
    expect(await load("p2")).toEqual({ state: "gone" });
    await removeSite(ORIGIN);
    expect(await load("p1")).toEqual({ state: "gone" });
  });

  it("a lock (and unlock) during the load: gone, no value", async () => {
    await saveProfile(stored());
    const real = store.loadProfileForOrigin;
    vi.spyOn(store, "loadProfileForOrigin").mockImplementation(async (o) => {
      const p = await real(o);
      await lock();
      expect((await unlockWithPassphrase(P)).ok).toBe(true);
      return p;
    });
    expect(await load("p1")).toEqual({ state: "gone" });
  });
});

describe("saved-check (before every Show, on return, on the worker's signal)", () => {
  it("ready while unlocked and the site still points at the id; opens nothing", async () => {
    await saveProfile(stored());
    const opened = vi.spyOn(aead, "open");
    expect(await check("p1")).toEqual({ state: "ready" });
    expect(opened).not.toHaveBeenCalled();
  });

  it("gone: locked, an unknown id, a removed site", async () => {
    await saveProfile(stored());
    expect(await check("p2")).toEqual({ state: "gone" });
    await lock();
    expect(await check("p1")).toEqual({ state: "gone" });
    expect((await unlockWithPassphrase(P)).ok).toBe(true);
    expect(await check("p1")).toEqual({ state: "ready" });
    await removeSite(ORIGIN);
    expect(await check("p1")).toEqual({ state: "gone" });
  });

  it("a vault that reports locked is gone", async () => {
    await saveProfile(stored());
    vi.spyOn(vault, "status").mockResolvedValue({
      state: "locked",
    } as Awaited<ReturnType<typeof vault.status>>);
    expect(await check("p1")).toEqual({ state: "gone" });
  });
});

describe("saved-save", () => {
  it("writes the new name, fill mode, prefix and policies; keeps the rest", async () => {
    const before = stored();
    await saveProfile(before);
    expect(
      await save({
        name: "  Bills ",
        fillMode: "auto",
        pathPrefix: "/",
        policies: [
          { fieldId: "f1", policy: "ask" },
          { fieldId: "f4", policy: "skip" },
          { fieldId: "f5", policy: "skip" },
        ],
      }),
    ).toEqual({ ok: true });
    const p = await loadProfileForOrigin(ORIGIN);
    expect(p).toEqual({
      ...before,
      name: "Bills",
      fillMode: "auto",
      pathPrefix: "/",
      fields: [
        { ...before.fields[0], policy: "ask" },
        { ...before.fields[1], value: "", pageDefault: "", policy: "skip" },
        before.fields[2],
      ],
    });
    expect((await readSites())[ORIGIN]!.profileId).toBe("p1");
  });

  it("a Don't save field cannot become Fill it in: invalid, nothing written", async () => {
    await saveProfile(stored());
    const set = vi.spyOn(fakeBrowser.storage.local, "set");
    expect(
      await save({
        policies: [...POLICIES.slice(0, 2), { fieldId: "f5", policy: "save" }],
      }),
    ).toEqual({ ok: false, error: "invalid" });
    expect(profileWrites(set)).toEqual([]);
  });

  it("a Don't save field may become Ask me, and stays empty", async () => {
    await saveProfile(stored());
    expect(
      await save({
        policies: [...POLICIES.slice(0, 2), { fieldId: "f5", policy: "ask" }],
      }),
    ).toEqual({ ok: true });
    const f5 = (await loadProfileForOrigin(ORIGIN))!.fields[2]!;
    expect(f5).toMatchObject({ id: "f5", value: "", policy: "ask" });
  });

  it("invalid: a prefix that misses a step, a blank name, a missing, unknown or repeated policy", async () => {
    await saveProfile(stored());
    const set = vi.spyOn(fakeBrowser.storage.local, "set");
    const bad: Partial<SaveReq>[] = [
      { pathPrefix: "/billpay/one" },
      { pathPrefix: "/other/" },
      { pathPrefix: "billpay/" },
      { name: "   " },
      { policies: POLICIES.slice(1) },
      { policies: [...POLICIES, { fieldId: "f9", policy: "save" }] },
      { policies: [...POLICIES, { fieldId: "f1", policy: "skip" }] },
    ];
    for (const over of bad) {
      expect(await save(over)).toEqual({ ok: false, error: "invalid" });
    }
    expect(profileWrites(set)).toEqual([]);
    // The prefix compares as the matcher does: case-insensitive (ADR 0034).
    expect(await save({ pathPrefix: "/BillPay/" })).toEqual({ ok: true });
  });

  it("gone: an unknown id or a removed site; the site is not recreated", async () => {
    expect(await save()).toEqual({ ok: false, error: "gone" });
    await saveProfile(stored());
    await removeSite(ORIGIN);
    const set = vi.spyOn(fakeBrowser.storage.local, "set");
    expect(await save()).toEqual({ ok: false, error: "gone" });
    expect(set).not.toHaveBeenCalled();
    expect((await readSites())[ORIGIN]).toBeUndefined();
  });

  it("a site removed after the id was looked up: gone, nothing recreated", async () => {
    await saveProfile(stored());
    const real = store.originOfProfile;
    vi.spyOn(store, "originOfProfile").mockImplementation(async (id) => {
      const o = await real(id);
      await removeSite(ORIGIN);
      return o;
    });
    expect(await save()).toEqual({ ok: false, error: "gone" });
    expect((await readSites())[ORIGIN]).toBeUndefined();
  });

  it("locked: gone, nothing written", async () => {
    await saveProfile(stored());
    await lock();
    const set = vi.spyOn(fakeBrowser.storage.local, "set");
    expect(await save({ name: "Other" })).toEqual({ ok: false, error: "gone" });
    expect(profileWrites(set)).toEqual([]);
  });
});

describe("wiring and parsing", () => {
  const ID = "p1";
  const good = {
    type: "saved-save",
    profileId: ID,
    name: "Bill pay",
    fillMode: "auto",
    pathPrefix: "/billpay/",
    policies: [{ fieldId: "f1", policy: "ask" }],
  };

  it("the worker's page handlers include the saved-mode requests", () => {
    const handlers = createPageHandlers(async () => newKdfParams());
    for (const t of [
      "saved-summary",
      "saved-load",
      "saved-check",
      "saved-save",
    ] as const) {
      expect(typeof handlers[t]).toBe("function");
    }
  });

  it("parses the four messages with exact keys into fresh objects", () => {
    expect(parsePageRequest({ type: "saved-load", profileId: ID })).toEqual({
      type: "saved-load",
      profileId: ID,
    });
    expect(parsePageRequest({ type: "saved-check", profileId: ID })).toEqual({
      type: "saved-check",
      profileId: ID,
    });
    expect(parsePageRequest({ type: "saved-summary", origin: ORIGIN })).toEqual(
      { type: "saved-summary", origin: ORIGIN },
    );
    const parsed = parsePageRequest(good);
    expect(parsed).toEqual(good);
    expect(parsed).not.toBe(good);
    if (parsed?.type !== "saved-save") return;
    expect(parsed.policies[0]).not.toBe(good.policies[0]);
  });

  it("enforces the limits and shapes", () => {
    const policy = (i: number) => ({ fieldId: `f${i}`, policy: "save" });
    const bad: unknown[] = [
      { type: "saved-load", profileId: "a|b" },
      { type: "saved-load", profileId: "" },
      { type: "saved-load", profileId: "x".repeat(65) },
      { type: "saved-load", profileId: ID, extra: 1 },
      { type: "saved-load", sessionId: ID },
      { type: "saved-check", profileId: 5 },
      { type: "saved-check", profileId: ID, origin: ORIGIN },
      { type: "saved-summary", origin: "x".repeat(257) },
      { type: "saved-summary", origin: 5 },
      { type: "saved-summary", origin: ORIGIN, profileId: ID },
      { ...good, profileId: "not an id" },
      { ...good, sessionId: ID },
      { ...good, name: "n".repeat(121) },
      { ...good, name: 5 },
      { ...good, pathPrefix: "/" + "p".repeat(256) },
      { ...good, fillMode: "always" },
      { ...good, policies: "f1" },
      { ...good, policies: Array.from({ length: 201 }, (_, i) => policy(i)) },
      { ...good, policies: [{ fieldId: "f1", policy: "fill" }] },
      { ...good, policies: [{ fieldId: "f1", policy: "save", x: 1 }] },
      { ...good, policies: [null] },
    ];
    for (const raw of bad) expect(parsePageRequest(raw)).toBeNull();
    expect(
      parsePageRequest({
        ...good,
        name: "n".repeat(120),
        pathPrefix: "/" + "p".repeat(255),
        policies: Array.from({ length: 200 }, (_, i) => policy(i)),
      }),
    ).not.toBeNull();
  });
});
