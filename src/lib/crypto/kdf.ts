// Passphrase -> KEK via Argon2id (hash-wasm, see ADR 0001). Parameters are stored in the vault header.
import { argon2id } from "hash-wasm";
import { importAesKey } from "./aead";
import { fromB64, randomBytes, toB64 } from "./bytes";

export interface KdfParams {
  alg: "argon2id";
  v: 1;
  /** memory in KiB */
  m: number;
  t: number;
  p: 1;
  /** base64, 16 bytes */
  salt: string;
}

export const KDF_FLOOR = { m: 65536, t: 3 } as const;
/** Upper bounds accepted from a stored header: 256 MiB, and the calibration cap. */
export const KDF_MAX = { m: 262144, t: 20 } as const;

const SALT_BYTES = 16;
const CALIBRATE_TARGET_MS = 500;
const CALIBRATE_MAX_T = KDF_MAX.t;

export function newKdfParams(t?: number): KdfParams {
  return {
    alg: "argon2id",
    v: 1,
    m: KDF_FLOOR.m,
    t: Math.max(t ?? KDF_FLOOR.t, KDF_FLOOR.t),
    p: 1,
    salt: toB64(randomBytes(SALT_BYTES)),
  };
}

/**
 * Params come from the plaintext vault header, so every field is validated: floor and upper
 * bounds on m and t so a tampered header can neither weaken the KDF nor hang or crash unlock.
 * Accepts any value (wrong types, null, non-objects) and returns false for anything invalid.
 */
export function isKdfParams(x: unknown): x is KdfParams {
  if (x === null || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return (
    p.alg === "argon2id" &&
    p.v === 1 &&
    p.p === 1 &&
    Number.isSafeInteger(p.m) &&
    (p.m as number) >= KDF_FLOOR.m &&
    (p.m as number) <= KDF_MAX.m &&
    Number.isSafeInteger(p.t) &&
    (p.t as number) >= KDF_FLOOR.t &&
    (p.t as number) <= KDF_MAX.t &&
    saltLength(p.salt) === SALT_BYTES
  );
}

/** RangeError for any failure of `isKdfParams`, including wrong types. */
function assertParams(params: KdfParams): void {
  if (!isKdfParams(params)) throw new RangeError("invalid KDF parameters");
}

function saltLength(salt: unknown): number {
  try {
    return fromB64(salt as string).length;
  } catch {
    return -1;
  }
}

/** Internal (exported for known-answer tests): raw 32-byte Argon2id output for the NFC-normalized passphrase. */
export async function argon2Raw(
  passphrase: string,
  params: KdfParams,
): Promise<Uint8Array> {
  assertParams(params);
  return argon2id({
    password: passphrase.normalize("NFC"),
    salt: fromB64(params.salt),
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: 32,
    outputType: "binary",
  });
}

export async function deriveKek(
  passphrase: string,
  params: KdfParams,
): Promise<CryptoKey> {
  const raw = await argon2Raw(passphrase, params);
  try {
    return await importAesKey(raw);
  } finally {
    raw.fill(0);
  }
}

async function timeDerivation(t: number): Promise<number> {
  const start = performance.now();
  await argon2Raw("calibration", newKdfParams(t));
  return performance.now() - start;
}

/**
 * Pick the smallest t (floor 3, cap 20) whose derivation takes at least 500 ms at m = 64 MiB.
 * `timeIt` is injectable for tests.
 */
export async function calibrate(
  timeIt: (t: number) => Promise<number> = timeDerivation,
): Promise<KdfParams> {
  let t: number = KDF_FLOOR.t;
  while (t < CALIBRATE_MAX_T && (await timeIt(t)) < CALIBRATE_TARGET_MS) t++;
  return newKdfParams(t);
}
