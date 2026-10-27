// The vault: passphrase -> KEK (Argon2id) -> wraps a random 256-bit DEK (spec §4). The DEK lives
// in memory as a non-extractable CryptoKey and is mirrored as raw bytes in storage.session so a
// suspended service worker can resume (§4.3). Raw key bytes exist only transiently and are zeroed.
//
// Every read-modify-write of vault state runs inside `withStoreLock` and touches storage.local
// only through its `tx` (ADR 0011). Decisions: ADR 0012.
import { aad } from "../crypto/aad";
import { importAesKey, open, seal, type Sealed } from "../crypto/aead";
import { canonicalJson, fromUtf8, randomBytes, utf8 } from "../crypto/bytes";
import {
  exportDraftPrivateKey,
  generateDraftKeyPair,
  importDraftPrivateKey,
} from "../crypto/draft-seal";
import { deriveKek, isKdfParams, type KdfParams } from "../crypto/kdf";
import { meetsMinLength } from "../passphrase/rules";
import { KEYS, getItem, withStoreLock, type StoreTx } from "../store/local";
import { checkBackoff, recordFailure, resetBackoff } from "./backoff";
import {
  TAG_BYTES,
  parseHeader,
  parseIntegrityPayload,
  parseSealed,
} from "./header";
import { clearSession, readSession, writeSession } from "./session";
import {
  DEFAULT_LOCK,
  LockedError,
  type IntegrityPayload,
  type UnlockResult,
  type VaultHeader,
  type VaultStatus,
} from "./types";

const DEK_BYTES = 32;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Bounds work on a tampered integrity record; the real payload is a few hundred bytes. */
const INTEGRITY_MAX_CT = 4096;

interface Unlocked {
  dek: CryptoKey;
  unlockedAt: number;
  draftPriv?: CryptoKey;
}

let mem: Unlocked | null = null;
const installed = (): Unlocked | null => mem;
/**
 * Bumped by `lock()` (and `__resetForTests`). Work that started in an older epoch (an unlock or
 * create, captured on entry before the queue wait and the KDF; a session rebuild; a draft-key
 * import) must not install key material afterwards: lock always wins (ADR 0012, ruling R23).
 */
let epoch = 0;
const listeners = new Set<(unlocked: boolean) => void>();

function notify(unlocked: boolean): void {
  for (const cb of [...listeners]) {
    try {
      cb(unlocked);
    } catch {
      // A failing listener must not break lock/unlock or starve the other listeners.
    }
  }
}

/** Throws `Error("weak")` for fewer than 12 characters (code points) after NFC. */
function assertStrong(passphrase: string): void {
  if (!meetsMinLength(passphrase)) {
    throw new Error("weak");
  }
}

function assertTime(now: number): void {
  // Stored as `lastPassphraseAt`, which `parseHeader` requires to be a non-negative safe integer.
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("now must be a non-negative integer (ms)");
  }
}

/** Validated plain copy, so the stored header has no stray keys (parseHeader is strict). */
function kdfCopy(kdf: KdfParams): KdfParams {
  if (!isKdfParams(kdf)) throw new RangeError("invalid KDF parameters");
  const { alg, v, m, t, p, salt } = kdf;
  return { alg, v, m, t, p, salt };
}

function integrityJson(x: IntegrityPayload): string {
  return canonicalJson({ draftPub: x.draftPub, lock: x.lock, kdf: x.kdf });
}

function sealIntegrity(dek: CryptoKey, x: IntegrityPayload): Promise<Sealed> {
  return seal(dek, utf8(integrityJson(x)), aad.integrity());
}

async function readIntegrity(
  tx: StoreTx,
  dek: CryptoKey,
): Promise<IntegrityPayload | null> {
  const sealed = parseSealed(
    await tx.getItem(KEYS.integrity),
    TAG_BYTES + 1,
    INTEGRITY_MAX_CT,
  );
  if (!sealed) return null;
  try {
    const pt = await open(dek, sealed, aad.integrity());
    return parseIntegrityPayload(JSON.parse(fromUtf8(pt)));
  } catch {
    return null;
  }
}

/**
 * Installs the unlocked state (memory + session mirror) unless `lock()` ran since epoch `e` (taken
 * when the caller started). Returns false when the lock won; nothing is left behind.
 */
