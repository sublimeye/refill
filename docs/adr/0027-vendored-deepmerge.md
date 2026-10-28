# ADR 0027: Replace the transitive `deepmerge` with a vendored, poisoning-safe copy

## Context
OSV-Scanner (CI gate, ADR 0005) started failing every build on GHSA-gcqx-w48m-w2h4: prototype
poisoning in `deepmerge` through 4.3.1, with no fixed version. Refill does not use `deepmerge`
itself; it arrives through `@wxt-dev/module-svelte` → `@sveltejs/vite-plugin-svelte`, which calls it
once at build time to merge its own config (`deepmerge(result, config, { arrayMerge })`). It never
sees untrusted input and nothing of it ships in the extension. Ignoring the advisory would weaken the
gate; waiting for upstream would block every PR.

## Decision
- `vendor/deepmerge/` is a small CommonJS package named `deepmerge` with the 4.x API
  (`deepmerge(target, source, options)` with `clone`, `arrayMerge`, `isMergeableObject`,
  `customMerge`; `deepmerge.all`). It never copies `__proto__`, `constructor` or `prototype` keys at
  any depth and, as upstream, never writes a key the target only inherits.
- `package.json` `pnpm.overrides` maps `deepmerge` to `link:./vendor/deepmerge`, so the lockfile has
  no npm `deepmerge` and OSV has nothing to match. The gate itself is unchanged.
- `tests/unit/vendor-deepmerge.test.ts` covers the API, the exact way vite-plugin-svelte calls it, and
  the poisoning payloads (`__proto__` at the top and nested, `constructor.prototype`, inherited keys).
- ESLint lints `vendor/**/*.cjs` as CommonJS; `svelte/no-inner-declarations` is off there because it
  crashes on CommonJS scopes.

## Consequences
- One more file we own. If a future vite-plugin-svelte uses more of the API, the build or its tests
  show it; the override and the vendored copy can be dropped once a fixed `deepmerge` is released.
- `pnpm install` must keep the override; removing it brings the advisory back and fails CI.

## Status
Accepted (2026-10-27).
