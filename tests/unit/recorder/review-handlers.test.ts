// The review page's requests in the worker: review-load, review-save and review-discard (spec §6.2,
// ADR 0033). Only a finished session loads; a save re-checks the session and the vault, writes the
// site's profile and ends the session.
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
  type ReviewLoadResult,
  type ReviewSaveResult,
} from "../../../src/lib/messaging/protocol";
import * as store from "../../../src/lib/profiles/store";
import {
  loadProfileForOrigin,
  saveProfile,
} from "../../../src/lib/profiles/store";
import type { FieldPolicy, Profile } from "../../../src/lib/profiles/types";
import { applyCapture } from "../../../src/lib/recorder/fields";
import { createReviewPageHandlers } from "../../../src/lib/recorder/review-handlers";
import {
  RECORDING_TTL_MS,
  discardSession,
  installRecorderListeners,
  startSession,
  withSession,
} from "../../../src/lib/recorder/session";
import { observePage } from "../../../src/lib/recorder/steps";
import {
  emptyBody,
  seedBody,
  type RecBody,
} from "../../../src/lib/recorder/types";
import { readSites } from "../../../src/lib/sites";
import * as vault from "../../../src/lib/vault/vault";
import {
  __resetForTests,
  createVault,
  lock,
  unlockWithPassphrase,
} from "../../../src/lib/vault/vault";
import { ORIGIN, capture, keys, page, savedProfile } from "./helpers";

const P = "correct horse battery staple";
const TAB = 7;
const T0 = 1_700_000_100_000;
const ID = "sess_0123456789abcdefgh";

let snapshot: Record<string, unknown>;
let clock: number;
const now = () => clock;
const h = () => createReviewPageHandlers(now);

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
  vi.spyOn(console, "error").mockImplementation(() => {});
  (fakeBrowser.tabs as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    async () => undefined,
  );
  installRecorderListeners();
});

afterEach(() => vi.restoreAllMocks());

const STEP0 = page("acct", "zip");
const STEP1 = page("amount", "memo");

/** A two-page walk: acct and zip typed on /billpay/one, amount on /billpay/two. */
function walked(from: RecBody = emptyBody()): RecBody {
  let b = observePage(from, keys(STEP0), "doc-1", "/billpay/one");
  if (b === "full") throw new Error("full");
  b = applyCapture(b, capture(STEP0[0]!, "12345")).body;
  b = applyCapture(b, capture(STEP0[1]!, "90210")).body;
  const b2 = observePage(b, keys(STEP1), "doc-2", "/billpay/two");
  if (b2 === "full") throw new Error("full");
  return applyCapture(b2, capture(STEP1[0]!, "45.12")).body;
}

/** A session holding `body`, finished unless told otherwise. Returns its id. */
async function session(
  body: RecBody,
  seed: Profile | null = null,
  finished = true,
): Promise<string> {
  const meta = await startSession(TAB, ORIGIN, clock, seed);
  await withSession({ id: meta.id }, clock, () => ({
    body,
    ...(finished ? { meta: { finished: true } } : {}),
    result: null,
  }));
  return meta.id;
}

const peek = () =>
  withSession({ any: true }, clock, (meta) => ({ result: meta }));

const load = (sessionId: string) =>
  h()["review-load"]({
    type: "review-load",
    sessionId,
  }) as Promise<ReviewLoadResult>;

type SaveReq = Extract<PageRequest, { type: "review-save" }>;

async function policiesOf(
  sessionId: string,
  over: Record<string, FieldPolicy> = {},
): Promise<SaveReq["policies"]> {
  const res = await load(sessionId);
  if (res.state !== "ready") throw new Error("not ready");
  return res.model.fields.map((f) => ({
    fieldId: f.id,
    policy: over[f.id] ?? f.policy,
  }));
}

const save = (sessionId: string, over: Partial<SaveReq> = {}) =>
  h()["review-save"]({
    type: "review-save",
    sessionId,
    name: "Bill pay",
    fillMode: "auto",
    pathPrefix: "/billpay/",
    policies: [],
    ...over,
  }) as Promise<ReviewSaveResult>;

