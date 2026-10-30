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
import {
  createContentHandlers,
  LAST_USED_THROTTLE_MS,
} from "../../../src/lib/messaging/content-handlers";
import type { ContentRequest } from "../../../src/lib/messaging/content-protocol";
import { createPageHandlers } from "../../../src/lib/messaging/page-handlers";
import {
  createRouter,
  type ContentContext,
} from "../../../src/lib/messaging/router";
import {
  loadProfileForOrigin,
  saveProfile,
} from "../../../src/lib/profiles/store";
import type { Profile, ProfileField } from "../../../src/lib/profiles/types";
import { sigKey } from "../../../src/lib/match/match";
import { readSites, upsertSite } from "../../../src/lib/sites";
import { createSiteHandlers } from "../../../src/lib/sites/handlers";
import {
  getItem,
  profileKey,
  withStoreLock,
} from "../../../src/lib/store/local";
import { originPattern } from "../../../src/lib/sites/origin";
import {
  __resetForTests,
  createVault,
  lock,
  unlockWithPassphrase,
} from "../../../src/lib/vault/vault";
import { installShims } from "../helpers/browser-shims";

const P = "correct horse battery staple";
const A = "https://a.example";
const RUNTIME_ID = "abcdefghijklmnopabcdefghijklmnop";
const T0 = 1_800_000_000_000;

type Sig = ProfileField["sig"];
const sig = (o: Partial<Sig>): Sig => ({
  name: null,
  idStable: null,
  autocomplete: null,
  type: "text",
  labelText: null,
  ordinal: 0,
  formAction: null,
  nameIdDerived: false,
  ...o,
});

const EMAIL = sig({
  name: "email",
  autocomplete: "email",
  type: "email",
  labelText: "email",
});
const PHONE = sig({
  name: "phone",
  autocomplete: "tel",
  type: "tel",
  labelText: "phone",
  ordinal: 1,
});
const NOTE = sig({ name: "note", labelText: "note", ordinal: 2 });
const ZIP = sig({
  name: "zip",
  autocomplete: "postal-code",
  labelText: "zip",
  ordinal: 3,
});

// Distinct secrets, so a leak of any one of them is visible in a serialized reply.
const SECRET = {
  email: "jane@secret.example",
  emailDefault: "default@page.example",
  phone: "ASK-SECRET-555",
  note: "SKIP-SECRET-NOTE",
  zip: "UNMATCHED-SECRET-ZIP",
};

const field = (
  id: string,
  s: Sig,
  value: string,
  policy: ProfileField["policy"],
  pageDefault = "",
): ProfileField => ({
  id,
  sig: s,
  step: 0,
  kind: "text",
  value,
  pageDefault,
  policy,
});

function profile(o: Partial<Profile> = {}): Profile {
  return {
    v: 1,
    id: "prof1",
    name: "Signup",
    origin: A,
    pathPrefix: "/signup",
    fillMode: "auto",
    createdAt: 1000,
    lastUsedAt: null,
    steps: [{ index: 0, pathHint: "/signup", fingerprint: [] }],
    fields: [
      field("f_email", EMAIL, SECRET.email, "save", SECRET.emailDefault),
      field("f_phone", PHONE, SECRET.phone, "ask"),
      field("f_note", NOTE, SECRET.note, "skip"),
      field("f_zip", ZIP, SECRET.zip, "save"),
    ],
    ...o,
  };
}

/** The page has email, phone and note, but no zip control. */
const PAGE = [
  { i: 0, kind: "text" as const, sig: EMAIL },
  { i: 1, kind: "text" as const, sig: PHONE },
  { i: 2, kind: "text" as const, sig: NOTE },
];

const pageKey = (c: (typeof PAGE)[number]) => sigKey(c.sig, c.kind);

/** A control that no recorded field resembles. */
const stranger = (i: number) => ({
  i,
  kind: "text" as const,
  sig: sig({ name: `other${i}`, labelText: `other ${i}`, ordinal: i }),
});

const scan = (
  controls: Extract<ContentRequest, { type: "scan-report" }>["controls"] = PAGE,
): Extract<ContentRequest, { type: "scan-report" }> => ({
  type: "scan-report",
  controls,
  truncated: false,
});

const ctx = (pathname = "/signup/step1"): ContentContext => ({
  origin: A,
  pathname,
  tabId: 7,
  documentId: "doc-1",
});