async function commitUnlock(
  dekRaw: Uint8Array,
  unlockedAt: number,
  e: number,
): Promise<boolean> {
  // Storage ops apply in issue order. A lock() at any point before the write (including during
  // the caller's KDF and this import) is caught right before it, so the mirror is never written:
  // a SW kill cannot leave it behind and no rebuild can read it. A lock() during the write is
  // caught after it.
  const dek = await importAesKey(dekRaw);
  if (epoch !== e) return false;
  await writeSession(dekRaw, unlockedAt);
  if (epoch !== e) {
    // lock() ran during the write; its remove may have landed before our set.
    await clearSession();
    return false;
  }
  mem = { dek, unlockedAt };
  return true;
}

type Opened = {
  header: VaultHeader;
  dekRaw: Uint8Array;
  dek: CryptoKey;
  restored: boolean;
};

/**
 * The passphrase path shared by unlock and change: backoff -> parse header -> derive -> unwrap
 * DEK (the GCM tag is the passphrase verifier) -> verify integrity. On success the returned
 * header carries the integrity copies of draftPub/lock/kdf; the caller must zero `dekRaw`.
 */
async function openWithPassphrase(
  tx: StoreTx,
  passphrase: string,
  now: number,
): Promise<{ fail: UnlockResult } | Opened> {
  const wait = await checkBackoff(now);
  if (wait > 0) {
    return { fail: { ok: false, reason: "backoff", retryAfterMs: wait } };
  }
  const raw = await tx.getItem(KEYS.header);
  if (raw === undefined) return { fail: { ok: false, reason: "no-vault" } };
  const header = parseHeader(raw);
  if (!header) return { fail: { ok: false, reason: "corrupt" } };

  const kek = await deriveKek(passphrase, header.kdf);
  let dekRaw: Uint8Array;
  try {
    dekRaw = await open(kek, header.wrappedDek, aad.dekPw());
  } catch {
    // `open` throws only DecryptError: wrong passphrase.
    await recordFailure(now);
    return { fail: { ok: false, reason: "wrong-passphrase" } };
  }
  try {
    const dek = await importAesKey(dekRaw);
    const copy = await readIntegrity(tx, dek);
    if (!copy) {
      // Right passphrase, but the tamper check cannot run: fail closed (ADR 0012).
      dekRaw.fill(0);
      return { fail: { ok: false, reason: "corrupt" } };
    }
    const restored = integrityJson(header) !== integrityJson(copy);
    return { header: { ...header, ...copy }, dekRaw, dek, restored };
  } catch (err) {
    dekRaw.fill(0);
    throw err;
  }
}

const success = (restored: boolean): UnlockResult =>
  restored ? { ok: true, warning: "integrity-restored" } : { ok: true };

/**
 * Hard-max lock for a session judged expired from a read of `unlockedAt` made in epoch `e`. Skips
 * the lock (returns false) when that read is stale: `lock()` already ran, or an unlock has since
 * written a session mirror with a different `unlockedAt` (committed or still committing), which
 * must not be wiped. A commit writes the mirror before memory, so checking the mirror suffices.
 */
async function lockIfStillExpired(
  e: number,
  unlockedAt: number,
): Promise<boolean> {
  const cur = await readSession();
  cur?.dekRaw.fill(0);
  // epoch: a lock() already ran (and an unlock started after it must not be cancelled).
  if (epoch !== e || (cur !== null && cur.unlockedAt !== unlockedAt)) {
    return false;
  }
  await lock();
  return true;
}

/**
 * `unlocked` when key material is in memory or in the session mirror. An unlocked vault past its
 * hard max (`unlockedAt + lock.maxHours`) is locked here (backstop for the alarm, ADR 0012).
 */
export async function status(now = Date.now()): Promise<VaultStatus> {
  const raw = await getItem(KEYS.header);
  if (raw === undefined) return { state: "none" };
  const header = parseHeader(raw);
  if (!header) return { state: "corrupt" };
  const locked: VaultStatus = { state: "locked", lock: header.lock };
  const unlocked = (unlockedAt: number): VaultStatus => ({
    state: "unlocked",
    unlockedAt,
    lock: header.lock,
  });
  const e = epoch;
  const unlockedAt = await currentUnlockedAt();
  if (unlockedAt === undefined) return locked;
  if (now < unlockedAt + header.lock.maxHours * HOUR_MS) {
    return unlocked(unlockedAt);
  }
  if (await lockIfStillExpired(e, unlockedAt)) return locked;
  // The read was stale (a lock or a fresh unlock happened meanwhile): report the current state.
  const current = await currentUnlockedAt();
  return current === undefined ? locked : unlocked(current);
}

