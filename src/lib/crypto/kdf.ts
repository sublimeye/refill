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

const SALT_BYTES = 16;
const CALIBRATE_TARGET_MS = 500;
const CALIBRATE_MAX_T = 20;

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

function assertParams(params: KdfParams): void {
  if (
    params.alg !== "argon2id" ||
    !(params.m >= KDF_FLOOR.m) ||
    !(params.t >= KDF_FLOOR.t)
  ) {
    throw new RangeError("KDF parameters below the floor");
  }
}

/** Internal (exported for known-answer tests): raw 32-byte Argon2id output for the NFC-normalized passphrase. */
export function argon2Raw(
  passphrase: string,
  params: KdfParams,
): Promise<Uint8Array> {
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
  assertParams(params);
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