function expectNoSecrets(reply: unknown, allowed: string[] = []): void {
  const json = JSON.stringify(reply);
  for (const s of Object.values(SECRET)) {
    if (!allowed.includes(s)) expect(json).not.toContain(s);
  }
}

/** Pauses the next read of `key` until `release()`; `started` resolves when it begins. */
function pauseRead(key: string) {
  const local = fakeBrowser.storage.local;
  const original = local.get.bind(local);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const started = new Promise<void>((r) => (entered = r));
  vi.spyOn(local, "get").mockImplementation((async (k: unknown) => {
    if (k === key) {
      entered();
      await gate;
    }
    return original(k as string);
  }) as never);
  return { started, release };
}

let snapshot: Record<string, unknown>;
let clock: number;
const now = () => clock;

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
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../../../src/lib/profiles/store");
  vi.doUnmock("../../../src/lib/vault/vault");
});

describe("scan-report", () => {
  it("auto: values only for matched save fields; ask, skip and unmatched never leave", async () => {
    await saveProfile(profile());
    const reply = await createContentHandlers(now)["scan-report"](
      scan(),
      ctx(),
    );
    expect(reply).toEqual({
      state: "fill",
      items: [
        {
          fieldId: "f_email",
          i: 0,
          kind: "text",
          value: SECRET.email,
          pageDefault: SECRET.emailDefault,
        },
      ],
      ask: [1],
      recording: false,
    });
    expectNoSecrets(reply, [SECRET.email, SECRET.emailDefault]);
  });

  it("ask holds the control index of every matched ask field, and no value", async () => {
    await saveProfile(profile());
    const reply = (await createContentHandlers(now)["scan-report"](
      scan(),
      ctx(),
    )) as { state: string; items: unknown[]; ask: number[] };
    expect(reply.state).toBe("fill");
    expect(reply.items).toHaveLength(1);
    expect(reply.ask).toEqual([PAGE[1]!.i]);
    // An unmatched ask field is not listed.
    const noPhone = (await createContentHandlers(now)["scan-report"](
      scan([PAGE[0]!]),
      ctx(),
    )) as { ask: number[] };
    expect(noPhone.ask).toEqual([]);
  });

  it("locked, site with a saved form: {state: locked} and nothing else", async () => {
    await saveProfile(profile());
    expect((await readSites())[A]?.profileId).toBe("prof1");
    await lock();
    const reply = await createContentHandlers(now)["scan-report"](
      scan(),
      ctx(),
    );
    expect(reply).toEqual({ state: "locked" });
  });

  it("locked, site without a saved form: none", async () => {
    await upsertSite(A, {});
    await lock();
    const reply = await createContentHandlers(now)["scan-report"](
      scan(),
      ctx(),
    );
    expect(reply).toEqual({ state: "none" });
  });

  it("locked answers from the site index alone: no key, no profile read", async () => {
    await saveProfile(profile());
    await lock();
    const get = vi.spyOn(fakeBrowser.storage.local, "get");
    await createContentHandlers(now)["scan-report"](scan(), ctx());
    expect(get.mock.calls.flat()).not.toContain(profileKey("prof1"));
  });

  it("locked, another origin's saved form does not count: none", async () => {
    await saveProfile(profile());
    await lock();
    const reply = await createContentHandlers(now)["scan-report"](scan(), {
      ...ctx(),
      origin: "https://b.example",
    });
    expect(reply).toEqual({ state: "none" });
  });

  it("no vault at all is reported as none (no site has a saved form)", async () => {
    fakeBrowser.reset();
    __resetForTests();
    const reply = await createContentHandlers(now)["scan-report"](
      scan(),
      ctx(),
    );
    expect(reply).toEqual({ state: "none" });
  });

  it("a lock landing before the profile decrypt (LockedError) is reported as locked", async () => {
    await saveProfile(profile());
    const read = pauseRead("sites");
    const pending = createContentHandlers(now)["scan-report"](scan(), ctx());
    await read.started; // status() said unlocked; the DEK is not taken yet
    await lock();
    read.release();
    expect(await pending).toEqual({ state: "locked" });
  });

  it("any other load failure propagates (the router answers internal)", async () => {
    vi.resetModules();
    vi.doMock("../../../src/lib/vault/vault", () => ({
      lockEpoch: () => 0,
      status: async () => ({ state: "unlocked", unlockedAt: 0, lock: {} }),
    }));
    vi.doMock("../../../src/lib/profiles/store", () => ({
      loadProfileForOrigin: async () => {
        throw new RangeError("boom");
      },
      touchLastUsed: async () => {},
    }));
    const mod = await import("../../../src/lib/messaging/content-handlers");
    await expect(
      mod.createContentHandlers(now)["scan-report"](scan(), ctx()),
    ).rejects.toThrow(RangeError);
  });

  it("no profile for the site: none", async () => {
    await upsertSite(A, {});
    const reply = await createContentHandlers(now)["scan-report"](
      scan(),
      ctx(),
    );
    expect(reply).toEqual({ state: "none" });
  });

  it.each(["/signupx", "/other", "/"])(
    "path %s outside the prefix, on a page unlike the recorded form: none",
    async (pathname) => {
      // The step's fingerprint is the recorded form (email, phone, note); this page shares only
      // the email control with it among four others (J = 1/7).
      await saveProfile(
        profile({
          steps: [
            { index: 0, pathHint: "/signup", fingerprint: PAGE.map(pageKey) },
          ],
        }),
      );
      const unlike = [PAGE[0]!, ...[1, 2, 3, 4].map(stranger)];
      const handlers = createContentHandlers(now);
      expect(
        await handlers["scan-report"](scan(unlike), ctx(pathname)),
      ).toEqual({ state: "none" });
      // The same page under the prefix fills the email: only the path made the difference.
      expect(await handlers["scan-report"](scan(unlike), ctx())).toMatchObject({
        state: "fill",
        items: [{ fieldId: "f_email" }],
      });
    },
  );

  it.each(["/Signup", "/SIGNUP/step1", "/signUp/x"])(
    "path %s is under the prefix in another case: fill (ADR 0034)",
    async (pathname) => {
      await saveProfile(profile());
      const reply = await createContentHandlers(now)["scan-report"](
        scan(),
        ctx(pathname),
      );
      expect(reply).toMatchObject({
        state: "fill",
        items: [{ fieldId: "f_email" }],
      });
    },
  );

  it("the prefix itself applies", async () => {
    await saveProfile(profile());
    const reply = await createContentHandlers(now)["scan-report"](
      scan(),
      ctx("/signup"),
    );
    expect(reply).toMatchObject({ state: "fill" });
  });

  it("gesture: the ids of the matched save fields and no values", async () => {
    await saveProfile(profile({ fillMode: "gesture" }));
    const reply = await createContentHandlers(now)["scan-report"](
      scan(),
      ctx(),
    );
    expect(reply).toEqual({ state: "gesture", fieldIds: ["f_email"] });
    expectNoSecrets(reply);
    // Not a value anywhere: the plan holds ids only.
    expect(JSON.stringify(reply)).not.toContain(SECRET.email);
    expect(JSON.stringify(reply)).not.toContain("value");
  });

  it("zero matched save fields: none (auto and gesture)", async () => {
    const onlyAskAndSkip = scan([PAGE[1]!, PAGE[2]!]);
    await saveProfile(profile());
    const handlers = createContentHandlers(now);
    expect(await handlers["scan-report"](onlyAskAndSkip, ctx())).toEqual({
      state: "none",
    });
    await saveProfile(profile({ fillMode: "gesture" }));
    expect(await handlers["scan-report"](onlyAskAndSkip, ctx())).toEqual({
      state: "none",
    });
  });

  it("an unmatched saved field never appears, even when the page has an unmatched control", async () => {
    await saveProfile(profile());
    const stranger = {
      i: 9,
      kind: "text" as const,
      sig: sig({ name: "zip-ish", ordinal: 3 }),
    };
    const reply = await createContentHandlers(now)["scan-report"](
      scan([...PAGE, stranger]),
      ctx(),
    );
    expectNoSecrets(reply, [SECRET.email, SECRET.emailDefault]);
  });

  it("an ask field still claims its control: a save field cannot take it over", async () => {
    // Both claim control 0; the conflict drops both, so nothing is filled.
    const twin = { ...EMAIL };
    await saveProfile(
      profile({
        fields: [
          field("f_save", twin, "TWIN-SAVE", "save"),
          field("f_ask", EMAIL, "TWIN-ASK", "ask"),
        ],
      }),
    );
    const reply = await createContentHandlers(now)["scan-report"](
      scan([PAGE[0]!]),
      ctx(),
    );
    expect(reply).toEqual({ state: "none" });
  });
});