/**
 * Service-worker wake check (Task 9): locks only when a session exists and is genuinely past its
 * hard max (`unlockedAt + lock.maxHours`) or its passphrase limit (`now - lastPassphraseAt >
 * lock.passphraseEveryDays`). A locked vault, an unreadable header or a session within both
 * limits is left alone. Goes through `lockIfStillExpired`, so a stale read never wipes a fresh
 * unlock. Returns whether it locked.
 */
export async function lockIfExpired(now = Date.now()): Promise<boolean> {
  const e = epoch;
  const unlockedAt = await currentUnlockedAt();
  if (unlockedAt === undefined) return false;
  // After the session read: an unlock writes the header before its mirror, so a header at least as
  // new as the `unlockedAt` just read is never older than the session it is judged against.
  const header = parseHeader(await getItem(KEYS.header));
  if (!header) return false;
  const expired =
    now >= unlockedAt + header.lock.maxHours * HOUR_MS ||
    now - header.lastPassphraseAt > header.lock.passphraseEveryDays * DAY_MS;
  return expired && (await lockIfStillExpired(e, unlockedAt));
}

async function currentUnlockedAt(): Promise<number | undefined> {
  if (mem) return mem.unlockedAt;
  const s = await readSession();
  s?.dekRaw.fill(0);
  return s?.unlockedAt;
}

/**
 * Creates the vault and leaves it unlocked, unless `lock()` runs while it is being created: then
 * the vault is still created (and this resolves) but stays locked. Throws `Error("weak")`,
 * `Error("exists")` (also when a concurrent call won), or `RangeError` for invalid KDF params /
 * `now`. `now` (here and in every vault function) is a test seam: production callers omit it and
 * must never forward a value from a message.
 */
export async function createVault(
  passphrase: string,
  kdf: KdfParams,
  now = Date.now(),
): Promise<void> {
  const e = epoch;
  assertStrong(passphrase);
  assertTime(now);
  const params = kdfCopy(kdf);
  // Cheap early exit; the authoritative check is inside the lock below.
  if ((await getItem(KEYS.header)) !== undefined) throw new Error("exists");

  const dekRaw = randomBytes(DEK_BYTES);
  let committed: boolean;
  try {
    const kek = await deriveKek(passphrase, params);
    const dek = await importAesKey(dekRaw);
    const wrappedDek = await seal(kek, dekRaw, aad.dekPw());
    const draft = await generateDraftKeyPair();
    const pkcs8 = await exportDraftPrivateKey(draft.privateKey);
    let wrappedDraftPriv: Sealed;
    try {
      wrappedDraftPriv = await seal(dek, pkcs8, aad.draftPriv());
    } finally {
      pkcs8.fill(0);
    }
    const header: VaultHeader = {
      v: 1,
      kdf: params,
      wrappedDek,
      draftPub: draft.publicJwk,
      wrappedDraftPriv,
      lock: { ...DEFAULT_LOCK },
      lastPassphraseAt: now,
    };
    const integrity = await sealIntegrity(dek, header);
    await withStoreLock(async (tx) => {
      if ((await tx.getItem(KEYS.header)) !== undefined) {
        throw new Error("exists");
      }
      await tx.setItems({ [KEYS.header]: header, [KEYS.integrity]: integrity });
    });
    committed = await commitUnlock(dekRaw, now, e);
  } finally {
    dekRaw.fill(0);
  }
  if (committed) notify(true);
}

export async function unlockWithPassphrase(
  passphrase: string,
  now = Date.now(),
): Promise<UnlockResult> {
  const e = epoch; // before the queue wait and the KDF: a lock() from here on wins
  assertTime(now);
  // Backoff check, verification and failure recording all run under the store lock, so
  // concurrent guesses are serialized and each sees the previous one's backoff.
  const out = await withStoreLock(async (tx) => {
    const r = await openWithPassphrase(tx, passphrase, now);
    if ("fail" in r) return { result: r.fail, committed: false };
    try {
      await tx.setItems({
        [KEYS.header]: { ...r.header, lastPassphraseAt: now },
      });
      await resetBackoff();
      const committed = await commitUnlock(r.dekRaw, now, e);
      const result: UnlockResult = committed
        ? success(r.restored)
        : { ok: false, reason: "locked-during-unlock" };
      return { result, committed };
    } finally {
      r.dekRaw.fill(0);
    }
  });
  // Outside the lock job, so a listener that writes to the store cannot deadlock it.
  if (out.committed) notify(true);
  return out.result;
}

