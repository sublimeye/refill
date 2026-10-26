# ADR 0001: Argon2id via hash-wasm 4.12.0

## Context
The vault key hierarchy (spec section 4.1) derives `KEK_pw` from the passphrase with Argon2id. WebCrypto has no Argon2, so a WASM implementation must be bundled; the extension CSP allows `wasm-unsafe-eval` only for this. The library must be small, widely used, vendored and pinned. Spec floor: m=64 MiB, t=3, p=1, with calibration at vault creation to roughly 0.5-1 s on the user's machine.

M0 spike (b) measured `hash-wasm` 4.12.0 (`dist/argon2.umd.min.js`, 29,467 bytes, sha256 `dcec617a2e1b700fa132d1583a186cb70611113395e869f2dd6cc82b415d3094`) on an Apple M1 Pro, m=65536 KiB, p=1, page context of an extension page, median of 3 runs: t=3 141-142 ms, t=4 179-185 ms, t=6 263-271 ms (ranges cover Chromium 156 and Brave 155). Cost is linear at about 43 ms per iteration. Details: `docs/spikes/m0-results.md`.

## Decision
- Use `hash-wasm` exactly `4.12.0` (no range), vendored and pinned, using only its Argon2 build (`argon2.umd.min.js` in the spike; the real build may import the `argon2` module instead).
- Parameter floor: `m=65536 KiB, t=3, p=1`. Calibration never goes below it, on any machine.
- Calibration target: 500-1000 ms median for one derivation, aiming at about 750 ms. Calibration raises `t` with `m` fixed at 64 MiB and `p=1`; on the measured Mac that means about t=11 to 23 (aim about t=17). Raising `m` is not part of v1 calibration: the derivation runs in the MV3 service worker, so memory stays fixed at 64 MiB to avoid allocation failures on small machines, and time cost is the tunable.
- The median-at-floor threshold of 1500 ms from the plan was not reached (measured 141 ms), so no "floor accepted as too slow" exception is needed.
- Calibrated `m`, `t`, `p` and salt are stored versioned in the vault header (spec 4.1). Unlock uses the stored values, not a re-calibration.

## Consequences
- Passphrase guessing costs the attacker about 0.75 s of one core and 64 MiB per attempt at the calibrated setting, versus 0.14 s at the floor.
- Calibration time is paid once at vault creation (a few runs of up to 1 s) and each unlock; the service worker must tolerate this (async, off the critical path of page load).
- The numbers above are page-context timings; Task 5 re-measures in the real service worker. Cold start and slower machines were also not measured; the floor protects the security level and the target cap bounds the waiting time, but unlock time on slower hardware can exceed 1 s.
- A 64 MiB WASM allocation happens in whichever context derives the key; failure to allocate must surface as a clear error, not a silent downgrade.
- Upgrading `hash-wasm` is a deliberate change (new ADR or status update), not a dependency bump.

## Status
Accepted (2026-10-26).
