// Sensitive-field classifier and card-number heuristic (spec 5.3). DOM-only, zero runtime
// dependencies: this runs in the content script. Page content is hostile, so every check is bounded
// and fails closed: anything that throws is treated as sensitive.

import { getAttr, nodeType } from "./dom";
import type { FormControl, Sig } from "./signature";

const FIELD_MAX = 256;
const CARD_VALUE_MAX = 64;

const OBSERVE_OPTIONS: MutationObserverInit = {
  subtree: true,
  attributes: true,
  attributeFilter: ["type"],
  attributeOldValue: true,
};

/**
 * Remembers every control that has ever been `type=password` in this document, so a show-password
 * toggle (password to text) cannot make the field capturable. A MutationObserver on the `type`
 * attribute (with the old value, so a flip that is undone before the observer callback runs is still
 * seen) plus an initial sweep; membership lives in a WeakSet, so removed controls are collectable.
 */
export class PasswordHistory {
  private readonly seen = new WeakSet<Element>();
  private observer: MutationObserver | null = null;
  private shadows = new WeakSet<ShadowRoot>();

  observe(root: Document | ShadowRoot): void {
    this.disconnect();
    for (const el of root.querySelectorAll('input[type="password" i]')) {
      this.seen.add(el);
    }
    this.observer = new MutationObserver((records) => {
      this.record(records);
    });
    this.observer.observe(root, OBSERVE_OPTIONS);
  }

  /**
   * Also watch a shadow root (a document observer does not see inside shadow trees), without
   * dropping what `observe` already watches; the document scanner calls this for every shadow root
   * it enters. A no-op for a root already watched. Without a prior `observe` it starts its own
   * observer, so the shadow root alone is covered. Only toggles from this point on are recorded: a
   * control that was a password and is text by now is judged by its current type alone.
   */
  observeShadow(root: ShadowRoot): void {
    if (this.shadows.has(root)) return;
    this.shadows.add(root);
    for (const el of root.querySelectorAll('input[type="password" i]')) {
      this.seen.add(el);
    }
    this.observer ??= new MutationObserver((records) => {
      this.record(records);
    });
    this.observer.observe(root, OBSERVE_OPTIONS);
  }

  /** True if `el` is, or at any point since `observe` was, `type=password`. */
  wasPassword(el: Element): boolean {
    // Flush records the observer has not delivered yet, so a toggle in the same task is not missed.
    if (this.observer !== null) this.record(this.observer.takeRecords());
    if (this.seen.has(el)) return true;
    if (isPasswordType(getAttr(el, "type"))) {
      this.seen.add(el);
      return true;
    }
    return false;
  }

  disconnect(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.shadows = new WeakSet();
  }

  private record(records: MutationRecord[]): void {
    for (const r of records) {
      if (
        isPasswordType(r.oldValue) ||
        (nodeType(r.target) === Node.ELEMENT_NODE &&
          isPasswordType(getAttr(r.target as Element, "type")))
      ) {
        this.seen.add(r.target as Element);
      }
    }
  }
}

function isPasswordType(value: string | null): boolean {
  return value !== null && value.trim().toLowerCase() === "password";
}

const AUTOCOMPLETE_SENSITIVE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
]);

// Word semantics: the haystack has camelCase and leading-acronym boundaries split (`cardNumber`,
// `PINCode` -> `PIN Code`, `txtCVVCode`), is lowercased, and every non-alphanumeric run (including
// `_`, `$`, `-`, `[`) becomes one space, so `\b` means "word edge" in `csrf_token`,
// `authenticity_token` and `__RequestVerificationToken`.
//   - Short or ambiguous tokens must be whole words: `pin` hits "pin" / "pin code" but not "pinnacle",
//     "spinner" (nor the unsplit Indian postal `pincode`); `pass` hits "pass" but not "passenger",
//     "bypass", "compass"; `seed` not "seeded".
//   - `token` / `tokens` may be the end of a word (`accesstoken`) but not the start of one, so
//     "tokenized" does not hit. `otp` may start a word (`otpcode`).
//   - `code` is sensitive only after an allow-listed qualifier (an OTP or CVV code), as the bare name
//     `code` / `otc`, or in the labels "6-digit code" / "code we sent" / "we sent a code" / "enter (your) code". `zip`, `postal`, `promo`,
//     `coupon`, `area`, `country`, `discount`, `referral` codes stay capturable. `confirmation code`
//     is included: it is the emailed sign-up code; `confirm code` is not (ambiguous).
// All patterns are alternations of literals and bounded classes: linear on a <= 256 char input.
const CODE_QUALIFIER =
  "sms|text|verify|verification|auth|authentication|authenticator|one ?time|onetime|otc|2fa|twofa|two ?factor|mfa|login|security|card|cc|access|confirmation";
