import { afterEach, describe, expect, it } from "vitest";
import {
  PasswordHistory,
  isSensitive,
} from "../../../src/lib/fields/sensitive";
import {
  buildSignature,
  type FormControl,
} from "../../../src/lib/fields/signature";

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html; // test-only fixture markup
  document.body.append(root);
  return root;
}

function control(root: ParentNode, selector = "input"): FormControl {
  const el = root.querySelector<FormControl>(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el;
}

const histories: PasswordHistory[] = [];
function history(): PasswordHistory {
  const h = new PasswordHistory();
  histories.push(h);
  return h;
}

function sensitive(html: string, h = history()): boolean {
  const el = control(mount(html));
  return isSensitive(el, buildSignature(el, 0, null), h);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  for (const h of histories.splice(0)) h.disconnect();
  document.body.replaceChildren();
});

describe("isSensitive: type", () => {
  it.each(["password", "hidden", "file"])("type=%s", (type) => {
    expect(sensitive(`<input type="${type}" name="x">`)).toBe(true);
  });

  it("type is matched case-insensitively", () => {
    expect(sensitive(`<input type="PASSWORD" name="x">`)).toBe(true);
  });

  it.each(["text", "email", "tel", "number", "date", "search", "url"])(
    "plain type=%s is not sensitive",
    (type) => {
      expect(sensitive(`<input type="${type}" name="city">`)).toBe(false);
    },
  );

  it("a plain textarea and select are not sensitive", () => {
    const r = mount(
      `<textarea name="notes"></textarea><select name="state"></select>`,
    );
    const h = history();
    for (const sel of ["textarea", "select"]) {
      const el = control(r, sel);
      expect(isSensitive(el, buildSignature(el, 0, null), h)).toBe(false);
    }
  });
});

describe("isSensitive: -webkit-text-security", () => {
  it("masked text field", () => {
    expect(
      sensitive(
        `<input type="text" name="x" style="-webkit-text-security:disc">`,
      ),
    ).toBe(true);
  });

  it("-webkit-text-security: none is fine", () => {
    expect(
      sensitive(
        `<input type="text" name="x" style="-webkit-text-security:none">`,
      ),
    ).toBe(false);
  });
});

describe("isSensitive: autocomplete", () => {
  it.each([
    "current-password",
    "new-password",
    "one-time-code",
    "cc-csc",
    "section-pay cc-csc",
    "billing CC-CSC",
  ])("autocomplete=%s", (ac) => {
    expect(sensitive(`<input name="x" autocomplete="${ac}">`)).toBe(true);
  });

  it.each([
    "email",
    "username",
    "given-name",
    "street-address",
    "off",
    "on",
    // card number, expiry and name are capturable; only the security code is a secret
    "cc-number",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year",
    "cc-name",
    "cc-type",
    "section-pay cc-number",
    "billing CC-NUMBER",
  ])("autocomplete=%s is fine", (ac) => {
    expect(sensitive(`<input name="x" autocomplete="${ac}">`)).toBe(false);
  });
});

