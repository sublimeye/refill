# Refill M0 spike (throwaway, never merged)

Probe extension for the M0 decisions. Plain MV3, no build step.
`hash-wasm.umd.min.js` is `dist/argon2.umd.min.js` from `hash-wasm@4.12.0` (sha256 `dcec617a2e1b700fa132d1583a186cb70611113395e869f2dd6cc82b415d3094`).

Probes (b) Argon2id timing and (d) insertText `isTrusted` were already run automatically with Playwright (see `docs/spikes/m0-results.md` on PR `t1-m0-results`).
Probes (a) and (c) need a human (Touch ID, permission dialog).

## Load it in Brave

1. Open `brave://extensions`, switch on **Developer mode** (top right).
2. Click **Load unpacked**, select the `spikes/m0` folder of this branch (`spike/m0`).
3. Note the extension ID. Pin the "Refill M0 spike" icon to the toolbar (puzzle icon, then the pin).
4. Open the probe page in a tab: `chrome-extension://<ID>/probe.html` (replace `<ID>`).

## (a) PRF / Touch ID

1. On `probe.html`, click **create + get**.
2. Approve the Touch ID prompt twice (once to create the passkey, once to use it). If Brave offers a choice of where to save the passkey, pick the platform/iCloud Keychain option and note which options appeared.
3. Copy the whole **Log** box back to me. The lines that matter:
   - `create ext: { enabled: ..., firstLen: ... }`
   - `(a) get prf: { origin, createEnabled, getFirstLen }`: `getFirstLen` of 32 means PRF works. Anything else, or an `ERROR` line, is a NO-GO.
4. Optional, if Chrome is installed: repeat in Chrome (same load-unpacked steps at `chrome://extensions`) and note both choices ("iCloud Keychain" and "Chrome profile") if offered, with their results.

## (c) Does code after `permissions.request` run once the popup closes?

1. Click the toolbar icon "Refill M0 spike" to open the popup.
2. Click **request example.com permission**. A browser permission dialog appears. The popup will probably close when the dialog takes focus. Click **Allow** (do it once; then repeat once with **Deny** if you can, after removing the permission at `brave://extensions` > Details > Site access).
3. Go back to the `probe.html` tab and click **read chrome.storage.session**.
4. Copy back the `(c) session:` log line.
   - `before` and `after` both present plus `granted`: code after the await ran even though the popup closed.
   - Only `before` present: the popup was destroyed before the await resumed, so permission requests must not rely on popup code continuing.
   Also tell me whether the popup visibly closed when the dialog appeared.

## Brave and macOS versions

Copy the Brave version from `brave://version` and the macOS version (Apple menu > About This Mac) too.