const WORD_RE = new RegExp(
  "\\b(?:pass|pwd|pin|2fa|twofa|mfa|cvv2?|cvc2?|csc|ssn|seed|nonce)\\b" +
    "|\\botp|tokens?\\b" +
    "|\\b(?:social security|recovery phrase|card ?(?:number|num|no)|cc ?num(?:ber)?)\\b" +
    `|\\b(?:${CODE_QUALIFIER}) ?code\\b` +
    "|\\b\\d ?digits? code\\b|\\bcode (?:we )?sent\\b|\\b(?:we )?sent (?:you )?a code\\b|\\benter (?:your |the )?code\\b",
);
const BARE_CODE_RE = /^(?:code|otc)$/;
// Unambiguous long forms are also matched in the separator-free form, so `confirmpassword`,
// `__VIEWSTATE` and `cardnumber` hit.
const COMPACT_RE =
  /password|passwd|passcode|passphrase|mnemonic|viewstate|eventvalidation|csrf|xsrf|totp|cardnumber/;

function wordForm(raw: string): string {
  return raw
    .slice(0, FIELD_MAX)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function nameMatchesSensitive(raw: string | null): boolean {
  if (raw === null || raw === "") return false;
  const words = wordForm(raw);
  return (
    WORD_RE.test(words) ||
    BARE_CODE_RE.test(words) ||
    COMPACT_RE.test(words.replaceAll(" ", ""))
  );
}

function captchaLike(raw: string | null): boolean {
  return (
    raw !== null && raw.slice(0, FIELD_MAX).toLowerCase().includes("captcha")
  );
}

function sensitiveAutocomplete(raw: string | null): boolean {
  if (raw === null) return false;
  return raw
    .slice(0, FIELD_MAX)
    .toLowerCase()
    .split(/\s+/)
    .some((t) => AUTOCOMPLETE_SENSITIVE.has(t) || t.startsWith("cc-"));
}

/**
 * Spec 5.3 never-capture rules for a control. Never throws: any failure reads as sensitive.
 * `sig` supplies the already-normalized label and autocomplete; name and id are read raw (and capped)
 * because `Sig.idStable` is null for generated ids such as `password1234`.
 */
export function isSensitive(
  el: FormControl,
  sig: Sig,
  history: PasswordHistory,
): boolean {
  try {
    const type = el.type.toLowerCase();
    if (type === "password" || type === "hidden" || type === "file") {
      return true;
    }
    if (
      sig.type === "password" ||
      sig.type === "hidden" ||
      sig.type === "file"
    ) {
      return true;
    }
    if (history.wasPassword(el)) return true;
    const textSecurity = getComputedStyle(el)
      .getPropertyValue("-webkit-text-security")
      .trim();
    if (textSecurity !== "" && textSecurity !== "none") return true;
    if (sensitiveAutocomplete(sig.autocomplete)) return true;
    if (sensitiveAutocomplete(el.getAttribute("autocomplete"))) return true;
    const name = el.getAttribute("name");
    const id = el.id;
    const cls = el.getAttribute("class");
    if (
      captchaLike(name) ||
      captchaLike(id) ||
      captchaLike(sig.labelText) ||
      captchaLike(cls)
    ) {
      return true;
    }
    return (
      nameMatchesSensitive(name) ||
      nameMatchesSensitive(id) ||
      nameMatchesSensitive(sig.labelText)
    );
  } catch {
    return true;
  }
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function cardIin(digits: string): boolean {
  if (digits.startsWith("4")) return true;
  const two = Number(digits.slice(0, 2));
  if ((two >= 51 && two <= 55) || two === 34 || two === 37 || two === 65) {
    return true;
  }
  if (digits.startsWith("6011")) return true;
  const four = Number(digits.slice(0, 4));
  return four >= 2221 && four <= 2720;
}

const CARD_HINT_RE = /card|credit|debit|ccnum|(?:^|[^a-z])cc(?:[^a-z]|$)/;

function cardHint(sig: Sig): boolean {
  const haystack = [sig.name, sig.idStable, sig.labelText, sig.autocomplete]
    .filter((s): s is string => s !== null)
    .join(" ")
    .slice(0, FIELD_MAX * 4)
    .toLowerCase();
  return CARD_HINT_RE.test(haystack);
}

/**
 * Luhn-valid 13 to 19 digits (spaces and dashes stripped) AND (a card hint in the signature OR a card
 * IIN prefix: 4, 51-55, 2221-2720, 34, 37, 6011, 65). The value is capped at 64 characters before
 * stripping, so a hostile megabyte value costs nothing.
 */
export function looksLikeCardNumber(value: string, sig: Sig): boolean {
  const digits = value.slice(0, CARD_VALUE_MAX).replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  if (!luhn(digits)) return false;
  return cardHint(sig) || cardIin(digits);
}
