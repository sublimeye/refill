import { describe, expect, it } from "vitest";
import type { RecBody } from "../../../src/lib/recorder/types";
import { emptyBody, seedBody } from "../../../src/lib/recorder/types";
import { observePage } from "../../../src/lib/recorder/steps";
import { ctrl, keys, page, savedProfile } from "./helpers";

function observe(
  body: RecBody,
  k: string[],
  doc: string | null,
  path = "/billpay/one",
): RecBody {
  const out = observePage(body, k, doc, path);
  if (out === "full") throw new Error("unexpected full");
  return out;
}

const STEP1 = keys(page("acct", "zip", "email"));
const STEP2 = keys(page("amount", "date", "memo"));

describe("observePage", () => {
  it("creates step 0 for the first page, with its path and keys", () => {
    const b = observe(emptyBody(), STEP1, "doc-1", "/billpay/one");
    expect(b.steps).toEqual([
      { index: 0, pathHint: "/billpay/one", fingerprint: STEP1 },
    ]);
    expect(b.current).toBe(0);
    expect(b.lastDocument).toBe("doc-1");
  });

  it("does not mutate its input", () => {
    const b0 = observe(emptyBody(), STEP1, "doc-1");
    const snapshot = structuredClone(b0);
    observe(b0, [...STEP1, "text|extra||"], "doc-1");
    observe(b0, STEP2, "doc-2");
    expect(b0).toEqual(snapshot);
  });

  it("an accordion opening in the same document stays one step and grows its fingerprint", () => {
    const b1 = observe(emptyBody(), STEP1, "doc-1");
    // The next section opens: every earlier control is still there, plus more than as many new ones.
    const opened = [...STEP1, ...keys(page("a", "b", "c", "d", "e"))];
    const b2 = observe(b1, opened, "doc-1");
    expect(b2.steps).toHaveLength(1);
    expect(b2.current).toBe(0);
    expect(b2.steps[0]?.fingerprint).toEqual(opened);
  });

  it("an SPA step change (same document, different controls) is a new step", () => {
    const b1 = observe(emptyBody(), STEP1, "doc-1", "/billpay/one");
    const b2 = observe(b1, STEP2, "doc-1", "/billpay/two");
    expect(b2.steps.map((s) => s.index)).toEqual([0, 1]);
    expect(b2.steps[1]).toEqual({
      index: 1,
      pathHint: "/billpay/two",
      fingerprint: STEP2,
    });
    expect(b2.current).toBe(1);
  });

  it("Review Focus 2: Back from step 2's keys to step 1's keys returns to step 1 (SPA and reload)", () => {
    const b1 = observe(emptyBody(), STEP1, "doc-1");
    const b2 = observe(b1, STEP2, "doc-1");
    // SPA Back: same document.
    const spa = observe(b2, STEP1, "doc-1");
    expect(spa.steps).toHaveLength(2);
    expect(spa.current).toBe(0);
    // Full reload Back: a new document.
    const reload = observe(b2, STEP1, "doc-9");
    expect(reload.steps).toHaveLength(2);
    expect(reload.current).toBe(0);
    expect(reload.lastDocument).toBe("doc-9");
  });

  it("Review Focus 3: a new document with the same keys (failed-validation POST) stays on the same step", () => {
    const b1 = observe(emptyBody(), STEP1, "doc-1");
    const b2 = observe(b1, STEP1, "doc-2");
    expect(b2.steps).toHaveLength(1);
    expect(b2.current).toBe(0);
    expect(b2.lastDocument).toBe("doc-2");
  });

  it("Review Focus 3: an accordion reloaded collapsed stays on its step (subset of the fingerprint)", () => {
    const s1 = keys(page("acct", "zip", "email"));
    const s2 = keys(page("street", "city", "state"));
    const s3 = keys(page("card", "exp", "name"));
    let b = observe(emptyBody(), s1, "doc-1");
    b = observe(b, [...s1, ...s2], "doc-1");
    b = observe(b, [...s1, ...s2, ...s3], "doc-1");
    expect(b.steps).toHaveLength(1);
    // A failed submit re-renders the page with only the first section open: Jaccard 3/9.
    const reloaded = observe(b, s1, "doc-2");
    expect(reloaded.steps).toHaveLength(1);
    expect(reloaded.current).toBe(0);
  });

  it("a page of fewer than 3 keys does not join a step by the subset rule", () => {
    const b1 = observe(
      emptyBody(),
      keys(page("acct", "zip", "email", "amount", "memo")),
      "doc-1",
    );
    // A later one-field step that repeats "amount": a subset of step 0, Jaccard 1/5.
    const b2 = observe(b1, keys(page("amount")), "doc-2");
    expect(b2.steps).toHaveLength(2);
    expect(b2.current).toBe(1);
    // Two keys: still Jaccard only (2/5).
    const b3 = observe(b1, keys(page("amount", "memo")), "doc-3");
    expect(b3.steps).toHaveLength(2);
  });

  it("among subset candidates the most similar step wins", () => {
    const big = keys(page("a", "b", "c", "d", "e", "f", "g", "h"));
    const small = keys(page("a", "b", "c", "x", "y"));
    let b = observe(emptyBody(), big, "doc-1");
    b = observe(b, small, "doc-2");
    expect(b.steps).toHaveLength(2);
    // {a, b, c} is a subset of both: Jaccard 3/8 with step 0, 3/5 with step 1.
    const back = observe(b, keys(page("a", "b", "c")), "doc-3");
    expect(back.steps).toHaveLength(2);
    expect(back.current).toBe(1);
  });

  it("a null document id never counts as the same document", () => {
    const b1 = observe(emptyBody(), STEP1, null);
    // A superset with low similarity: joins only through the same-document rule.
    const opened = [...STEP1, ...keys(page("a", "b", "c", "d", "e"))];
    const b2 = observe(b1, opened, null);
    expect(b2.steps).toHaveLength(2);
  });

  it("the latest step wins a similarity tie", () => {
    const b1 = observe(emptyBody(), keys(page("a", "b")), "doc-1");
    const b2 = observe(b1, keys(page("c", "d")), "doc-2");
    // {a, b, c, d} has Jaccard 0.5 with each step.
    const tie = observe(b2, keys(page("a", "b", "c", "d")), "doc-3");
    expect(tie.steps).toHaveLength(2);
    expect(tie.current).toBe(1);
  });

  it("a seeded body: the first page joins seeded step 0", () => {
    const seeded = seedBody(savedProfile());
    const b = observe(
      seeded,
      keys(page("acct", "zip", "promo")),
      "doc-1",
      "/billpay/one-new",
    );
    expect(b.steps).toHaveLength(2);
    expect(b.current).toBe(0);
    // The seeded path hint is kept; the fingerprint gains the new key.
    expect(b.steps[0]?.pathHint).toBe("/billpay/one");
    expect(b.steps[0]?.fingerprint).toEqual(keys(page("acct", "zip", "promo")));
  });

  it("an 11th page is full", () => {
    let b = emptyBody();
    for (let n = 0; n < 10; n++) {
      b = observe(b, keys(page(`s${n}a`, `s${n}b`)), `doc-${n}`);
    }
    expect(b.steps).toHaveLength(10);
    expect(observePage(b, keys(page("x", "y")), "doc-x", "/x")).toBe("full");
    // A page of a known step still joins it.
    const back = observe(b, keys(page("s3a", "s3b")), "doc-y");
    expect(back.current).toBe(3);
  });

  it("gives a new step the lowest unused index (a seeded profile may skip indexes)", () => {
    const p = savedProfile();
    const seeded = seedBody({
      ...p,
      steps: p.steps.map((s) => (s.index === 1 ? { ...s, index: 9 } : s)),
      fields: p.fields.map((f) => (f.step === 1 ? { ...f, step: 9 } : f)),
    });
    const b = observe(seeded, keys(page("x", "y")), "doc-1");
    expect(b.steps.map((s) => s.index)).toEqual([0, 9, 1]);
    expect(b.current).toBe(1);
  });

  it("keeps a fingerprint to 300 distinct entries, first ones first", () => {
    const many = Array.from({ length: 280 }, (_, n) => `text|k${n}||`);
    const b1 = observe(emptyBody(), [...many, many[0]!], "doc-1");
    expect(b1.steps[0]?.fingerprint).toEqual(many);
    const more = Array.from({ length: 40 }, (_, n) => `text|m${n}||`);
    const b2 = observe(b1, [...many, ...more], "doc-1");
    expect(b2.steps[0]?.fingerprint).toEqual([...many, ...more.slice(0, 20)]);
  });

  it("drops keys longer than a fingerprint entry may be", () => {
    const long = "x".repeat(1025);
    const b = observe(emptyBody(), [...STEP1, long], "doc-1");
    expect(b.steps[0]?.fingerprint).toEqual(STEP1);
  });

  it("cuts an over-long path hint back to a segment boundary", () => {
    const path = "/billpay/" + "a".repeat(300);
    const b = observe(emptyBody(), STEP1, "doc-1", path);
    expect(b.steps[0]?.pathHint).toBe("/billpay/");
  });

  it("a page with no keys files no step and clears the current step", () => {
    const b1 = observe(emptyBody(), STEP1, "doc-1");
    const b2 = observe(b1, [], "doc-2");
    expect(b2.steps).toEqual(b1.steps);
    expect(b2.current).toBeNull();
    expect(b2.lastDocument).toBe("doc-2");
    expect(observe(emptyBody(), [], "doc-1").steps).toEqual([]);
  });

  it("radio and checkbox keys take part like any other key", () => {
    const radios = [
      ctrl(0, "plan", { labelText: "Basic", type: "radio" }, "radio"),
      ctrl(1, "plan", { labelText: "Pro", type: "radio" }, "radio"),
    ];
    const b1 = observe(emptyBody(), keys(radios), "doc-1");
    const b2 = observe(b1, keys(radios), "doc-2");
    expect(b2.steps).toHaveLength(1);
  });
});