describe("isSensitive: name / id / label words", () => {
  const hits: Array<[string, string]> = [
    ["name", "password"],
    ["name", "user_pass"],
    ["name", "pass"],
    ["name", "passwd"],
    ["name", "confirmpassword"],
    ["name", "confirmPassword"],
    ["name", "pwd"],
    ["name", "login[pwd]"],
    ["name", "pin"],
    ["name", "card_pin"],
    ["name", "otp"],
    ["name", "otp_code"],
    ["name", "2fa"],
    ["name", "mfa-code"],
    ["name", "totp"],
    ["name", "totp_secret"],
    ["name", "verification_code"],
    ["name", "verificationCode"],
    ["name", "cvv"],
    ["name", "CVV2"],
    ["name", "cvc"],
    ["name", "csc"],
    ["name", "security_code"],
    ["name", "cc_code"],
    ["name", "seed_phrase"],
    ["name", "seed"],
    ["name", "mnemonic"],
    ["name", "recovery_phrase"],
    ["name", "__VIEWSTATE"],
    ["name", "__EVENTVALIDATION"],
    ["name", "__VIEWSTATEGENERATOR"],
    ["name", "csrf_token"],
    ["name", "csrfmiddlewaretoken"],
    ["name", "_csrf"],
    ["name", "xsrf-token"],
    ["name", "authenticity_token"],
    ["name", "__RequestVerificationToken"],
    ["name", "access_token"],
    ["name", "accesstoken"],
    ["name", "token"],
    ["name", "nonce"],
    ["name", "ctl00$Main$txtPassword"],
    // leading acronyms split from the next word
    ["name", "PINCode"],
    ["name", "MFACode"],
    ["name", "txtCVVCode"],
    ["name", "PINNumber"],
    ["name", "pin_code"],
    ["name", "pinCode"],
    // one-time and card verification codes
    ["name", "code"],
    ["name", "Code"],
    ["name", "otc"],
    ["name", "smsCode"],
    ["name", "sms_code"],
    ["name", "verifyCode"],
    ["name", "verify_code"],
    ["name", "verificationCode"],
    ["name", "oneTimeCode"],
    ["name", "one_time_code"],
    ["name", "onetimecode"],
    ["name", "authCode"],
    ["name", "auth_code"],
    ["name", "authenticator_code"],
    ["name", "twoFactorCode"],
    ["name", "two_factor_code"],
    ["name", "twofa"],
    ["name", "login_code"],
    ["name", "security_code"],
    ["name", "access_code"],
    ["name", "confirmation_code"],
    ["name", "text_code"],
    ["name", "cardCode"],
    ["name", "card_code"],
    ["name", "x_card_code"], // Authorize.net CVV
    ["name", "CVVCode"],
    ["id", "password"],
    ["id", "user-pwd-field"],
    ["id", "otp1234"],
  ];
  it.each(hits)("%s=%s is sensitive", (attr, value) => {
    expect(sensitive(`<input ${attr}="${value}">`)).toBe(true);
  });

  const misses: Array<[string, string]> = [
    ["name", "account_number"],
    ["name", "zip"],
    ["name", "pinnacle"],
    ["name", "spinner"],
    ["name", "passenger_name"],
    ["name", "passport"],
    ["name", "bypass"],
    ["name", "compass"],
    ["name", "tokenized"],
    ["name", "tokenizer"],
    ["name", "seeded"],
    ["name", "address"],
    ["name", "first_name"],
    ["name", "email"],
    ["name", "phone"],
    ["name", "amount"],
    ["name", "invoice_number"],
    ["id", "shipping-city"],
    ["id", "motp"],
    // other codes stay capturable
    ["name", "zip_code"],
    ["name", "zipCode"],
    ["name", "postal_code"],
    ["name", "promo_code"],
    ["name", "promoCode"],
    ["name", "coupon_code"],
    ["name", "area_code"],
    ["name", "country_code"],
    ["name", "discount_code"],
    ["name", "referral_code"],
    ["name", "barcode"],
    ["name", "code_of_conduct_notes"],
    ["name", "confirm_code"],
    ["name", "pincode"], // unsplit Indian postal code
    ["name", "accnum"],
    ["name", "PINNACLEFund"],
    ["name", "AccountNumber"],
    ["name", "ctl00$cphMain$txtAccountNumber"],
    // card numbers and SSNs are capturable now (spec 5.3, 2026-10-27)
    ["name", "ssn"],
    ["name", "social_security_number"],
    ["name", "card_number"],
    ["name", "cardNumber"],
    ["name", "cardnumber"],
    ["name", "SSNLast4"],
    ["name", "CCNumber"],
    ["name", "ccnum"],
    ["name", "cc_number"],
    ["name", "txtCCNum"],
    ["name", "card_no"],
    ["name", "cardNo"],
    ["name", "card_expiry"],
    ["name", "cardholder_name"],
    ["id", "cc-number"],
  ];
  it.each(misses)("%s=%s is not sensitive", (attr, value) => {
    expect(sensitive(`<input ${attr}="${value}">`)).toBe(false);
  });

  it("label text: password, pin, verification code, card number", () => {
    for (const label of [
      "Password",
      "Confirm password:",
      "PIN",
      "Your PIN *",
      "Verification code",
      "Security Code",
      "Recovery phrase",
      "Seed phrase",
      "CVV",
      "Card code",
      "Enter token",
      "6-digit code",
      "Enter the 6 digit code",
      "Code we sent you",
      "SMS code",
      "Authentication code",
      "Verify code",
      "Code",
      "PIN code",
      "Enter code",
      "Enter your code",
      "Enter the code",
      "We sent a code to your phone",
      "Verification code",
    ]) {
      expect(sensitive(`<label>${label} <input name="f"></label>`), label).toBe(
        true,
      );
    }
  });

  it("label text that merely contains similar letters is fine", () => {
    for (const label of [
      "Passenger name",
      "Pinnacle account",
      "Zip code",
      "Account number",
      "Tokenized value",
      "ZIP code",
      "Postal code",
      "Promo code",
      "Coupon code",
      "Area code",
      "Country code",
      "Discount code",
      "Referral code",
      "5-digit ZIP code",
      "Routing number",
      "Enter promo code",
      "Enter your promo code",
      "Enter your zip code",
      "Enter coupon code",
      "ZIP code",
      "Postal code",
      "Promo code",
      "Coupon code",
      "Area code",
      "Country code",
      "Discount code",
      "Referral code",
      "5-digit ZIP code",
      "Routing number",
      "Social Security Number",
      "SSN",
      "Card number",
      "Card no.",
      "Credit card number",
      "Expiry date",
      "Name on card",
    ]) {
      expect(sensitive(`<label>${label} <input name="f"></label>`), label).toBe(
        false,
      );
    }
  });

  it("placeholder-only label", () => {
    expect(sensitive(`<input name="f" placeholder="Enter your PIN">`)).toBe(
      true,
    );
  });

  it("a generated id that hides in Sig.idStable is still checked raw", () => {
    const r = mount(`<input id="password1234">`);
    const el = control(r);
    const sig = buildSignature(el, 0, null);
    expect(sig.idStable).toBeNull();
    expect(isSensitive(el, sig, history())).toBe(true);
  });

  it("a very long hostile name still classifies (capped, linear)", () => {
    const el = control(mount(`<input>`));
    el.setAttribute("name", "a".repeat(200_000) + "_token");
    const start = performance.now();
    // Token sits past the 256-char cap, so it is not seen; the point is bounded time.
    isSensitive(el, buildSignature(el, 0, null), history());
    expect(performance.now() - start).toBeLessThan(200);
    el.setAttribute("name", "token_" + "a".repeat(200_000));
    expect(isSensitive(el, buildSignature(el, 0, null), history())).toBe(true);
  });
});