const profileKeys = async () =>
  Object.keys(await fakeBrowser.storage.local.get(null)).filter((k) =>
    k.startsWith("p:"),
  );

describe("review-load", () => {
  it("a finished session loads its model; a new site replaces nothing", async () => {
    const id = await session(walked());
    const res = await load(id);
    expect(res).toMatchObject({ state: "ready", replacesProfile: false });
    if (res.state !== "ready") return;
    expect(res.model.host).toBe("pay.example.com");
    expect(res.model.name).toBe("pay.example.com");
    expect(res.model.pathPrefix).toBe("/billpay/");
    expect(res.model.fillMode).toBe("auto");
    expect(
      res.model.fields.map((f) => [f.label, f.value, f.policy, f.step]),
    ).toEqual([
      ["acct", "12345", "save", 0],
      ["zip", "90210", "save", 0],
      ["amount", "45.12", "save", 1],
    ]);
  });

  it("an unfinished session is gone", async () => {
    const id = await session(walked(), null, false);
    expect(await load(id)).toEqual({ state: "gone" });
    expect(await peek()).not.toBe("off"); // a load never ends a recording
  });

  it("an unknown id, an expired session and a locked vault are gone", async () => {
    expect(await load(ID)).toEqual({ state: "gone" });
    const id = await session(walked());
    clock += RECORDING_TTL_MS;
    expect(await load(id)).toEqual({ state: "gone" });
    clock = T0;
    const id2 = await session(walked());
    await lock();
    expect(await load(id2)).toEqual({ state: "gone" });
  });

  it("Record again: the saved name, prefix and fill mode, and a replace warning", async () => {
    const saved = savedProfile();
    await saveProfile(saved);
    const id = await session(walked(seedBody(saved)), saved);
    const res = await load(id);
    expect(res).toMatchObject({
      state: "ready",
      replacesProfile: true,
      model: { name: "Bill pay", pathPrefix: "/billpay/", fillMode: "gesture" },
    });
  });

  it("a form saved after the seed (another id) warns, but lends nothing to the model", async () => {
    const seed = savedProfile();
    await saveProfile(seed);
    const id = await session(walked(seedBody(seed)), seed);
    // The site's form was replaced while the recording ran.
    await saveProfile(
      savedProfile({ id: "p2", name: "Replaced", pathPrefix: "/" }),
    );
    const res = await load(id);
    expect(res).toMatchObject({
      state: "ready",
      replacesProfile: true,
      model: {
        name: "pay.example.com",
        pathPrefix: "/billpay/",
        fillMode: "auto",
      },
    });
  });

  it("a saved form that was not the seed still warns, but lends nothing to the model", async () => {
    await saveProfile(savedProfile({ name: "Elsewhere" }));
    const id = await session(walked());
    const res = await load(id);
    expect(res).toMatchObject({
      state: "ready",
      replacesProfile: true,
      model: { name: "pay.example.com" },
    });
  });
});