/**
 * The lock generation: changes on every `lock()` and never otherwise. A caller that read it before
 * checking `status()` and finds it unchanged after later awaits knows no lock happened in between,
 * so plaintext decrypted with a DEK captured earlier may still be released (ADR 0025).
 */
export function lockEpoch(): number {
  return epoch;
}

export async function lock(): Promise<void> {
  epoch++;
  mem = null;
  await clearSession();
  // Again after the clear: a rebuild that started during teardown may have read the session
  // before the removal landed. Invalidate it if still in flight, and drop what it installed.
  epoch++;
  mem = null;
  notify(false);
}

/**
 * The DEK. After a service-worker restart it is rebuilt from the session mirror, but only within
 * the hard max (`unlockedAt + lock.maxHours`); an expired session, or one next to an unreadable
 * header, is locked instead (ruling R24).
 */
export async function getDek(now = Date.now()): Promise<CryptoKey> {
  if (mem) return mem.dek;
  const e = epoch;
  const s = await readSession();
  if (!s) throw new LockedError();
  let dek: CryptoKey;
  try {
    const header = parseHeader(await getItem(KEYS.header));
    const fresh = installed(); // TS keeps `mem` narrowed to null across the await
    if (fresh) return fresh.dek; // an unlock committed during the header read
    if (!header || now >= s.unlockedAt + header.lock.maxHours * HOUR_MS) {
      // Not locked when the session read is stale (a fresh unlock is committing); either way
      // this caller gets LockedError and may retry.
      await lockIfStillExpired(e, s.unlockedAt);
      throw new LockedError();
    }
    dek = await importAesKey(s.dekRaw);
  } finally {
    s.dekRaw.fill(0);
  }
  if (epoch !== e) throw new LockedError(); // lock() ran meanwhile
  mem ??= { dek, unlockedAt: s.unlockedAt };
  return mem.dek;
}

/** Non-extractable ECDH private key for opening drafts; cached until lock. */
export async function getDraftPrivateKey(): Promise<CryptoKey> {
  const e = epoch;
  const dek = await getDek();
  if (mem?.draftPriv) return mem.draftPriv;
  const header = parseHeader(await getItem(KEYS.header));
  if (!header) throw new Error("corrupt");
  // GCM under the DEK authenticates the wrapped key, so the plaintext header cannot substitute one.
  const pkcs8 = await open(dek, header.wrappedDraftPriv, aad.draftPriv());
  let key: CryptoKey;
  try {
    key = await importDraftPrivateKey(pkcs8);
  } finally {
    pkcs8.fill(0);
  }
  if (epoch !== e || !mem) throw new LockedError();
  mem.draftPriv = key;
  return key;
}

/**
 * Re-wraps the unchanged DEK under a KEK from `newP` and `kdf`; existing records stay valid.
 * Same backoff/verification as unlock (and the integrity copies are restored first, so a
 * tampered header is never re-sealed). Does not change the lock state. Throws `Error("weak")`.
 */
export async function changePassphrase(
  oldP: string,
  newP: string,
  kdf: KdfParams,
  now = Date.now(),
): Promise<UnlockResult> {
  assertStrong(newP);
  assertTime(now);
  const params = kdfCopy(kdf);
  return withStoreLock(async (tx) => {
    const r = await openWithPassphrase(tx, oldP, now);
    if ("fail" in r) return r.fail;
    try {
      const kek = await deriveKek(newP, params);
      const next: VaultHeader = {
        ...r.header,
        kdf: params,
        wrappedDek: await seal(kek, r.dekRaw, aad.dekPw()),
        lastPassphraseAt: now,
      };
      const integrity = await sealIntegrity(r.dek, next);
      await tx.setItems({ [KEYS.header]: next, [KEYS.integrity]: integrity });
      await resetBackoff();
    } finally {
      r.dekRaw.fill(0);
    }
    return success(r.restored);
  });
}

/** Called with `true` after an unlock (or create) commits and `false` on every `lock()`. */
export function onLockChange(cb: (unlocked: boolean) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Test-only: drop in-memory key material, as a service-worker restart would. Storage, session and listeners are kept. */
export function __resetForTests(): void {
  epoch++;
  mem = null;
}
