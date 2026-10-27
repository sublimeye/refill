# ADR 0016: Extension-page CSP `default-src 'none'`, modulepreload polyfill off, built-output network gate

## Context
The Plan 1 final review (issue #16, I-1 and I-2) found two gaps in the "no network" guarantee.

- The production CSP was `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'none'`. With no `default-src`, `img-src`, `style-src`, `font-src`, `media-src` and `frame-src` were unrestricted. `connect-src 'none'` blocks `fetch`, XHR, WebSocket, EventSource and `sendBeacon`, but a compromised dependency in a page (the onboarding bundle ships 1.66 MB of zxcvbn-ts; supply chain is an in-scope adversary) could still exfiltrate with `new Image().src = "https://...?" + data` or a CSS `url()`. Pages hold the passphrase in flight and can read the session DEK mirror. Semgrep scans `src/` only, so no CI gate saw this.
- The shipped `chunks/protocol-*.js` carried Vite's modulepreload polyfill, which contains a live `fetch(` call. It is dead in Chromium (it returns early when `modulepreload` is supported, and `minimum_chrome_version` is 127), but it showed that the "no network APIs" rule was enforced on source only, with CSP as the sole backstop for bundled code.

## Decision
- **CSP.** Production `extension_pages` is
  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self'; font-src 'self'; object-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'`.
  Own assets stay allowed (`'self'`); everything else is denied by default, including media, frames, workers and manifests. No `'unsafe-inline'` is needed: Svelte 5 compiles `<style>` to CSS files and sets `style:` directives through CSSOM. `base-uri` and `form-action` do not fall back to `default-src`, so they are listed. The dev CSP is unchanged (no `default-src`, no `connect-src 'none'`) because the dev server needs HMR.
- **Verification.** Every e2e test now fails if a page logs a CSP violation (console message or `securitypolicyviolation` event, `tests/e2e/fixtures.ts`), and `smoke.spec.ts` loads onboarding and popup and proves a cross-origin image is refused (positive control for the watcher and for the policy). The existing create/lock/unlock flows exercise the Argon2 WASM, zxcvbn and Svelte styles under the new policy. `security/manifest.expected.json` is updated by hand and enforced by the manifest snapshot test.
- **Polyfill.** `wxt.config.ts` sets `vite: () => ({ build: { modulePreload: { polyfill: false } } })`. Chrome 127+ supports `modulepreload` natively.
- **Built-output gate.** `scripts/check-built-network.mjs <dir>` scans every `.js/.mjs/.cjs` under the build output for `fetch(`, `XMLHttpRequest`, `WebSocket(`, `EventSource(` and `sendBeacon`, and exits 1 on any hit (2 on bad usage or no JS files). CI runs it as `pnpm check:built-network` right after the reproducible-build step. `tests/unit/check-built-network.test.ts` is its self-test (a temp dir with a fake `fetch(` file exits 1, each token is caught, a clean tree passes). There is no allowlist: with the polyfill off, the built output of Plan 1 (including hash-wasm's WASM loader and zxcvbn-ts) has zero hits, so no vendored-library false positive had to be accepted. If one appears later it must be reviewed and documented here before any exclusion is added. `importScripts(` was suggested in the review but is not a network call by itself, and CSP `script-src 'self'` limits it to same-origin files, so it is not in the list.

## Consequences
- A compromised page dependency can no longer reach another origin through images, fonts, styles, frames or media, only (as before) through navigation-class tricks that need a user-visible page change; the policy is a backstop, not a substitute for the Semgrep and bundle gates.
- Any later feature that needs more (an `img-src data:` icon, inline styles, web workers via `worker-src`) must widen the CSP deliberately, with a snapshot change and an ADR update. Plan 2 content scripts are not governed by the extension-page CSP.
- The bundle gate is string-based: a dependency that builds the token at runtime (`self["fe"+"tch"]`) evades it, as with the Semgrep aliasing limit (ADR 0006). CSP `connect-src 'none'` remains the runtime backstop for that.
- Spec §3, the Plan 1 Global Constraints, PRIVACY.md and the threat model carry the new policy and gate.

## Status
Accepted.