describe("review-save", () => {
  it("saves the site's profile with the chosen policies and ends the session", async () => {
    const id = await session(walked());
    const policies = await policiesOf(id, { f2: "skip", f3: "ask" });
    expect(
      await save(id, { policies, name: "  Bills  ", fillMode: "gesture" }),
    ).toEqual({ ok: true });
    const p = await loadProfileForOrigin(ORIGIN);
    expect(p).toMatchObject({
      name: "Bills",
      origin: ORIGIN,
      pathPrefix: "/billpay/",
      fillMode: "gesture",
      createdAt: T0,
      lastUsedAt: null,
    });
    expect(p!.fields.map((f) => [f.id, f.value, f.policy])).toEqual([
      ["f1", "12345", "save"],
      // "Don't save" keeps the field (it still claims its control) but not its value (C1).
      ["f2", "", "skip"],
      ["f3", "45.12", "ask"],
    ]);
    expect(p!.steps.map((s) => s.pathHint)).toEqual([
      "/billpay/one",
      "/billpay/two",
    ]);
    expect((await readSites())[ORIGIN]!.profileId).toBe(p!.id);
    expect(await peek()).toBe("off");
    expect(await load(id)).toEqual({ state: "gone" });
  });

  it("Record again after a Don't save: the seeded review shows that field empty and Don't save (C1)", async () => {
    const first = await session(walked());
    expect(
      await save(first, { policies: await policiesOf(first, { f2: "skip" }) }),
    ).toEqual({ ok: true });
    const saved = (await loadProfileForOrigin(ORIGIN))!;
    // Record again, finished before the user reached step 1's zip field again.
    const again = await session(seedBody(saved), saved);
    const res = await load(again);
    if (res.state !== "ready") throw new Error("not ready");
    expect(res.model.fields.map((f) => [f.id, f.value, f.policy])).toEqual([
      ["f1", "12345", "save"],
      ["f2", "", "skip"],
      ["f3", "45.12", "save"],
    ]);
    expect(JSON.stringify(res)).not.toContain("90210");
  });

  it("after a lock: gone, and no profile is written (Review Focus 4)", async () => {
    const id = await session(walked());
    const policies = await policiesOf(id);
    const set = vi.spyOn(fakeBrowser.storage.local, "set");
    await lock();
    expect(await save(id, { policies })).toEqual({ ok: false, error: "gone" });
    // Unlocking again does not bring the recording back.
    expect((await unlockWithPassphrase(P)).ok).toBe(true);
    expect(await save(id, { policies })).toEqual({ ok: false, error: "gone" });
    expect(await profileKeys()).toEqual([]);
    expect(
      set.mock.calls.some(([items]) =>
        Object.keys(items).some((k) => k.startsWith("p:")),
      ),
    ).toBe(false);
    expect((await readSites())[ORIGIN]).toBeUndefined();
  });

  it("a lock (and unlock) while the save runs: gone, nothing written", async () => {
    const id = await session(walked());
    const policies = await policiesOf(id);
    const real = store.loadProfileForOrigin;
    vi.spyOn(store, "loadProfileForOrigin").mockImplementation(async (o) => {
      const p = await real(o);
      await lock();
      expect((await unlockWithPassphrase(P)).ok).toBe(true);
      return p;
    });
    expect(await save(id, { policies })).toEqual({ ok: false, error: "gone" });
    expect(await profileKeys()).toEqual([]);
  });

  for (const [what, between] of [
    ["a discard", (id: string) => discardSession("cancelled", id)],
    [
      "a new recording replacing it",
      () => startSession(TAB, ORIGIN, clock, null).then(() => undefined),
    ],
  ] as const) {
    it(`${what} between opening the session and the write: gone, nothing written`, async () => {
      const id = await session(walked());
      const policies = await policiesOf(id);
      const real = store.loadProfileForOrigin;
      vi.spyOn(store, "loadProfileForOrigin").mockImplementation(async (o) => {
        const p = await real(o);
        await between(id);
        return p;
      });
      expect(await save(id, { policies })).toEqual({
        ok: false,
        error: "gone",
      });
      expect(await profileKeys()).toEqual([]);
    });
  }

  it("an unfinished session is gone and stays recording", async () => {
    const id = await session(walked(), null, false);
    expect(await save(id)).toEqual({ ok: false, error: "gone" });
    expect(await profileKeys()).toEqual([]);
    expect(await peek()).toMatchObject({ id, finished: false });
  });

  it("Record again keeps the profile id and createdAt, keeps unreached fields, replaces edited ones", async () => {
    const saved = savedProfile();
    await saveProfile(saved);
    // Walk step 0 only: acct is filled from the saved form (f1) and edited; step 1 is not reached.
    let b = observePage(seedBody(saved), keys(STEP0), "doc-9", "/billpay/one");
    if (b === "full") throw new Error("full");
    b = applyCapture(b, capture(STEP0[0]!, "99999", { fieldId: "f1" })).body;
    const id = await session(b, saved);
    const policies = await policiesOf(id);
    clock += 60_000;
    expect(await save(id, { policies, name: "Bill pay" })).toEqual({
      ok: true,
    });
    const p = await loadProfileForOrigin(ORIGIN);
    expect(p!.id).toBe(saved.id);
    expect(p!.createdAt).toBe(saved.createdAt);
    expect(p!.lastUsedAt).toBeNull();
    expect(p!.fields.map((f) => [f.id, f.value, f.policy])).toEqual([
      ["f1", "99999", "save"],
      ["f4", "45.12", "ask"],
    ]);
    expect(await profileKeys()).toEqual([`p:${saved.id}`]);
  });

  it("a site with a saved form that was not the seed: that form's id is kept", async () => {
    const saved = savedProfile();
    await saveProfile(saved);
    const id = await session(walked());
    expect(await save(id, { policies: await policiesOf(id) })).toEqual({
      ok: true,
    });
    const p = await loadProfileForOrigin(ORIGIN);
    expect(p!.id).toBe(saved.id);
    expect(p!.createdAt).toBe(saved.createdAt);
    expect(p!.fields).toHaveLength(3);
  });

  it("invalid: a prefix that misses a recorded page, or does not start with /", async () => {
    const id = await session(walked());
    const policies = await policiesOf(id);
    for (const pathPrefix of ["/billpay/one", "/other/", "billpay/", ""]) {
      expect(await save(id, { policies, pathPrefix })).toEqual({
        ok: false,
        error: "invalid",
      });
    }
    expect(await profileKeys()).toEqual([]);
    // The recording waits for a corrected save.
    expect(await peek()).toMatchObject({ id, finished: true });
    expect(await save(id, { policies, pathPrefix: "/" })).toEqual({
      ok: true,
    });
  });

  it("invalid: a blank name, a missing, unknown or repeated field policy", async () => {
    const id = await session(walked());
    const policies = await policiesOf(id);
    const bad: Partial<SaveReq>[] = [
      { policies, name: "   " },
      { policies: policies.slice(1) },
      { policies: [...policies, { fieldId: "f99", policy: "save" }] },
      { policies: [...policies, { fieldId: "f1", policy: "skip" }] },
      {
        policies: [...policies, { fieldId: "__proto__", policy: "save" }],
      },
    ];
    for (const over of bad) {
      expect(await save(id, over)).toEqual({ ok: false, error: "invalid" });
    }
    expect(await profileKeys()).toEqual([]);
  });

  it("invalid: an empty recording (the page offers Discard only) never replaces a saved form", async () => {
    const saved = savedProfile();
    await saveProfile(saved);
    const id = await session(emptyBody(), saved);
    expect(await save(id)).toEqual({ ok: false, error: "invalid" });
    expect((await loadProfileForOrigin(ORIGIN))!.fields).toHaveLength(2);
  });

  it("gone wins over invalid", async () => {
    expect(await save(ID, { name: "" })).toEqual({ ok: false, error: "gone" });
  });
});

