// The page-only `fill-now` request (spec §6.3, §7; ADR 0038).
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
import { createPageHandlers } from "../../../src/lib/messaging/page-handlers";
import { parsePageRequest } from "../../../src/lib/messaging/protocol";
import { upsertSite } from "../../../src/lib/sites";
import { FILL_GRANT_MS, takeGrant } from "../../../src/lib/sites/fill-now";
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
const B = "https://b.example";
const T0 = 1_800_000_000_000;
// Grants live in module memory: a tab of its own per test keeps one from reaching the next.
let TAB = 30;

let snapshot: Record<string, unknown>;
let shims: ReturnType<typeof installShims>;
let sendMessage: ReturnType<typeof vi.fn>;
let clock: number;
const now = () => clock;

const fillNow = (tabId = TAB, origin = A) => {
  const req = parsePageRequest({ type: "fill-now", tabId, origin });
  if (req === null || req.type !== "fill-now") throw new Error("bad request");
  return createPageHandlers(() => Promise.resolve(newKdfParams()), now)[
    "fill-now"
  ](req);
};

/** Everything the handler needs: a site with a saved form, its permission, and a tab showing it. */
async function ready() {
  await upsertSite(A, { profileId: "prof1" });
  shims.grant(originPattern(A));
  shims.setTab(TAB, A + "/signup");
}

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
  TAB += 1;
  clock = T0;
  shims = installShims();
  vi.spyOn(console, "error").mockImplementation(() => {});
  sendMessage = vi.fn(async () => undefined);
  (fakeBrowser.tabs as unknown as { sendMessage: unknown }).sendMessage =
    sendMessage;
});

afterEach(() => vi.restoreAllMocks());

/** A refusal leaves no grant and sends no nudge. */
function expectRefused(tabId = TAB, origin = A) {
  expect(takeGrant(tabId, origin, clock)).toBe(false);
  expect(sendMessage).not.toHaveBeenCalled();
}

describe("fill-now", () => {
  it("grants, nudges the tab once and answers ok", async () => {
    await ready();
    expect(await fillNow()).toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      TAB,
      { type: "refill-nudge" },
      { frameId: 0 },
    );
    // The grant is the worker's clock's: valid for 10 s from now, for this tab and origin only.
    clock = T0 + FILL_GRANT_MS - 1;
    expect(takeGrant(TAB, B, clock)).toBe(false);
    expect(takeGrant(TAB + 1, A, clock)).toBe(false);
    expect(takeGrant(TAB, A, clock)).toBe(true);
  });

  it("the grant is granted before the nudge, so the nudged scan can take it", async () => {
    await ready();
    let takenDuringNudge: boolean | undefined;
    sendMessage.mockImplementation(async () => {
      takenDuringNudge = takeGrant(TAB, A, clock);
    });
    expect(await fillNow()).toEqual({ ok: true });
    expect(takenDuringNudge).toBe(true);
  });

  it("answers ok even when the tab has no content script to nudge", async () => {
    await ready();
    sendMessage.mockRejectedValue(new Error("Could not establish connection"));
    expect(await fillNow()).toEqual({ ok: true });
  });

  it("invalid-origin: not a canonical https origin", async () => {
    await ready();
    for (const origin of [A + "/path", "http://a.example", "https://*"]) {
      expect(await fillNow(TAB, origin)).toEqual({
        ok: false,
        error: "invalid-origin",
      });
    }
    expectRefused();
  });

  it("locked", async () => {
    await ready();
    await lock();
    expect(await fillNow()).toEqual({ ok: false, error: "locked" });
    expectRefused();
  });

  it("not-granted: no host permission", async () => {
    await ready();
    shims.revoke(originPattern(A));
    expect(await fillNow()).toEqual({ ok: false, error: "not-granted" });
    expectRefused();
  });

  it("not-granted: the site is not enabled", async () => {
    shims.grant(originPattern(A));
    shims.setTab(TAB, A + "/");
    expect(await fillNow()).toEqual({ ok: false, error: "not-granted" });
    expectRefused();
  });

  it("not-granted: access revoked on the site record", async () => {
    await ready();
    await upsertSite(A, { accessRevoked: true });
    expect(await fillNow()).toEqual({ ok: false, error: "not-granted" });
    expectRefused();
  });

  it("no-profile: an enabled site without a saved form", async () => {
    await ready();
    await upsertSite(A, { profileId: null });
    expect(await fillNow()).toEqual({ ok: false, error: "no-profile" });
    expectRefused();
  });

  it("tab-moved: the tab shows another origin, or is closed", async () => {
    await ready();
    shims.setTab(TAB, B + "/");
    expect(await fillNow()).toEqual({ ok: false, error: "tab-moved" });
    shims.closeTab(TAB);
    expect(await fillNow()).toEqual({ ok: false, error: "tab-moved" });
    expectRefused();
  });

  it("checks in order: origin, lock, permission and site, profile, tab", async () => {
    // Everything wrong at once: each fix reveals the next error.
    await upsertSite(A, { profileId: null });
    shims.setTab(TAB, B + "/");
    await lock();
    expect(await fillNow(TAB, A + "/x")).toEqual({
      ok: false,
      error: "invalid-origin",
    });
    expect(await fillNow()).toEqual({ ok: false, error: "locked" });
    expect((await unlockWithPassphrase(P)).ok).toBe(true);
    expect(await fillNow()).toEqual({ ok: false, error: "not-granted" });
    shims.grant(originPattern(A));
    expect(await fillNow()).toEqual({ ok: false, error: "no-profile" });
    await upsertSite(A, { profileId: "prof1" });
    expect(await fillNow()).toEqual({ ok: false, error: "tab-moved" });
    shims.setTab(TAB, A + "/");
    expect(await fillNow()).toEqual({ ok: true });
  });

  it("a second Fill now replaces the grant and nudges again", async () => {
    await ready();
    expect(await fillNow()).toEqual({ ok: true });
    clock = T0 + 8_000;
    expect(await fillNow()).toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    clock = T0 + 15_000; // past the first grant, inside the second
    expect(takeGrant(TAB, A, clock)).toBe(true);
  });
});
