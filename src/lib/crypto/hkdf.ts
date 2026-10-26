// HKDF-SHA256 (RFC 5869) for sub-key derivation from high-entropy input keying material.
import { importAesKey } from "./aead";

const DEFAULT_SALT = new Uint8Array(32);

/** Internal (exported for known-answer tests): `lengthBytes` of HKDF-SHA256 output. */
export async function hkdfBits(
  ikm: Uint8Array,
  info: Uint8Array,
  salt: Uint8Array | undefined,
  lengthBytes: number,
): Promise<Uint8Array> {
  const base = await globalThis.crypto.subtle.importKey(
    "raw",
    ikm as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: (salt ?? DEFAULT_SALT) as BufferSource,
      info: info as BufferSource,
    },
    base,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

export async function hkdfAesKey(
  ikm: Uint8Array,
  info: Uint8Array,
  salt?: Uint8Array,
): Promise<CryptoKey> {
  const raw = await hkdfBits(ikm, info, salt, 32);
  try {
    return await importAesKey(raw);
  } finally {
    raw.fill(0);
  }
}