describe("review-check", () => {
  const check = (sessionId: string) =>
    h()["review-check"]({ type: "review-check", sessionId });

  it("a finished session of that id is ready, and the check opens no body", async () => {
    const id = await session(walked());
    const opened = vi.spyOn(aead, "open");
    const set = vi.spyOn(fakeBrowser.storage.session, "set");
    expect(await check(id)).toEqual({ state: "ready" });
    expect(opened).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("locked, expired, unfinished, discarded or another id: gone", async () => {
    expect(await check(ID)).toEqual({ state: "gone" });
    const unfinished = await session(walked(), null, false);
    expect(await check(unfinished)).toEqual({ state: "gone" });
    const id = await session(walked());
    expect(await check(ID)).toEqual({ state: "gone" });
    await lock();
    expect(await check(id)).toEqual({ state: "gone" });
    expect((await unlockWithPassphrase(P)).ok).toBe(true);
    expect(await check(id)).toEqual({ state: "gone" }); // the lock ended it
    const id2 = await session(walked());
    clock += RECORDING_TTL_MS;
    expect(await check(id2)).toEqual({ state: "gone" });
    clock = T0;
    const id3 = await session(walked());
    await discardSession("cancelled", id3);
    expect(await check(id3)).toEqual({ state: "gone" });
  });

  it("a locked vault is gone even before the lock listener ended the session", async () => {
    const id = await session(walked());
    // Not through lock(): the vault state says locked while the record is still stored.
    vi.spyOn(vault, "status").mockResolvedValue({
      state: "locked",
    } as Awaited<ReturnType<typeof vault.status>>);
    expect(await check(id)).toEqual({ state: "gone" });
  });
});

describe("review-discard", () => {
  it("ends that session only", async () => {
    const id = await session(walked());
    expect(
      await h()["review-discard"]({ type: "review-discard", sessionId: ID }),
    ).toEqual({ ok: true });
    expect(await peek()).toMatchObject({ id });
    expect(
      await h()["review-discard"]({ type: "review-discard", sessionId: id }),
    ).toEqual({ ok: true });
    expect(await peek()).toBe("off");
    expect(await profileKeys()).toEqual([]);
  });
});

describe("wiring and parsing", () => {
  it("the worker's page handlers include the review requests", () => {
    const handlers = createPageHandlers(async () => newKdfParams());
    expect(typeof handlers["review-load"]).toBe("function");
    expect(typeof handlers["review-save"]).toBe("function");
    expect(typeof handlers["review-discard"]).toBe("function");
    expect(typeof handlers["review-check"]).toBe("function");
  });

  const good = {
    type: "review-save",
    sessionId: ID,
    name: "Bill pay",
    fillMode: "auto",
    pathPrefix: "/billpay/",
    policies: [{ fieldId: "f1", policy: "ask" }],
  };

  it("parses the three messages with exact keys into fresh objects", () => {
    expect(parsePageRequest({ type: "review-load", sessionId: ID })).toEqual({
      type: "review-load",
      sessionId: ID,
    });
    expect(parsePageRequest({ type: "review-check", sessionId: ID })).toEqual({
      type: "review-check",
      sessionId: ID,
    });
    expect(parsePageRequest({ type: "review-discard", sessionId: ID })).toEqual(
      { type: "review-discard", sessionId: ID },
    );
    const parsed = parsePageRequest(good);
    expect(parsed).toEqual(good);
    expect(parsed).not.toBe(good);
    if (parsed?.type !== "review-save") return;
    expect(parsed.policies[0]).not.toBe(good.policies[0]);
  });

  it("enforces the limits and shapes", () => {
    const policy = (i: number) => ({ fieldId: `f${i}`, policy: "save" });
    const bad: unknown[] = [
      { type: "review-load", sessionId: "a|b" },
      { type: "review-load", sessionId: "" },
      { type: "review-load", sessionId: "x".repeat(65) },
      { type: "review-load", sessionId: ID, extra: 1 },
      { type: "review-discard", sessionId: 5 },
      { type: "review-check", sessionId: "a|b" },
      { type: "review-check", sessionId: ID, origin: "https://a.example" },
      { ...good, sessionId: "not an id" },
      { ...good, name: "n".repeat(121) },
      { ...good, name: 5 },
      { ...good, pathPrefix: "/" + "p".repeat(256) },
      { ...good, fillMode: "always" },
      { ...good, policies: "f1" },
      { ...good, policies: Array.from({ length: 201 }, (_, i) => policy(i)) },
      { ...good, policies: [{ fieldId: "f1", policy: "fill" }] },
      { ...good, policies: [{ fieldId: "f|1", policy: "save" }] },
      { ...good, policies: [{ fieldId: "f1", policy: "save", x: 1 }] },
      { ...good, policies: [{ fieldId: "f1" }] },
      { ...good, policies: [null] },
      { ...good, policies: [["f1", "save"]] },
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
