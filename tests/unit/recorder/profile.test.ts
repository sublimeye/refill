import { describe, expect, it } from "vitest";
import type { FieldPolicy, Profile } from "../../../src/lib/profiles/types";
import { applyCapture } from "../../../src/lib/recorder/fields";
import {
  buildProfile,
  defaultPathPrefix,
  reviewModel,
} from "../../../src/lib/recorder/profile";
import { observePage } from "../../../src/lib/recorder/steps";
import type { RecBody } from "../../../src/lib/recorder/types";
import { emptyBody, seedBody } from "../../../src/lib/recorder/types";
import { capture, ctrl, keys, ORIGIN, page, savedProfile } from "./helpers";

const STEP1 = page("acct", "zip");
const STEP2 = page("amount", "memo");

function on(body: RecBody, controls: typeof STEP1, doc: string, path: string) {
  const out = observePage(body, keys(controls), doc, path);
  if (out === "full") throw new Error("unexpected full");
  return out;
}

/** Two steps under /billpay/, two fields (f1 on step 0, f2 on step 1). */
function recorded(): RecBody {
  let b = on(emptyBody(), STEP1, "d1", "/billpay/one");
  b = applyCapture(b, capture(STEP1[0]!, "12345")).body;
  b = on(b, STEP2, "d2", "/billpay/two");
  return applyCapture(b, capture(STEP2[0]!, "45.12")).body;
}

const NOW = 1_800_000_000_000;

function build(
  over: Partial<Parameters<typeof buildProfile>[0]> = {},
): Profile | null {
  return buildProfile({
    id: "p9",
    origin: ORIGIN,
    name: "Bill pay",
    pathPrefix: "/billpay/",
    fillMode: "auto",
    now: NOW,
    createdAt: null,
    body: recorded(),
    policies: { f1: "save", f2: "ask" },
    ...over,
  });
}

describe("defaultPathPrefix", () => {
  it.each<[string[], string]>([
    [["/billpay/a", "/billpay/b"], "/billpay/"],
    [["/billpay/a", "/billpay/a"], "/billpay/a"],
    [["/billpay/a"], "/billpay/a"],
    [["/billpay1", "/billpay2"], "/"],
    [["/billpay/one", "/billpayment/two"], "/"],
    [["/a/b/c", "/a/b/d", "/a/x"], "/a/"],
    [["/billpay", "/billpay/confirm"], "/billpay"],
    [["/billpay/", "/billpay"], "/billpay"],
    [["/billpay/", "/billpay/two"], "/billpay/"],
    [["/", "/billpay"], "/"],
    [[], "/"],
  ])("%j -> %s", (paths, expected) => {
    expect(defaultPathPrefix(paths)).toBe(expected);
  });
});

describe("reviewModel", () => {
  it("defaults name to the host, prefix to the steps' common prefix, fill mode to auto", () => {
    const m = reviewModel("https://pay.example.com:8443", recorded(), null);
    expect(m).toEqual({
      origin: "https://pay.example.com:8443",
      host: "pay.example.com:8443",
      steps: [
        { index: 0, pathHint: "/billpay/one" },
        { index: 1, pathHint: "/billpay/two" },
      ],
      fields: [
        {
          id: "f1",
          step: 0,
          label: "acct",
          kind: "text",
          value: "12345",
          policy: "save",
        },
        {
          id: "f2",
          step: 1,
          label: "amount",
          kind: "text",
          value: "45.12",
          policy: "save",
        },
      ],
      name: "pay.example.com:8443",
      pathPrefix: "/billpay/",
      fillMode: "auto",
    });
  });

  it("sets the default prefix from steps with fields only (a fieldless landing step at /)", () => {
    let b = on(emptyBody(), page("q"), "d0", "/");
    b = on(b, STEP1, "d1", "/billpay/a");
    b = applyCapture(b, capture(STEP1[0]!, "12345")).body;
    b = on(b, STEP2, "d2", "/billpay/b");
    b = applyCapture(b, capture(STEP2[0]!, "45.12")).body;
    expect(b.steps.map((s) => s.pathHint)).toEqual([
      "/",
      "/billpay/a",
      "/billpay/b",
    ]);
    const m = reviewModel(ORIGIN, b, null);
    expect(m.pathPrefix).toBe("/billpay/");
    const p = build({ body: b, pathPrefix: m.pathPrefix });
    expect(p).not.toBeNull();
    // The fieldless step stays in the profile.
    expect(p?.steps.map((s) => s.pathHint)).toEqual([
      "/",
      "/billpay/a",
      "/billpay/b",
    ]);
  });

  it("labels a field by label text, then name, then a placeholder", () => {
    let b = on(emptyBody(), STEP1, "d1", "/x");
    b = applyCapture(b, capture(ctrl(5, "n1", { labelText: null }), "a")).body;
    b = applyCapture(
      b,
      capture(ctrl(6, "n2", { labelText: null, name: null }), "b"),
    ).body;
    const m = reviewModel(ORIGIN, b, null);
    expect(m.fields.map((f) => f.label)).toEqual(["n1", "Unlabeled field"]);
  });

  it("takes name, prefix and fill mode from the saved profile", () => {
    const saved = savedProfile();
    const m = reviewModel(ORIGIN, seedBody(saved), saved);
    expect(m).toMatchObject({
      name: "Bill pay",
      pathPrefix: "/billpay/",
      fillMode: "gesture",
    });
  });

  it("replaces a saved prefix that no longer covers every step", () => {
    const saved = savedProfile({ pathPrefix: "/billpay/one" });
    const m = reviewModel(ORIGIN, seedBody(saved), saved);
    expect(m.pathPrefix).toBe("/billpay/");
  });

  it("cuts a long host to the name limit", () => {
    const host = `${"a".repeat(63)}.${"b".repeat(63)}.example.com`;
    const m = reviewModel(`https://${host}`, recorded(), null);
    expect(m.host).toBe(host);
    expect(m.name).toBe(host.slice(0, 120));
  });
});

