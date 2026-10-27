import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aad } from "../../../src/lib/crypto/aad";
import { importAesKey, open } from "../../../src/lib/crypto/aead";
import { toB64, utf8 } from "../../../src/lib/crypto/bytes";
import {
  generateDraftKeyPair,
  openDraft,
  sealDraft,
} from "../../../src/lib/crypto/draft-seal";
import { deriveKek, newKdfParams } from "../../../src/lib/crypto/kdf";
import { KEYS, getItem, setItems } from "../../../src/lib/store/local";
import { checkBackoff } from "../../../src/lib/vault/backoff";
import { parseHeader } from "../../../src/lib/vault/header";
import { getEncrypted, putEncrypted } from "../../../src/lib/vault/records";
import {
  clearSession,
  readSession,
  writeSession,
} from "../../../src/lib/vault/session";
import {
  DEFAULT_LOCK,
  LockedError,
  type VaultHeader,
} from "../../../src/lib/vault/types";
import {
  __resetForTests,
  changePassphrase,
  createVault,
  getDek,
  getDraftPrivateKey,
  lock,
  lockEpoch,
  onLockChange,
  status,
  unlockWithPassphrase,
} from "../../../src/lib/vault/vault";

// Pass-through spy on deriveKek so a test can assert the KDF did not run (ESM exports cannot be
// spied on after import; vi.mock replaces the module for every importer, including vault.ts).
vi.mock("../../../src/lib/crypto/kdf", async (importOriginal) => {
  const m =
    await importOriginal<typeof import("../../../src/lib/crypto/kdf")>();
  return { ...m, deriveKek: vi.fn(m.deriveKek) };
});

// Pass-through spy on importAesKey so a test can gate the import inside commitUnlock.
vi.mock("../../../src/lib/crypto/aead", async (importOriginal) => {
  const m =
    await importOriginal<typeof import("../../../src/lib/crypto/aead")>();
  return { ...m, importAesKey: vi.fn(m.importAesKey) };
});

const P = "correct horse battery staple";
// Real "now": getDek's session rebuild checks the hard max against Date.now() (R24).
const T0 = Date.now();
const HOUR = 3_600_000;
const SLOW = { timeout: 30_000 };

let snapshot: Record<string, unknown> | undefined;

/**
 * A locked vault created with passphrase `P` at `T0`. Argon2 runs once per file: later calls
 * restore a storage snapshot of the first vault.
 */
async function lockedVault(): Promise<void> {
  if (snapshot === undefined) {
    await createVault(P, newKdfParams(), T0);
    snapshot = structuredClone(await fakeBrowser.storage.local.get(null));
  } else {
    await fakeBrowser.storage.local.set(structuredClone(snapshot));
  }
  await lock();
}

/**
 * Makes the next deriveKek call wait until `release()`: lets a test land `lock()` mid-KDF.
 * `started` resolves once the derivation has begun (i.e. the caller holds the store lock).
 */
function pauseNextKdf(): { started: Promise<void>; release: () => void } {
  const real = vi.mocked(deriveKek).getMockImplementation()!;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const started = new Promise<void>((r) => (entered = r));
  vi.mocked(deriveKek).mockImplementationOnce(async (pw, kdf) => {
    entered();
    await gate;
    return real(pw, kdf);
  });
  return { started, release };
}

/** A gate: `wait()` blocks until `release()`; `started` resolves when something waits. */
function gate(): {
  started: Promise<void>;
  wait: () => Promise<void>;
  release: () => void;
} {
  let release!: () => void;
  let entered!: () => void;
  const open = new Promise<void>((r) => (release = r));
  const started = new Promise<void>((r) => (entered = r));
  return {
    started,
    release,
    wait: () => {
      entered();
      return open;
    },
  };
}

/** Records every value written to `vault:session` (including writes later cleared). */
function watchSessionWrites(): unknown[] {
  const writes: unknown[] = [];
  fakeBrowser.storage.session.onChanged.addListener((changes) => {
    const v = changes["vault:session"]?.newValue;
    if (v !== undefined && v !== null) writes.push(v);
  });
  return writes;
}

async function rawHeader(): Promise<VaultHeader> {
  return structuredClone((await getItem(KEYS.header)) as VaultHeader);
}

async function unlocksWith(header: unknown, passphrase: string) {
  const h = parseHeader(header);
  if (!h) throw new Error("bad header");
  const kek = await deriveKek(passphrase, h.kdf);
  return open(kek, h.wrappedDek, aad.dekPw()).then(
    () => true,
    () => false,
  );
}

