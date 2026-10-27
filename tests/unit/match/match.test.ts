import { describe, expect, it } from "vitest";
import type { ControlKind } from "../../../src/lib/fields/eligibility";
import type { Sig } from "../../../src/lib/fields/signature";
import {
  jaccard,
  matchControls,
  profileApplies,
  scoreSig,
  sigKey,
  type MatchInput,
  type SavedField,
} from "../../../src/lib/match/match";

const sig = (over: Partial<Sig> = {}): Sig => ({
  name: null,
  idStable: null,
  autocomplete: null,
  type: "text",
  labelText: null,
  ordinal: 0,
  formAction: null,
  nameIdDerived: false,
  ...over,
});

// Ordinals differ so the ordinal weight stays out of the way unless a test wants it.
const A = (over: Partial<Sig> = {}) => sig({ ordinal: 1, ...over });
const B = (over: Partial<Sig> = {}) => sig({ ordinal: 2, ...over });

const control = (
  i: number,
  over: Partial<Sig> = {},
  kind: ControlKind = "text",
): MatchInput => ({ i, sig: sig({ ordinal: i + 100, ...over }), kind });

const field = (
  id: string,
  over: Partial<Sig> = {},
  step = 0,
  kind: ControlKind = "text",
): SavedField => ({ id, step, sig: sig({ ordinal: -1, ...over }), kind });

describe("profileApplies", () => {
  const p = { origin: "https://pay.example.com", pathPrefix: "/bill" };

  it("matches the exact origin and a path prefix", () => {
    expect(profileApplies(p, "https://pay.example.com", "/bill/step2")).toBe(
      true,
    );
    expect(profileApplies(p, "https://pay.example.com", "/bill")).toBe(true);
  });

  it("rejects a different path", () => {
    expect(profileApplies(p, "https://pay.example.com", "/account")).toBe(
      false,
    );
    expect(profileApplies(p, "https://pay.example.com", "/")).toBe(false);
  });

  it("rejects a port difference, scheme difference and sibling hosts", () => {
    expect(profileApplies(p, "https://pay.example.com:8443", "/bill")).toBe(
      false,
    );
    expect(profileApplies(p, "http://pay.example.com", "/bill")).toBe(false);
    expect(profileApplies(p, "https://evil.pay.example.com", "/bill")).toBe(
      false,
    );
    expect(profileApplies(p, "https://pay.example.com.evil.io", "/bill")).toBe(
      false,
    );
  });

  it("requires pathPrefix to start with a slash", () => {
    const bad = { origin: p.origin, pathPrefix: "bill" };
    expect(profileApplies(bad, p.origin, "bill/x")).toBe(false);
    expect(profileApplies(bad, p.origin, "/bill/x")).toBe(false);
    expect(profileApplies({ ...p, pathPrefix: "" }, p.origin, "/x")).toBe(
      false,
    );
  });

  it("accepts the root prefix for any path", () => {
    expect(
      profileApplies({ origin: p.origin, pathPrefix: "/" }, p.origin, "/a/b"),
    ).toBe(true);
  });
});

