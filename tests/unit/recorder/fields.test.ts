import { describe, expect, it } from "vitest";
import { matchControls } from "../../../src/lib/match/match";
import { applyCapture, capturedCount } from "../../../src/lib/recorder/fields";
import { observePage } from "../../../src/lib/recorder/steps";
import type { Capture, RecBody } from "../../../src/lib/recorder/types";
import { emptyBody, seedBody } from "../../../src/lib/recorder/types";
import { capture, ctrl, keys, page, savedProfile } from "./helpers";

const STEP1 = page("acct", "zip", "email");
const STEP2 = page("amount", "date", "memo");

function on(body: RecBody, controls = STEP1, doc = "doc-1"): RecBody {
  const out = observePage(body, keys(controls), doc, "/billpay/one");
  if (out === "full") throw new Error("unexpected full");
  return out;
}

function apply(body: RecBody, c: Capture): RecBody {
  const out = applyCapture(body, c);
  expect(out.result).toBe("ok");
  return out.body;
}

const acct = STEP1[0]!;
const zip = STEP1[1]!;

describe("applyCapture", () => {
  it("before any page: no-step", () => {
    const b = emptyBody();
    expect(applyCapture(b, capture(acct, "1"))).toEqual({
      body: b,
      result: "no-step",
    });
  });

  it("stores a new field with policy save in the current step", () => {
    const b = apply(on(emptyBody()), capture(acct, "12345"));
    expect(b.fields).toEqual([
      {
        id: "f1",
        step: 0,
        sig: acct.sig,
        kind: "text",
        value: "12345",
        pageDefault: "",
        policy: "save",
      },
    ]);
    expect(b.nextId).toBe(2);
    expect(capturedCount(b)).toBe(1);
  });

  it("does not mutate its input", () => {
    const b0 = apply(on(emptyBody()), capture(acct, "1"));
    const snapshot = structuredClone(b0);
    apply(b0, capture(acct, "2"));
    apply(b0, capture(zip, "3"));
    apply(b0, capture(acct, ""));
    expect(b0).toEqual(snapshot);
  });

  it("a second edit of the same control updates its field", () => {
    let b = apply(on(emptyBody()), capture(acct, "1"));
    b = apply(b, capture(acct, "12"));
    expect(b.fields).toHaveLength(1);
    expect(b.fields[0]?.value).toBe("12");
  });

  it("Review Focus 1: a revert to the page default removes the field", () => {
    let b = apply(on(emptyBody()), capture(acct, "12345"));
    b = apply(b, capture(acct, ""));
    expect(b.fields).toEqual([]);
    // A non-empty page default: changing it and changing it back stores nothing.
    b = apply(b, capture(zip, "90210", { pageDefault: "10001" }));
    expect(b.fields).toHaveLength(1);
    b = apply(b, capture(zip, "10001", { pageDefault: "10001" }));
    expect(b.fields).toEqual([]);
    // A revert of a control never captured stores nothing either.
    b = apply(b, capture(acct, "", { pageDefault: "" }));
    expect(b.fields).toEqual([]);
  });

  it("Review Focus 1: reverting a seeded field removes it", () => {
    const seeded = on(seedBody(savedProfile()), page("acct", "zip"));
    // Refill filled f1 into the account input; the user clears it.
    const b = apply(seeded, capture(acct, "", { fieldId: "f1" }));
    expect(b.fields.map((f) => f.id)).toEqual(["f4"]);
  });

  it("two radios of one group are one field", () => {
    const basic = ctrl(
      0,
      "plan",
      { labelText: "Basic", type: "radio" },
      "radio",
    );
    const pro = ctrl(1, "plan", { labelText: "Pro", type: "radio" }, "radio");
    let b = on(emptyBody(), [basic, pro]);
    b = apply(b, capture(basic, "true", { pageDefault: "false" }));
    b = apply(b, capture(pro, "true", { pageDefault: "false" }));
    expect(b.fields).toHaveLength(1);
    expect(b.fields[0]?.sig).toEqual(pro.sig);
    // Choosing the option that was checked on load reverts the group.
    const basicDefault = ctrl(
      0,
      "plan",
      { labelText: "Basic", type: "radio" },
      "radio",
    );
    b = apply(b, capture(basicDefault, "true", { pageDefault: "true" }));
    expect(b.fields).toEqual([]);
  });

  it("radios of the same name in different forms are different groups", () => {
    const a = ctrl(0, "plan", { type: "radio", formAction: "/a" }, "radio");
    const c = ctrl(0, "plan", { type: "radio", formAction: "/c" }, "radio");
    let b = on(emptyBody(), [a, c]);
    b = apply(b, capture(a, "true", { pageDefault: "false" }));
    b = apply(b, capture(c, "true", { pageDefault: "false" }));
    expect(b.fields).toHaveLength(2);
  });

  it("unnamed radios are not one group", () => {
    const x = ctrl(
      0,
      "x",
      { name: null, labelText: "Yes", type: "radio" },
      "radio",
    );
    const y = ctrl(
      1,
      "y",
      { name: null, labelText: "No", type: "radio" },
      "radio",
    );
    let b = on(emptyBody(), [x, y]);
    b = apply(b, capture(x, "true", { pageDefault: "false" }));
    b = apply(b, capture(y, "true", { pageDefault: "false" }));
    expect(b.fields).toHaveLength(2);
  });

  it("the same label at two ordinals is two fields", () => {
    const first = ctrl(0, "phone");
    const second = ctrl(1, "phone");
    let b = on(emptyBody(), [first, second]);
    b = apply(b, capture(first, "555-0100"));
    b = apply(b, capture(second, "555-0199"));
    expect(b.fields.map((f) => f.value)).toEqual(["555-0100", "555-0199"]);
  });

  it("ignores a password, one-time code or CVV signature", () => {
    const b0 = on(emptyBody());
    for (const over of [
      { type: "password" },
      { autocomplete: "one-time-code" },
      { name: "cvv", labelText: "CVV" },
    ]) {
      const out = applyCapture(b0, capture(ctrl(5, "x", over), "secret"));
      expect(out).toEqual({ body: b0, result: "ok" });
    }
  });

  it("stores a card number", () => {
    const card = ctrl(3, "cardnumber", {
      labelText: "Card number",
      autocomplete: "cc-number",
    });
    const b = apply(on(emptyBody()), capture(card, "4111111111111111"));
    expect(b.fields[0]?.value).toBe("4111111111111111");
  });

  it("ignores an over-long value, a radio that is not chosen and a checkbox value that is not a boolean", () => {
    const b0 = on(emptyBody());
    const radio = ctrl(4, "plan", { type: "radio" }, "radio");
    const box = ctrl(5, "terms", { type: "checkbox" }, "checkbox");
    for (const c of [
      capture(acct, "x".repeat(4097)),
      capture(acct, "1", { pageDefault: "x".repeat(4097) }),
      capture(radio, "false"),
      capture(radio, "on"),
      capture(box, "on"),
    ]) {
      expect(applyCapture(b0, c)).toEqual({ body: b0, result: "ok" });
    }
    const b1 = apply(b0, capture(box, "false", { pageDefault: "true" }));
    expect(b1.fields[0]?.value).toBe("false");
    expect(apply(b0, capture(acct, "x".repeat(4096))).fields).toHaveLength(1);
  });

  it("Review Focus 5: a capture linked to a relabeled seeded field updates it and adds none", () => {
    const seeded = seedBody(savedProfile());
    // The page now labels the account input differently.
    const relabeled = ctrl(0, "acct", { labelText: "Account number" });
    let b = on(seeded, [relabeled, STEP1[1]!]);
    b = apply(b, capture(relabeled, "99999", { fieldId: "f1" }));
    expect(b.fields.map((f) => f.id)).toEqual(["f1", "f4"]);
    const f1 = b.fields[0]!;
    expect(f1.value).toBe("99999");
    expect(f1.sig.labelText).toBe("Account number");
    expect(f1.policy).toBe("save");
    // The field not reached stays as saved.
    expect(b.fields[1]).toEqual(seeded.fields[1]);
  });

  it("a linked capture keeps the field's id and policy and moves it to the current step", () => {
    let b = seedBody(savedProfile());
    b = on(b, STEP2, "doc-1");
    // f4 (policy ask, step 1) filled into a control on the current step.
    expect(b.current).toBe(1);
    b = on(b, page("acct", "zip"), "doc-2");
    expect(b.current).toBe(0);
    b = apply(b, capture(STEP2[0]!, "50.00", { fieldId: "f4" }));
    const f4 = b.fields.find((f) => f.id === "f4");
    expect(f4).toMatchObject({ step: 0, value: "50.00", policy: "ask" });
    expect(b.fields).toHaveLength(2);
  });

  it("a linked capture drops an older field for the same control in the current step", () => {
    let b = on(seedBody(savedProfile()), page("acct", "zip"));
    // An unlinked edit of the zip control first; later an edit of the same control arrives linked to
    // f1 (Refill filled f1 there in a new document). The older unlinked field must not stay behind.
    b = apply(b, capture(zip, "10001"));
    expect(b.fields).toHaveLength(3);
    const newId = b.fields[2]!.id;
    b = apply(b, capture(zip, "10002", { fieldId: "f1" }));
    expect(b.fields.map((f) => f.id)).toEqual(["f1", "f4"]);
    expect(b.fields.some((f) => f.id === newId)).toBe(false);
  });

  it("Review Focus 1: a linked revert also removes an older capture of the same control", () => {
    let b = on(seedBody(savedProfile()), page("acct", "zip"));
    b = apply(b, capture(zip, "10001"));
    expect(b.fields).toHaveLength(3);
    // Refill filled f1 into the zip control in a new document; the user clears it.
    b = apply(b, capture(zip, "", { fieldId: "f1" }));
    expect(b.fields.map((f) => f.id)).toEqual(["f4"]);
  });

  it("Review Focus 5: an unlinked edit of a relabeled seeded field updates it (matcher fallback)", () => {
    const p = savedProfile();
    const amount = ctrl(0, "amount", {
      idStable: "amt",
      autocomplete: "transaction-amount",
    });
    const others = page("x", "date", "memo", "note").slice(1);
    const seeded = seedBody({
      ...p,
      steps: [
        p.steps[0]!,
        { ...p.steps[1]!, fingerprint: keys([amount, ...others]) },
      ],
      fields: [
        p.fields[0]!,
        { ...p.fields[1]!, sig: amount.sig, policy: "ask" },
      ],
    });
    // The page now labels it "Amount due"; Refill did not fill it (policy ask), so no fieldId.
    const relabeled = {
      ...amount,
      sig: { ...amount.sig, labelText: "Amount due" },
    };
    const now = [relabeled, ...others];
    let b = on(seeded, now, "doc-1");
    expect(b.current).toBe(1);
    b = apply(b, capture(relabeled, "50.00"));
    expect(b.fields.map((f) => f.id)).toEqual(["f1", "f4"]);
    expect(b.fields[1]).toMatchObject({
      id: "f4",
      value: "50.00",
      policy: "ask",
      step: 1,
    });
    expect(b.fields[1]?.sig.labelText).toBe("Amount due");
    // The fill matcher still gives the control to f4 alone.
    expect(matchControls(b.fields, b.steps, now).get("f4")).toBe(0);
  });

  it("a genuinely new control next to a seeded field is a new field", () => {
    let b = on(seedBody(savedProfile()), page("acct", "zip"));
    b = apply(
      b,
      capture(ctrl(7, "promo", { labelText: "Promo code" }), "SAVE10"),
    );
    expect(b.fields.map((f) => f.id)).toEqual(["f1", "f4", "f5"]);
  });

  it("a fieldId that names no field falls back to identity", () => {
    let b = apply(on(emptyBody()), capture(acct, "1"));
    b = apply(b, capture(acct, "2", { fieldId: "f99" }));
    expect(b.fields).toHaveLength(1);
    expect(b.fields[0]).toMatchObject({ id: "f1", value: "2" });
  });

  it("identity is looked up in the current step only", () => {
    let b = on(emptyBody(), STEP1, "doc-1");
    b = apply(b, capture(acct, "1"));
    // Same control signature on another step (a different page).
    b = on(b, [acct, ...STEP2], "doc-2");
    b = on(b, STEP2, "doc-3");
    expect(b.current).toBe(1);
    b = apply(b, capture(acct, "2"));
    expect(b.fields.map((f) => [f.step, f.value])).toEqual([
      [0, "1"],
      [1, "2"],
    ]);
  });

  it("new ids continue past the seeded ones and never collide", () => {
    const p = savedProfile();
    const b0 = seedBody({
      ...p,
      fields: [...p.fields, { ...p.fields[0]!, id: "custom" }],
    });
    expect(b0.nextId).toBe(5);
    const b = apply(on(b0, page("acct", "zip")), capture(zip, "1"));
    expect(b.fields.at(-1)?.id).toBe("f5");
  });

  it("the 201st field is full and leaves the body unchanged", () => {
    let b = on(emptyBody());
    for (let n = 0; n < 200; n++) {
      b = apply(b, capture(ctrl(n, "x"), String(n)));
    }
    expect(capturedCount(b)).toBe(200);
    expect(applyCapture(b, capture(ctrl(200, "x"), "1"))).toEqual({
      body: b,
      result: "full",
    });
    // Updating an existing field still works when full.
    const upd = applyCapture(b, capture(ctrl(7, "x"), "new"));
    expect(upd.result).toBe("ok");
    expect(upd.body.fields[7]?.value).toBe("new");
  });
});
