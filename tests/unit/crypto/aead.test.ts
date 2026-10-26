import { describe, expect, it } from "vitest";
import { aad } from "../../../src/lib/crypto/aad";
import {
  DecryptError,
  importAesKey,
  open,
  seal,
  sealWithIv,
} from "../../../src/lib/crypto/aead";
import { fromB64, toB64, utf8, fromUtf8 } from "../../../src/lib/crypto/bytes";

const newKey = () => importAesKey(crypto.getRandomValues(new Uint8Array(32)));
const A = aad.profile("p1", "https://a.example");

describe("aead", () => {
  it("seal then open round-trips", async () => {
    const key = await newKey();
    const s = await seal(key, utf8("hello"), A);
    expect(fromUtf8(await open(key, s, A))).toBe("hello");
  });

  it("open with different AAD throws DecryptError", async () => {
    const key = await newKey();
    const s = await seal(key, utf8("hello"), A);
    await expect(
      open(key, s, aad.profile("p1", "https://b.example")),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it("open with a different key throws DecryptError", async () => {
    const s = await seal(await newKey(), utf8("hello"), A);
    await expect(open(await newKey(), s, A)).rejects.toBeInstanceOf(
      DecryptError,
    );
  });

  it("flipping one ciphertext byte throws DecryptError", async () => {
    const key = await newKey();
    const s = await seal(key, utf8("hello"), A);
    const ct = fromB64(s.ct);
    ct[0] = ct[0]! ^ 1;
    await expect(
      open(key, { iv: s.iv, ct: toB64(ct) }, A),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it("truncated ciphertext throws DecryptError", async () => {
    const key = await newKey();
    const s = await seal(key, utf8("hello"), A);
    const ct = fromB64(s.ct).slice(0, 5); // shorter than the 16-byte tag
    await expect(
      open(key, { iv: s.iv, ct: toB64(ct) }, A),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it("malformed base64 or IV length throws DecryptError", async () => {
    const key = await newKey();
    const s = await seal(key, utf8("hello"), A);
    await expect(open(key, { iv: "%%%", ct: s.ct }, A)).rejects.toBeInstanceOf(
      DecryptError,
    );
    await expect(
      open(key, { iv: toB64(new Uint8Array(8)), ct: s.ct }, A),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it("two seals of the same plaintext use different IVs", async () => {
    const key = await newKey();
    const ivs = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const s = await seal(key, utf8("same"), A);
      expect(fromB64(s.iv)).toHaveLength(12);
      ivs.add(s.iv);
    }
    expect(ivs.size).toBe(1000);
  });

  it("known-answer", async () => {
    // Computed once with Node, not at test runtime:
    //   const c = require("crypto");
    //   const ci = c.createCipheriv("aes-256-gcm", Buffer.alloc(32), Buffer.alloc(12));
    //   ci.setAAD(Buffer.from("refill/v1|integrity"));
    //   const ct = Buffer.concat([ci.update("refill"), ci.final()]);
    //   Buffer.concat([ct, ci.getAuthTag()]).toString("base64")
    const expected = "vMImVCEMduXyg4eAo+xQIPmIQsRTKw==";
    const key = await importAesKey(new Uint8Array(32));
    const s = await sealWithIv(
      key,
      new Uint8Array(12),
      utf8("refill"),
      utf8("refill/v1|integrity"),
    );
    expect(s.ct).toBe(expected);
    expect(s.iv).toBe(toB64(new Uint8Array(12)));
    expect(fromUtf8(await open(key, s, aad.integrity()))).toBe("refill");
  });

  it("importAesKey is non-extractable by default", async () => {
    const key = await newKey();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
    const ex = await importAesKey(new Uint8Array(32), true);
    expect(ex.extractable).toBe(true);
  });

  it("importAesKey rejects keys that are not 32 bytes", async () => {
    await expect(importAesKey(new Uint8Array(16))).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});