describe("scoreSig weights in isolation", () => {
  it("autocomplete 4", () => {
    expect(
      scoreSig(
        A({ autocomplete: "given-name" }),
        B({ autocomplete: "given-name" }),
      ),
    ).toBe(4);
  });

  it("autocomplete on/off/null carries no weight", () => {
    expect(scoreSig(A({ autocomplete: "on" }), B({ autocomplete: "on" }))).toBe(
      0,
    );
    expect(
      scoreSig(A({ autocomplete: "off" }), B({ autocomplete: "off" })),
    ).toBe(0);
    expect(scoreSig(A(), B())).toBe(0);
  });

  it("name 3", () => {
    expect(scoreSig(A({ name: "amt" }), B({ name: "amt" }))).toBe(3);
  });

  it("label 3", () => {
    expect(
      scoreSig(A({ labelText: "amount" }), B({ labelText: "amount" })),
    ).toBe(3);
  });

  it("idStable 2", () => {
    expect(scoreSig(A({ idStable: "amt" }), B({ idStable: "amt" }))).toBe(2);
  });

  it("formAction 1", () => {
    expect(scoreSig(A({ formAction: "/pay" }), B({ formAction: "/pay" }))).toBe(
      1,
    );
  });

  it("ordinal 1", () => {
    expect(scoreSig(sig({ ordinal: 3 }), sig({ ordinal: 3 }))).toBe(1);
  });

  it("different or missing evidence scores nothing", () => {
    expect(
      scoreSig(
        A({ name: "a", idStable: "a", labelText: "a", formAction: "/a" }),
        B({ name: "b", idStable: "b", labelText: "b", formAction: "/b" }),
      ),
    ).toBe(0);
    expect(scoreSig(A({ name: "a" }), B({ name: null }))).toBe(0);
    expect(scoreSig(A({ name: null }), B({ name: null }))).toBe(0);
  });

  it("sums all evidence", () => {
    const s = sig({
      autocomplete: "email",
      name: "e",
      labelText: "email",
      idStable: "e",
      formAction: "/f",
      ordinal: 4,
    });
    expect(scoreSig(s, { ...s })).toBe(4 + 3 + 3 + 2 + 1 + 1);
  });
});

describe("scoreSig kind and type gate", () => {
  const strong = { name: "x", labelText: "x", autocomplete: "email" };

  it("text-like types are interchangeable for text controls", () => {
    const types = [
      "text",
      "email",
      "tel",
      "number",
      "search",
      "url",
      "textarea",
      "date",
    ];
    for (const a of types) {
      for (const b of types) {
        expect(
          scoreSig(
            sig({ ...strong, type: a, ordinal: 1 }),
            sig({ ...strong, type: b, ordinal: 2 }),
          ),
        ).toBe(10);
      }
    }
  });

  it("-Infinity for a different kind even with identical evidence", () => {
    const kinds: ControlKind[] = ["text", "select", "checkbox", "radio"];
    for (const ka of kinds) {
      for (const kb of kinds) {
        if (ka === kb) continue;
        expect(scoreSig(sig(strong), sig(strong), ka, kb)).toBe(-Infinity);
      }
    }
  });

  it("non-text kinds need an equal type", () => {
    expect(
      scoreSig(
        sig({ ...strong, type: "select-one" }),
        sig({ ...strong, type: "select-multiple" }),
        "select",
        "select",
      ),
    ).toBe(-Infinity);
    expect(
      scoreSig(
        sig({ ...strong, type: "select-one" }),
        sig({ ...strong, type: "select-one" }),
        "select",
        "select",
      ),
    ).toBeGreaterThan(0);
  });

  it("a text control of a non-listed type needs an equal type", () => {
    expect(
      scoreSig(
        sig({ ...strong, type: "month" }),
        sig({ ...strong, type: "text" }),
      ),
    ).toBe(-Infinity);
    expect(
      scoreSig(
        sig({ ...strong, type: "month" }),
        sig({ ...strong, type: "month" }),
      ),
    ).toBeGreaterThan(0);
  });

  it("non-text kinds do not use the text-like set", () => {
    expect(
      scoreSig(
        sig({ ...strong, type: "text" }),
        sig({ ...strong, type: "email" }),
        "checkbox",
        "checkbox",
      ),
    ).toBe(-Infinity);
  });
});

describe("scoreSig name/id derived pair", () => {
  it("counts the name weight once and drops the idStable weight", () => {
    const s = (over: Partial<Sig>) =>
      sig({ name: "ctl00$Main$Amt", idStable: "ctl00_Main_Amt", ...over });
    expect(
      scoreSig(
        s({ nameIdDerived: true, ordinal: 1 }),
        s({ nameIdDerived: true, ordinal: 2 }),
      ),
    ).toBe(3);
  });

  it("applies when only one side is derived, even if ids are equal", () => {
    const a = sig({
      name: "n",
      idStable: "same",
      nameIdDerived: true,
      ordinal: 1,
    });
    const b = sig({
      name: "n",
      idStable: "same",
      nameIdDerived: false,
      ordinal: 2,
    });
    expect(scoreSig(a, b)).toBe(3);
    expect(scoreSig(b, a)).toBe(3);
  });

  it("non-derived pairs still count both", () => {
    const a = sig({ name: "n", idStable: "same", ordinal: 1 });
    const b = sig({ name: "n", idStable: "same", ordinal: 2 });
    expect(scoreSig(a, b)).toBe(5);
  });

  it("derived flag with different names gives no id weight either", () => {
    const a = sig({
      name: "n1",
      idStable: "same",
      nameIdDerived: true,
      ordinal: 1,
    });
    const b = sig({ name: "n2", idStable: "same", ordinal: 2 });
    expect(scoreSig(a, b)).toBe(0);
  });
});