describe("scan-report off the path prefix (ADR 0034)", () => {
  const key = pageKey;
  /** The step's fingerprint is this page: what the recorder files for it. */
  const recorded = (o: Partial<Profile> = {}) =>
    profile({
      steps: [{ index: 0, pathHint: "/signup", fingerprint: PAGE.map(key) }],
      ...o,
    });
  const FILL_EMAIL = {
    state: "fill",
    items: [
      {
        fieldId: "f_email",
        i: 0,
        kind: "text",
        value: SECRET.email,
        pageDefault: SECRET.emailDefault,
      },
    ],
    recording: false,
  };

  it("a single-step profile fills a page that is the recorded form, off-path (J = 1)", async () => {
    await saveProfile(recorded());
    const reply = await createContentHandlers(now)["scan-report"](
      scan(),
      ctx("/register/search"),
    );
    // The phone field is matched too (policy ask): control 1.
    expect(reply).toEqual({ ...FILL_EMAIL, ask: [1] });
    expectNoSecrets(reply, [SECRET.email, SECRET.emailDefault]);
  });

  it("gesture mode is kept off-path: ids and no values", async () => {
    await saveProfile(recorded({ fillMode: "gesture" }));
    const reply = await createContentHandlers(now)["scan-report"](
      scan(),
      ctx("/register/search"),
    );
    expect(reply).toEqual({ state: "gesture", fieldIds: ["f_email"] });
    expectNoSecrets(reply);
  });

  it("off-path with one shared key among many different ones (J < 0.5): none", async () => {
    await saveProfile(recorded());
    const page = [PAGE[0]!, stranger(1), stranger(2), stranger(3)];
    const reply = await createContentHandlers(now)["scan-report"](
      scan(page),
      ctx("/newsletter"),
    );
    expect(reply).toEqual({ state: "none" });
    expectNoSecrets(reply);
  });

  it("on-path, the same single shared key still fills as before", async () => {
    await saveProfile(recorded());
    const page = [PAGE[0]!, stranger(1), stranger(2), stranger(3)];
    const reply = await createContentHandlers(now)["scan-report"](
      scan(page),
      ctx(),
    );
    expect(reply).toEqual({ ...FILL_EMAIL, ask: [] });
  });

  it("multi-step off-path: only fields whose own step reaches MIN_JACCARD fill", async () => {
    const zipControl = { i: 3, kind: "text" as const, sig: ZIP };
    await saveProfile(
      recorded({
        steps: [
          // Step 0 shows email, phone and note: J = 3/4 on the page below.
          { index: 0, pathHint: "/signup", fingerprint: PAGE.map(key) },
          // Step 1 shows zip and three controls not on the page: J = 1/7, and not the max.
          {
            index: 1,
            pathHint: "/signup/2",
            fingerprint: [
              key(zipControl),
              "text|a|a|",
              "text|b|b|",
              "text|c|c|",
            ],
          },
        ],
        fields: [
          field("f_email", EMAIL, SECRET.email, "save", SECRET.emailDefault),
          { ...field("f_zip", ZIP, SECRET.zip, "save"), step: 1 },
        ],
      }),
    );
    const reply = await createContentHandlers(now)["scan-report"](
      scan([...PAGE, zipControl]),
      ctx("/elsewhere"),
    );
    expect(reply).toEqual({ ...FILL_EMAIL, ask: [] });
    expectNoSecrets(reply, [SECRET.email, SECRET.emailDefault]);
  });

  it("multi-step, steps tied below MIN_JACCARD: both fill on-path, none off-path", async () => {
    const zipControl = { i: 3, kind: "text" as const, sig: ZIP };
    const page = [PAGE[0]!, zipControl, stranger(4), stranger(5)];
    await saveProfile(
      recorded({
        steps: [
          // Each fingerprint shares one key with the page and has one of its own: J = 1/5 each.
          {
            index: 0,
            pathHint: "/signup",
            fingerprint: [key(PAGE[0]!), "text|a|a|"],
          },
          {
            index: 1,
            pathHint: "/signup/2",
            fingerprint: [key(zipControl), "text|b|b|"],
          },
        ],
        fields: [
          field("f_email", EMAIL, SECRET.email, "save", SECRET.emailDefault),
          { ...field("f_zip", ZIP, SECRET.zip, "save"), step: 1 },
        ],
      }),
    );
    const handlers = createContentHandlers(now);
    expect(await handlers["scan-report"](scan(page), ctx())).toMatchObject({
      state: "fill",
      items: [{ fieldId: "f_email" }, { fieldId: "f_zip" }],
    });
    const off = await handlers["scan-report"](scan(page), ctx("/elsewhere"));
    expect(off).toEqual({ state: "none" });
    expectNoSecrets(off);
  });

  it("a different origin: none, even with the recorded form at the prefix", async () => {
    await saveProfile(recorded());
    const reply = await createContentHandlers(now)["scan-report"](scan(), {
      ...ctx("/signup"),
      origin: "https://b.example",
    });
    expect(reply).toEqual({ state: "none" });
  });

  it("a loaded profile for another origin is never used, on-path or off", async () => {
    vi.resetModules();
    vi.doMock("../../../src/lib/vault/vault", () => ({
      lockEpoch: () => 0,
      status: async () => ({ state: "unlocked", unlockedAt: 0, lock: {} }),
    }));
    vi.doMock("../../../src/lib/profiles/store", () => ({
      loadProfileForOrigin: async () => recorded(),
      touchLastUsed: async () => {},
    }));
    const mod = await import("../../../src/lib/messaging/content-handlers");
    const handlers = mod.createContentHandlers(now);
    for (const pathname of ["/signup", "/elsewhere"]) {
      expect(
        await handlers["scan-report"](scan(), {
          ...ctx(pathname),
          origin: "https://b.example",
        }),
      ).toEqual({ state: "none" });
    }
  });
});

