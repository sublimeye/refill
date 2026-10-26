import { expect, it } from "vitest";
import { scorePassphrase } from "../../../src/lib/passphrase/strength";

it("rejects a common password", () => {
  const r = scorePassphrase("password123");
  expect(r.acceptable).toBe(false);
  expect(r.score).toBeLessThan(3);
});

it("accepts a long diceware-style passphrase", () => {
  const r = scorePassphrase("correct horse battery staple");
  expect(r.acceptable).toBe(true);
  expect(r.score).toBeGreaterThanOrEqual(3);
});

it("rejects an 11-character random string even though it scores high (length rule)", () => {
  const p = "xK9#mQ2$vL7";
  expect(p).toHaveLength(11);
  const r = scorePassphrase(p);
  expect(r.score).toBeGreaterThanOrEqual(3);
  expect(r.acceptable).toBe(false);
  expect(r.feedback).toBe("Use at least 12 characters.");
});

it("counts length after NFC normalization, in code points", () => {
  // Twelve characters, but written decomposed (e + combining acute): 18 UTF-16 units, 12 once composed.
  const composed = "é".repeat(6) + "xK9#mQ";
  const decomposed = composed.normalize("NFD");
  expect(decomposed.length).toBeGreaterThan(12);
  expect(scorePassphrase(composed).acceptable).toBe(true);
  expect(scorePassphrase(decomposed).acceptable).toBe(true);
  // 11 code points but 22 UTF-16 units: too short.
  expect(scorePassphrase("😀".repeat(11)).acceptable).toBe(false);
});

it("gives empty-string input a zero score and no crash", () => {
  expect(scorePassphrase("")).toMatchObject({ score: 0, acceptable: false });
});