describe("matchControls thresholds", () => {
  const steps = [{ index: 0, fingerprint: [] as string[] }];

  it("score 4 fails, 5 passes", () => {
    const f = [field("f", { autocomplete: "email" })];
    expect(
      matchControls(f, steps, [control(0, { autocomplete: "email" })]).size,
    ).toBe(0);
    // 4 + 1 (formAction)
    const f5 = [field("f", { autocomplete: "email", formAction: "/a" })];
    expect(
      matchControls(f5, steps, [
        control(0, { autocomplete: "email", formAction: "/a" }),
      ]),
    ).toEqual(new Map([["f", 0]]));
  });

  it("margin 2: a runner-up within 1 point blocks the match", () => {
    const f = [field("f", { name: "a", labelText: "l", formAction: "/x" })]; // 7
    const top = { name: "a", labelText: "l", formAction: "/x" };
    expect(
      matchControls(f, steps, [
        control(0, top), // 7
        control(1, { name: "a", labelText: "l" }), // 6
      ]).size,
    ).toBe(0);
    expect(
      matchControls(f, steps, [
        control(0, top), // 7
        control(1, { name: "a", formAction: "/x" }), // 4
      ]),
    ).toEqual(new Map([["f", 0]]));
  });

  it("exact margin boundary: 10 vs 8 matches, 10 vs 9 does not", () => {
    const f = [
      field("f", {
        autocomplete: "email",
        name: "e",
        formAction: "/x",
        idStable: "e",
      }),
    ]; // 4+3+1+2 = 10
    const full = {
      autocomplete: "email",
      name: "e",
      formAction: "/x",
      idStable: "e",
    };
    const s8 = { autocomplete: "email", name: "e", formAction: "/x" }; // 8
    const s9 = { autocomplete: "email", name: "e", idStable: "e" }; // 9
    expect(matchControls(f, steps, [control(0, full), control(1, s8)])).toEqual(
      new Map([["f", 0]]),
    );
    expect(
      matchControls(f, steps, [control(0, full), control(1, s9)]).size,
    ).toBe(0);
  });

  it("a tie never matches, whatever the iteration order", () => {
    const f = [field("f", { name: "n", labelText: "l" })];
    const c = [
      control(0, { name: "n", labelText: "l" }),
      control(1, { name: "n", labelText: "l" }),
    ];
    expect(matchControls(f, steps, c).size).toBe(0);
    expect(matchControls(f, steps, [...c].reverse()).size).toBe(0);
  });

  it("incompatible controls do not count as runner-up", () => {
    const f = [field("f", { name: "n", labelText: "l" })];
    expect(
      matchControls(f, steps, [
        control(0, { name: "n", labelText: "l" }),
        control(1, { name: "n", labelText: "l" }, "select"),
      ]),
    ).toEqual(new Map([["f", 0]]));
  });

  it("kind mismatch never matches", () => {
    const f = [field("f", { name: "n", labelText: "l", autocomplete: "x" })];
    expect(
      matchControls(f, steps, [
        control(
          0,
          { name: "n", labelText: "l", autocomplete: "x" },
          "checkbox",
        ),
      ]).size,
    ).toBe(0);
  });

  it("returns the control index i, not the array position", () => {
    const f = [field("f", { name: "n", labelText: "l" })];
    const m = matchControls(f, steps, [
      control(7, { name: "zzz" }),
      control(42, { name: "n", labelText: "l" }),
    ]);
    expect(m.get("f")).toBe(42);
  });
});

