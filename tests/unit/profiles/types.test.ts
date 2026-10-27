import { describe, expect, it } from "vitest";
import {
  LIMITS,
  parseProfile,
  type Profile,
} from "../../../src/lib/profiles/types";

const sig = {
  name: "email",
  idStable: null,
  autocomplete: "email",
  type: "email",
  labelText: "Email",
  ordinal: 0,
  formAction: null,
  nameIdDerived: false,
};

// Loosely typed so tests can set out-of-range values and delete keys.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Draft = any;

function make(): Profile {
  return {
    v: 1,
    id: "abc_DEF-123",
    name: "Checkout",
    origin: "https://shop.example",
    pathPrefix: "/checkout",
    fillMode: "gesture",
    createdAt: 1_700_000_000_000,
    lastUsedAt: null,
    steps: [
      { index: 0, pathHint: "/checkout", fingerprint: ["a", "b"] },
      { index: 1, pathHint: "/checkout/pay", fingerprint: [] },
    ],
    fields: [
      {
        id: "f1",
        sig,
        step: 0,
        kind: "text",
        value: "jane@example.com",
        pageDefault: "",
        policy: "save",
      },
      {
        id: "f2",
        sig: { ...sig, name: null, ordinal: 2 },
        step: 1,
        kind: "checkbox",
        value: "true",
        pageDefault: "false",
        policy: "ask",
      },
    ],
  };
}

// Applies `mutate` to a deep copy and parses it.
const parse = (mutate: (p: Draft) => void): Profile | null => {
  const p = structuredClone(make());
  mutate(p);
  return parseProfile(p);
};

