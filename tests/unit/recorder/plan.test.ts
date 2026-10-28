import { describe, expect, it } from "vitest";
import { applyCapture } from "../../../src/lib/recorder/fields";
import { recordingPlan } from "../../../src/lib/recorder/plan";
import { observePage } from "../../../src/lib/recorder/steps";
import type { Capture, RecBody } from "../../../src/lib/recorder/types";
import { emptyBody, seedBody } from "../../../src/lib/recorder/types";
import { capture, keys, page, savedProfile } from "./helpers";

const STEP1 = page("acct", "zip", "email");
const STEP2 = page("amount", "date", "memo");

function on(body: RecBody, controls: typeof STEP1, doc: string): RecBody {
  const out = observePage(body, keys(controls), doc, "/billpay/one");
  if (out === "full") throw new Error("unexpected full");
  return out;
}

function apply(body: RecBody, c: Capture): RecBody {
  return applyCapture(body, c).body;
}

describe("recordingPlan", () => {
  it("returns step 1's captured fields when the page shows step 1's controls again", () => {
    let b = on(emptyBody(), STEP1, "doc-1");
    b = apply(b, capture(STEP1[0]!, "12345"));
    b = apply(b, capture(STEP1[1]!, "10001", { pageDefault: "" }));
    b = on(b, STEP2, "doc-2");
    b = apply(b, capture(STEP2[0]!, "45.12"));
    // Back: step 1 re-rendered, the controls in another scan order.
    const again = [
      { ...STEP1[1]!, i: 0 },
      { ...STEP1[0]!, i: 1 },
      { ...STEP1[2]!, i: 2 },
    ];
    b = on(b, again, "doc-3");
    expect(recordingPlan(b, again)).toEqual([
      { fieldId: "f1", i: 1, kind: "text", value: "12345", pageDefault: "" },
      { fieldId: "f2", i: 0, kind: "text", value: "10001", pageDefault: "" },
    ]);
    // Step 2's page gets only step 2's value.
    expect(recordingPlan(b, STEP2)).toEqual([
      { fieldId: "f3", i: 0, kind: "text", value: "45.12", pageDefault: "" },
    ]);
  });

  it("never returns skip or ask fields", () => {
    const p = savedProfile();
    const b = seedBody({
      ...p,
      fields: [
        { ...p.fields[0]!, policy: "skip" },
        { ...p.fields[1]!, policy: "ask" },
      ],
    });
    expect(recordingPlan(b, page("acct", "zip"))).toEqual([]);
    expect(recordingPlan(b, page("amount", "memo"))).toEqual([]);
  });

  it("fills seeded save fields from the session", () => {
    const b = seedBody(savedProfile());
    expect(recordingPlan(b, page("acct", "zip"))).toEqual([
      { fieldId: "f1", i: 0, kind: "text", value: "12345", pageDefault: "" },
    ]);
  });

  it("an empty session plans nothing", () => {
    expect(recordingPlan(emptyBody(), STEP1)).toEqual([]);
  });
});
