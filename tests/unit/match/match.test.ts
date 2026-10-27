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

const score = (
  a: Sig,
  b: Sig,
  ka: ControlKind = "text",
  kb: ControlKind = ka,
): number => scoreSig(a, b, ka, kb);

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

  it("matches on path-segment boundaries", () => {
    const o = p.origin;
    const bp = { origin: o, pathPrefix: "/billpay" };
    expect(profileApplies(bp, o, "/billpay")).toBe(true);
    expect(profileApplies(bp, o, "/billpay/")).toBe(true);
    expect(profileApplies(bp, o, "/billpay/step2")).toBe(true);
    expect(profileApplies(bp, o, "/billpayment")).toBe(false);
    expect(profileApplies(bp, o, "/billpay-admin")).toBe(false);
    expect(profileApplies(bp, o, "/billing")).toBe(false);
    const slash = { origin: o, pathPrefix: "/billpay/" };
    expect(profileApplies(slash, o, "/billpay/step2")).toBe(true);
    expect(profileApplies(slash, o, "/billpay")).toBe(false);
    expect(profileApplies(slash, o, "/billpayment")).toBe(false);
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
      score(
        A({ autocomplete: "given-name" }),
        B({ autocomplete: "given-name" }),
      ),
    ).toBe(4);
  });

  it("autocomplete on/off/null carries no weight", () => {
    expect(score(A({ autocomplete: "on" }), B({ autocomplete: "on" }))).toBe(0);
    expect(score(A({ autocomplete: "off" }), B({ autocomplete: "off" }))).toBe(
      0,
    );
    expect(score(A(), B())).toBe(0);
  });

  it("autocomplete counts only when it names a WHATWG autofill field", () => {
    for (const junk of [
      "nope",
      "chrome-off",
      "disabled",
      "none",
      "false",
      "x",
    ]) {
      expect(score(A({ autocomplete: junk }), B({ autocomplete: junk }))).toBe(
        0,
      );
    }
    for (const ok of [
      "email",
      "cc-number",
      "address-line1",
      "tel-national",
      "section-a shipping email",
      "billing postal-code",
      "work tel",
    ]) {
      expect(score(A({ autocomplete: ok }), B({ autocomplete: ok }))).toBe(4);
    }
  });

  it("autocomplete equality uses the full normalized string, modifiers included", () => {
    expect(
      score(
        A({ autocomplete: "shipping email" }),
        B({ autocomplete: "billing email" }),
      ),
    ).toBe(0);
    // modifiers alone are not a field name
    expect(
      score(A({ autocomplete: "shipping" }), B({ autocomplete: "shipping" })),
    ).toBe(0);
  });

  it("name 3", () => {
    expect(score(A({ name: "amt" }), B({ name: "amt" }))).toBe(3);
  });

  it("label 3", () => {
    expect(score(A({ labelText: "amount" }), B({ labelText: "amount" }))).toBe(
      3,
    );
  });

  it("idStable 2", () => {
    expect(score(A({ idStable: "amt" }), B({ idStable: "amt" }))).toBe(2);
  });

  it("formAction 1", () => {
    expect(score(A({ formAction: "/pay" }), B({ formAction: "/pay" }))).toBe(1);
  });

  it("ordinal 1", () => {
    expect(score(sig({ ordinal: 3 }), sig({ ordinal: 3 }))).toBe(1);
  });

  it("different or missing evidence scores nothing", () => {
    expect(
      score(
        A({ name: "a", idStable: "a", labelText: "a", formAction: "/a" }),
        B({ name: "b", idStable: "b", labelText: "b", formAction: "/b" }),
      ),
    ).toBe(0);
    expect(score(A({ name: "a" }), B({ name: null }))).toBe(0);
    expect(score(A({ name: null }), B({ name: null }))).toBe(0);
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
    expect(score(s, { ...s })).toBe(4 + 3 + 3 + 2 + 1 + 1);
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
          score(
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
        expect(score(sig(strong), sig(strong), ka, kb)).toBe(-Infinity);
      }
    }
  });

  it("non-text kinds need an equal type", () => {
    expect(
      score(
        sig({ ...strong, type: "select-one" }),
        sig({ ...strong, type: "select-multiple" }),
        "select",
        "select",
      ),
    ).toBe(-Infinity);
    expect(
      score(
        sig({ ...strong, type: "select-one" }),
        sig({ ...strong, type: "select-one" }),
        "select",
        "select",
      ),
    ).toBeGreaterThan(0);
  });

  it("a text control of a non-listed type needs an equal type", () => {
    expect(
      score(
        sig({ ...strong, type: "month" }),
        sig({ ...strong, type: "text" }),
      ),
    ).toBe(-Infinity);
    expect(
      score(
        sig({ ...strong, type: "month" }),
        sig({ ...strong, type: "month" }),
      ),
    ).toBeGreaterThan(0);
  });

  it("non-text kinds do not use the text-like set", () => {
    expect(
      score(
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
      score(
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
    expect(score(a, b)).toBe(3);
    expect(score(b, a)).toBe(3);
  });

  it("non-derived pairs still count both", () => {
    const a = sig({ name: "n", idStable: "same", ordinal: 1 });
    const b = sig({ name: "n", idStable: "same", ordinal: 2 });
    expect(score(a, b)).toBe(5);
  });

  it("derived flag with different names gives no id weight either", () => {
    const a = sig({
      name: "n1",
      idStable: "same",
      nameIdDerived: true,
      ordinal: 1,
    });
    const b = sig({ name: "n2", idStable: "same", ordinal: 2 });
    expect(score(a, b)).toBe(0);
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

  describe("randomized name+id with only a placeholder label (score 3)", () => {
    const rnd = (id: string, over: Partial<Sig> = {}) => ({
      labelText: "first name",
      name: id,
      idStable: id,
      ...over,
    });

    it("stays unmatched when ordinal or formAction differ", () => {
      const f = field("f", rnd("r1", { formAction: "/f" }));
      const base = rnd("x9", { formAction: "/f" });
      // label 3 + formAction 1 only (ordinals differ)
      const noOrdinal = { ...f, sig: { ...f.sig, ordinal: 1 } };
      const c = control(0, base);
      expect(score(noOrdinal.sig, c.sig)).toBe(4);
      expect(matchControls([noOrdinal], steps, [c]).size).toBe(0);
      // label 3 + ordinal 1 only (formAction differs)
      const sameOrdinal = {
        ...f,
        sig: { ...f.sig, ordinal: 100, formAction: "/other" },
      };
      expect(score(sameOrdinal.sig, c.sig)).toBe(4);
      expect(matchControls([sameOrdinal], steps, [c]).size).toBe(0);
      // label alone
      expect(
        matchControls([field("f", rnd("r1"))], steps, [control(0, rnd("x9"))])
          .size,
      ).toBe(0);
    });

    it("matches when label, formAction and ordinal all agree (3+1+1 = 5)", () => {
      const f = field("f", rnd("r1", { formAction: "/f" }));
      const saved = { ...f, sig: { ...f.sig, ordinal: 100 } };
      const c = control(0, rnd("x9", { formAction: "/f" }));
      expect(score(saved.sig, c.sig)).toBe(5);
      expect(matchControls([saved], steps, [c])).toEqual(new Map([["f", 0]]));
    });
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

  it("drops both claimants when the best Jaccard is below 0.5", () => {
    // One recorded step (no cross-step gate): step 3 is known but dissimilar, step 9 is unknown.
    const steps = [
      { index: 3, fingerprint: [pageKeys[0]!, "a", "b", "c", "d", "e"] },
    ];
    expect(jaccard(steps[0]!.fingerprint, pageKeys)).toBeLessThan(0.5);
    expect(
      matchControls([mk("amt3", 3), mk("amt9", 9)], steps, page).size,
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
      { index: 1, fingerprint: pageKeys },
      { index: 3, fingerprint: [...pageKeys] },
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

describe("matchControls cross-step gate", () => {
  const f1 = field("acct", { name: "acct", labelText: "account number" }, 1);
  const f2 = field("amt", { name: "amount", labelText: "amount" }, 2);
  const c1 = control(0, { name: "acct", labelText: "account number" });
  const c2 = control(1, { name: "amount", labelText: "amount" });
  const k = (c: MatchInput) => sigKey(c.sig, c.kind);
  const steps = [
    { index: 1, fingerprint: [k(c1), "text|a|a|"] },
    { index: 2, fingerprint: [k(c2), "text|b|b|"] },
  ];

  it("a step-1 field never fills a step-2 page", () => {
    // Page has step 2's signature plus a control that would match step 1's field.
    const lookalike = control(0, { name: "acct", labelText: "account number" });
    const page = [lookalike, c2];
    const pageSteps = [
      { index: 1, fingerprint: ["text|a|a|", "text|q|q|"] },
      { index: 2, fingerprint: [k(c2), k(lookalike)] },
    ];
    // step 2 has Jaccard 1, step 1 has 0: only step 2's fields are allowed
    expect(matchControls([f1, f2], pageSteps, page)).toEqual(
      new Map([["amt", 1]]),
    );
  });

  it("nothing matches when no step resembles the page (max Jaccard 0)", () => {
    expect(
      matchControls(
        [f1, f2],
        [
          { index: 1, fingerprint: ["z"] },
          { index: 2, fingerprint: ["y"] },
        ],
        [c1, c2],
      ).size,
    ).toBe(0);
  });

  it("an SPA page holding both steps fills both only when Jaccards tie at the max", () => {
    const page = [c1, c2];
    // each fingerprint is 2 keys with 1 in common with the page: 1/3 each, tie
    expect(matchControls([f1, f2], steps, page)).toEqual(
      new Map([
        ["acct", 0],
        ["amt", 1],
      ]),
    );
    // step 2 resembles the page more: only its field may fill
    const skewed = [
      { index: 1, fingerprint: [k(c1)] }, // Jaccard 1/2, positive but not max
      { index: 2, fingerprint: [k(c2), k(c1)] }, // Jaccard 1
    ];
    expect(matchControls([f1, f2], skewed, page)).toEqual(
      new Map([["amt", 1]]),
    );
  });

  it("a single-step profile has no gate", () => {
    expect(
      matchControls([f1], [{ index: 1, fingerprint: ["unrelated"] }], [c1]),
    ).toEqual(new Map([["acct", 0]]));
  });
});

describe("junk autocomplete cannot match a lone control", () => {
  it("step-1 account number does not fill a lone amount control", () => {
    const shared = {
      autocomplete: "nope",
      formAction: "/Pay.aspx",
    };
    const acct = field(
      "acct",
      {
        ...shared,
        labelText: "account number",
        name: "ctl00$Main$Acct",
        idStable: "ctl00_Main_Acct",
        nameIdDerived: true,
      },
      1,
    );
    const saved = { ...acct, sig: { ...acct.sig, ordinal: 0 } };
    const amount: MatchInput = {
      i: 0,
      kind: "text",
      sig: sig({ ...shared, labelText: "amount", name: "amt", ordinal: 0 }),
    };
    expect(score(saved.sig, amount.sig)).toBe(2); // formAction + ordinal only
    expect(
      matchControls(
        [saved],
        [
          {
            index: 1,
            fingerprint: ["text|ctl00$Main$Acct|account number|nope"],
          },
        ],
        [amount],
      ).size,
    ).toBe(0);
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
