// The recording session store (spec §6.2, ADR 0029). The worker owns at most one session, kept in
// storage.session (RAM-only) at "recorder:session" as `{ meta, body }`: the metadata in plaintext and
// the body (steps and captured values) sealed under the DEK with AAD
// "refill/v1|recording|<id>|<origin>", so a captured value is never plaintext at rest. Every
// read-modify-write runs on one module-level promise chain. A lock or the TTL discards the session
// and leaves a data-free tombstone so the pill can say why recording stopped.
import { browser } from "wxt/browser";
import { aad } from "../crypto/aad";
import { DecryptError, open, seal, type Sealed } from "../crypto/aead";
import { fromUtf8, utf8 } from "../crypto/bytes";
import { newId } from "../profiles/store";
import { ID_RE, type Profile } from "../profiles/types";
import { normalizeOrigin } from "../sites/origin";
import { TAG_BYTES, parseSealed } from "../vault/header";
import { LockedError } from "../vault/types";
import { getDek, lockEpoch, onLockChange } from "../vault/vault";
import { emptyBody, seedBody, type RecBody } from "./types";

/** A session lives 30 min from its start; Finish resets it to 30 min from then. */
export const RECORDING_TTL_MS = 1_800_000;
/** How long the pill can still learn why the session stopped. */
const TOMBSTONE_TTL_MS = 1_800_000;

const KEY = "recorder:session";
const TOMBSTONE_KEY = "recorder:stopped";
const BADGE_RECORDING = "●";

export interface SessionMeta {
  v: 1;
  id: string;
  tabId: number;
  origin: string;
  startedAt: number;
  expiresAt: number;
  finished: boolean;
  /** Id of the saved profile this session was seeded from (Record again), else null. */
  seededFrom: string | null;
}

export type StopReason = "locked" | "expired";
export type DiscardReason =
  StopReason | "cancelled" | "replaced" | "saved" | "tab-closed";

export type SessionMatch = { tabId: number; origin: string } | { id: string };

export interface SessionUpdate<T> {
  body?: RecBody;
  meta?: Partial<Pick<SessionMeta, "finished" | "expiresAt">>;
  result: T;
}

interface Stored {
  meta: SessionMeta;
  body: Sealed;
}

interface Tombstone {
  tabId: number;
  reason: StopReason;
  at: number;
}

type Obj = Record<string, unknown>;

const META_KEYS = [
  "v",
  "id",
  "tabId",
  "origin",
  "startedAt",
  "expiresAt",
  "finished",
  "seededFrom",
] as const;

function plainWithKeys(x: unknown, keys: readonly string[]): x is Obj {
  if (x === null || typeof x !== "object") return false;
  const proto = Object.getPrototypeOf(x);
  if (proto !== Object.prototype && proto !== null) return false;
  const own = Object.keys(x);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

const isTabId = (x: unknown): x is number =>
  Number.isSafeInteger(x) && (x as number) >= 0;

const isOrigin = (x: unknown): x is string =>
  typeof x === "string" && normalizeOrigin(x) === x;

// storage.session is readable and writable by every trusted extension context: never trust the
// shape read back, and return fresh objects with known keys only.
function parseMeta(x: unknown): SessionMeta | null {
  if (!plainWithKeys(x, META_KEYS)) return null;
  const { v, id, tabId, origin, startedAt, expiresAt, finished, seededFrom } =
    x;
  if (
    v !== 1 ||
    typeof id !== "string" ||
    !ID_RE.test(id) ||
    !isTabId(tabId) ||
    !isOrigin(origin) ||
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    typeof finished !== "boolean" ||
    !(
      seededFrom === null ||
      (typeof seededFrom === "string" && ID_RE.test(seededFrom))
    )
  ) {
    return null;
  }
  return { v, id, tabId, origin, startedAt, expiresAt, finished, seededFrom };
}

/** `null` when absent, `"malformed"` for a record of any other shape. */
async function load(): Promise<Stored | null | "malformed"> {
  const raw = (await browser.storage.session.get(KEY))[KEY] as unknown;
  if (raw === undefined) return null;
  if (!plainWithKeys(raw, ["meta", "body"])) return "malformed";
  const meta = parseMeta(raw.meta);
  const body = parseSealed(raw.body, TAG_BYTES, Number.MAX_SAFE_INTEGER);
  return meta && body ? { meta, body } : "malformed";
}

function save(s: Stored): Promise<void> {
  return browser.storage.session.set({ [KEY]: s });
}

function removeRecord(): Promise<void> {
  return browser.storage.session.remove(KEY);
}

async function sealBody(
  dek: CryptoKey,
  meta: SessionMeta,
  body: RecBody,
): Promise<Sealed> {
  const pt = utf8(JSON.stringify(body));
  try {
    return await seal(dek, pt, aad.recording(meta.id, meta.origin));
  } finally {
    pt.fill(0);
  }
}

async function openBody(
  dek: CryptoKey,
  meta: SessionMeta,
  sealed: Sealed,
): Promise<RecBody> {
  const pt = await open(dek, sealed, aad.recording(meta.id, meta.origin));
  try {
    return JSON.parse(fromUtf8(pt)) as RecBody;
  } catch {
    throw new DecryptError();
  } finally {
    pt.fill(0);
  }
}

const errName = (err: unknown): string =>
  err instanceof Error ? err.name : "error";

async function setBadge(tabId: number, text: string): Promise<void> {
  try {
    await browser.action.setBadgeText({ tabId, text });
  } catch (err) {
    console.error("[refill] badge failed:", errName(err));
  }
}

/** Clears the tab's recording badge (Finish, discard). Failures are logged by error name only. */
export function clearBadge(tabId: number): Promise<void> {
  return setBadge(tabId, "");
}

/**
 * Wakes the tab's content script with a data-free message, so it asks the worker for the state.
 * Failures (no content script, a closed tab) are ignored and logged by error name only.
 */
export async function nudge(tabId: number): Promise<void> {
  try {
    await browser.tabs.sendMessage(
      tabId,
      { type: "refill-nudge" },
      { frameId: 0 },
    );
  } catch (err) {
    console.error("[refill] nudge failed:", errName(err));
  }
}

// One chain for every job that reads or writes the record, so concurrent captures cannot lose
// each other's writes. A job must never wait on another job (it would wait on itself).
let chain: Promise<unknown> = Promise.resolve();

function serialized<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job);
  chain = run.catch(() => undefined);
  return run;
}