describe("isSensitive: captcha", () => {
  it.each([
    `<input name="captcha">`,
    `<input id="reCaptchaResponse">`,
    `<input name="x" class="form-control g-recaptcha-response">`,
    `<label>Type the captcha <input name="x"></label>`,
    `<input name="x" class="CaptchaInput">`,
  ])("captcha-like: %s", (html) => {
    expect(sensitive(html)).toBe(true);
  });
});

describe("isSensitive: fail closed", () => {
  it("treats a control that throws as sensitive", () => {
    const el = control(mount(`<input name="city">`));
    const sig = buildSignature(el, 0, null);
    Object.defineProperty(el, "type", {
      get() {
        throw new Error("hostile");
      },
    });
    expect(isSensitive(el, sig, history())).toBe(true);
  });
});

describe("PasswordHistory.observeShadow", () => {
  function shadowWith(html: string): ShadowRoot {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = html; // test-only fixture markup
    return shadow;
  }

  it("adds a shadow root without dropping the document observation", async () => {
    const r = mount(`<input id="d" type="password">`);
    const shadow = shadowWith(`<input id="s" type="password">`);
    const h = history();
    h.observe(document);
    h.observeShadow(shadow);
    (r.querySelector("#d") as HTMLInputElement).type = "text";
    (shadow.querySelector("#s") as HTMLInputElement).type = "text";
    await tick();
    expect(h.wasPassword(control(r, "#d"))).toBe(true);
    expect(h.wasPassword(shadow.querySelector("#s") as HTMLInputElement)).toBe(
      true,
    );
  });

  it("works without a prior observe and is idempotent per root", async () => {
    const shadow = shadowWith(`<input id="s" type="password">`);
    const h = history();
    h.observeShadow(shadow);
    h.observeShadow(shadow);
    const el = shadow.querySelector("#s") as HTMLInputElement;
    el.type = "text";
    await tick();
    expect(h.wasPassword(el)).toBe(true);
  });

  it("disconnect forgets watched roots so they can be observed again", async () => {
    const shadow = shadowWith(`<input id="s" type="text">`);
    const h = history();
    h.observeShadow(shadow);
    h.disconnect();
    h.observeShadow(shadow);
    const el = shadow.querySelector("#s") as HTMLInputElement;
    el.type = "password";
    el.type = "text";
    await tick();
    expect(h.wasPassword(el)).toBe(true);
  });
});

