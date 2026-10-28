// Pure never-capture rules (spec 5.3, secrets only): string and signature predicates with no DOM
// access and no runtime imports, so the service worker can use them. The DOM-bound classifier (`isSensitive`,
// `PasswordHistory`) stays in ./sensitive. Page content is hostile, so every check is bounded.

import type { Sig } from "./signature";

const FIELD_MAX = 256;

const AUTOCOMPLETE_SENSITIVE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-csc",
]);

// Word semantics: the haystack has camelCase and leading-acronym boundaries split (`cardCode`,
// `PINCode` -> `PIN Code`, `txtCVVCode`), is lowercased, and every non-alphanumeric run (including
// `_`, `$`, `-`, `[`) becomes one space, so `\b` means "word edge" in `csrf_token`,
// `authenticity_token` and `__RequestVerificationToken`.
//   - Short or ambiguous tokens must be whole words: `pin` hits "pin" / "pin code" but not "pinnacle",
//     "spinner" (nor the unsplit Indian postal `pincode`); `pass` hits "pass" but not "passenger",
//     "bypass", "compass"; `seed` not "seeded".
//   - `token` / `tokens` may be the end of a word (`accesstoken`) but not the start of one, so
//     "tokenized" does not hit. `otp` may start a word (`otpcode`).
//   - `code` is sensitive only after an allow-listed qualifier (an OTP or CVV code), as the bare name
//     `code` / `otc`, or in the labels "6-digit code" / "code we sent" / "we sent a code" / "enter (your)
//     code". `card` and `cc` are in that qualifier list on purpose: `card code`, `cc code`, `x_card_code`
//     and `security code` are card security codes (CVV). `zip`, `postal`, `promo`, `coupon`, `area`,
//     `country`, `discount`, `referral` codes stay capturable. `confirmation code` is included: it is
//     the emailed sign-up code; `confirm code` is not (ambiguous).
//   - Card numbers and SSNs are NOT secrets here (spec 5.3 as amended 2026-10-27): `card number`,
//     `cc num`, `ssn`, `social security` and the `cc-number` / `cc-exp` / `cc-name` autocomplete tokens
//     are capturable. Only the card security code (`cc-csc`, CVV words) stays excluded.
// All patterns are alternations of literals and bounded classes: linear on a <= 256 char input.
const CODE_QUALIFIER =
  "sms|text|verify|verification|auth|authentication|authenticator|one ?time|onetime|otc|2fa|twofa|two ?factor|mfa|login|security|card|cc|access|confirmation";
const WORD_RE = new RegExp(
  "\\b(?:pass|pwd|pin|2fa|twofa|mfa|cvv2?|cvc2?|csc|seed|nonce)\\b" +
    "|\\botp|tokens?\\b" +
    "|\\brecovery phrase\\b" +
    `|\\b(?:${CODE_QUALIFIER}) ?code\\b` +
    "|\\b\\d ?digits? code\\b|\\bcode (?:we )?sent\\b|\\b(?:we )?sent (?:you )?a code\\b|\\benter (?:your |the )?code\\b",
);
const BARE_CODE_RE = /^(?:code|otc)$/;
// Unambiguous long forms are also matched in the separator-free form, so `confirmpassword`
// and `__VIEWSTATE` hit.
const COMPACT_RE =
  /password|passwd|passcode|passphrase|mnemonic|viewstate|eventvalidation|csrf|xsrf|totp/;

function wordForm(raw: string): string {
  return raw
    .slice(0, FIELD_MAX)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function nameMatchesSensitive(raw: string | null): boolean {
  if (raw === null || raw === "") return false;
  const words = wordForm(raw);
  return (
    WORD_RE.test(words) ||
    BARE_CODE_RE.test(words) ||
    COMPACT_RE.test(words.replaceAll(" ", ""))
  );
}

export function captchaLike(raw: string | null): boolean {
  return (
    raw !== null && raw.slice(0, FIELD_MAX).toLowerCase().includes("captcha")
  );
}

export function sensitiveAutocomplete(raw: string | null): boolean {
  if (raw === null) return false;
  return raw
    .slice(0, FIELD_MAX)
    .toLowerCase()
    .split(/\s+/)
    .some((t) => AUTOCOMPLETE_SENSITIVE.has(t));
}

/**
 * True when the signature alone marks the field as a secret: password, hidden or file type, a
 * sensitive autocomplete token, or a secret/captcha name, stable id or label.
 */
export function sigLooksSensitive(sig: Sig): boolean {
  const type = sig.type.toLowerCase();
  if (type === "password" || type === "hidden" || type === "file") return true;
  if (sensitiveAutocomplete(sig.autocomplete)) return true;
  for (const text of [sig.name, sig.idStable, sig.labelText]) {
    if (nameMatchesSensitive(text) || captchaLike(text)) return true;
  }
  return false;
}
