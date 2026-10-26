import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes, toB64 } from "../../../src/lib/crypto/bytes";
import { generateDraftKeyPair } from "../../../src/lib/crypto/draft-seal";
import { newKdfParams } from "../../../src/lib/crypto/kdf";
import {
  parseHeader,
  parseIntegrityPayload,
  parseSealed,
} from "../../../src/lib/vault/header";
import { DEFAULT_LOCK, type VaultHeader } from "../../../src/lib/vault/types";

const sealed = (ctBytes: number) => ({
  iv: toB64(randomBytes(12)),
  ct: toB64(randomBytes(ctBytes)),
});

let draftPub: JsonWebKey;
let valid: VaultHeader;

beforeAll(async () => {
  draftPub = (await generateDraftKeyPair()).publicJwk;
});

const make = (): VaultHeader => ({
  v: 1,
  kdf: newKdfParams(),
  wrappedDek: sealed(48),
  draftPub: { ...draftPub },
  wrappedDraftPriv: sealed(154),
  lock: { ...DEFAULT_LOCK },
  lastPassphraseAt: 1_700_000_000_000,
});

const prf = () => ({
  credentialId: "AbC-_9",
  salt: toB64(randomBytes(32)),
  wrappedDek: sealed(48),
});

/** Deep clone, then apply `fn` to the clone. */
const tweak = (fn: (h: Record<string, unknown>) => void): unknown => {
  const h = structuredClone(valid) as unknown as Record<string, unknown>;
  fn(h);
  return h;
};
const at = (h: Record<string, unknown>, k: string) =>
  h[k] as Record<string, unknown>;

