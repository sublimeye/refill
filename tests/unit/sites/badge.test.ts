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
  BADGE_RECORDING,
  startSession,
} from "../../../src/lib/recorder/session";
import { upsertSite } from "../../../src/lib/sites";
import {
  BADGE_LOCKED,
  badgeCount,
  installBadgeListeners,
  profileTabs,
  showFillCount,
  showLocked,
} from "../../../src/lib/sites/badge";
import {
  __resetForTests,
  createVault,
  lock,
  unlockWithPassphrase,
} from "../../../src/lib/vault/vault";

const P = "correct horse battery staple";
const A = "https://a.example";
const B = "https://b.example";
const NOSAVED = "https://nosaved.example";
const REVOKED = "https://revoked.example";
const NOT_ENABLED = "https://notenabled.example";

let snapshot: Record<string, unknown>;
let sendMessage: ReturnType<typeof vi.fn>;
let tabs: { id?: number; url?: string | undefined }[];

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
  sendMessage = vi.fn(async () => undefined);
  (fakeBrowser.tabs as unknown as { sendMessage: unknown }).sendMessage =
    sendMessage;
  await upsertSite(A, { profileId: "pa" });
  await upsertSite(B, { profileId: "pb" });
  await upsertSite(NOSAVED, {});
  await upsertSite(REVOKED, { profileId: "pr", accessRevoked: true });
  tabs = [
    { id: 1, url: `${A}/one` },
    { id: 2, url: `${B}/two?x=1` },
    { id: 3, url: `${NOSAVED}/` },
    { id: 4, url: `${REVOKED}/` },
    { id: 5, url: `${NOT_ENABLED}/` },
    { id: 6, url: undefined },
    { id: 7, url: "chrome://extensions" },
    { url: `${A}/no-id` },
  ];
  vi.spyOn(fakeBrowser.tabs, "query").mockImplementation(
    (async () => tabs) as never,
  );
  installBadgeListeners();
});

afterEach(() => vi.restoreAllMocks());

const badge = (tabId: number) => fakeBrowser.action.getBadgeText({ tabId });

describe("badgeCount", () => {
  it("is empty outside 1..200", () => {
    expect(badgeCount(0)).toBe("");
    expect(badgeCount(1)).toBe("1");
    expect(badgeCount(200)).toBe("200");
    expect(badgeCount(201)).toBe("");
    expect(badgeCount(-1)).toBe("");
  });
});

describe("showFillCount", () => {
  it("sets the count", async () => {
    await showFillCount(1, 3);
    expect(await badge(1)).toBe("3");
  });

  it("clears the badge for a count of 0 (after Undo)", async () => {
    await showFillCount(1, 3);
    await showFillCount(1, 0);
    expect(await badge(1)).toBe("");
  });

  it("leaves the recording badge on a recording tab", async () => {
    await startSession(1, A, Date.now(), null);
    expect(await badge(1)).toBe(BADGE_RECORDING);
    await showFillCount(1, 3);
    expect(await badge(1)).toBe(BADGE_RECORDING);
  });

  it("sets nothing while the vault is locked", async () => {
    await lock();
    await showFillCount(1, 3);
    expect(await badge(1)).toBe("");
  });

  it("logs a badge failure by error name only and does not throw", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(fakeBrowser.action, "setBadgeText").mockRejectedValue(
      new Error("SECRET-MESSAGE"),
    );
    await expect(showFillCount(1, 3)).resolves.toBeUndefined();
    expect(JSON.stringify(err.mock.calls)).toContain("Error");
    expect(JSON.stringify(err.mock.calls)).not.toContain("SECRET-MESSAGE");
  });
});

describe("showLocked", () => {
  it("sets the lock", async () => {
    await showLocked(1);
    expect(await badge(1)).toBe(BADGE_LOCKED);
  });

  it("leaves the recording badge on a recording tab", async () => {
    await startSession(1, A, Date.now(), null);
    await showLocked(1);
    expect(await badge(1)).toBe(BADGE_RECORDING);
  });
});

describe("profileTabs", () => {
  it("lists only the tabs of an enabled, granted site with a saved form", async () => {
    expect((await profileTabs()).sort()).toEqual([1, 2]);
  });

  it("rejects when the tab query fails", async () => {
    vi.spyOn(fakeBrowser.tabs, "query").mockRejectedValue(new Error("x"));
    await expect(profileTabs()).rejects.toThrow();
  });
});

describe("lock and unlock passes", () => {
  it("a lock puts the lock on those tabs only", async () => {
    await lock();
    await vi.waitFor(async () => expect(await badge(1)).toBe(BADGE_LOCKED));
    await vi.waitFor(async () => expect(await badge(2)).toBe(BADGE_LOCKED));
    for (const id of [3, 4, 5, 6, 7]) expect(await badge(id)).toBe("");
  });

  it("an unlock clears them and nudges exactly those tabs", async () => {
    await lock();
    await vi.waitFor(async () => expect(await badge(1)).toBe(BADGE_LOCKED));
    sendMessage.mockClear();
    expect((await unlockWithPassphrase(P)).ok).toBe(true);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls.map((c) => c[0] as number).sort()).toEqual([
      1, 2,
    ]);
    expect(sendMessage.mock.calls[0]![1]).toEqual({ type: "refill-nudge" });
    expect(await badge(1)).toBe("");
    expect(await badge(2)).toBe("");
  });

  it("an unlock keeps the recording badge of a recording tab, and still nudges it", async () => {
    await startSession(1, A, Date.now(), null);
    sendMessage.mockClear();
    // A second unlock commit, with no lock before it, so the session is still there.
    expect((await unlockWithPassphrase(P)).ok).toBe(true);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect(await badge(2)).toBe(""));
    expect(await badge(1)).toBe(BADGE_RECORDING);
  });

  it("a failing tab query is logged by error name only", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(fakeBrowser.tabs, "query").mockRejectedValue(
      new Error("SECRET-MESSAGE"),
    );
    await lock();
    await vi.waitFor(() => expect(err).toHaveBeenCalled());
    expect(JSON.stringify(err.mock.calls)).not.toContain("SECRET-MESSAGE");
  });
});

describe("tabs.onUpdated", () => {
  it("clears the count when the tab starts loading", async () => {
    await showFillCount(1, 3);
    await fakeBrowser.tabs.onUpdated.trigger(1, { status: "loading" }, {
      id: 1,
    } as never);
    await vi.waitFor(async () => expect(await badge(1)).toBe(""));
  });

  it("ignores other updates", async () => {
    await showFillCount(1, 3);
    await fakeBrowser.tabs.onUpdated.trigger(1, { status: "complete" }, {
      id: 1,
    } as never);
    await fakeBrowser.tabs.onUpdated.trigger(1, { title: "x" }, {
      id: 1,
    } as never);
    expect(await badge(1)).toBe("3");
  });

  it("leaves the recording badge on a recording tab", async () => {
    await startSession(1, A, Date.now(), null);
    await fakeBrowser.tabs.onUpdated.trigger(1, { status: "loading" }, {
      id: 1,
    } as never);
    // Let the (skipped) clear settle.
    await showFillCount(2, 1);
    await vi.waitFor(async () => expect(await badge(2)).toBe("1"));
    expect(await badge(1)).toBe(BADGE_RECORDING);
  });
});
