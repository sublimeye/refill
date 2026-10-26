// Write-only draft sealing (spec §4.1): ECDH P-256 ephemeral-static. Anyone holding the public
// `draftPub` can seal; only the vault's `draftPriv` (unlocked) can open.
import { aad } from "./aad";
import { DecryptError, open, seal } from "./aead";
import { utf8 } from "./bytes";
import { hkdfAesKey } from "./hkdf";

export interface SealedDraft {
  id: string;
  expiresAt: number | null;
  /** ephemeral public key (EC P-256, public members only) */
  eph: JsonWebKey;
  /** base64, 12 bytes (same format as `Sealed`) */
  iv: string;
  /** base64, ciphertext || 16-byte tag (same format as `Sealed`) */
  ct: string;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const ECDH_P256 = { name: "ECDH", namedCurve: "P-256" } as const;

/** Accepts only a public EC P-256 JWK; returns just its public members. Throws `TypeError` otherwise. */
function publicOnly(jwk: JsonWebKey): JsonWebKey {
  if (
    jwk === null ||
    typeof jwk !== "object" ||
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    "d" in jwk ||
    typeof jwk.x !== "string" ||
    typeof jwk.y !== "string"
  ) {
    throw new TypeError("draft public key must be a public EC P-256 JWK");
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

async function importPublic(jwk: JsonWebKey): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey("jwk", jwk, ECDH_P256, true, []);
}

async function raw(pub: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", pub));
}

/** info = utf8("refill/v1|draft|" + id + "|") || raw(eph.pub) || utf8("|") || raw(draftPub) */
async function draftKey(
  priv: CryptoKey,
  otherPub: CryptoKey,
  id: string,
  ephPub: CryptoKey,
  draftPub: CryptoKey,
): Promise<CryptoKey> {
  const ss = new Uint8Array(
    await globalThis.crypto.subtle.deriveBits(
      { name: "ECDH", public: otherPub },
      priv,
      256,
    ),
  );
  try {
    const info = concat(
      utf8(`refill/v1|draft|${id}|`),
      await raw(ephPub),
      utf8("|"),
      await raw(draftPub),
    );
    return await hkdfAesKey(ss, info);
  } finally {
    ss.fill(0);
  }
}

/** The private key is extractable so the vault can wrap it as PKCS#8 (see `exportDraftPrivateKey`). */
export async function generateDraftKeyPair(): Promise<{
  publicJwk: JsonWebKey;
  privateKey: CryptoKey;
}> {
  const kp = await globalThis.crypto.subtle.generateKey(ECDH_P256, true, [
    "deriveBits",
  ]);
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", kp.publicKey);
  return { publicJwk: publicOnly(jwk), privateKey: kp.privateKey };
}

export async function exportDraftPrivateKey(k: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.exportKey("pkcs8", k));
}

/** Non-extractable, usable only for ECDH `deriveBits`. */
export function importDraftPrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as BufferSource,
    ECDH_P256,
    false,
    ["deriveBits"],
  );
}

export async function sealDraft(
  draftPub: JsonWebKey,
  id: string,
  expiresAt: number | null,
  plaintext: Uint8Array,
): Promise<SealedDraft> {
  const pubJwk = publicOnly(draftPub);
  const aadBytes = aad.draft(id, expiresAt); // rejects ids containing "|"
  const pub = await importPublic(pubJwk);
  // Ephemeral private key is non-extractable and is dropped when this function returns.
  const eph = await globalThis.crypto.subtle.generateKey(ECDH_P256, false, [
    "deriveBits",
  ]);
  const key = await draftKey(eph.privateKey, pub, id, eph.publicKey, pub);
  const sealed = await seal(key, plaintext, aadBytes);
  const ephJwk = publicOnly(
    await globalThis.crypto.subtle.exportKey("jwk", eph.publicKey),
  );
  return { id, expiresAt, eph: ephJwk, iv: sealed.iv, ct: sealed.ct };
}

/**
 * `draftPub` comes from the vault header: a malformed one throws `TypeError`. Everything about the
 * record `d` (bad eph, tampered id/expiresAt/eph/iv/ct, wrong recipient) throws `DecryptError`.
 */
export async function openDraft(
  draftPriv: CryptoKey,
  draftPub: JsonWebKey,
  d: SealedDraft,
): Promise<Uint8Array> {
  const pubJwk = publicOnly(draftPub);
  try {
    const pub = await importPublic(pubJwk);
    const eph = await importPublic(publicOnly(d.eph));
    const key = await draftKey(draftPriv, eph, d.id, eph, pub);
    return await open(
      key,
      { iv: d.iv, ct: d.ct },
      aad.draft(d.id, d.expiresAt),
    );
  } catch {
    throw new DecryptError();
  }
}
