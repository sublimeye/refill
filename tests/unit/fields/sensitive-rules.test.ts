import { describe, expect, it } from "vitest";
import { sigLooksSensitive } from "../../../src/lib/fields/sensitive-rules";
import type { Sig } from "../../../src/lib/fields/signature";

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

describe("sigLooksSensitive", () => {
  it.each(["password", "hidden", "file"])("is true for type %s", (type) => {
    expect(sigLooksSensitive(sig({ type }))).toBe(true);
  });

  it("is true for one-time-code autocomplete", () => {
    expect(sigLooksSensitive(sig({ autocomplete: "one-time-code" }))).toBe(
      true,
    );
  });

  it("compares the type case-insensitively", () => {
    expect(sigLooksSensitive(sig({ type: "PASSWORD" }))).toBe(true);
    expect(sigLooksSensitive(sig({ type: "Hidden" }))).toBe(true);
    expect(sigLooksSensitive(sig({ type: "FILE" }))).toBe(true);
    expect(sigLooksSensitive(sig({ type: "TEXT", name: "email" }))).toBe(false);
  });

  it("is true for the name confirmPassword", () => {
    expect(sigLooksSensitive(sig({ name: "confirmPassword" }))).toBe(true);
  });

  it("is true for the label 'verification code'", () => {
    expect(sigLooksSensitive(sig({ labelText: "verification code" }))).toBe(
      true,
    );
  });

  it("is true for a sensitive stable id and for a captcha name", () => {
    expect(sigLooksSensitive(sig({ idStable: "otp" }))).toBe(true);
    expect(sigLooksSensitive(sig({ name: "g-recaptcha-response" }))).toBe(true);
  });

  it("is false for email, zip code and pinnacle", () => {
    expect(sigLooksSensitive(sig({ type: "email", name: "email" }))).toBe(
      false,
    );
    expect(sigLooksSensitive(sig({ labelText: "zip code" }))).toBe(false);
    expect(sigLooksSensitive(sig({ name: "pinnacle" }))).toBe(false);
  });

  it.each([
    sig({ name: "cvv" }),
    sig({ name: "x_card_code" }),
    sig({ labelText: "Security code" }),
    sig({ autocomplete: "cc-csc" }),
    sig({ autocomplete: "section-pay cc-csc" }),
    sig({ name: "card_pin" }),
    sig({ labelText: "Seed phrase" }),
    sig({ name: "seed_phrase" }),
    sig({ labelText: "Recovery phrase" }),
    sig({ autocomplete: "one-time-code" }),
    sig({ name: "password" }),
    sig({ autocomplete: "new-password" }),
  ])("is true for the secret %j", (s) => {
    expect(sigLooksSensitive(s)).toBe(true);
  });

  it.each([
    sig({ name: "card_number" }),
    sig({ name: "cardNumber" }),
    sig({ name: "ssn" }),
    sig({ labelText: "Card number" }),
    sig({ labelText: "Social Security Number" }),
    sig({ autocomplete: "cc-number" }),
    sig({ autocomplete: "cc-exp" }),
    sig({ autocomplete: "cc-name" }),
    sig({ name: "cc_num", autocomplete: "cc-number" }),
  ])("is false for the capturable card or SSN field %j", (s) => {
    expect(sigLooksSensitive(s)).toBe(false);
  });
});
