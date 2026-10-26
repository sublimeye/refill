// Untrusted-input parsers for the plaintext vault header and the integrity payload. Anyone with
// write access to the profile can edit `vault:header`, so every field is checked and a fresh,
// plain object with only known keys is returned (safe for `canonicalJson`); anything else -> null.
import type { Sealed } from "../crypto/aead";
import { fromB64 } from "../crypto/bytes";
import { isKdfParams, type KdfParams } from "../crypto/kdf";
import type { IntegrityPayload, LockPolicy, VaultHeader } from "./types";

type Obj = Record<string, unknown>;

const IV_BYTES = 12;
const TAG_BYTES = 16;
/** A sealed 32-byte DEK: ciphertext || tag. */
const WRAPPED_DEK_BYTES = 32 + TAG_BYTES;
/** PKCS#8 for P-256 is ~138 bytes; the cap only bounds work on a tampered header. */
const WRAPPED_DRAFT_PRIV_MAX = 1024;
const PRF_SALT_BYTES = 32;
/** 32 bytes as unpadded canonical base64url (last char carries 2 zero bits). */
const B64URL_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
/** WebAuthn credential ids are at most 1023 bytes; stored as unpadded base64url. */
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,1364}$/;

const LOCK_RANGES: Record<keyof LockPolicy, [number, number]> = {
  idleMinutes: [1, 240],
  maxHours: [1, 72],
  passphraseEveryDays: [1, 90],
};

function isPlainObject(x: unknown): x is Obj {
  if (x === null || typeof x !== "object") return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

/** Plain object whose own keys are all in `required` ∪ `optional`, with every `required` key present. */
function shaped(
  x: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): x is Obj {
  if (!isPlainObject(x)) return false;
  const keys = Object.keys(x);
  return (
    required.every((k) => keys.includes(k)) &&
    keys.every((k) => required.includes(k) || optional.includes(k))
  );
}

function b64Length(s: unknown): number {
  if (typeof s !== "string") return -1;
  try {
    return fromB64(s).length;
  } catch {
    return -1;
  }
}

/** `{ iv, ct }` with a 12-byte IV and `minCt`..`maxCt` bytes of ciphertext (tag included). */
export function parseSealed(
  x: unknown,
  minCt: number,
  maxCt: number,
): Sealed | null {
  if (!shaped(x, ["iv", "ct"])) return null;
  const ctLen = b64Length(x.ct);
  if (b64Length(x.iv) !== IV_BYTES || ctLen < minCt || ctLen > maxCt) {
    return null;
  }
  return { iv: x.iv as string, ct: x.ct as string };
}

const parseWrappedDek = (x: unknown) =>
  parseSealed(x, WRAPPED_DEK_BYTES, WRAPPED_DEK_BYTES);

/** Reuses the kdf module's validator (types, v/p, m/t floor and max, 16-byte salt). */
function parseKdf(x: unknown): KdfParams | null {
  if (!shaped(x, ["alg", "v", "m", "t", "p", "salt"]) || !isKdfParams(x)) {
    return null;
  }
  return { alg: x.alg, v: x.v, m: x.m, t: x.t, p: x.p, salt: x.salt };
}

/** Public EC P-256 JWK with exactly kty/crv/x/y (what `generateDraftKeyPair` produces). */
function parseDraftPub(x: unknown): JsonWebKey | null {
  if (
    !shaped(x, ["kty", "crv", "x", "y"]) ||
    x.kty !== "EC" ||
    x.crv !== "P-256" ||
    typeof x.x !== "string" ||
    typeof x.y !== "string" ||
    !B64URL_32.test(x.x) ||
    !B64URL_32.test(x.y)
  ) {
    return null;
  }
  return { kty: "EC", crv: "P-256", x: x.x, y: x.y };
}

function parseLock(x: unknown): LockPolicy | null {
  if (!shaped(x, Object.keys(LOCK_RANGES))) return null;
  for (const [k, [lo, hi]] of Object.entries(LOCK_RANGES)) {
    const v = x[k];
    if (!Number.isSafeInteger(v) || (v as number) < lo || (v as number) > hi) {
      return null;
    }
  }
  return {
    idleMinutes: x.idleMinutes as number,
    maxHours: x.maxHours as number,
    passphraseEveryDays: x.passphraseEveryDays as number,
  };
}

function parsePrf(x: unknown): VaultHeader["prf"] | null {
  if (!shaped(x, ["credentialId", "salt", "wrappedDek"])) return null;
  const wrappedDek = parseWrappedDek(x.wrappedDek);
  if (
    typeof x.credentialId !== "string" ||
    !CREDENTIAL_ID.test(x.credentialId) ||
    b64Length(x.salt) !== PRF_SALT_BYTES ||
    !wrappedDek
  ) {
    return null;
  }
  return { credentialId: x.credentialId, salt: x.salt as string, wrappedDek };
}

export function parseHeader(raw: unknown): VaultHeader | null {
  if (
    !shaped(
      raw,
      [
        "v",
        "kdf",
        "wrappedDek",
        "draftPub",
        "wrappedDraftPriv",
        "lock",
        "lastPassphraseAt",
      ],
      ["prf"],
    ) ||
    raw.v !== 1
  ) {
    return null;
  }
  const kdf = parseKdf(raw.kdf);
  const wrappedDek = parseWrappedDek(raw.wrappedDek);
  const draftPub = parseDraftPub(raw.draftPub);
  const wrappedDraftPriv = parseSealed(
    raw.wrappedDraftPriv,
    TAG_BYTES + 1,
    WRAPPED_DRAFT_PRIV_MAX,
  );
  const lock = parseLock(raw.lock);
  const at = raw.lastPassphraseAt;
  if (
    !kdf ||
    !wrappedDek ||
    !draftPub ||
    !wrappedDraftPriv ||
    !lock ||
    !Number.isSafeInteger(at) ||
    (at as number) < 0
  ) {
    return null;
  }
  const header: VaultHeader = {
    v: 1,
    kdf,
    wrappedDek,
    draftPub,
    wrappedDraftPriv,
    lock,
    lastPassphraseAt: at as number,
  };
  if ("prf" in raw) {
    const prf = parsePrf(raw.prf);
    if (!prf) return null;
    header.prf = prf;
  }
  return header;
}

/** The decrypted `vault:integrity` JSON: exactly `{ draftPub, lock, kdf }`, same rules as the header. */
export function parseIntegrityPayload(raw: unknown): IntegrityPayload | null {
  if (!shaped(raw, ["draftPub", "lock", "kdf"])) return null;
  const draftPub = parseDraftPub(raw.draftPub);
  const lock = parseLock(raw.lock);
  const kdf = parseKdf(raw.kdf);
  return draftPub && lock && kdf ? { draftPub, lock, kdf } : null;
}
