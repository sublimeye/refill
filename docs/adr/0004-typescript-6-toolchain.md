# ADR 0004: TypeScript pinned to 6.0.3, not 7.x

## Context
The scaffold installed "latest" for each dev dependency, which resolved `typescript` to 7.0.2 (the native port). `svelte-check` 4.7.7 refuses to run on TypeScript 7 without a second TypeScript 6 install plus an experimental `--tsgo` flag, and `typescript-eslint` 8.72.1 declares the peer range `>=4.8.4 <6.1.0`. `pnpm typecheck` (`svelte-check && tsc --noEmit`) and `pnpm lint` are required by the plan.

## Decision
- Pin `typescript` to exactly `6.0.3`, the newest 6.x, which satisfies both `svelte-check` and `typescript-eslint`.
- Add `@types/node` `22.x` (exact) so tests can use `node:fs` and `node:crypto`, and `@eslint/js` for the flat ESLint config.
- Add `src/env.d.ts` (`/// <reference types="svelte" />`) so `tsc` resolves `*.svelte` imports; Svelte components carry a `<script lang="ts">` block so `svelte-check` treats them as TypeScript modules.
- Import the Vitest plugin from `wxt/testing/vitest-plugin` (and `fakeBrowser` from `wxt/testing/fake-browser`): WXT 0.21.5 has no `wxt/testing` export.

## Consequences
- Moving to TypeScript 7 is a deliberate change, gated on `svelte-check` and `typescript-eslint` supporting it; revisit when they do.
- Versions stay exact (no `^`/`~`), per the plan's constraints.

## Status
Accepted (2026-10-26).
