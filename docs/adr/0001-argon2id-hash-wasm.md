# ADR 0001: Argon2id via hash-wasm 4.12.0

## Context
The vault key hierarchy (spec section 4.1) derives `KEK_pw` from the passphrase with Argon2id. WebCrypto has no Argon2, so a WASM implementation must be bundled; the extension CSP allows `wasm-unsafe-eval` only for this. The library must be small, widely used, vendored and pinned. Spec floor: m=64 MiB, t=3, p=1, with calibration at vault creation to roughly 0.5-1 s on the user's machine.

M0 spike (b) measured `hash-wasm` 4.12.0 (`dist/argon2.umd.min.js`, 29,467 bytes, sha256 `dcec617a2e1b700fa132d1583a186cb70611113395e869f2dd6cc82b415d3094`) on an Apple M1 Pro, m=65536 KiB, p=1, page context of an extension page, median of 3 runs: t=3 141-142 ms, t=4 179-185 ms, t=6 263-271 ms (ranges cover Chromium 156 and Brave 155). Cost is linear at about 43 ms per iteration. Details: `docs/spikes/m0-results.md`.

## Decision
- Use `hash-wasm` exactly `4.12.0` (no range), vendored and pinned, using only its Argon2 build (`argon2.umd.min.js` in the spike; the real build may import the `argon2` module instead).
- Parameter floor: `m=65536 KiB, t=3, p=1`. Calibration never goes below it, on any machine.
- Calibration target: the smallest `t` whose single derivation takes at least 500 ms, with `t` capped at 20 (ruling R9; the cap was 10 in the Task 5 brief, which would stop at about 430 ms on the measured Mac and never reach the target). Calibration raises `t` with `m` fixed at 64 MiB and `p=1`; on the measured Mac that means about t=12 (about 500 ms); the cap of 20 (about 840 ms) bounds the wait on fast machines. Raising `m` is not part of v1 calibration: the derivation runs in the MV3 service worker, so memory stays fixed at 64 MiB to avoid allocation failures on small machines, and time cost is the tunable.
- The median-at-floor threshold of 1500 ms from the plan was not reached (measured 141 ms), so no "floor accepted as too slow" exception is needed.
- Calibrated `m`, `t`, `p` and salt are stored versioned in the vault header (spec 4.1). Unlock uses the stored values, not a re-calibration.

## Consequences
- Passphrase guessing costs the attacker about 0.5 s of one core and 64 MiB per attempt at the calibrated setting on the measured Mac (more on faster hardware, up to the t=20 cap), versus 0.14 s at the floor.
- Calibration time is paid once at vault creation (a few runs of up to 1 s) and each unlock; the service worker must tolerate this (async, off the critical path of page load).
- Task 5 re-measured in the real MV3 service worker (production build, production CSP `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'none'`, Playwright Chromium 156.0.8078.4, Apple M1 Pro, m=65536 KiB, p=1, median of 3 runs): t=3 136 ms, t=4 179 ms, t=6 254 ms, t=12 508 ms, t=17 722 ms, t=20 839 ms. WASM instantiation works under the production CSP in the service worker. Service-worker timings match the page-context ones (about 42 ms per iteration), so the t=17 estimate above is superseded by the 500 ms rule: calibration lands at about t=12 here and about 0.5 s per derivation. Cold start and slower machines were still not measured; unlock time on slower hardware can exceed the target, though the floor protects the security level.
- A 64 MiB WASM allocation happens in whichever context derives the key; failure to allocate must surface as a clear error, not a silent downgrade.
- Upgrading `hash-wasm` is a deliberate change (new ADR or status update), not a dependency bump.

## Status
Accepted (2026-10-26). Updated 2026-10-26 (Task 5): service-worker measurements and calibration rule (500 ms threshold, t cap 20).
