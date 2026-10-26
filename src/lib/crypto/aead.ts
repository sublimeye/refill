// AES-256-GCM with a fresh random 96-bit IV per seal. Ciphertext includes the 16-byte tag.
import { fromB64, randomBytes, toB64 } from "./bytes";

export interface Sealed {
  /** base64, 12 bytes */
  iv: string;
  /** base64, ciphertext || 16-byte tag */
  ct: string;
}

/** Any failure to decrypt/authenticate. Deliberately uninformative. */
export class DecryptError extends Error {
  constructor() {
    super("decryption failed");
    this.name = "DecryptError";
  }
}

const IV_BYTES = 12;

export function importAesKey(
  raw: Uint8Array,
  extractable = false,
): Promise<CryptoKey> {
  if (raw.length !== 32) {
    return Promise.reject(new RangeError("AES-256 key must be 32 bytes"));
  }
  return globalThis.crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "AES-GCM" },
    extractable,
    ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
  );
}

/** Test-only (known-answer vectors): seal with a caller-supplied IV. Never re-export; never reuse an IV. */
export async function sealWithIv(
  key: CryptoKey,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Sealed> {
  const ct = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: aad as BufferSource,
      tagLength: 128,
    },
    key,
    plaintext as BufferSource,
  );
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

export function seal(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Sealed> {
  return sealWithIv(key, randomBytes(IV_BYTES), plaintext, aad);
}

export async function open(
  key: CryptoKey,
  s: Sealed,
  aad: Uint8Array,
): Promise<Uint8Array> {
  try {
    const iv = fromB64(s.iv);
    if (iv.length !== IV_BYTES) throw new TypeError("bad iv length");
    const pt = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        additionalData: aad as BufferSource,
        tagLength: 128,
      },
      key,
      fromB64(s.ct) as BufferSource,
    );
    return new Uint8Array(pt);
  } catch {
    throw new DecryptError();
  }
}
