# ADR 0039: Reset for a forgotten passphrase

## Context
Refill has no recovery: the passphrase derives the key that wraps the vault key. Until now a forgotten passphrase, or a damaged vault, left the popup at a dead end, and the only way out was removing the extension and installing it again. The owner hit this while using Refill, and wanted a way out from the popup.

## Decision
- **Reset, not recovery.** A page-only `vault-reset` message returns Refill to a fresh install. Data is erased, never decrypted, so no passphrase is involved and the encryption is not weakened.
- **What goes.** Every key in `storage.local` (vault header, integrity copy, site index, settings, saved forms, drafts), everything in `storage.session` (key mirror, backoff, intent, recording, tombstone), every granted host permission (from `permissions.getAll`, so an origin missing from the index goes too), the registered content script (through `reconcile`), and the badges on open tabs of saved forms.
- **Order** (`resetEverything`, `eraseVault`). Read the badge tabs while the site index exists. Discard a recording as `site-removed`, so its page is not told the vault locked. Drop key material and bump the epoch before the erase, so saves already running cannot write after it (`lockEpoch` checks, ADR 0033). Erase `storage.local` in a single `remove` inside `withStoreLock`. Notify lock listeners last, so their `🔒` pass finds no site.
- **Failure.** If the erase fails the handler rejects, the popup shows the generic error and the data is intact, locked. Once the erase succeeds, permission and content-script cleanup failures are logged by error name and the reset stands: leftovers hold no data, and the next `reconcile` repeats that work.
- **Confirmation.** The popup replaces the unlock form with a warning and requires typing `erase`. It is a UI guard against accidents, not a security control.
- **Where it appears.** "Forgot passphrase?" on the locked view, and "Erase and start over" on the damaged-vault view. It is not offered while unlocked.

## Consequences
- Someone with access to the browser profile can erase the vault without the passphrase. They could already do that by removing the extension or clearing its data, and they learn nothing either way, so this is accepted.
- Content scripts cannot reach it: the router only gives page senders the page handlers (ADR 0014).
- Unlock backoff is cleared by the reset. It protects the data, and the data is gone.
- PRIVACY.md and the threat model describe the reset.

## Status
Accepted.