beforeEach(() => {
  fakeBrowser.reset();
  __resetForTests();
  vi.mocked(deriveKek).mockClear();
  vi.mocked(importAesKey).mockClear();
});

describe("vault lifecycle", SLOW, () => {
  it("status is none before create", async () => {
    expect(await status()).toEqual({ state: "none" });
    expect(await unlockWithPassphrase(P)).toEqual({
      ok: false,
      reason: "no-vault",
    });
  });

  it("create → status unlocked, header and integrity written, session mirrored", async () => {
    await createVault(P, newKdfParams(), T0);
    expect(await status(T0)).toEqual({
      state: "unlocked",
      unlockedAt: T0,
      lock: DEFAULT_LOCK,
    });
    const h = parseHeader(await getItem(KEYS.header));
    expect(h).not.toBeNull();
    expect(h?.lastPassphraseAt).toBe(T0);
    expect(h?.lock).toEqual(DEFAULT_LOCK);
    expect(await getItem(KEYS.integrity)).toMatchObject({
      iv: expect.any(String),
      ct: expect.any(String),
    });
    const s = await readSession();
    expect(s?.unlockedAt).toBe(T0);
    expect(s?.dekRaw).toHaveLength(32);
    const dek = await getDek();
    expect(dek.extractable).toBe(false);
  });

  it("createVault rejects an existing vault and weak passphrases (length after NFC)", async () => {
    await expect(createVault("short", newKdfParams())).rejects.toThrow("weak");
    await expect(createVault("12345678901", newKdfParams())).rejects.toThrow(
      "weak",
    );
    // 12 code units in NFD, 6 characters after NFC
    const nfd = "é".repeat(6);
    expect(nfd.length).toBe(12);
    await expect(createVault(nfd, newKdfParams())).rejects.toThrow("weak");
    expect(await getItem(KEYS.header)).toBeUndefined();
    await lockedVault();
    vi.mocked(deriveKek).mockClear();
    await expect(createVault(P, newKdfParams())).rejects.toThrow("exists");
    expect(vi.mocked(deriveKek)).not.toHaveBeenCalled();
  });

  it("lock → status locked; key material and session gone", async () => {
    await lockedVault();
    expect(await status(T0)).toEqual({ state: "locked", lock: DEFAULT_LOCK });
    expect(await readSession()).toBeNull();
    await expect(getDek()).rejects.toBeInstanceOf(LockedError);
    await expect(getDraftPrivateKey()).rejects.toBeInstanceOf(LockedError);
  });

  it("unlock with the right passphrase → ok, unlocked, lastPassphraseAt updated", async () => {
    await lockedVault();
    const t1 = T0 + HOUR;
    expect(await unlockWithPassphrase(P, t1)).toEqual({ ok: true });
    expect(await status(t1)).toEqual({
      state: "unlocked",
      unlockedAt: t1,
      lock: DEFAULT_LOCK,
    });
    expect((await rawHeader()).lastPassphraseAt).toBe(t1);
    expect((await readSession())?.unlockedAt).toBe(t1);
    expect(await checkBackoff(t1)).toBe(0);
  });

  it("wrong passphrase → wrong-passphrase, stays locked, records a failure", async () => {
    await lockedVault();
    expect(await unlockWithPassphrase(P + "!", T0)).toEqual({
      ok: false,
      reason: "wrong-passphrase",
    });
    expect((await status(T0)).state).toBe("locked");
    expect(await readSession()).toBeNull();
    expect(await checkBackoff(T0)).toBe(1000);
    expect((await rawHeader()).lastPassphraseAt).toBe(T0);
  });

  it("NFD passphrase unlocks a vault created with NFC", async () => {
    const nfc = "Ångström façade passphrase".normalize("NFC");
    const nfd = nfc.normalize("NFD");
    expect(nfd).not.toBe(nfc);
    await createVault(nfc, newKdfParams(), T0);
    await lock();
    expect(await unlockWithPassphrase(nfd, T0)).toEqual({ ok: true });
  });

  it("two concurrent createVault calls create exactly one vault", async () => {
    const pa = "passphrase-AAAA-1";
    const pb = "passphrase-BBBB-2";
    const [ra, rb] = await Promise.allSettled([
      createVault(pa, newKdfParams(), T0),
      createVault(pb, newKdfParams(), T0),
    ]);
    const results = [ra, rb];
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toEqual(
      new Error("exists"),
    );
    const winner = ra?.status === "fulfilled" ? pa : pb;
    const loser = winner === pa ? pb : pa;
    const header = await getItem(KEYS.header);
    expect(await unlocksWith(header, winner)).toBe(true);
    expect(await unlocksWith(header, loser)).toBe(false);
    // the integrity record belongs to the same vault: unlock succeeds without a warning
    await lock();
    expect(await unlockWithPassphrase(winner, T0)).toEqual({ ok: true });
  });

  it("onLockChange reports transitions until unsubscribed", async () => {
    const seen: boolean[] = [];
    const off = onLockChange((u) => seen.push(u));
    const offThrowing = onLockChange(() => {
      throw new Error("a throwing listener does not break the vault");
    });
    await lockedVault(); // create (first file use) or restore, then lock
    expect(seen.at(-1)).toBe(false);
    seen.length = 0;
    await unlockWithPassphrase(P, T0);
    await lock();
    expect(seen).toEqual([true, false]);
    off();
    offThrowing();
    await unlockWithPassphrase(P, T0);
    expect(seen).toEqual([true, false]);
  });

  it("status locks an unlocked vault once maxHours since unlock have passed", async () => {
    await lockedVault();
    await unlockWithPassphrase(P, T0);
    expect((await status(T0 + 12 * HOUR - 1)).state).toBe("unlocked");
    expect(await status(T0 + 12 * HOUR)).toEqual({
      state: "locked",
      lock: DEFAULT_LOCK,
    });
    expect(await readSession()).toBeNull();
    await expect(getDek()).rejects.toBeInstanceOf(LockedError);
  });
});

