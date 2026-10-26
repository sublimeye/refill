import { describe, expect, it } from "vitest";
import { aad } from "../../../src/lib/crypto/aad";
import {
  canonicalJson,
  fromB64,
  fromUtf8,
  randomBytes,
  toB64,
  utf8,
} from "../../../src/lib/crypto/bytes";

describe("bytes", () => {
  it("fromB64 throws TypeError on invalid input", () => {
    expect(() => fromB64("%%%")).toThrow(TypeError);
    expect(() => fromB64("abc")).toThrow(TypeError); // bad length
    expect(() => fromB64("YW=j")).toThrow(TypeError); // padding mid-string
  });

  it("base64 round-trips, including empty", () => {
    const b = randomBytes(33);
    expect(fromB64(toB64(b))).toEqual(b);
    expect(fromB64("")).toEqual(new Uint8Array(0));
  });

  it("randomBytes returns n bytes and differs between calls", () => {
    expect(randomBytes(16)).toHaveLength(16);
    expect(toB64(randomBytes(16))).not.toBe(toB64(randomBytes(16)));
  });

  it("utf8 round-trips non-ASCII", () => {
    expect(fromUtf8(utf8("héllo ✓"))).toBe("héllo ✓");
  });

  it("canonicalJson sorts keys recursively with no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
    expect(canonicalJson([{ z: 1, y: [{ b: 1, a: 2 }] }])).toBe(
      '[{"y":[{"a":2,"b":1}],"z":1}]',
    );
    expect(canonicalJson(null)).toBe("null");
  });
});

describe("aad", () => {
  it("builds the exact literals", () => {
    expect(fromUtf8(aad.dekPw())).toBe("refill/v1|dek|pw");
    expect(fromUtf8(aad.dekPrf("cred1"))).toBe("refill/v1|dek|prf|cred1");
    expect(fromUtf8(aad.draftPriv())).toBe("refill/v1|draft-priv");
    expect(fromUtf8(aad.integrity())).toBe("refill/v1|integrity");
    expect(fromUtf8(aad.profile("p1", "https://a.example"))).toBe(
      "refill/v1|profile|p1|https://a.example",
    );
    expect(fromUtf8(aad.draft("d1", 123))).toBe("refill/v1|draft|d1|123");
    expect(fromUtf8(aad.draft("d1", null))).toBe("refill/v1|draft|d1|none");
  });

  it("rejects a separator inside profile/draft ids", () => {
    expect(() => aad.profile("a|b", "https://a.example")).toThrow(TypeError);
    expect(() => aad.draft("a|b", null)).toThrow(TypeError);
  });
});
