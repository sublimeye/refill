# ADR 0020: Eligibility and sensitive-field rules (word semantics, bounded walks, fail closed)

## Context
Spec 5.2 (eligibility) and 5.3 (never-capture list) run in the content script against hostile page content, for both record and fill. Two failure modes matter: a sensitive field captured or filled (leak), and an ordinary field refused (silent usability loss). The brief's keyword list (`pass(word)?`, `pin`, `token`, ...) needs concrete matching semantics, and the eligibility checks need budgets.

## Decision
- Both modules (`src/lib/fields/eligibility.ts`, `sensitive.ts`) are DOM-only with zero runtime dependencies. Neither throws: `isEligible` returns false and `isSensitive` returns true on any exception (a page-replaced getter, a cross-origin error).
- Eligibility is cheap and ordered: kind, connected, top window, `:disabled` (also true under a disabled `fieldset`), readonly, an `[inert]` / `[aria-hidden="true"]` walk over the element and its ancestors (crossing shadow hosts), then one `checkVisibility`, one `getBoundingClientRect`, the document-area test, and `elementFromPoint` only when the box intersects the viewport. The ancestor walk is capped at 512 levels; a deeper chain is ineligible.
- When the box is only partly in the viewport the hit test uses the center of the visible part (the real center may be off-screen, where `elementFromPoint` returns null). Inside a shadow tree the hit test asks the control's own `ShadowRoot`, because the document-level answer is retargeted to the host and cannot tell the control from a covering sibling.
- Node type checks use `localName` / `nodeType`, not `instanceof`, so a control from another realm is classified correctly.
- `isEligible(el, doc, isTopWindow)` takes the top-window predicate as a third parameter, defaulting to `win === win.top`. Vitest browser mode runs every test in an iframe, so tests stub it and exercise the real default with a nested iframe.
- Name/id/label matching: the string is capped at 256, camelCase boundaries are split, lowercased, and every non-alphanumeric run (`_`, `$`, `-`, `[`) becomes a space. Then:
  - whole-word match: `pass`, `pwd`, `pin`, `2fa`, `mfa`, `cvv`, `cvc`, `csc`, `ssn`, `seed`, `nonce`, and the phrases `verification code`, `security code`, `social security`, `recovery phrase`, `card number`. So `pin` does not hit `pinnacle` or `spinner`; `pass` does not hit `passenger`, `bypass`, `compass`; `seed` does not hit `seeded`.
  - `token` / `tokens` may end a word but not start one (`csrf_token`, `authenticity_token`, `__RequestVerificationToken`, `accesstoken` hit; `tokenized`, `tokenizer` do not). `otp` may start a word (`otp_code`, `otpcode`) but not appear inside one (`motp`).
  - separator-free substring for long unambiguous forms: `password`, `passwd`, `passcode`, `passphrase`, `mnemonic`, `viewstate`, `eventvalidation`, `csrf`, `xsrf`, `totp`, `cardnumber` (so `confirmpassword`, `__VIEWSTATE`, `csrfmiddlewaretoken` hit).
  - `captcha` as a substring of name, id, label or class.
  - Every pattern is an alternation of literals and bounded classes, linear on a 256-character input. The id is read raw, not from `Sig.idStable`, which is null for generated ids such as `password1234`.
- `autocomplete` is checked per token, so a section prefix (`section-pay cc-number`) does not hide a sensitive token.
- `-webkit-text-security` is read from the computed style; anything other than empty or `none` is sensitive.
- `PasswordHistory` observes the `type` attribute with `subtree`, `attributeFilter: ["type"]` and `attributeOldValue` (a flip to password and back before the callback runs is still seen), sweeps `input[type=password]` at `observe` time, drains `takeRecords()` on every `wasPassword` call so a toggle in the same task is not missed, and keeps membership in a `WeakSet`. `observe` accepts a `Document` or a `ShadowRoot` (a document observer does not see inside shadow trees). `disconnect()` stops observing and keeps what was seen.
- `looksLikeCardNumber` slices the value to 64 characters before stripping spaces and dashes, then requires 13 to 19 digits, Luhn, and a card hint (`card`, `credit`, `debit`, `ccnum`, or a standalone `cc` token in name, stable id, label or autocomplete) or an IIN prefix (4, 51-55, 2221-2720, 34, 37, 6011, 65).

## Consequences
- Over-matching is the safe direction and is accepted for the substring family (a field named `mypasswordhint` is never captured); ordinary words are protected by the whole-word rule. A field whose only cue is an unsplit lowercase compound such as `userpin` is not caught by the name rule (autocomplete, type and label still apply).
- A field parked at `left: 9999px` extends the scrollable width, so by the spec's own definition it is inside the document area and eligible. Spec 5.2 does not exclude it; revisit if a honeypot pattern shows up in the fixture corpus.
- A card number longer than 64 characters of padding is judged on its first 64 characters, which can only cause a drop (safe), never a capture.

## Status
Accepted.