describe("corrupt header", SLOW, () => {
  const cases: [string, (h: VaultHeader) => unknown][] = [
    ["{}", () => ({})],
    ['"garbage"', () => "garbage"],
    ["v: 2", (h) => ({ ...h, v: 2 })],
    ['kdf.m: "x"', (h) => ({ ...h, kdf: { ...h.kdf, m: "x" } })],
    [
      "truncated wrappedDek.ct",
      (h) => ({
        ...h,
        wrappedDek: { ...h.wrappedDek, ct: h.wrappedDek.ct.slice(0, -4) },
      }),
    ],
  ];
  it.each(cases)("%s → status corrupt and unlock corrupt", async (_n, mut) => {
    await lockedVault();
    await setItems({ [KEYS.header]: mut(await rawHeader()) });
    expect(await status()).toEqual({ state: "corrupt" });
    expect(await unlockWithPassphrase(P, T0)).toEqual({
      ok: false,
      reason: "corrupt",
    });
    expect(vi.mocked(deriveKek)).not.toHaveBeenCalled();
    expect(await readSession()).toBeNull();
  });
});

describe("backoff", SLOW, () => {
  it("after 3 failures unlock is refused for 4 s without running the KDF", async () => {
    await lockedVault();
    // each attempt waits out the previous backoff (1 s, then 2 s)
    for (const t of [T0, T0 + 1000, T0 + 3000]) {
      expect(await unlockWithPassphrase("wrong passphrase!", t)).toEqual({
        ok: false,
        reason: "wrong-passphrase",
      });
    }
    const t3 = T0 + 3000;
    expect(await checkBackoff(t3)).toBe(4000);
    vi.mocked(deriveKek).mockClear();
    expect(await unlockWithPassphrase(P, t3 + 1000)).toEqual({
      ok: false,
      reason: "backoff",
      retryAfterMs: 3000,
    });
    expect(
      await changePassphrase(P, P + " two", newKdfParams(), t3 + 1000),
    ).toEqual({ ok: false, reason: "backoff", retryAfterMs: 3000 });
    expect(vi.mocked(deriveKek)).not.toHaveBeenCalled();
    expect(await unlockWithPassphrase(P, t3 + 4000)).toEqual({ ok: true });
    expect(await checkBackoff(t3 + 4000)).toBe(0);
  });

  it("concurrent wrong guesses are serialized: the second waits for the first's backoff", async () => {
    await lockedVault();
    const [a, b] = await Promise.all([
      unlockWithPassphrase("wrong passphrase 1", T0),
      unlockWithPassphrase("wrong passphrase 2", T0),
    ]);
    expect(a).toEqual({ ok: false, reason: "wrong-passphrase" });
    expect(b).toEqual({ ok: false, reason: "backoff", retryAfterMs: 1000 });
    expect(vi.mocked(deriveKek)).toHaveBeenCalledTimes(1);
  });
});

