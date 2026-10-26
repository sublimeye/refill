# 0012 — Vault core details (header parsing, locking, integrity, backoff)

## Context

Task 8 implements the vault (spec §4.1–§4.3, §8.2): create, unlock, lock, change passphrase, the `vault:integrity` tamper check, failed-unlock backoff, the DEK session mirror and encrypted records. The plan fixes the API and the main flow; this ADR records the details it leaves open. The header is plaintext and writable by anyone with disk write access, so it is parsed as untrusted input.

## Decision

- **Strict header parsing** (`parseHeader`, `null` ⇒ status `corrupt`): every object must be a plain object with exactly the known keys (unknown keys rejected, `prf` optional). `v === 1`. `kdf` passes the kdf module's own validator, now exported as `isKdfParams` (same bounds as `deriveKek`: alg, v, p, m and t floor and max, 16-byte salt). `wrappedDek` (and `prf.wrappedDek`) is a 12-byte IV plus exactly 48 bytes of ciphertext (a 32-byte DEK plus tag), so a truncated `ct` is `corrupt`, not `wrong-passphrase`. `wrappedDraftPriv` ciphertext is 17–1024 bytes. `draftPub` is exactly `{kty:"EC", crv:"P-256", x, y}` with `x`/`y` canonical unpadded base64url of 32 bytes. `lock` values are safe integers in the plan's ranges. `lastPassphraseAt` is a non-negative safe integer. `prf.credentialId` is unpadded base64url, 1–1364 chars (at most 1023 bytes, the WebAuthn limit), and `prf.salt` is 32 bytes (the Touch ID task may revise this). The parser returns a fresh copy built from the validated fields only, so it is safe to pass to `canonicalJson`.
- **Serialization**: `unlockWithPassphrase` and `changePassphrase` run the whole attempt inside `withStoreLock`: backoff check, header read, KDF, DEK unwrap, integrity check, failure recording and writes. Concurrent guesses are serialized, and each one sees the backoff set by the one before (tested: two parallel wrong guesses run the KDF once). The cost is that other store writes wait for one Argon2 derivation (two for a passphrase change), about 0.5–1 s. `createVault` derives outside the lock, then re-checks for a header inside it and writes header and integrity in one `tx.setItems`. A cheap early `exists` check before the KDF avoids wasted work.
- **Integrity**: on a mismatch the header's `draftPub`, `lock` and `kdf` are restored from the integrity copy and the result carries `warning: "integrity-restored"`. A missing, malformed or undecryptable integrity record after a correct passphrase **fails closed**: the result is `reason: "corrupt"`, nothing is written and the vault stays locked. Otherwise, deleting the record would switch the tamper check off. A `kdf` mismatch is unreachable in practice, because any change to the parameters changes the KEK, so the DEK unwrap fails first.
- **Change passphrase**: runs the same verification path as unlock, so it is subject to backoff, records failures, and restores tampered values before sealing a new integrity record with the new `kdf`. The DEK is unchanged; the header is rewritten with a new `wrappedDek`, `kdf` and `lastPassphraseAt`. The lock state is unchanged: a locked vault stays locked. It takes an optional `now` like the other mutators.
- **Passphrase strength**: `Error("weak")` when there are fewer than 12 code points after NFC. It applies to create and to the new passphrase in a change, not to unlock.
- **Lock wins races**: `lock()` bumps an epoch. A session rebuild in `getDek`, an unlock commit or a draft-key import that started before the bump installs nothing and cleans up the session it wrote. An unlock whose KDF overlaps an earlier `lock()` still commits, because the user's action finishes after the lock.
- **`status(now)` is a hard-max backstop**: when the vault is unlocked and `now >= unlockedAt + lock.maxHours`, it calls `lock()` and reports `locked`. Alarms and `enforceOnWake` (Task 9) remain the primary mechanism.
- **Backoff state** in `storage.session` `vault:backoff`. Malformed state reads as no failures. A stored deadline more than 60 s in the future is clamped to `now + 60 s` and persisted, so a clock moved back cannot lock the user out for longer than 60 s. A correct passphrase (unlock or change) resets the state. An integrity-corrupt result neither records a failure nor resets the state.
- **Session mirror** `vault:session` = `{ dek: base64, unlockedAt }`. A malformed mirror reads as locked. Raw DEK bytes (the unwrap output, the session read) are zeroed after import. The base64 string in session storage cannot be zeroed, which is accepted in spec §8.3.
- **Records**: the value is serialized with `JSON.stringify` and sealed under the DEK with the caller's AAD. A value with no JSON form throws `TypeError`. A malformed stored record throws `DecryptError`. Both functions check the lock first, so a locked vault throws `LockedError` even for a missing key. `putEncrypted` takes an optional `StoreTx` for use inside a lock job (ADR 0011).
- **`onLockChange`**: listeners get `true` after an unlock or create commits and `false` on every `lock()` call, even when the vault was already locked. Listener exceptions are swallowed. Notification happens outside the store lock.
- **Draft private key**: decrypted lazily on first `getDraftPrivateKey()`, imported non-extractable and cached until lock.
- **Tests**: to assert that the KDF does not run during backoff, `vi.mock` replaces the kdf module with a pass-through `vi.fn` around the real `deriveKek` (ESM exports cannot be spied on after import). Vault tests use the Argon2 floor and create one vault per file, then restore a storage snapshot for later tests.

## Consequences

- A header written by a future format (new keys, `v: 2`) reads as `corrupt` in this version, so format changes need a migration that bumps `v`.
- The plan's `changePassphrase(oldP, newP, kdf)` gains an optional fourth parameter `now`. Callers that omit it are unaffected.
- A user whose integrity record is lost cannot unlock without manual recovery. This is accepted: only a disk-write attacker or storage corruption can cause it, and failing open would make the check worthless.
- Unlock holds the store queue for about one Argon2 derivation, so draft writes arriving during an unlock are delayed rather than interleaved.

## Status

Accepted
