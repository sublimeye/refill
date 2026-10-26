import { describe, expect, it } from "vitest";
import { aad } from "../../../src/lib/crypto/aad";
import { open, seal } from "../../../src/lib/crypto/aead";
import { fromB64, utf8, fromUtf8 } from "../../../src/lib/crypto/bytes";
import {
  KDF_FLOOR,
  argon2Raw,
  calibrate,
  deriveKek,
  newKdfParams,
  type KdfParams,
} from "../../../src/lib/crypto/kdf";

const SLOW = 20_000;
const A = aad.profile("p1", "https://a.example");
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const params = (over: Partial<KdfParams> = {}): KdfParams => ({
  ...newKdfParams(),
  ...over,
});

describe("kdf", () => {
  it(
    "argon2id matches an external vector",
    async () => {
      // Independent implementation (reference C library via argon2-cffi 25.1.0), not hash-wasm:
      //   python3 -c "from argon2.low_level import hash_secret_raw, Type; print(hash_secret_raw(
      //     b'password', b'somesaltsomesalt', time_cost=3, memory_cost=65536, parallelism=1,
      //     hash_len=32, type=Type.ID, version=19).hex())"
      // Equivalent CLI: echo -n password | argon2 somesaltsomesalt -id -t 3 -m 16 -p 1 -l 32 -r
      const out = await argon2Raw("password", {
        alg: "argon2id",
        v: 1,
        m: 65536,
        t: 3,
        p: 1,
        salt: "c29tZXNhbHRzb21lc2FsdA==", // base64("somesaltsomesalt")
      });
      expect(hex(out)).toBe(
        "7664ad4ba1a3c999fcdd0991ffc2270f78302d2383233db5e7befc85d1bb1819",
      );
    },
    SLOW,
  );

  it("fixture salt is the 16 ASCII bytes used in the vector", () => {
    expect(fromUtf8(fromB64("c29tZXNhbHRzb21lc2FsdA=="))).toBe(
      "somesaltsomesalt",
    );
  });

  it(
    "NFC and NFD passphrases derive the same key",
    async () => {
      const p = params();
      const nfc = "café";
      const nfd = "café";
      expect(nfc).not.toBe(nfd);
      const k1 = await deriveKek(nfc, p);
      const k2 = await deriveKek(nfd, p);
      const sealed = await seal(k1, utf8("secret"), A);
      expect(fromUtf8(await open(k2, sealed, A))).toBe("secret");
    },
    SLOW,
  );

  it(
    "different salts derive different keys",
    async () => {
      const k1 = await deriveKek("passphrase-123", params());
      const k2 = await deriveKek("passphrase-123", params());
      const sealed = await seal(k1, utf8("x"), A);
      await expect(open(k2, sealed, A)).rejects.toThrow();
    },
    SLOW,
  );

  it(
    "derived KEK is a non-extractable AES-GCM key",
    async () => {
      const k = await deriveKek("passphrase-123", params());
      expect(k.extractable).toBe(false);
      expect(k.algorithm.name).toBe("AES-GCM");
    },
    SLOW,
  );

  it("deriveKek rejects params below floor", async () => {
    await expect(deriveKek("pw", params({ m: 32768 }))).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(deriveKek("pw", params({ t: 2 }))).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(
      deriveKek("pw", { ...params(), alg: "argon2i" } as unknown as KdfParams),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("newKdfParams uses a fresh 16-byte salt and clamps t to the floor", () => {
    const a = newKdfParams();
    const b = newKdfParams(1);
    expect(a).toMatchObject({ alg: "argon2id", v: 1, m: 65536, t: 3, p: 1 });
    expect(b.t).toBe(KDF_FLOOR.t);
    expect(newKdfParams(7).t).toBe(7);
    expect(fromB64(a.salt)).toHaveLength(16);
    expect(a.salt).not.toBe(b.salt);
  });

  it("calibrate raises t until >= 500 ms", async () => {
    expect((await calibrate(async (t) => t * 150)).t).toBe(4);
  });

  it("calibrate keeps the floor when already slow enough", async () => {
    expect((await calibrate(async () => 2000)).t).toBe(3);
  });

  it("calibrate caps t at 20", async () => {
    expect((await calibrate(async () => 10)).t).toBe(20);
  });
});