describe("integrity", SLOW, () => {
  it("tampered lock.maxHours is restored from the integrity copy", async () => {
    await lockedVault();
    const h = await rawHeader();
    await setItems({
      [KEYS.header]: { ...h, lock: { ...h.lock, maxHours: 72 } },
    });
    expect(await status()).toMatchObject({
      state: "locked",
      lock: { maxHours: 72 }, // plaintext is only a hint while locked
    });
    expect(await unlockWithPassphrase(P, T0 + 5)).toEqual({
      ok: true,
      warning: "integrity-restored",
    });
    const after = await rawHeader();
    expect(after.lock.maxHours).toBe(12);
    expect(after).toEqual({ ...h, lastPassphraseAt: T0 + 5 });
    await lock();
    expect(await unlockWithPassphrase(P, T0)).toEqual({ ok: true });
  });

  it("tampered draftPub is restored from the integrity copy", async () => {
    await lockedVault();
    const h = await rawHeader();
    const attacker = (await generateDraftKeyPair()).publicJwk;
    await setItems({ [KEYS.header]: { ...h, draftPub: attacker } });
    expect(await unlockWithPassphrase(P, T0)).toEqual({
      ok: true,
      warning: "integrity-restored",
    });
    expect((await rawHeader()).draftPub).toEqual(h.draftPub);
  });

  it("missing or undecryptable integrity record → corrupt, stays locked", async () => {
    for (const integrity of [
      undefined,
      "x",
      { iv: toB64(new Uint8Array(12)), ct: toB64(new Uint8Array(64)) },
    ]) {
      await lockedVault();
      if (integrity === undefined) {
        await fakeBrowser.storage.local.remove(KEYS.integrity);
      } else {
        await setItems({ [KEYS.integrity]: integrity });
      }
      expect(await unlockWithPassphrase(P, T0)).toEqual({
        ok: false,
        reason: "corrupt",
      });
      expect((await status()).state).toBe("locked");
      expect(await readSession()).toBeNull();
    }
  });
});

describe("changePassphrase", SLOW, () => {
  it("re-wraps the DEK: old fails, new works, existing records still decrypt", async () => {
    await lockedVault();
    await unlockWithPassphrase(P, T0);
    const recAad = aad.profile("x", "https://a.example");
    await putEncrypted("p:x", recAad, { name: "Jane" });
    const before = await rawHeader();
    const P2 = "a completely new passphrase";
    const kdf2 = newKdfParams(4);

    expect(await changePassphrase(P, P2, kdf2, T0 + 10)).toEqual({ ok: true });
    const after = await rawHeader();
    expect(after.kdf).toEqual(kdf2);
    expect(after.wrappedDek).not.toEqual(before.wrappedDek);
    expect(after.wrappedDraftPriv).toEqual(before.wrappedDraftPriv);
    expect(after.lastPassphraseAt).toBe(T0 + 10);
    expect((await status(T0 + 10)).state).toBe("unlocked"); // lock state unchanged

    await lock();
    expect(await unlockWithPassphrase(P, T0 + 20)).toEqual({
      ok: false,
      reason: "wrong-passphrase",
    });
    expect(await unlockWithPassphrase(P2, T0 + 2000)).toEqual({ ok: true });
    expect(await getEncrypted("p:x", recAad)).toEqual({ name: "Jane" });
  });

  it("wrong old passphrase → wrong-passphrase, header unchanged; weak new passphrase throws", async () => {
    await lockedVault();
    const before = await rawHeader();
    expect(
      await changePassphrase("not the passphrase", P + "2", newKdfParams(), T0),
    ).toEqual({ ok: false, reason: "wrong-passphrase" });
    expect(await rawHeader()).toEqual(before);
    await expect(
      changePassphrase(P, "too short", newKdfParams(), T0),
    ).rejects.toThrow("weak");
  });

  it("restores a tampered header before re-sealing integrity", async () => {
    await lockedVault();
    const h = await rawHeader();
    await setItems({
      [KEYS.header]: { ...h, lock: { ...h.lock, maxHours: 72 } },
    });
    const P2 = "a completely new passphrase";
    expect(await changePassphrase(P, P2, newKdfParams(), T0)).toEqual({
      ok: true,
      warning: "integrity-restored",
    });
    expect((await rawHeader()).lock.maxHours).toBe(12);
    expect(await unlockWithPassphrase(P2, T0)).toEqual({ ok: true });
  });

  it("does not unlock a locked vault", async () => {
    await lockedVault();
    expect(await changePassphrase(P, P + " v2", newKdfParams(), T0)).toEqual({
      ok: true,
    });
    expect((await status()).state).toBe("locked");
  });
});