describe("lock racing the profile read", () => {
  it("a lock landing during the profile read: locked, no values", async () => {
    await saveProfile(profile());
    const read = pauseRead(profileKey("prof1"));
    const pending = createContentHandlers(now)["scan-report"](scan(), ctx());
    await read.started; // the DEK is already in hand here
    await lock();
    read.release();
    const reply = await pending;
    expect(reply).toEqual({ state: "locked" });
    expectNoSecrets(reply);
  });

  it("gesture: a lock during the read reports locked, not ids", async () => {
    await saveProfile(profile({ fillMode: "gesture" }));
    const read = pauseRead(profileKey("prof1"));
    const pending = createContentHandlers(now)["scan-report"](scan(), ctx());
    await read.started;
    await lock();
    read.release();
    expect(await pending).toEqual({ state: "locked" });
  });
});

describe("lastUsedAt", () => {
  const stored = async () => (await loadProfileForOrigin(A))?.lastUsedAt;

  it("is set from the worker clock when items are returned, throttled to once per 60 s", async () => {
    expect(LAST_USED_THROTTLE_MS).toBe(60_000);
    await saveProfile(profile());
    const handlers = createContentHandlers(now);
    await handlers["scan-report"](scan(), ctx());
    await vi.waitFor(async () => expect(await stored()).toBe(T0));

    const set = vi.spyOn(fakeBrowser.storage.local, "set");
    clock = T0 + LAST_USED_THROTTLE_MS - 1;
    await handlers["scan-report"](scan(), ctx());
    await new Promise((r) => setTimeout(r, 20));
    expect(set).not.toHaveBeenCalled();
    expect(await stored()).toBe(T0);

    clock = T0 + LAST_USED_THROTTLE_MS;
    await handlers["scan-report"](scan(), ctx());
    await vi.waitFor(async () =>
      expect(await stored()).toBe(T0 + LAST_USED_THROTTLE_MS),
    );
  });

  it("keeps the rest of the profile intact", async () => {
    await saveProfile(profile());
    await createContentHandlers(now)["scan-report"](scan(), ctx());
    await vi.waitFor(async () => expect(await stored()).toBe(T0));
    expect(await loadProfileForOrigin(A)).toEqual(profile({ lastUsedAt: T0 }));
  });

  it("is not set for gesture, none or locked replies", async () => {
    const handlers = createContentHandlers(now);
    await saveProfile(profile({ fillMode: "gesture" }));
    await handlers["scan-report"](scan(), ctx());
    await saveProfile(profile());
    await handlers["scan-report"](scan(), ctx("/other"));
    await handlers["scan-report"](scan([PAGE[1]!]), ctx());
    await new Promise((r) => setTimeout(r, 20));
    expect(await stored()).toBeNull();
  });

  it("a failed update never changes the reply", async () => {
    await saveProfile(profile());
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(fakeBrowser.storage.local, "set").mockRejectedValue(
      new Error("QUOTA_BYTES quota exceeded"),
    );
    const reply = await createContentHandlers(now)["scan-report"](
      scan(),
      ctx(),
    );
    expect(reply).toMatchObject({
      state: "fill",
      items: [{ fieldId: "f_email" }],
    });
    await vi.waitFor(() => expect(err).toHaveBeenCalled());
    // The log holds the error name, never its message.
    expect(JSON.stringify(err.mock.calls)).not.toContain("quota");
  });

  it("a site removal that lands before the touch is never undone", async () => {
    installShims();
    await saveProfile(profile());
    let release!: () => void;
    const held = withStoreLock(() => new Promise<void>((r) => (release = r)));
    // Queued behind the held lock, ahead of the touch the scan below will queue.
    const removal = createSiteHandlers(now)["site-remove"]({
      type: "site-remove",
      origin: A,
    });
    const reply = await createContentHandlers(now)["scan-report"](
      scan(),
      ctx(),
    );
    expect(reply).toMatchObject({ state: "fill" }); // read before the removal ran
    release();
    await held;
    await removal;
    await new Promise((r) => setTimeout(r, 20));
    expect(await readSites()).toEqual({});
    expect(await getItem(profileKey("prof1"))).toBeUndefined();
  });

  it("an edit that lands before the touch survives (policy change kept)", async () => {
    await saveProfile(profile());
    let release!: () => void;
    const held = withStoreLock(() => new Promise<void>((r) => (release = r)));
    const edited = profile({ name: "Edited" });
    edited.fields[0] = { ...edited.fields[0]!, policy: "skip" };
    const edit = saveProfile(edited);
    const reply = await createContentHandlers(now)["scan-report"](
      scan(),
      ctx(),
    );
    expect(reply).toMatchObject({ state: "fill" }); // computed from the pre-edit record
    release();
    await held;
    await edit;
    await vi.waitFor(async () =>
      expect(await loadProfileForOrigin(A)).toEqual({
        ...edited,
        lastUsedAt: T0,
      }),
    );
  });

  it("a lock that lands before the touch writes nothing and logs nothing", async () => {
    await saveProfile(profile());
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let release!: () => void;
    const held = withStoreLock(() => new Promise<void>((r) => (release = r)));
    const reply = await createContentHandlers(now)["scan-report"](
      scan(),
      ctx(),
    );
    expect(reply).toMatchObject({ state: "fill" });
    await lock();
    release();
    await held;
    await new Promise((r) => setTimeout(r, 20));
    expect(err).not.toHaveBeenCalled();
    expect(await unlockWithPassphrase(P)).toMatchObject({ ok: true });
    expect(await stored()).toBeNull();
  });

  it("a busy store lock does not delay the reply", async () => {
    await saveProfile(profile());
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const busy = withStoreLock(() => held);
    const reply = await createContentHandlers(now)["scan-report"](
      scan(),
      ctx(),
    );
    expect(reply).toMatchObject({ state: "fill" });
    expect(await stored()).toBeNull(); // the write waits behind the held lock
    release();
    await busy;
    await vi.waitFor(async () => expect(await stored()).toBe(T0));
  });
});