describe("matchControls realistic cases", () => {
  const steps = [{ index: 0, fingerprint: [] as string[] }];

  it("Address 1 / Address 2 twins match by label", () => {
    const common = {
      autocomplete: "address-line1",
      name: "addr",
      formAction: "/f",
    };
    const saved = [
      field("a1", { ...common, labelText: "address 1" }),
      field("a2", { ...common, labelText: "address 2" }),
    ];
    const page = [
      control(0, { ...common, labelText: "address 2" }),
      control(1, { ...common, labelText: "address 1" }),
    ];
    // Both twins share name/autocomplete/formAction (8), label adds 3 => 11 vs 8.
    expect(matchControls(saved, steps, page)).toEqual(
      new Map([
        ["a1", 1],
        ["a2", 0],
      ]),
    );
  });

  it("randomized name+id with only a placeholder label scores 3 and stays unmatched", () => {
    const f = [
      field("f", { labelText: "first name", name: "r1", idStable: "r1" }),
    ];
    const c = control(0, {
      labelText: "first name",
      name: "x9",
      idStable: "x9",
    });
    expect(scoreSig(f[0]!.sig, c.sig)).toBe(3);
    expect(matchControls(f, steps, [c]).size).toBe(0);
  });

  it("ASP.NET derived pair is not double-counted", () => {
    const d = {
      name: "ctl00$Main$Amt",
      idStable: "ctl00_Main_Amt",
      nameIdDerived: true,
    };
    const f = [field("f", d)];
    // 3 only: below threshold 5
    expect(matchControls(f, steps, [control(0, d)]).size).toBe(0);
    // plus label 3 => 6
    expect(
      matchControls([field("f", { ...d, labelText: "amount" })], steps, [
        control(0, { ...d, labelText: "amount" }),
      ]),
    ).toEqual(new Map([["f", 0]]));
  });

  it("empty inputs do not throw", () => {
    expect(matchControls([], [], []).size).toBe(0);
    expect(matchControls([field("f", { name: "n" })], [], []).size).toBe(0);
    expect(matchControls([], steps, [control(0)]).size).toBe(0);
  });
});

describe("matchControls conflict resolution", () => {
  // Both saved fields describe the same "amount" control; they live on steps 1 and 3.
  const amountSig = { name: "amount", labelText: "amount" };
  const mk = (id: string, step: number) => field(id, amountSig, step);

  const page: MatchInput[] = [
    control(0, amountSig),
    control(1, { name: "card-holder", labelText: "cardholder" }),
    control(2, { name: "review", labelText: "review order" }),
  ];
  const pageKeys = page.map((c) => sigKey(c.sig, c.kind));
  const fp = (...extra: string[]) => [pageKeys[0]!, pageKeys[1]!, ...extra];

  it("the step whose fingerprint resembles the page wins", () => {
    const steps = [
      { index: 1, fingerprint: ["text|x|x|", "text|y|y|", "text|z|z|"] },
      { index: 3, fingerprint: fp(pageKeys[2]!) },
    ];
    const m = matchControls([mk("amt1", 1), mk("amt3", 3)], steps, page);
    expect(m).toEqual(new Map([["amt3", 0]]));
  });

  it("is independent of saved-field order", () => {
    const steps = [
      { index: 1, fingerprint: ["text|x|x|", "text|y|y|", "text|z|z|"] },
      { index: 3, fingerprint: fp(pageKeys[2]!) },
    ];
    const m = matchControls([mk("amt3", 3), mk("amt1", 1)], steps, page);
    expect(m).toEqual(new Map([["amt3", 0]]));
  });

  it("drops both when the best Jaccard is below 0.5", () => {
    const steps = [
      { index: 1, fingerprint: ["text|x|x|", "text|y|y|", "text|z|z|"] },
      { index: 3, fingerprint: [pageKeys[0]!, "a", "b", "c", "d", "e"] },
    ];
    expect(jaccard(steps[1]!.fingerprint, pageKeys)).toBeLessThan(0.5);
    expect(
      matchControls([mk("amt1", 1), mk("amt3", 3)], steps, page).size,
    ).toBe(0);
  });

  it("drops both when the Jaccard scores tie", () => {
    const steps = [
      { index: 1, fingerprint: pageKeys },
      { index: 3, fingerprint: [...pageKeys] },
    ];
    expect(
      matchControls([mk("amt1", 1), mk("amt3", 3)], steps, page).size,
    ).toBe(0);
  });

  it("keeps non-conflicting matches while dropping conflicting ones", () => {
    const steps = [
      { index: 1, fingerprint: ["q"] },
      { index: 3, fingerprint: ["r"] },
    ];
    const holder = field(
      "holder",
      { name: "card-holder", labelText: "cardholder" },
      3,
    );
    const m = matchControls(
      [mk("amt1", 1), mk("amt3", 3), holder],
      steps,
      page,
    );
    expect([...m]).toEqual([["holder", 1]]);
  });

  it("a control is used at most once and a field at most once", () => {
    const steps = [{ index: 0, fingerprint: pageKeys }];
    const m = matchControls(
      [
        mk("a", 0),
        field("b", { name: "card-holder", labelText: "cardholder" }),
      ],
      steps,
      page,
    );
    expect(new Set(m.values()).size).toBe(m.size);
    expect(m.get("b")).toBe(1);
  });

  it("a claimant on an unknown step has Jaccard 0 and loses", () => {
    const steps = [{ index: 3, fingerprint: pageKeys }];
    expect(matchControls([mk("amt9", 9), mk("amt3", 3)], steps, page)).toEqual(
      new Map([["amt3", 0]]),
    );
  });
});

