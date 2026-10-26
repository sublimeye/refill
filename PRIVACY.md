# Privacy

Refill is local-only. **No data leaves your device.**

- The extension makes no network requests of any kind: its code uses no network APIs, and its
  Content Security Policy sets `connect-src 'none'` for extension pages. CI enforces the first
  rule with Semgrep and the second with a manifest snapshot test.
- There is no account, no server, no sync (`chrome.storage.sync` is never used), no analytics,
  no telemetry, no crash reporting, and no remote code or remote configuration.
- Refill does not read pages you have not explicitly enabled it on. Host access is requested per
  site, at your click, as an optional permission.

## What is stored, and where

Everything is kept in `chrome.storage.local` inside your own browser profile (plus short-lived
`chrome.storage.session` in memory while unlocked).

Encrypted (AES-256-GCM, key derived from your passphrase with Argon2id):

- every saved field value, profile names, and page paths,
- drafts you opted into (sealed to a public key, so they can be saved while locked),
- an encrypted integrity copy of the lock settings and key-derivation parameters.

Stored in plaintext (needed to run while the vault is locked, and contains no field values):

- the **site index**: which origins you enabled Refill on, with per-site flags (profile id,
  drafts on/off, draft retention, access revoked),
- settings (retention defaults, toast duration, lock timings),
- the vault header: key-derivation parameters and salt, wrapped (encrypted) keys, the draft
  public key, and the time of the last passphrase entry,
- for each draft: its expiry time and random id.

The site list is not encrypted because Chrome itself already stores granted host permissions and
registered content scripts in plaintext in your profile, so encrypting Refill's copy would not hide
it from someone who can read your disk. Field values never appear in plaintext on disk.

## Never captured

Refill never records password fields (including fields that were ever a password field), one-time
codes, card-number and security-code fields, hidden, file, disabled or read-only fields, and other
fields on its never-capture list (design spec section 5.3). Values that look like card numbers are
dropped and reported on the review screen. Refill does not run on pages you have not enabled.

## Your control

You can export your data (as a separately encrypted file), delete any profile or draft, revoke a
site (which removes the host permission), and remove the extension, which deletes everything it
stored. Forgetting your
passphrase means the data cannot be recovered: there is no backdoor or reset.

## Optional Touch ID

If a later release enables Touch ID unlock, it relies on a platform passkey. On macOS those can
sync through iCloud Keychain, so that option is not device-bound; this is disclosed on the enable
screen, and passphrase-only remains available.

## Changes

Any change to what is stored or transmitted is recorded in this file and in an ADR under
`docs/adr/` before release.