describe("toast-unlock-click", () => {
  const click = { type: "toast-unlock-click" } as const;
  const stub = (impl: () => Promise<void>) => {
    const openPopup = vi.fn(impl);
    (fakeBrowser as unknown as { action: unknown }).action = { openPopup };
    return openPopup;
  };

  it("opens the popup and answers ok: true", async () => {
    const openPopup = stub(async () => {});
    expect(
      await createContentHandlers(now)["toast-unlock-click"](click, ctx()),
    ).toEqual({ ok: true });
    expect(openPopup).toHaveBeenCalledOnce();
  });

  it("answers ok: false when the popup cannot open, logging the error name only", async () => {
    stub(() => Promise.reject(new Error("no user gesture SECRET-MESSAGE")));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await createContentHandlers(now)["toast-unlock-click"](click, ctx()),
    ).toEqual({ ok: false });
    expect(err).toHaveBeenCalledOnce();
    expect(JSON.stringify(err.mock.calls)).toContain("Error");
    expect(JSON.stringify(err.mock.calls)).not.toContain("SECRET-MESSAGE");
  });

  it("goes through the router for an enabled, granted site", async () => {
    const shims = installShims();
    shims.grant(originPattern(A));
    await saveProfile(profile());
    stub(async () => {});
    (fakeBrowser.runtime as { id: string }).id = RUNTIME_ID;
    const r = createRouter({
      page: createPageHandlers(async () => newKdfParams()),
      content: createContentHandlers(now),
    });
    const sender = {
      id: RUNTIME_ID,
      url: `${A}/signup/step1`,
      origin: A,
      frameId: 0,
      documentId: "doc-1",
      tab: { id: 7, url: `${A}/signup/step1` },
    } as Parameters<typeof r>[1];
    expect(await r(click, sender)).toEqual({ ok: true });
    expect(await r({ ...click, tabId: 1 }, sender)).toEqual({
      ok: false,
      error: "rejected",
    });
  });
});

