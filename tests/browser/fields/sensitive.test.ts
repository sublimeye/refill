import { afterEach, describe, expect, it } from "vitest";
import {
  PasswordHistory,
  isSensitive,
  looksLikeCardNumber,
} from "../../../src/lib/fields/sensitive";
import {
  buildSignature,
  type FormControl,
  type Sig,
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
    "cc-number",
    "cc-exp",
    "cc-csc",
    "cc-name",
    "section-pay cc-number",
    "billing CC-NUMBER",
  ])("autocomplete=%s", (ac) => {
    expect(sensitive(`<input name="x" autocomplete="${ac}">`)).toBe(true);
  });

  it.each(["email", "username", "given-name", "street-address", "off", "on"])(
    "autocomplete=%s is fine",
    (ac) => {
      expect(sensitive(`<input name="x" autocomplete="${ac}">`)).toBe(false);
    },
  );
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
    ["name", "ssn"],
    ["name", "social_security_number"],
    ["name", "card_number"],
    ["name", "cardNumber"],
    ["name", "cardnumber"],
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
      "Social Security Number",
      "Card number",
      "Recovery phrase",
      "Enter token",
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

function sigFor(over: Partial<Sig> = {}): Sig {
  return {
    name: null,
    idStable: null,
    autocomplete: null,
    type: "text",
    labelText: null,
    ordinal: 0,
    formAction: null,
    nameIdDerived: false,
    ...over,
  };
}

describe("looksLikeCardNumber", () => {
  const visa = "4111111111111111";

  it("Luhn-valid with a card IIN and no hint", () => {
    expect(looksLikeCardNumber(visa, sigFor())).toBe(true);
  });

  it("spaces and dashes are stripped", () => {
    expect(looksLikeCardNumber("4111 1111 1111 1111", sigFor())).toBe(true);
    expect(looksLikeCardNumber("4111-1111-1111-1111", sigFor())).toBe(true);
  });

  it("Luhn-invalid is not a card number, even with a hint", () => {
    expect(
      looksLikeCardNumber("4111111111111112", sigFor({ name: "card" })),
    ).toBe(false);
  });

  it("wrong length is not a card number", () => {
    expect(looksLikeCardNumber("411111111111", sigFor({ name: "card" }))).toBe(
      false,
    ); // 12
    expect(looksLikeCardNumber("4".repeat(20), sigFor({ name: "card" }))).toBe(
      false,
    );
  });

  it("13 and 19 digit numbers", () => {
    expect(looksLikeCardNumber("4222222222222", sigFor())).toBe(true); // 13, Visa
    expect(looksLikeCardNumber("6759649826438453", sigFor())).toBe(false); // Maestro: no IIN rule, no hint
    expect(
      looksLikeCardNumber(
        "6759649826438453",
        sigFor({ labelText: "card number" }),
      ),
    ).toBe(true);
  });

  it.each([
    ["4111111111111111", "Visa 4"],
    ["5105105105105100", "Mastercard 51"],
    ["5555555555554444", "Mastercard 55"],
    ["2221000000000009", "Mastercard 2221"],
    ["2720990000000007", "Mastercard 2720"],
    ["378282246310005", "Amex 37"],
    ["340000000000009", "Amex 34"],
    ["6011111111111117", "Discover 6011"],
    ["6500000000000002", "Discover 65"],
  ])("IIN prefix without hint: %s (%s)", (num) => {
    expect(looksLikeCardNumber(num, sigFor())).toBe(true);
  });

  it.each([
    ["2220999999999995", "2220 is below 2221"],
    ["2721000000000003", "2721 is above 2720"],
    ["5000000000000009", "50 is not 51-55"],
    ["5600000000000000", "56 is not 51-55"],
    ["3600000000000008", "36 is not 34/37"],
    ["6000000000000000", "6000 is not 6011"],
  ])("non-card prefix %s without hint is not flagged (%s)", (num) => {
    // keep only Luhn-valid ones: fix up the check digit so only the prefix rule can say no
    const body = num.slice(0, -1);
    let check = 0;
    for (let c = 0; c < 10; c++) {
      if (luhnValid(body + c)) check = c;
    }
    expect(looksLikeCardNumber(body + check, sigFor())).toBe(false);
  });

  it("a card hint in the signature is enough without an IIN prefix", () => {
    const num = "9111111111111111".slice(0, 15);
    let n = num + "0";
    for (let c = 0; c < 10; c++) if (luhnValid(num + c)) n = num + c;
    expect(looksLikeCardNumber(n, sigFor())).toBe(false);
    for (const sig of [
      sigFor({ name: "cardNumber" }),
      sigFor({ idStable: "credit-card" }),
      sigFor({ labelText: "debit card" }),
      sigFor({ autocomplete: "cc-number" }),
      sigFor({ name: "cc_num" }),
    ]) {
      expect(looksLikeCardNumber(n, sig), JSON.stringify(sig)).toBe(true);
    }
  });

  it("a hint word inside an unrelated word does not count as 'cc'", () => {
    const num = "9111111111111111".slice(0, 15);
    let n = num + "0";
    for (let c = 0; c < 10; c++) if (luhnValid(num + c)) n = num + c;
    expect(looksLikeCardNumber(n, sigFor({ name: "accounting" }))).toBe(false);
  });

  it("non-numeric junk and empty values", () => {
    expect(looksLikeCardNumber("", sigFor({ name: "card" }))).toBe(false);
    expect(looksLikeCardNumber("4111 1111 1111 111a", sigFor())).toBe(false);
    expect(looksLikeCardNumber("abcd", sigFor())).toBe(false);
  });

  it("a long value is capped before stripping (bounded work)", () => {
    const huge = "4111111111111111" + " ".repeat(5_000_000) + "9";
    const start = performance.now();
    looksLikeCardNumber(huge, sigFor());
    expect(performance.now() - start).toBeLessThan(200);
    // Digits past the 64-character cap are not part of the value that is checked.
    expect(looksLikeCardNumber("4".repeat(100), sigFor())).toBe(false);
  });
});

function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}
