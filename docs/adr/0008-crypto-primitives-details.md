# 0008 — Crypto primitive details (AES-GCM wrapper, AAD, base64)

## Context

Task 4 specifies the signatures of `bytes`, `aad` and `aead` but leaves several details open: how strict base64 parsing is, what decryption failures look like to callers, what key sizes are accepted, and how AAD fields are delimited.

## Decision

- **Base64**: standard alphabet, padded, validated by regex before `atob`, and canonical (decoded bytes must re-encode to the same string, so non-zero trailing bits are rejected); anything else throws `TypeError`. No URL-safe or unpadded forms are accepted.
- **`DecryptError`**: a single uninformative class (`name = "DecryptError"`, message `decryption failed`). `open` maps every failure (bad base64, wrong IV length, wrong key/AAD, tampering, truncation) to it, so callers cannot build an oracle from error details. This also masks key-misuse bugs (e.g. a key without `decrypt` usage) as `DecryptError`; callers must not treat it as proof of a wrong passphrase alone. The underlying error is not attached as `cause`.
- **IV length** is enforced as exactly 12 bytes in `open`; tag length is fixed at 128 bits.
- **`importAesKey`** accepts only 32-byte keys (AES-256 per the global constraints) and rejects others with `RangeError`.
- **AAD delimiter**: `|` is the field separator. `profile` and `draft` reject ids containing `|` (`TypeError`), because the id is followed by another field and the encoding would otherwise be ambiguous. `credentialId` and `origin` are final fields and need no check.
- **`canonicalJson`** emits the string directly (no intermediate object): keys sorted by UTF-16 code unit at every level (so integer-like keys are not reordered numerically and an own `__proto__` key is preserved), no whitespace. It accepts only plain objects (prototype `Object.prototype` or `null`), arrays, strings, finite numbers, booleans and null; everything else (undefined, functions, Date, Map, class instances, bigint, symbols, non-finite numbers, cycles) throws `TypeError`. This keeps the encoding injective for data later compared or hashed.
- **Draft AAD (spec drift, ruling R16)**: `aad.draft` is `"refill/v1|draft|" + id + "|" + (expiresAt ?? "none")`. Spec §4.1 said `+ expiresAt` (which gives `null`) and §4.2 omitted `expiresAt`; both are updated to match.
- **`sealWithIv`** is exported from `aead.ts` for known-answer tests only; there is no index barrel, so it is never re-exported.
- **Environment**: code uses `globalThis.crypto`, which exists in the MV3 service worker and in Node/Vitest. `crypto.subtle` stays inside `src/lib/crypto/` (Semgrep rule).

## Consequences

- Stored data from any other base64 variant would fail to load; all writers use `toB64`.
- Callers must treat any `DecryptError` as "wrong passphrase/key or corrupt data" without further detail.
- Ids generated elsewhere (random 128-bit ids, hex/base64url) never contain `|`, so the id check is a guard rail only.

## Status

Accepted
