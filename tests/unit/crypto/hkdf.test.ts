import { describe, expect, it } from "vitest";
import { aad } from "../../../src/lib/crypto/aad";
import { open, seal } from "../../../src/lib/crypto/aead";
import { fromUtf8, utf8 } from "../../../src/lib/crypto/bytes";
import { hkdfAesKey, hkdfBits } from "../../../src/lib/crypto/hkdf";

const unhex = (h: string) =>
  Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// RFC 5869 Appendix A.1 (SHA-256)
const IKM = unhex("0b".repeat(22));
const SALT = unhex("000102030405060708090a0b0c");
const INFO = unhex("f0f1f2f3f4f5f6f7f8f9");
const OKM =
  "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865";

describe("hkdf", () => {
  it("matches RFC 5869 test case 1", async () => {
    expect(hex(await hkdfBits(IKM, INFO, SALT, 42))).toBe(OKM);
  });

  it("default salt is 32 zero bytes", async () => {
    const a = await hkdfBits(IKM, INFO, undefined, 32);
    const b = await hkdfBits(IKM, INFO, new Uint8Array(32), 32);
    expect(hex(a)).toBe(hex(b));
  });

  it("hkdfAesKey is non-extractable AES-GCM and usable", async () => {
    const A = aad.profile("p1", "https://a.example");
    const k1 = await hkdfAesKey(IKM, utf8("refill/test"));
    const k2 = await hkdfAesKey(IKM, utf8("refill/test"));
    expect(k1.extractable).toBe(false);
    expect(k1.algorithm.name).toBe("AES-GCM");
    const s = await seal(k1, utf8("hi"), A);
    expect(fromUtf8(await open(k2, s, A))).toBe("hi");
  });

  it("different info gives a different key", async () => {
    const A = aad.profile("p1", "https://a.example");
    const k1 = await hkdfAesKey(IKM, utf8("a"));
    const k2 = await hkdfAesKey(IKM, utf8("b"));
    const s = await seal(k1, utf8("hi"), A);
    await expect(open(k2, s, A)).rejects.toThrow();
  });
});