describe("buildProfile", () => {
  it("builds a profile that parses, with the given policies", () => {
    const p = build();
    expect(p).not.toBeNull();
    expect(p).toMatchObject({
      v: 1,
      id: "p9",
      name: "Bill pay",
      origin: ORIGIN,
      pathPrefix: "/billpay/",
      fillMode: "auto",
      createdAt: NOW,
      lastUsedAt: null,
    });
    expect(p?.steps.map((s) => s.index)).toEqual([0, 1]);
    expect(p?.fields.map((f) => [f.id, f.step, f.value, f.policy])).toEqual([
      ["f1", 0, "12345", "save"],
      ["f2", 1, "45.12", "ask"],
    ]);
  });

  it("keeps no value for a Don't save field: empty value and page default, sig, step and kind kept (C1)", () => {
    const body = recorded();
    body.fields[1] = { ...body.fields[1]!, pageDefault: "0.00" };
    const p = build({ body, policies: { f1: "save", f2: "skip" } });
    expect(p?.fields[1]).toEqual({
      id: "f2",
      sig: body.fields[1]!.sig,
      step: 1,
      kind: "text",
      value: "",
      pageDefault: "",
      policy: "skip",
    });
    expect(JSON.stringify(p)).not.toContain("45.12");
    expect(JSON.stringify(p)).not.toContain("0.00");
    // The other fields keep theirs.
    expect(p?.fields[0]).toMatchObject({ value: "12345", policy: "save" });
  });

  it("trims the name", () => {
    expect(build({ name: "  Bills  " })?.name).toBe("Bills");
  });

  it("keeps a seeded createdAt", () => {
    const saved = savedProfile();
    expect(
      build({
        createdAt: saved.createdAt,
        body: seedBody(saved),
        policies: { f1: "save", f4: "skip" },
      })?.createdAt,
    ).toBe(saved.createdAt);
  });

  it("rejects a prefix that misses a step", () => {
    expect(build({ pathPrefix: "/billpay/one" })).toBeNull();
    expect(build({ pathPrefix: "/bill" })).toBeNull();
    expect(build({ pathPrefix: "/" })).not.toBeNull();
  });

  it("returns copies, not the body's own arrays and signatures", () => {
    const body = recorded();
    const p = build({ body });
    expect(p?.steps[0]?.fingerprint).not.toBe(body.steps[0]?.fingerprint);
    expect(p?.fields[0]?.sig).not.toBe(body.fields[0]?.sig);
  });

  it("rejects a missing policy", () => {
    expect(build({ policies: { f1: "save" } })).toBeNull();
  });

  it("rejects a policy for an unknown field", () => {
    expect(
      build({ policies: { f1: "save", f2: "ask", f3: "save" } }),
    ).toBeNull();
  });

  it("does not read a policy from the object prototype", () => {
    let b = on(emptyBody(), STEP1, "d1", "/billpay/one");
    b = applyCapture(b, capture(STEP1[0]!, "1")).body;
    b = { ...b, fields: b.fields.map((f) => ({ ...f, id: "constructor" })) };
    expect(build({ body: b, policies: {} })).toBeNull();
  });

  it("rejects an invalid policy value", () => {
    expect(
      build({
        policies: { f1: "save", f2: "maybe" as unknown as FieldPolicy },
      }),
    ).toBeNull();
  });

  it("rejects an empty or over-long name", () => {
    expect(build({ name: "" })).toBeNull();
    expect(build({ name: "   " })).toBeNull();
    expect(build({ name: "x".repeat(121) })).toBeNull();
    expect(build({ name: "x".repeat(120) })).not.toBeNull();
  });

  it("rejects what parseProfile rejects (bad id, bad origin)", () => {
    expect(build({ id: "bad id" })).toBeNull();
    expect(build({ origin: "http://pay.example.com" })).toBeNull();
  });
});