describe("fill-result", () => {
  it("answers ok and writes nothing", async () => {
    const set = vi.spyOn(fakeBrowser.storage.local, "set");
    const reply = await createContentHandlers(now)["fill-result"](
      { type: "fill-result", filled: 1, skipped: 2, unsupported: 0 },
      ctx(),
    );
    expect(reply).toEqual({ ok: true });
    expect(set).not.toHaveBeenCalled();
  });
});

describe("through the real router", () => {
  const sender = (o: Record<string, unknown> = {}) =>
    ({
      id: RUNTIME_ID,
      url: `${A}/signup/step1?x=1#y`,
      origin: A,
      frameId: 0,
      documentId: "doc-1",
      tab: { id: 7, url: `${A}/signup/step1` },
      ...o,
    }) as Parameters<ReturnType<typeof createRouter>>[1];

  function route() {
    (fakeBrowser.runtime as { id: string }).id = RUNTIME_ID;
    return createRouter({
      page: createPageHandlers(async () => newKdfParams()),
      content: createContentHandlers(now),
    });
  }

  it("an enabled, granted site gets its fill plan; the payload cannot pick the origin", async () => {
    const shims = installShims();
    shims.grant(originPattern(A));
    await saveProfile(profile());
    const r = route();
    expect(await r(scan(), sender())).toMatchObject({
      state: "fill",
      items: [{ fieldId: "f_email", value: SECRET.email }],
    });
    expect(
      await r({ ...scan(), origin: "https://b.example" }, sender()),
    ).toEqual({ ok: false, error: "rejected" });
    expect(
      await r(
        { type: "fill-result", filled: 1, skipped: 0, unsupported: 0 },
        sender(),
      ),
    ).toEqual({ ok: true });
  });

  it("revoked, not granted, or a mismatched url: rejected", async () => {
    const shims = installShims();
    shims.grant(originPattern(A));
    await saveProfile(profile());
    const r = route();
    const REJECTED = { ok: false, error: "rejected" };

    expect(
      await r(scan(), sender({ url: "https://b.example/signup" })),
    ).toEqual(REJECTED);

    shims.grants.clear();
    expect(await r(scan(), sender())).toEqual(REJECTED);
    shims.grant(originPattern(A));

    await upsertSite(A, { accessRevoked: true });
    expect(await r(scan(), sender())).toEqual(REJECTED);
    await upsertSite(A, { accessRevoked: false });
    expect(await r(scan(), sender())).toMatchObject({ state: "fill" });
  });

  it("another port of an enabled site: rejected even when the permission covers it", async () => {
    // The default-port pattern covers every port (ADR 0018); the exact-origin record does not.
    const shims = installShims();
    shims.permissions.contains.mockImplementation(async () => true);
    await saveProfile(profile());
    const port = `${A}:8443`;
    expect(
      await route()(scan(), sender({ origin: port, url: `${port}/signup` })),
    ).toEqual({ ok: false, error: "rejected" });
    expect(await route()(scan(), sender())).toMatchObject({ state: "fill" });
  });

  it("locked vault through the router: locked for a saved form, no values", async () => {
    const shims = installShims();
    shims.grant(originPattern(A));
    await saveProfile(profile());
    await lock();
    const reply = await route()(scan(), sender());
    expect(reply).toEqual({ state: "locked" });
  });
});