/** Inside a chain job: removes the record, leaves a tombstone for a lock or expiry, clears the badge and nudges the tab. */
async function drop(
  meta: SessionMeta,
  reason: DiscardReason,
  at: number,
): Promise<void> {
  await removeRecord();
  if (reason === "locked" || reason === "expired") {
    const t: Tombstone = { tabId: meta.tabId, reason, at };
    await browser.storage.session.set({ [TOMBSTONE_KEY]: t });
  }
  // A closed tab has neither a badge nor a content script left.
  if (reason === "tab-closed") return;
  await clearBadge(meta.tabId);
  // Not awaited: the content script answers a nudge by messaging the worker, whose handler queues
  // on this chain behind the current job.
  void nudge(meta.tabId);
}

/**
 * Starts a session for `tabId` on `origin`, empty or seeded from a saved profile (Record again),
 * replacing any previous one. Sets the recording badge and clears the tombstone. Throws
 * `LockedError` when locked (nothing changes then) and `TypeError` for a bad tab id or an origin
 * that is not a canonical https origin.
 */
export function startSession(
  tabId: number,
  origin: string,
  now: number,
  seed: Profile | null,
): Promise<SessionMeta> {
  if (!isTabId(tabId)) return Promise.reject(new TypeError("bad tab id"));
  if (!isOrigin(origin)) return Promise.reject(new TypeError("bad origin"));
  return serialized(async () => {
    const dek = await getDek();
    const meta: SessionMeta = {
      v: 1,
      id: newId(),
      tabId,
      origin,
      startedAt: now,
      expiresAt: now + RECORDING_TTL_MS,
      finished: false,
      seededFrom: seed?.id ?? null,
    };
    const body = await sealBody(dek, meta, seed ? seedBody(seed) : emptyBody());
    const prev = await load();
    if (prev === "malformed") await removeRecord();
    else if (prev) await drop(prev.meta, "replaced", now);
    await save({ meta, body });
    await browser.storage.session.remove(TOMBSTONE_KEY);
    await setBadge(tabId, BADGE_RECORDING);
    return meta;
  });
}

function matches(meta: SessionMeta, m: SessionMatch): boolean {
  return "id" in m
    ? meta.id === m.id
    : meta.tabId === m.tabId && meta.origin === m.origin;
}

/**
 * Runs `fn` on the session that `match` names, serialized with every other session job. `"off"`
 * when there is none, or it belongs to another tab, origin or id. An expired session is discarded
 * (`"expired"`), and so is one whose body cannot be opened because the vault is locked
 * (`"locked"`); both answer `"off"`. A body that fails to open under an unlocked vault (tampered,
 * or moved under another id) is dropped without a tombstone. `fn` gets a copy of the metadata. A
 * returned `body` is re-sealed with a fresh IV; a returned `meta` patch updates `finished` and
 * `expiresAt` (at most `now + RECORDING_TTL_MS`, else `TypeError`). If `fn` throws, nothing is
 * written. A lock that lands after the DEK was taken and before `fn` returned drops the session as
 * `"locked"` and answers `"off"`, writing nothing. A lock can still land during the write itself:
 * a caller that replies with values re-checks `lockEpoch()` synchronously before replying.
 */