describe("parseHeader", () => {
  beforeAll(() => {
    valid = make();
  });

  it("accepts a valid header and returns a fresh copy", () => {
    const out = parseHeader(valid);
    expect(out).toEqual(valid);
    expect(out).not.toBe(valid);
    expect(out?.lock).not.toBe(valid.lock);
  });

  it("accepts a valid optional prf block", () => {
    const h = { ...make(), prf: prf() };
    expect(parseHeader(h)).toEqual(h);
  });

  it("accepts lock values at the range edges", () => {
    for (const lock of [
      { idleMinutes: 1, maxHours: 1, passphraseEveryDays: 1 },
      { idleMinutes: 240, maxHours: 72, passphraseEveryDays: 90 },
    ]) {
      expect(parseHeader({ ...make(), lock })?.lock).toEqual(lock);
    }
  });

  const bad: [string, () => unknown][] = [
    ["null", () => null],
    ["undefined", () => undefined],
    ["a string", () => "garbage"],
    ["an array", () => [valid]],
    ["{}", () => ({})],
    ["v: 2", () => tweak((h) => (h.v = 2))],
    ["v: '1'", () => tweak((h) => (h.v = "1"))],
    ["unknown top-level key", () => tweak((h) => (h.extra = 1))],
    ...(
      [
        "kdf",
        "wrappedDek",
        "draftPub",
        "wrappedDraftPriv",
        "lock",
        "lastPassphraseAt",
      ] as const
    ).map((k): [string, () => unknown] => [
      `missing ${k}`,
      () => tweak((h) => delete h[k]),
    ]),
    // kdf: the kdf module's own bounds apply (isKdfParams)
    ["kdf.m: 'x'", () => tweak((h) => (at(h, "kdf").m = "x"))],
    ["kdf.m below floor", () => tweak((h) => (at(h, "kdf").m = 1024))],
    ["kdf.t above max", () => tweak((h) => (at(h, "kdf").t = 21))],
    ["kdf.p: 2", () => tweak((h) => (at(h, "kdf").p = 2))],
    [
      "kdf.salt 8 bytes",
      () => tweak((h) => (at(h, "kdf").salt = toB64(randomBytes(8)))),
    ],
    ["kdf unknown key", () => tweak((h) => (at(h, "kdf").extra = 1))],
    // wrappedDek: exactly a sealed 32-byte key (48 bytes with tag), 12-byte IV
    [
      "wrappedDek.ct truncated by 4 chars (valid base64, 45 bytes)",
      () =>
        tweak(
          (h) => (at(h, "wrappedDek").ct = valid.wrappedDek.ct.slice(0, -4)),
        ),
    ],
    [
      "wrappedDek.ct truncated by 1 char (invalid base64)",
      () =>
        tweak(
          (h) => (at(h, "wrappedDek").ct = valid.wrappedDek.ct.slice(0, -1)),
        ),
    ],
    [
      "wrappedDek.ct 49 bytes",
      () => tweak((h) => (at(h, "wrappedDek").ct = toB64(randomBytes(49)))),
    ],
    [
      "wrappedDek.iv 11 bytes",
      () => tweak((h) => (at(h, "wrappedDek").iv = toB64(randomBytes(11)))),
    ],
    [
      "wrappedDek.iv a number",
      () => tweak((h) => (at(h, "wrappedDek").iv = 5)),
    ],
    ["wrappedDek extra key", () => tweak((h) => (at(h, "wrappedDek").x = "y"))],
    ["wrappedDek a string", () => tweak((h) => (h.wrappedDek = "abc"))],
    [
      "wrappedDraftPriv.ct only a tag (16 bytes)",
      () =>
        tweak((h) => (at(h, "wrappedDraftPriv").ct = toB64(randomBytes(16)))),
    ],
    // draftPub: public EC P-256 JWK, exactly kty/crv/x/y
    ["draftPub with d", () => tweak((h) => (at(h, "draftPub").d = "AAAA"))],
    ["draftPub kty RSA", () => tweak((h) => (at(h, "draftPub").kty = "RSA"))],
    [
      "draftPub crv P-384",
      () => tweak((h) => (at(h, "draftPub").crv = "P-384")),
    ],
    [
      "draftPub x 31 bytes",
      () => tweak((h) => (at(h, "draftPub").x = "A".repeat(42))),
    ],
    [
      "draftPub x non-canonical base64url",
      () => tweak((h) => (at(h, "draftPub").x = "A".repeat(42) + "B")),
    ],
    [
      "draftPub x padded",
      () => tweak((h) => (at(h, "draftPub").x = "A".repeat(43) + "=")),
    ],
    ["draftPub y missing", () => tweak((h) => delete at(h, "draftPub").y)],
    ["draftPub ext key", () => tweak((h) => (at(h, "draftPub").ext = true))],
    // lock
    ["lock.idleMinutes 0", () => tweak((h) => (at(h, "lock").idleMinutes = 0))],
    [
      "lock.idleMinutes 241",
      () => tweak((h) => (at(h, "lock").idleMinutes = 241)),
    ],
    ["lock.maxHours 73", () => tweak((h) => (at(h, "lock").maxHours = 73))],
    ["lock.maxHours 1.5", () => tweak((h) => (at(h, "lock").maxHours = 1.5))],
    [
      "lock.passphraseEveryDays 91",
      () => tweak((h) => (at(h, "lock").passphraseEveryDays = 91)),
    ],
    [
      "lock.idleMinutes '15'",
      () => tweak((h) => (at(h, "lock").idleMinutes = "15")),
    ],
    ["lock extra key", () => tweak((h) => (at(h, "lock").extra = 1))],
    // lastPassphraseAt
    ["lastPassphraseAt -1", () => tweak((h) => (h.lastPassphraseAt = -1))],
    ["lastPassphraseAt NaN", () => tweak((h) => (h.lastPassphraseAt = NaN))],
    ["lastPassphraseAt 1.5", () => tweak((h) => (h.lastPassphraseAt = 1.5))],
    ["lastPassphraseAt '1'", () => tweak((h) => (h.lastPassphraseAt = "1"))],
    // prf
    ["prf null", () => tweak((h) => (h.prf = null))],
    [
      "prf empty credentialId",
      () => tweak((h) => (h.prf = { ...prf(), credentialId: "" })),
    ],
    [
      "prf credentialId with '|'",
      () => tweak((h) => (h.prf = { ...prf(), credentialId: "a|b" })),
    ],
    [
      "prf salt 16 bytes",
      () => tweak((h) => (h.prf = { ...prf(), salt: toB64(randomBytes(16)) })),
    ],
    [
      "prf wrappedDek 47 bytes",
      () => tweak((h) => (h.prf = { ...prf(), wrappedDek: sealed(47) })),
    ],
    ["prf extra key", () => tweak((h) => (h.prf = { ...prf(), extra: 1 }))],
  ];

  it.each(bad)("rejects %s", (_name, build) => {
    expect(parseHeader(build())).toBeNull();
  });

  it("rejects a header with a non-plain prototype", () => {
    expect(parseHeader(Object.assign(new (class X {})(), make()))).toBeNull();
  });
});

describe("parseSealed", () => {
  it("checks iv length, base64 and ciphertext length bounds", () => {
    const s = sealed(48);
    expect(parseSealed(s, 48, 48)).toEqual(s);
    expect(parseSealed(s, 49, 100)).toBeNull();
    expect(parseSealed({ ...s, iv: "x" }, 17, 100)).toBeNull();
    expect(parseSealed({ iv: s.iv }, 17, 100)).toBeNull();
    expect(parseSealed(null, 17, 100)).toBeNull();
  });
});

describe("parseIntegrityPayload", () => {
  it("accepts exactly { draftPub, lock, kdf }", () => {
    const p = { draftPub, lock: { ...DEFAULT_LOCK }, kdf: newKdfParams() };
    expect(parseIntegrityPayload(p)).toEqual(p);
    expect(parseIntegrityPayload({ ...p, extra: 1 })).toBeNull();
    expect(parseIntegrityPayload({ ...p, lock: { maxHours: 1 } })).toBeNull();
    expect(parseIntegrityPayload("x")).toBeNull();
  });
});