describe("PasswordHistory", () => {
  it("a field that is password at observe time stays sensitive after a toggle to text", async () => {
    const r = mount(`<input type="password" name="user_field">`);
    const el = control(r);
    const h = history();
    h.observe(document);
    el.setAttribute("type", "text"); // show-password toggle
    await tick();
    expect(el.type).toBe("text");
    expect(h.wasPassword(el)).toBe(true);
    expect(isSensitive(el, buildSignature(el, 0, null), h)).toBe(true);
  });

  it("a text field that later becomes password, then text again", async () => {
    const r = mount(`<input type="text" name="user_field">`);
    const el = control(r);
    const h = history();
    h.observe(document);
    expect(h.wasPassword(el)).toBe(false);
    expect(isSensitive(el, buildSignature(el, 0, null), h)).toBe(false);
    el.setAttribute("type", "password");
    await tick();
    el.setAttribute("type", "text");
    await tick();
    expect(isSensitive(el, buildSignature(el, 0, null), h)).toBe(true);
  });

  it("a flip to password and back in one task is still seen", () => {
    const r = mount(`<input type="text" name="user_field">`);
    const el = control(r);
    const h = history();
    h.observe(document);
    el.setAttribute("type", "password");
    el.setAttribute("type", "text");
    expect(h.wasPassword(el)).toBe(true);
  });

  it("a toggle in the same task as the check (no tick) is seen", () => {
    const r = mount(`<input type="password" name="user_field">`);
    const el = control(r);
    const h = history();
    h.observe(document);
    el.setAttribute("type", "text");
    expect(h.wasPassword(el)).toBe(true);
  });

  it("an input inserted as password later, then toggled", async () => {
    const h = history();
    h.observe(document);
    const el = control(mount(`<input type="password" name="late">`));
    await tick();
    el.setAttribute("type", "text");
    await tick();
    expect(h.wasPassword(el)).toBe(true);
  });

  it("other controls are unaffected", async () => {
    const r = mount(
      `<input type="password" id="a" name="p"><input type="text" id="b" name="city">`,
    );
    const h = history();
    h.observe(document);
    expect(h.wasPassword(control(r, "#a"))).toBe(true);
    expect(h.wasPassword(control(r, "#b"))).toBe(false);
    control(r, "#a").setAttribute("type", "text");
    await tick();
    expect(h.wasPassword(control(r, "#b"))).toBe(false);
  });

  it("works on controls without a prior observe call (current type only)", () => {
    const el = control(mount(`<input type="password">`));
    expect(new PasswordHistory().wasPassword(el)).toBe(true);
  });

  it("disconnect stops recording but keeps what was seen", async () => {
    const r = mount(`<input type="password" id="a"><input type="text" id="b">`);
    const h = history();
    h.observe(document);
    h.disconnect();
    control(r, "#b").setAttribute("type", "password");
    control(r, "#b").setAttribute("type", "text");
    await tick();
    expect(h.wasPassword(control(r, "#a"))).toBe(true);
    expect(h.wasPassword(control(r, "#b"))).toBe(false);
  });

  it("a shadow root can be observed too", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<input type="password">`; // test-only fixture markup
    const el = shadow.querySelector("input") as HTMLInputElement;
    const h = history();
    h.observe(shadow);
    el.setAttribute("type", "text");
    await tick();
    expect(h.wasPassword(el)).toBe(true);
  });
});
