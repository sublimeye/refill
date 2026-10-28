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
    expect(() => fromB64("YR==")).toThrow(TypeError); // non-zero trailing bits
    expect(fromB64("YQ==")).toEqual(new Uint8Array([97]));
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

  it("canonicalJson orders integer-like keys by UTF-16 code unit, not numerically", () => {
    expect(canonicalJson({ b: 1, "10": 2, "2": 3, a: 4 })).toBe(
      '{"10":2,"2":3,"a":4,"b":1}',
    );
  });

  it("canonicalJson keeps an own __proto__ key and distinguishes it", () => {
    const withProto = JSON.parse('{"__proto__":{"x":1},"a":1}') as unknown;
    expect(canonicalJson(withProto)).toBe('{"__proto__":{"x":1},"a":1}');
    expect(canonicalJson(withProto)).not.toBe(canonicalJson({ a: 1 }));
  });

  it("canonicalJson accepts null-prototype objects and handles unicode strings", () => {
    const o = Object.assign(Object.create(null) as object, {
      k: 'é\u2028\n"✓',
    });
    expect(canonicalJson(o)).toBe(JSON.stringify({ k: 'é\u2028\n"✓' }));
    expect(canonicalJson({ ключ: "значение", a: "😀" })).toBe(
      '{"a":"😀","ключ":"значение"}',
    );
  });

  it("canonicalJson handles nested arrays/objects and primitives", () => {
    expect(
      canonicalJson([1, [true, null, "x"], { b: [], a: {} }, -0, 1.5]),
    ).toBe('[1,[true,null,"x"],{"a":{},"b":[]},0,1.5]');
  });

  it("canonicalJson rejects unsupported values", () => {
    class C {
      x = 1;
    }
    const cyc: Record<string, unknown> = {};
    cyc["self"] = cyc;
    const bad: unknown[] = [
      undefined,
      { a: undefined },
      [undefined],
      // eslint-disable-next-line no-sparse-arrays
      [1, , 2],
      () => 1,
      new Date(0),
      new Map(),
      new C(),
      new Uint8Array(1),
      NaN,
      Infinity,
      -Infinity,
      10n,
      Symbol("s"),
      cyc,
    ];
    for (const v of bad) expect(() => canonicalJson(v)).toThrow(TypeError);
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
    expect(fromUtf8(aad.recording("r1", "https://a.example"))).toBe(
      "refill/v1|recording|r1|https://a.example",
    );
  });

  it("rejects a separator inside profile/draft/recording ids", () => {
    expect(() => aad.profile("a|b", "https://a.example")).toThrow(TypeError);
    expect(() => aad.draft("a|b", null)).toThrow(TypeError);
    expect(() => aad.recording("a|b", "https://a.example")).toThrow(TypeError);
  });
});
