# ADR 0019: Vitest browser mode (Playwright provider) for DOM tests; `idStable` generated-id rule

## Context
Field signatures (spec 5.1) and, later, the eligibility check, matcher and fill engine read real DOM: `label[for]`, `closest("label")`, `aria-labelledby`, `checkVisibility`, `elementFromPoint`, and React/Vue controlled-input behavior. jsdom/happy-dom do not implement layout, visibility or focus faithfully, so tests of that code in Node would assert against a fake. The e2e suite (Playwright with the built extension) is too slow and coarse for per-rule cases.

## Decision
- Vitest 5.0.5 browser mode with the official Playwright provider: `@vitest/browser-playwright` 5.0.5 and `@vitest/browser` 5.0.5, both pinned exactly. Real Chromium (the same Playwright 1.64.1 download CI already installs), headless.
- A separate config, `vitest.browser.config.ts`, includes only `tests/browser/**/*.test.ts`; script `pnpm test:browser`. `vitest.config.ts` still includes only `tests/unit/**`, so `pnpm test` stays Node-only and never needs a browser.
- CI: the "Install Playwright Chromium" step moves before the unit/browser test steps, and `verify` gains a `test:browser` step with `timeout-minutes: 5`.
- `react` 19.3.1, `react-dom` 19.3.1 and `vue` 3.5.44 (latest stable, exact) are added as devDependencies now. They are used from Task 10 to test fills into framework-controlled inputs. They are test-only: nothing under `src/` imports them. Check recorded for Task 10 onward: after `pnpm build`, `grep -rlw -e react -e react-dom -e vue .output/chrome-mv3` must find nothing, and a search for framework internals (`ReactCurrentDispatcher`, `__VUE_OPTIONS_API__`, `createVNode`) must find nothing. Verified at this commit (no imports yet): clean.
- `src/lib/fields/signature.ts` is DOM-only with zero runtime dependencies (it runs in the content script).
- `idStable` hash rule, refined from "a run of >= 12 chars from `[A-Za-z0-9_-]` with letters and digits" to: a token is a maximal `[A-Za-z0-9]` run (`-` and `_` separate words); a token of >= 12 chars with letters and digits mixed is hash-like, ignoring up to 3 trailing digits for the mix test. The literal rule marked `billing_address_line1` (21 chars, letters plus `1`) and `ctl00_Main_Acct` as generated, which would drop good evidence on most real forms. The other rules are unchanged: empty; a run of >= 4 digits; React `:r1:` / `«r1»`; sequential `/^[a-z][\w-]*[-_]\d+$/i`. Consequence of the sequential rule: `shipping-address-line-2` and `emergency_contact_phone_1` are also unstable (as the spec lists `<prefix>-<n>`); `address-line2`, `phone2`, `billingAddressLine1` are stable.
- `labelText` skips nested form controls, `script` and `style` when reading a wrapping label, normalizes (lowercase, collapse whitespace, trim, strip trailing `*`/`:` repeatedly), then truncates to 256.

## Consequences
- Browser tests run Chromium once more in `verify` (a few seconds for the signature suite); the 5-minute step cap bounds a stall.
- Two Vitest configs to keep in step on shared settings (currently none shared).
- A random id that is short, or whose digits are only a 1-3 digit suffix on a 12+ letter run, is kept as stable. It then simply fails to match on the next load; the other evidence (name, label, autocomplete) still decides.
- Test fixtures use `innerHTML`; the Semgrep ban applies to `src/` only (rules are path-scoped), and test files are the one place it is acceptable.

## Status
Accepted.