describe("session and service-worker restart", SLOW, () => {
  it("getDek after simulated SW restart rebuilds from the session; LockedError once cleared", async () => {
    await lockedVault();
    await unlockWithPassphrase(P, T0);
    __resetForTests();
    const dek = await getDek(T0 + 60_000);
    expect(dek.extractable).toBe(false);
    expect(await status(T0)).toMatchObject({
      state: "unlocked",
      unlockedAt: T0,
    });
    __resetForTests();
    await clearSession();
    await expect(getDek()).rejects.toBeInstanceOf(LockedError);
    expect((await status(T0)).state).toBe("locked");
  });

  it("lock() racing a session rebuild wins", async () => {
    await lockedVault();
    await unlockWithPassphrase(P, T0);
    __resetForTests();
    const pending = getDek();
    await lock();
    await expect(pending).rejects.toBeInstanceOf(LockedError);
    await expect(getDek()).rejects.toBeInstanceOf(LockedError);
  });

  it("getDek's session rebuild enforces the hard max (R24)", async () => {
    await lockedVault();
    await unlockWithPassphrase(P, T0);
    __resetForTests();
    await expect(getDek(T0 + 12 * HOUR)).rejects.toBeInstanceOf(LockedError);
    expect(await readSession()).toBeNull(); // expired session is locked, not just refused
    expect((await status(T0)).state).toBe("locked");

    await unlockWithPassphrase(P, T0);
    __resetForTests();
    expect((await getDek(T0 + 12 * HOUR - 1)).extractable).toBe(false);
  });

  it("getDek's session rebuild next to an unreadable header locks", async () => {
    await lockedVault();
    await unlockWithPassphrase(P, T0);
    __resetForTests();
    await setItems({ [KEYS.header]: "garbage" });
    await expect(getDek(T0)).rejects.toBeInstanceOf(LockedError);
    expect(await readSession()).toBeNull();
  });

  it("readSession rejects malformed state", async () => {
    await writeSession(new Uint8Array(32).fill(7), T0);
    expect(await readSession()).toEqual({
      dekRaw: new Uint8Array(32).fill(7),
      unlockedAt: T0,
    });
    for (const bad of [
      "x",
      { dek: toB64(new Uint8Array(31)), unlockedAt: T0 },
      { dek: "!!", unlockedAt: T0 },
      { dek: toB64(new Uint8Array(32)), unlockedAt: "now" },
      { dek: toB64(new Uint8Array(32)) },
    ]) {
      await fakeBrowser.storage.session.set({ "vault:session": bad });
      expect(await readSession()).toBeNull();
    }
  });
});