describe("parseProfile", () => {
  it("accepts a valid profile and returns an equal, fresh object", () => {
    const p = make();
    const out = parseProfile(p);
    expect(out).toEqual(p);
    expect(out).not.toBe(p);
    expect(out!.fields[0]).not.toBe(p.fields[0]);
  });

  it("accepts the limits exactly", () => {
    expect(
      parse((p) => {
        p.name = "n".repeat(LIMITS.name);
        p.pathPrefix = "/" + "p".repeat(LIMITS.pathPrefix - 1);
        p.fields[0].value = "v".repeat(LIMITS.value);
        p.steps[0].fingerprint = Array.from(
          { length: LIMITS.fingerprint },
          () => "f".repeat(LIMITS.fingerprintEntry),
        );
        p.fields[0].id = "i".repeat(64);
        p.fields[0].sig.labelText = "l".repeat(256);
      }),
    ).not.toBeNull();
  });

  it.each([null, undefined, 5, "x", [], [make()]])(
    "rejects non-object %j",
    (v) => {
      expect(parseProfile(v)).toBeNull();
    },
  );

  it.each([
    ["extra top-level key", (p: Draft) => (p.extra = 1)],
    ["missing key", (p: Draft) => delete p.pathPrefix],
    ["wrong version", (p: Draft) => (p.v = 2)],
    ["empty name", (p: Draft) => (p.name = "")],
    ["name too long", (p: Draft) => (p.name = "n".repeat(LIMITS.name + 1))],
    ["id with pipe", (p: Draft) => (p.id = "a|b")],
    ["empty id", (p: Draft) => (p.id = "")],
    ["origin with path", (p: Draft) => (p.origin = "https://shop.example/x")],
    ["origin not canonical", (p: Draft) => (p.origin = "https://SHOP.example")],
    ["origin http", (p: Draft) => (p.origin = "http://shop.example")],
    ["origin wildcard", (p: Draft) => (p.origin = "https://*")],
    ["pathPrefix without slash", (p: Draft) => (p.pathPrefix = "checkout")],
    [
      "pathPrefix too long",
      (p: Draft) => (p.pathPrefix = "/" + "p".repeat(LIMITS.pathPrefix)),
    ],
    ["bad fillMode", (p: Draft) => (p.fillMode = "always")],
    ["negative createdAt", (p: Draft) => (p.createdAt = -1)],
    ["NaN createdAt", (p: Draft) => (p.createdAt = NaN)],
    ["Infinity lastUsedAt", (p: Draft) => (p.lastUsedAt = Infinity)],
    ["string lastUsedAt", (p: Draft) => (p.lastUsedAt = "1")],
    ["steps not array", (p: Draft) => (p.steps = {})],
    [
      "too many steps",
      (p: Draft) =>
        (p.steps = Array.from({ length: 11 }, (_, i) => ({
          index: i % 10,
          pathHint: "",
          fingerprint: [],
        }))),
    ],
    [
      "duplicate step index",
      (p: Draft) => {
        p.steps[1].index = 0;
        p.fields[1].step = 0; // keep every field reference valid: only the duplicate is wrong
      },
    ],
    ["step index 10", (p: Draft) => (p.steps[1].index = 10)],
    ["step index negative", (p: Draft) => (p.steps[1].index = -1)],
    ["step index fractional", (p: Draft) => (p.steps[1].index = 1.5)],
    ["step extra key", (p: Draft) => (p.steps[0].x = 1)],
    [
      "fingerprint too long",
      (p: Draft) =>
        (p.steps[0].fingerprint = Array.from(
          { length: LIMITS.fingerprint + 1 },
          () => "f",
        )),
    ],
    [
      "fingerprint entry too long",
      (p: Draft) =>
        (p.steps[0].fingerprint = ["f".repeat(LIMITS.fingerprintEntry + 1)]),
    ],
    [
      "fingerprint entry not string",
      (p: Draft) => (p.steps[0].fingerprint = [1]),
    ],
    [
      "too many fields",
      (p: Draft) =>
        (p.fields = Array.from({ length: LIMITS.fields + 1 }, (_, i) => ({
          ...make().fields[0],
          id: "f" + i,
        }))),
    ],
    ["field extra key", (p: Draft) => (p.fields[0].x = 1)],
    ["field missing id", (p: Draft) => delete p.fields[0].id],
    ["field id duplicate", (p: Draft) => (p.fields[1].id = "f1")],
    ["field id too long", (p: Draft) => (p.fields[0].id = "i".repeat(65))],
    ["field id bad chars", (p: Draft) => (p.fields[0].id = "a b")],
    ["field id empty", (p: Draft) => (p.fields[0].id = "")],
    ["field step dangling", (p: Draft) => (p.fields[0].step = 5)],
    ["field step not int", (p: Draft) => (p.fields[0].step = 0.5)],
    ["bad kind", (p: Draft) => (p.fields[0].kind = "password")],
    ["bad policy", (p: Draft) => (p.fields[0].policy = "always")],
    [
      "value too long",
      (p: Draft) => (p.fields[0].value = "v".repeat(LIMITS.value + 1)),
    ],
    ["value not string", (p: Draft) => (p.fields[0].value = 1)],
    [
      "pageDefault too long",
      (p: Draft) => (p.fields[0].pageDefault = "v".repeat(LIMITS.value + 1)),
    ],
    ["sig extra key", (p: Draft) => (p.fields[0].sig.x = 1)],
    ["sig missing key", (p: Draft) => delete p.fields[0].sig.formAction],
    ["sig name number", (p: Draft) => (p.fields[0].sig.name = 1)],
    [
      "sig name too long",
      (p: Draft) => (p.fields[0].sig.name = "n".repeat(257)),
    ],
    [
      "sig labelText too long",
      (p: Draft) => (p.fields[0].sig.labelText = "n".repeat(257)),
    ],
    ["sig type null", (p: Draft) => (p.fields[0].sig.type = null)],
    ["sig ordinal negative", (p: Draft) => (p.fields[0].sig.ordinal = -1)],
    ["sig ordinal NaN", (p: Draft) => (p.fields[0].sig.ordinal = NaN)],
    [
      "sig nameIdDerived string",
      (p: Draft) => (p.fields[0].sig.nameIdDerived = "no"),
    ],
    [
      "sig formAction too long",
      (p: Draft) => (p.fields[0].sig.formAction = "n".repeat(257)),
    ],
    ["sig not object", (p: Draft) => (p.fields[0].sig = null)],
  ])("rejects %s", (_name, mutate) => {
    expect(parse(mutate)).toBeNull();
  });

  it("accepts zero steps and fields", () => {
    expect(parse((p) => ((p.steps = []), (p.fields = [])))).not.toBeNull();
  });

  it("rejects a field when there are no steps for it", () => {
    expect(parse((p) => (p.steps = []))).toBeNull();
  });

  it("accepts 200 fields and 10 steps", () => {
    const out = parse((p) => {
      p.steps = Array.from({ length: 10 }, (_, i) => ({
        index: i,
        pathHint: "",
        fingerprint: [],
      }));
      p.fields = Array.from({ length: 200 }, (_, i) => ({
        ...make().fields[0],
        id: "f" + i,
        step: i % 10,
      }));
    });
    expect(out).not.toBeNull();
  });
});
