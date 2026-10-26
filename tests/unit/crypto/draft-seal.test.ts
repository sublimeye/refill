import { describe, expect, it } from "vitest";
import { DecryptError } from "../../../src/lib/crypto/aead";
import { fromB64, fromUtf8, utf8 } from "../../../src/lib/crypto/bytes";
import {
  exportDraftPrivateKey,
  generateDraftKeyPair,
  importDraftPrivateKey,
  openDraft,
  sealDraft,
} from "../../../src/lib/crypto/draft-seal";

const PT = utf8("hello draft");

describe("draft-seal", () => {
  it("round-trips", async () => {
    const { publicJwk, privateKey } = await generateDraftKeyPair();
    const d = await sealDraft(publicJwk, "d1", 123, PT);
    expect(d.id).toBe("d1");
    expect(d.expiresAt).toBe(123);
    expect(fromUtf8(await openDraft(privateKey, publicJwk, d))).toBe(
      "hello draft",
    );
  });

  it("round-trips with null expiresAt and empty plaintext", async () => {
    const { publicJwk, privateKey } = await generateDraftKeyPair();
    const d = await sealDraft(publicJwk, "d1", null, new Uint8Array(0));
    expect((await openDraft(privateKey, publicJwk, d)).length).toBe(0);
  });

  it("uses a fresh ephemeral key and IV per draft", async () => {
    const { publicJwk } = await generateDraftKeyPair();
    const a = await sealDraft(publicJwk, "d1", null, PT);
    const b = await sealDraft(publicJwk, "d1", null, PT);
    expect(a.eph.x).not.toBe(b.eph.x);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("publishes only public EC P-256 parameters", async () => {
    const { publicJwk } = await generateDraftKeyPair();
    const d = await sealDraft(publicJwk, "d1", null, PT);
    for (const j of [publicJwk, d.eph]) {
      expect(j.kty).toBe("EC");
      expect(j.crv).toBe("P-256");
      expect(j.d).toBeUndefined();
    }
  });

  it("follows the spec key schedule (independent derivation)", async () => {
    const { publicJwk, privateKey } = await generateDraftKeyPair();
    const d = await sealDraft(publicJwk, "d1", 77, PT);
    const subtle = globalThis.crypto.subtle;
    const imp = (j: JsonWebKey) =>
      subtle.importKey(
        "jwk",
        j,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        [],
      );
    const [ephPub, pub] = [await imp(d.eph), await imp(publicJwk)];
    const ss = await subtle.deriveBits(
      { name: "ECDH", public: ephPub },
      privateKey,
      256,
    );
    const info = new Uint8Array([
      ...utf8("refill/v1|draft|d1|"),
      ...new Uint8Array(await subtle.exportKey("raw", ephPub)),
      ...utf8("|"),
      ...new Uint8Array(await subtle.exportKey("raw", pub)),
    ]);
    const base = await subtle.importKey("raw", ss, "HKDF", false, [
      "deriveKey",
    ]);
    const k = await subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const pt = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromB64(d.iv) as BufferSource,
        additionalData: utf8("refill/v1|draft|d1|77") as BufferSource,
        tagLength: 128,
      },
      k,
      fromB64(d.ct) as BufferSource,
    );
    expect(fromUtf8(new Uint8Array(pt))).toBe("hello draft");
  });

  it("changing expiresAt on the record makes openDraft throw", async () => {
    const { publicJwk, privateKey } = await generateDraftKeyPair();
    const d = await sealDraft(publicJwk, "d1", 100, PT);
    await expect(
      openDraft(privateKey, publicJwk, { ...d, expiresAt: 101 }),
    ).rejects.toBeInstanceOf(DecryptError);
    await expect(
      openDraft(privateKey, publicJwk, { ...d, expiresAt: null }),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it("changing id throws", async () => {
    const { publicJwk, privateKey } = await generateDraftKeyPair();
    const d = await sealDraft(publicJwk, "d1", null, PT);
    await expect(
      openDraft(privateKey, publicJwk, { ...d, id: "d2" }),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it("swapping eph between two drafts throws", async () => {
    const { publicJwk, privateKey } = await generateDraftKeyPair();
    const a = await sealDraft(publicJwk, "d1", null, PT);
    const b = await sealDraft(publicJwk, "d1", null, PT);
    await expect(
      openDraft(privateKey, publicJwk, { ...a, eph: b.eph }),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it("a draft sealed to another public key throws", async () => {
    const mine = await generateDraftKeyPair();
    const other = await generateDraftKeyPair();
    const d = await sealDraft(other.publicJwk, "d1", null, PT);
    await expect(
      openDraft(mine.privateKey, mine.publicJwk, d),
    ).rejects.toBeInstanceOf(DecryptError);
    await expect(
      openDraft(mine.privateKey, other.publicJwk, d),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it("tampered ciphertext, iv or malformed eph throws DecryptError", async () => {
    const { publicJwk, privateKey } = await generateDraftKeyPair();
    const d = await sealDraft(publicJwk, "d1", null, PT);
    const flipped = {
      ...d,
      ct: d.ct.startsWith("A") ? "B" + d.ct.slice(1) : "A" + d.ct.slice(1),
    };
    await expect(
      openDraft(privateKey, publicJwk, flipped),
    ).rejects.toBeInstanceOf(DecryptError);
    await expect(
      openDraft(privateKey, publicJwk, { ...d, iv: "AAAA" }),
    ).rejects.toBeInstanceOf(DecryptError);
    await expect(
      openDraft(privateKey, publicJwk, {
        ...d,
        eph: { kty: "EC", crv: "P-256", x: "AA", y: "AA" },
      }),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it("sealDraft needs no private key", async () => {
    const publicJwk = await (async () =>
      (await generateDraftKeyPair()).publicJwk)();
    // Only the public JWK is passed; nothing else is in scope for sealing.
    const d = await sealDraft(publicJwk, "d1", null, PT);
    expect(d.ct.length).toBeGreaterThan(0);
  });

  it("rejects a draft public JWK that carries a private part or another curve", async () => {
    const { publicJwk } = await generateDraftKeyPair();
    await expect(
      sealDraft({ ...publicJwk, d: "AAAA" }, "d1", null, PT),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      sealDraft({ ...publicJwk, crv: "P-384" }, "d1", null, PT),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      sealDraft({ ...publicJwk, kty: "RSA" }, "d1", null, PT),
    ).rejects.toBeInstanceOf(TypeError);
    const { privateKey } = await generateDraftKeyPair();
    const d = await sealDraft(publicJwk, "d1", null, PT);
    await expect(
      openDraft(privateKey, { ...publicJwk, d: "AAAA" }, d),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("rejects an id containing |", async () => {
    const { publicJwk } = await generateDraftKeyPair();
    await expect(sealDraft(publicJwk, "a|b", null, PT)).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("private key export -> import round-trip still opens, and the import is non-extractable", async () => {
    const { publicJwk, privateKey } = await generateDraftKeyPair();
    expect(privateKey.extractable).toBe(true);
    const d = await sealDraft(publicJwk, "d1", 5, PT);
    const pkcs8 = await exportDraftPrivateKey(privateKey);
    expect(pkcs8).toBeInstanceOf(Uint8Array);
    expect(pkcs8.length).toBeGreaterThan(60);
    const imported = await importDraftPrivateKey(pkcs8);
    expect(imported.extractable).toBe(false);
    expect(imported.algorithm).toMatchObject({
      name: "ECDH",
      namedCurve: "P-256",
    });
    expect(imported.usages).toEqual(["deriveBits"]);
    expect(fromUtf8(await openDraft(imported, publicJwk, d))).toBe(
      "hello draft",
    );
    await expect(exportDraftPrivateKey(imported)).rejects.toThrow();
  });
});
