# ADR 0022: Profile records and the e2e profile seam

## Context
Profiles hold field values and are the most sensitive records Refill stores. They are decrypted from `storage.local`, so their shape is untrusted input, and they must stay bound to the site they belong to. Playwright also needs a way to seed a profile before the capture UI exists.

## Decision
- A profile is stored at `p:<id>`, sealed with AAD `refill/v1|profile|<id>|<origin>`; the site index (`sites[origin].profileId`) points at it. `id` is 128 random bits as base64url without padding (22 chars, no `|`, which AAD forbids). Ids are validated as `/^[A-Za-z0-9_-]{1,64}$/` on read and write.
- `parseProfile` is strict: exact keys at every level, every `Sig` field type-checked and length-capped (256), `fields[].id` unique (spec 4.2 gains `id`), step indices unique integers 0..9 and every `field.step` must reference one, `pathPrefix` starts with `/`, fingerprints at most 300 entries of at most 1024 chars, `createdAt`/`lastUsedAt` finite and non-negative. It returns a fresh object, never the input.
- `saveProfile` validates, then does everything in one `withStoreLock` using only `tx`: seal and write the record, `upsertSite(origin, { profileId }, tx)`, and remove the origin's previous profile record when its id differs. The record is written first, so a failure (locked, quota) leaves the old profile and pointer intact. It refuses an id already attached to another origin, which would orphan that origin's pointer.
- `loadProfileForOrigin` returns `null` for no site, no `profileId`, a missing record, a `DecryptError` (wrong AAD, tampering), a parse failure, or a decrypted `origin`/`id` that differs from the one requested (defence in depth beside the AAD). It logs the error name only. `LockedError` propagates. A site with no profile never needs the vault, so it returns `null` even while locked.
- The e2e seam is `globalThis.__refillE2E = { saveProfile, loadProfile }` (`loadProfile` is `loadProfileForOrigin`, added by the Plan 3 final review to prove what a review saved) in the service worker under `import.meta.env.MODE === "e2e"`. The marker is a property name (a string), which minifiers keep; a local binding would be mangled and the production check could pass for the wrong reason.
- CI adds a positive control: `node scripts/check-no-seams.mjs .output/chrome-mv3-e2e` must exit exactly 1 (not 0, not the usage error 2). This proves the marker survives minification into the built service worker, so the production pass (exit 0) is meaningful.

## Consequences
- A corrupt or foreign profile record degrades to "no profile" rather than a crash or a fill from untrusted data; the cost is that a damaged record is silent apart from a name-only log.
- `saveProfile` and `loadProfile` are also the seam's capability: anything that can run code in the e2e service worker can write a profile, or read one while the vault is unlocked. The e2e build is never shipped; the CI check bounds that.
- Callers must generate ids with `newId()`; ids chosen elsewhere must satisfy the same pattern.

## Status
Accepted (2026-10-26). Amended by ADR 0033 (2026-10-27): `loadProfileForOrigin` re-reads the site
index when the record is missing and follows a moved pointer, so a replace in flight never answers a
spurious `null` (Plan 2 review M9); it stays lock-free. Plan 3 final review (2026-10-28): the seam gains `loadProfile`.
