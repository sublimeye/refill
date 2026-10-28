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
});
