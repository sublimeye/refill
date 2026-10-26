# Architecture decision records

Each ADR has Context / Decision / Consequences / Status. Add a new `NNNN-<slug>.md` for any meaningful decision (library, algorithm, parameter, permission, data format, deviation from the spec or plan), and update the index below. To retire a decision, set its Status to `Superseded by NNNN` and add the new ADR.

| # | Title | Status |
|---|---|---|
| [0001](0001-argon2id-hash-wasm.md) | Argon2id via hash-wasm 4.12.0 | Accepted |
| [0002](0002-touch-id-prf.md) | Touch ID unlock via WebAuthn PRF is a go for v1 | Accepted |
| [0003](0003-manifest-key.md) | Dev/test manifest key pinned for a stable extension ID | Accepted |
| [0004](0004-typescript-6-toolchain.md) | TypeScript pinned to 6.0.3, not 7.x | Accepted |
| [0005](0005-ci-supply-chain-pinning.md) | CI supply-chain pinning (actions by SHA, Semgrep image by digest) | Accepted |
| [0006](0006-semgrep-svelte-and-rule-tests.md) | Semgrep coverage of Svelte files, spelling variants and rule self-tests | Accepted |
| [0007](0007-permission-request-popup-lifecycle.md) | Popup does no work after `permissions.request`; the service worker completes the flow | Accepted |
| [0008](0008-crypto-primitives-details.md) | Crypto primitive details (strict base64, uniform DecryptError, 32-byte keys, AAD delimiter) | Accepted |