export function withSession<T>(
  match: SessionMatch,
  now: number,
  fn: (meta: SessionMeta, body: RecBody) => SessionUpdate<T>,
): Promise<T | "off"> {
  return serialized(async (): Promise<T | "off"> => {
    const rec = await load();
    if (rec === null) return "off";
    if (rec === "malformed") {
      await removeRecord();
      return "off";
    }
    const { meta } = rec;
    if (now >= meta.expiresAt) {
      await drop(meta, "expired", now);
      return "off";
    }
    if (!matches(meta, match)) return "off";
    // Before the DEK: a lock from here on must not let a body opened with that DEK be written back
    // (or its values answered) as if the vault were still unlocked.
    const epoch = lockEpoch();
    let dek: CryptoKey;
    let body: RecBody;
    try {
      dek = await getDek();
      body = await openBody(dek, meta, rec.body);
    } catch (err) {
      if (err instanceof LockedError) {
        await drop(meta, "locked", now);
        return "off";
      }
      if (err instanceof DecryptError) {
        await drop(meta, "cancelled", now);
        return "off";
      }
      throw err;
    }
    const out = fn({ ...meta }, body);
    if (lockEpoch() !== epoch) {
      await drop(meta, "locked", now);
      return "off";
    }
    const next: SessionMeta = { ...meta };
    if (out.meta?.finished !== undefined) {
      if (typeof out.meta.finished !== "boolean") {
        throw new TypeError("bad finished");
      }
      next.finished = out.meta.finished;
    }
    if (out.meta?.expiresAt !== undefined) {
      // Finish may reset the TTL to 30 min from now, never extend a session past that.
      if (
        !Number.isFinite(out.meta.expiresAt) ||
        out.meta.expiresAt > now + RECORDING_TTL_MS
      ) {
        throw new TypeError("bad expiresAt");
      }
      next.expiresAt = out.meta.expiresAt;
    }
    const metaChanged =
      next.finished !== meta.finished || next.expiresAt !== meta.expiresAt;
    if (out.body !== undefined) {
      await save({ meta: next, body: await sealBody(dek, next, out.body) });
    } else if (metaChanged) {
      await save({ meta: next, body: rec.body });
    }
    return out.result;
  });
}

/**
 * Discards the session, if any (see `drop`). With `id`, only while the stored session still has
 * that id, so a late discard of an old session never ends a newer one. A malformed record is
 * removed either way.
 */
export function discardSession(
  reason: DiscardReason,
  id?: string,
): Promise<void> {
  return serialized(async () => {
    const rec = await load();
    if (rec === "malformed") await removeRecord();
    else if (rec && (id === undefined || rec.meta.id === id)) {
      await drop(rec.meta, reason, Date.now());
    }
  });
}

function parseTombstone(x: unknown): Tombstone | null {
  if (!plainWithKeys(x, ["tabId", "reason", "at"])) return null;
  const { tabId, reason, at } = x;
  if (
    !isTabId(tabId) ||
    (reason !== "locked" && reason !== "expired") ||
    typeof at !== "number" ||
    !Number.isFinite(at)
  ) {
    return null;
  }
  return { tabId, reason, at };
}

/** Why the session of `tabId` stopped, for 30 min after a lock or an expiry; else null. */
export async function stoppedReason(
  tabId: number,
  now: number,
): Promise<StopReason | null> {
  const raw = (await browser.storage.session.get(TOMBSTONE_KEY))[
    TOMBSTONE_KEY
  ] as unknown;
  const t = parseTombstone(raw);
  if (!t || t.tabId !== tabId || now - t.at >= TOMBSTONE_TTL_MS) return null;
  return t.reason;
}

/** Discards the session of a closed tab, unless it is finished (its review page still needs it). */
function discardClosedTab(tabId: number): Promise<void> {
  return serialized(async () => {
    const rec = await load();
    if (rec === null || rec === "malformed") return;
    if (rec.meta.tabId !== tabId || rec.meta.finished) return;
    await drop(rec.meta, "tab-closed", Date.now());
  });
}

let stopLockListener: (() => void) | null = null;

/**
 * Registers the lock and tab-close listeners. Synchronous: call it at the worker's top level. Calling
 * it again replaces the vault listener rather than adding a second one.
 */
export function installRecorderListeners(): void {
  stopLockListener?.();
  stopLockListener = onLockChange((unlocked) => {
    if (unlocked) return;
    discardSession("locked").catch((err: unknown) => {
      console.error("[refill] discard on lock failed:", errName(err));
    });
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    discardClosedTab(tabId).catch((err: unknown) => {
      console.error("[refill] discard on tab close failed:", errName(err));
    });
  });
}
