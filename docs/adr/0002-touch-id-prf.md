# ADR 0002: Touch ID unlock via WebAuthn PRF is a go for v1

## Context
Spec §1.3 and §11 made Touch ID a gated convenience: v1 stays passphrase-only unless M0 probe (a) shows that WebAuthn PRF works in Brave from a `chrome-extension://` page. Risks were that Brave could not reach iCloud Keychain passkeys, that PRF would be missing, or that a blank `rp.id` would not work on an extension origin.

Probe (a), run manually in Brave 1.97.56 (Chromium 155.0.8059.40) on macOS 27.0.1 (`docs/spikes/m0-results.md`): `navigator.credentials.create` reported the PRF extension enabled, and `get` returned a 32-byte PRF result, with `rp.id` omitted. Brave asked where to save the passkey. Choosing 1Password opened 1Password, which failed to save the passkey. Choosing Apple Passwords (iCloud Keychain) succeeded, and that passkey produced the results.

## Decision
- GO: v1 ships Touch ID unlock through WebAuthn PRF, as an optional second wrap of the DEK. Implementation is in Plan 6.
- `rp.id` is omitted, so it defaults to the extension origin (`chrome-extension://<id>`). The manifest `key` from ADR 0003 keeps that origin stable.
- The PRF salt is 32 random bytes, stored with the credential in the header (`prf.salt`).
- `KEK_prf` is derived as in spec §4.1: `HKDF-SHA256(prfOutput, salt=32×0x00, info="refill/v1|prf-kek|" + credentialId)`. It wraps the DEK with AES-GCM, alongside the passphrase wrap.
- The Touch ID prompt runs in a dedicated unlock window (`windows.create`, extension page), per spec §6.6, because the system sheet can blur and close the action popup.

## Consequences
- The passphrase stays mandatory. It is the recovery path if the passkey is lost, removed or unavailable, and the only wrap created at onboarding.
- The only confirmed working path is Apple Passwords (iCloud Keychain). With iCloud Keychain sync on, that passkey syncs across the user's Apple ID devices, so Touch ID is not device-bound. The spec §8.3 disclosure applies and must appear on the Touch ID enable screen.
- Third-party passkey managers such as 1Password do not work for this origin and flow (1Password failed to save the passkey). The enable-Touch-ID UI must tell the user to choose Apple Passwords when Brave asks where to save, and must handle a failed or cancelled enrolment without changing the vault.
- Not verified: Chrome's local profile authenticator (optional M0 row, still pending) and non-Apple platforms.
- The probe ran under its own path-derived extension origin. The result is expected to hold for Refill's origin, but it must be re-checked with the Refill build during Plan 6.
- e2e tests use the CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator` with `hasPrf: true`). Real hardware is checked in a manual release checklist.
- Replacing the dev key with the Web Store key (ADR 0003) changes the extension origin and orphans any passkeys enrolled under the dev ID. Accepted before release, since no user data exists yet.

## Status
Accepted (2026-10-26).
