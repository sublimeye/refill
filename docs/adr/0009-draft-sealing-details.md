# 0009 — Draft sealing details (ECDH P-256)

## Context

Spec §4.1 fixes the draft key schedule (ephemeral ECDH P-256, HKDF-SHA256, AES-256-GCM with `aad.draft`). Task 6 leaves open how keys are encoded, how the vault persists the private key without touching `crypto.subtle`, and how malformed public keys are handled.

## Decision

- **Key schedule** exactly per spec: `ss = deriveBits(ECDH, 256)`; `k = hkdfAesKey(ss, info)` with the default 32-zero salt; `info = utf8("refill/v1|draft|" + id + "|") ‖ raw(eph.pub) ‖ utf8("|") ‖ raw(draftPub)`, where `raw` is the 65-byte uncompressed point from `exportKey("raw")`. AAD is `aad.draft(id, expiresAt)`. The shared secret is zeroed after use. A test re-derives the key independently with raw WebCrypto to pin this.
- **Ephemeral key**: generated non-extractable and dropped when `sealDraft` returns. `SealedDraft.eph` is the public JWK reduced to `{kty, crv, x, y}`; `iv`/`ct` use the `Sealed` base64 format.
- **Draft key pair**: the private key is generated extractable so the vault can wrap it. To keep `crypto.subtle` inside `src/lib/crypto/`, the module also exports `exportDraftPrivateKey` (PKCS#8 bytes) and `importDraftPrivateKey` (non-extractable, ECDH, usages `["deriveBits"]`) (controller ruling R4). The unlocked in-memory key is the non-extractable import.
- **Public JWK validation**: both `sealDraft` and `openDraft` accept only `kty "EC"`, `crv "P-256"`, string `x`/`y` and no `d`, otherwise `TypeError`; only `{kty, crv, x, y}` is passed to `importKey`. A tampered vault header therefore cannot substitute a private JWK, another curve or extra members (`key_ops`, `ext`).
- **Errors in `openDraft`**: a malformed `draftPub` (header) throws `TypeError`; anything wrong with the record (bad or swapped `eph`, changed `id`/`expiresAt`, tampered `iv`/`ct`, wrong recipient) throws `DecryptError`, uninformative as in ADR 0008. Invalid curve points in `eph` fail at `importKey` and are mapped to `DecryptError`.
- Ids containing `|` are rejected by `aad.draft` (ADR 0008) before any key work.

## Consequences

- The vault (Task 8) stores `exportDraftPrivateKey` output sealed under the DEK and never calls `crypto.subtle`.
- `exportDraftPrivateKey` fails on the non-extractable imported key by design; it is only usable right after generation.
- `draftPub` is bound into the HKDF info but not into the AAD; swapping the recipient key changes the derived key, so decryption fails.

## Status

Accepted