describe("matchControls determinism", () => {
  it("result is unchanged by control and saved-field order", () => {
    const steps = [{ index: 0, fingerprint: [] as string[] }];
    const saved = [
      field("a", { name: "a", labelText: "a" }),
      field("b", { name: "b", labelText: "b" }),
      field("c", { name: "c", labelText: "c" }),
    ];
    const page = [
      control(0, { name: "c", labelText: "c" }),
      control(1, { name: "a", labelText: "a" }),
      control(2, { name: "b", labelText: "b" }),
    ];
    const expected = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 0],
    ]);
    const norm = (m: Map<string, number>) =>
      [...m].sort((x, y) => x[0].localeCompare(y[0]));
    expect(norm(matchControls(saved, steps, page))).toEqual(norm(expected));
    expect(
      norm(matchControls([...saved].reverse(), steps, [...page].reverse())),
    ).toEqual(norm(expected));
  });
});

describe("sigKey and jaccard", () => {
  it("sigKey format", () => {
    expect(
      sigKey(sig({ name: "n", labelText: "l", autocomplete: "a" }), "select"),
    ).toBe("select|n|l|a");
    expect(sigKey(sig(), "text")).toBe("text|||");
  });

  it("jaccard", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard(["a"], ["a"])).toBe(1);
    expect(jaccard(["a"], ["b"])).toBe(0);
    expect(jaccard([], [])).toBe(0);
    expect(jaccard(["a", "a", "b"], ["a", "b"])).toBe(1);
  });
});

describe("performance", () => {
  it("200 saved x 300 controls in under 50 ms", () => {
    const steps = [{ index: 0, fingerprint: [] as string[] }];
    const saved: SavedField[] = [];
    for (let k = 0; k < 200; k++) {
      saved.push(
        field(`f${k}`, {
          name: `name${k}`,
          labelText: `label ${k}`,
          idStable: `id${k}`,
          formAction: "/f",
        }),
      );
    }
    const page: MatchInput[] = [];
    for (let k = 0; k < 300; k++) {
      page.push(
        control(k, {
          name: `name${k}`,
          labelText: `label ${k}`,
          idStable: `id${k}`,
          formAction: "/f",
        }),
      );
    }
    matchControls(saved.slice(0, 5), steps, page.slice(0, 5)); // warm up
    const t0 = performance.now();
    const m = matchControls(saved, steps, page);
    const dt = performance.now() - t0;
    expect(m.size).toBe(200);
    expect(dt).toBeLessThan(50);
  });
});