describe("lock wins races (R23)", SLOW, () => {
  it("lockEpoch changes on every lock() and on nothing else", async () => {
    await createVault(P, newKdfParams(), T0);
    const e0 = lockEpoch();
    await status(T0);
    await getDek(T0);
    expect(lockEpoch()).toBe(e0);
    await lock();
    const e1 = lockEpoch();
    expect(e1).not.toBe(e0);
    expect((await unlockWithPassphrase(P, T0)).ok).toBe(true);
    expect(lockEpoch()).toBe(e1);
    await lock(); // even when already locked
    await lock();
    expect(lockEpoch()).not.toBe(e1);
  });

  it("lock() during unlock's KDF: no keys installed, no session written, reason locked-during-unlock", async () => {
    await lockedVault();
    const seen: boolean[] = [];
    const off = onLockChange((u) => seen.push(u));
    const writes = watchSessionWrites();
    const { started, release } = pauseNextKdf();
    const pending = unlockWithPassphrase(P, T0);
    await started;
    await lock();
    release();
    expect(await pending).toEqual({
      ok: false,
      reason: "locked-during-unlock",
    });
    expect((await status(T0)).state).toBe("locked");
    expect(await readSession()).toBeNull();
    expect(writes).toEqual([]); // the DEK never reached the session mirror
    await expect(getDek(T0)).rejects.toBeInstanceOf(LockedError);
    expect(seen).toEqual([false]); // no `true` after the lock
    off();
    // the passphrase was right: a fresh attempt unlocks without backoff
    expect(await unlockWithPassphrase(P, T0)).toEqual({ ok: true });
  });

  it("lock() during the session write: the commit is undone", async () => {
    await lockedVault();
    fakeBrowser.storage.session.onChanged.addListener((changes) => {
      if (changes["vault:session"]?.newValue) void lock();
    });
    expect(await unlockWithPassphrase(P, T0)).toEqual({
      ok: false,
      reason: "locked-during-unlock",
    });
    expect(await readSession()).toBeNull();
    await expect(getDek(T0)).rejects.toBeInstanceOf(LockedError);
  });

  it("lock() during createVault: the vault is created but left locked", async () => {
    const writes = watchSessionWrites();
    const { started, release } = pauseNextKdf();
    const pending = createVault(P, newKdfParams(), T0);
    await started;
    await lock();
    release();
    await expect(pending).resolves.toBeUndefined();
    expect(await status(T0)).toEqual({ state: "locked", lock: DEFAULT_LOCK });
    expect(writes).toEqual([]);
    await expect(getDek(T0)).rejects.toBeInstanceOf(LockedError);
    expect(await unlockWithPassphrase(P, T0)).toEqual({ ok: true });
  });

  it("lock() during getDraftPrivateKey: nothing installed", async () => {
    await lockedVault();
    await unlockWithPassphrase(P, T0);
    const pending = getDraftPrivateKey();
    await lock();
    await expect(pending).rejects.toBeInstanceOf(LockedError);
    await expect(getDraftPrivateKey()).rejects.toBeInstanceOf(LockedError);
  });

  it("lock() during commitUnlock's key import: mirror never written, nothing rebuildable", async () => {
    await lockedVault();
    const g = gate();
    const real = vi.mocked(importAesKey).getMockImplementation()!;
    vi.mocked(importAesKey).mockImplementation(async (raw, extractable) => {
      // Only the import inside commitUnlock (the vault code is not minified under Vitest).
      if (new Error().stack?.includes("commitUnlock")) {
        vi.mocked(importAesKey).mockImplementation(real);
        await g.wait();
      }
      return real(raw, extractable);
    });
    const writes = watchSessionWrites();
    let rebuild: Promise<unknown> | undefined;
    fakeBrowser.storage.session.onChanged.addListener((c) => {
      // Any getDek after lock() returned must not find a mirror to rebuild from.
      if (c["vault:session"]?.newValue && !rebuild) {
        rebuild = getDek(T0).catch((err: unknown) => err);
      }
    });
    const pending = unlockWithPassphrase(P, T0);
    await g.started;
    await lock();
    g.release();
    expect(await pending).toEqual({
      ok: false,
      reason: "locked-during-unlock",
    });
    expect(writes).toEqual([]);
    expect(rebuild).toBeUndefined();
    await expect(getDek(T0)).rejects.toBeInstanceOf(LockedError);
    expect((await status(T0)).state).toBe("locked");
  });

  it("a hard-max rebuild acting on a stale session read does not wipe a fresh unlock (getDek)", async () => {
    await lockedVault();
    await unlockWithPassphrase(P, T0);
    __resetForTests(); // SW restart: session at T0 stays
    const later = T0 + 12 * HOUR; // T0's session is expired at `later`
    const local = fakeBrowser.storage.local;
    const realGet = local.get.bind(local) as (
      k: string,
    ) => Promise<Record<string, unknown>>;
    const g = gate();
    vi.spyOn(local, "get").mockImplementationOnce(async (keys) => {
      await g.wait(); // getDek has read the stale session; hold its header read
      return realGet(keys as string);
    });
    const dekP = getDek(later);
    await g.started;
    expect(await unlockWithPassphrase(P, later)).toEqual({ ok: true });
    g.release();
    expect((await dekP).extractable).toBe(false); // the fresh unlock's DEK
    expect(await status(later)).toMatchObject({
      state: "unlocked",
      unlockedAt: later,
    });
    expect((await readSession())?.unlockedAt).toBe(later);
  });

  it("a hard-max check does not lock an unlock that is still committing (session compare)", async () => {
    await lockedVault();
    await unlockWithPassphrase(P, T0);
    __resetForTests();
    const later = T0 + 12 * HOUR;
    const local = fakeBrowser.storage.local;
    const realGet = local.get.bind(local) as (
      k: string,
    ) => Promise<Record<string, unknown>>;
    const g = gate();
    vi.spyOn(local, "get").mockImplementationOnce(async (keys) => {
      await g.wait();
      return realGet(keys as string);
    });
    const dekP = getDek(later).catch((err: unknown) => err);
    await g.started;
    // Resume getDek while the new mirror is written but memory is not yet set.
    fakeBrowser.storage.session.onChanged.addListener(async (c) => {
      const v = c["vault:session"]?.newValue as
        { unlockedAt?: number } | undefined;
      if (v?.unlockedAt === later) {
        g.release();
        await dekP;
      }
    });
    expect(await unlockWithPassphrase(P, later)).toEqual({ ok: true });
    expect(await dekP).toBeInstanceOf(LockedError); // transient for that caller only
    expect(await status(later)).toMatchObject({
      state: "unlocked",
      unlockedAt: later,
    });
  });

  it("a stale hard-max read does not cancel an unlock that started after a lock()", async () => {
    await lockedVault();
    await unlockWithPassphrase(P, T0);
    __resetForTests();
    const later = T0 + 12 * HOUR;
    const local = fakeBrowser.storage.local;
    const realGet = local.get.bind(local) as (
      k: string,
    ) => Promise<Record<string, unknown>>;
    const g = gate();
    vi.spyOn(local, "get").mockImplementationOnce(async (keys) => {
      await g.wait();
      return realGet(keys as string);
    });
    const dekP = getDek(later).catch((err: unknown) => err);
    await g.started; // stale expired session read
    await lock();
    const kdf = pauseNextKdf();
    const unlockP = unlockWithPassphrase(P, later); // starts after the lock
    await kdf.started;
    g.release();
    expect(await dekP).toBeInstanceOf(LockedError);
    kdf.release();
    expect(await unlockP).toEqual({ ok: true });
    expect((await status(later)).state).toBe("unlocked");
  });

  it("status's hard-max backstop does not wipe a fresh unlock after a stale read", async () => {
    await lockedVault();
    await unlockWithPassphrase(P, T0);
    __resetForTests();
    const later = T0 + 12 * HOUR;
    const session = fakeBrowser.storage.session;
    const realGet = session.get.bind(session);
    const g = gate();
    vi.spyOn(session, "get").mockImplementationOnce(async (keys) => {
      const stale = await realGet(keys as string); // read now, delivered late
      await g.wait();
      return stale;
    });
    const statusP = status(later);
    await g.started;
    expect(await unlockWithPassphrase(P, later)).toEqual({ ok: true });
    g.release();
    expect(await statusP).toMatchObject({
      state: "unlocked",
      unlockedAt: later,
    });
    await expect(getDek(later)).resolves.toBeDefined();
  });

  it("a session rebuild during lock()'s teardown is dropped", async () => {
    await lockedVault();
    await unlockWithPassphrase(P, T0);
    __resetForTests(); // SW restart: next getDek rebuilds from the session
    // Hold the session removal so a rebuild can read the mirror mid-teardown.
    const session = fakeBrowser.storage.session;
    const realRemove = session.remove.bind(session);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spy = vi
      .spyOn(session, "remove")
      .mockImplementationOnce(async (keys: string | string[]) => {
        await gate;
        return realRemove(keys);
      });
    const locking = lock();
    await getDek(T0).catch(() => undefined); // may complete before the removal lands
    release();
    await locking;
    spy.mockRestore();
    await expect(getDek(T0)).rejects.toBeInstanceOf(LockedError);
    expect((await status(T0)).state).toBe("locked");
  });
});

describe("draft private key", SLOW, () => {
  it("opens drafts sealed to the header draftPub", async () => {
    await lockedVault();
    const h = await rawHeader();
    const sealed = await sealDraft(h.draftPub, "d1", null, utf8("hi"));
    await unlockWithPassphrase(P, T0);
    const priv = await getDraftPrivateKey();
    expect(priv.extractable).toBe(false);
    expect(await openDraft(priv, h.draftPub, sealed)).toEqual(utf8("hi"));
    __resetForTests(); // rebuilt after SW restart too
    expect(
      await openDraft(await getDraftPrivateKey(), h.draftPub, sealed),
    ).toEqual(utf8("hi"));
  });
});
