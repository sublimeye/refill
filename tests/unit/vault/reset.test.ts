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
import {
  installRecorderListeners,
  peekMeta,
  startSession,
  stoppedReason,
} from "../../../src/lib/recorder/session";
import { readSites, upsertSite } from "../../../src/lib/sites";
import {
  BADGE_LOCKED,
  installBadgeListeners,
  showLocked,
} from "../../../src/lib/sites/badge";
import { writeIntent } from "../../../src/lib/sites/intent";
import { CONTENT_SCRIPT_ID, reconcile } from "../../../src/lib/sites/reconcile";
import { KEYS, draftKey, profileKey } from "../../../src/lib/store/local";
import { checkBackoff, recordFailure } from "../../../src/lib/vault/backoff";
import { resetEverything } from "../../../src/lib/vault/reset";
import { readSession } from "../../../src/lib/vault/session";
import { LockedError } from "../../../src/lib/vault/types";
import {
  __resetForTests,
  createVault,
  getDek,
  lock,
  status,
  unlockWithPassphrase,
} from "../../../src/lib/vault/vault";
import { installShims } from "../helpers/browser-shims";

const P = "correct horse battery staple";
const NEW_P = "an entirely different passphrase";
const A = "https://a.example";
const PA = A + "/*";
const TAB = 7;
const NOW = 1_000_000;

let snapshot: Record<string, unknown>;
let shims: ReturnType<typeof installShims>;

beforeAll(async () => {
  fakeBrowser.reset();
  await createVault(P, newKdfParams());
  snapshot = structuredClone(await fakeBrowser.storage.local.get(null));
}, 30_000);

beforeEach(async () => {
  fakeBrowser.reset();
  __resetForTests();
  shims = installShims();
  vi.spyOn(console, "error").mockImplementation(() => {});
  (fakeBrowser.tabs as unknown as { sendMessage: unknown }).sendMessage = vi.fn(
    async () => undefined,
  );
  vi.spyOn(fakeBrowser.tabs, "query").mockImplementation((async () => [
    { id: TAB, url: `${A}/form` },
  ]) as never);
  await fakeBrowser.storage.local.set(structuredClone(snapshot));
  await upsertSite(A, { profileId: "pa" });
  await fakeBrowser.storage.local.set({
    [profileKey("pa")]: { sealed: true },
    [draftKey("da")]: { sealed: true },
    [KEYS.settings]: { toast: 1 },
  });
});

afterEach(() => vi.restoreAllMocks());

const localKeys = async () =>
  Object.keys(await fakeBrowser.storage.local.get(null));
const badge = (tabId: number) => fakeBrowser.action.getBadgeText({ tabId });

describe("resetEverything", () => {
  it("erases the vault, sites, settings, forms and drafts without the passphrase", async () => {
    expect((await status()).state).toBe("locked");
    expect((await localKeys()).length).toBeGreaterThan(0);
    await resetEverything();
    expect(await localKeys()).toEqual([]);
    expect((await status()).state).toBe("none");
  });

  it("works on a damaged vault", async () => {
    await fakeBrowser.storage.local.set({ [KEYS.header]: "garbage" });
    expect((await status()).state).toBe("corrupt");
    await resetEverything();
    expect((await status()).state).toBe("none");
  });

  it("takes the key away from an unlocked vault", async () => {
    expect((await unlockWithPassphrase(P)).ok).toBe(true);
    await resetEverything();
    expect(await readSession()).toBeNull();
    await expect(getDek()).rejects.toBeInstanceOf(LockedError);
  });

  it("clears the unlock backoff and every other in-memory-only record", async () => {
    await recordFailure(NOW);
    expect(await checkBackoff(NOW)).toBeGreaterThan(0);
    await writeIntent({ tabId: TAB, origin: A, kind: "enable", ts: NOW });
    await resetEverything();
    expect(await fakeBrowser.storage.session.get(null)).toEqual({});
    expect(await checkBackoff(NOW)).toBe(0);
  });

  it("ends a recording without telling the page the vault locked", async () => {
    installRecorderListeners();
    expect((await unlockWithPassphrase(P)).ok).toBe(true);
    await startSession(TAB, A, NOW, null);
    await resetEverything();
    expect(await peekMeta({ any: true }, NOW)).toBeNull();
    expect(await stoppedReason(TAB, A, NOW)).toBeNull();
  });

  it("removes every granted site permission, even one with no site record", async () => {
    const orphan = "https://orphan.example/*";
    shims.grant(PA);
    shims.grant(orphan);
    await resetEverything();
    expect([...shims.grants]).toEqual([]);
  });

  it("finishes when one permission cannot be removed", async () => {
    const stuck = "https://stuck.example/*";
    shims.grant(stuck);
    shims.grant(PA);
    const remove = shims.permissions.remove.getMockImplementation()!;
    shims.permissions.remove.mockImplementation(async (p) => {
      if (p.origins?.includes(stuck)) throw new Error("required");
      return remove(p);
    });
    await resetEverything();
    expect(await localKeys()).toEqual([]);
    expect([...shims.grants]).toEqual([stuck]);
  });

  it("unregisters the content script", async () => {
    shims.grant(PA);
    await reconcile();
    expect(shims.scripts.has(CONTENT_SCRIPT_ID)).toBe(true);
    await resetEverything();
    expect(shims.scripts.has(CONTENT_SCRIPT_ID)).toBe(false);
  });

  it("clears the lock badge and does not put it back", async () => {
    installBadgeListeners();
    await showLocked(TAB);
    expect(await badge(TAB)).toBe(BADGE_LOCKED);
    await resetEverything();
    // The lock listener's pass is not awaited by the reset: let it run.
    await new Promise((r) => setTimeout(r, 10));
    expect(await badge(TAB)).toBe("");
  });

  it("rejects, leaving the data, when storage cannot be erased", async () => {
    vi.spyOn(fakeBrowser.storage.local, "remove").mockRejectedValue(
      new Error("disk"),
    );
    await expect(resetEverything()).rejects.toThrow();
    expect(await readSites()).toHaveProperty([A]);
  });
});

describe("vault-reset message", () => {
  it("lets a new passphrase create a new, empty vault", async () => {
    const h = createPageHandlers(async () => newKdfParams());
    expect(await h["vault-reset"]({ type: "vault-reset" })).toEqual({
      ok: true,
    });
    expect(
      await h["vault-create"]({ type: "vault-create", passphrase: NEW_P }),
    ).toEqual({ ok: true });
    await lock();
    expect((await unlockWithPassphrase(P)).ok).toBe(false);
    expect(await readSites()).toEqual({});
  }, 30_000);
});
