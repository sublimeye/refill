# M0 spike results

Throwaway probe extension: branch `spike/m0`, folder `spikes/m0/` (never merged). Date: 2026-10-26.
Machine: Apple M1 Pro, 16 GiB, macOS 27.0.1.

Probes (b) and (d) were run automatically with Playwright against the unpacked probe extension (persistent context, headed, `--load-extension`), in an extension page (`chrome-extension://<id>/probe.html`, `insert.html`). Probes (a) and (c) need Touch ID and a permission dialog and were run manually by the user in their own Brave (steps in `spikes/m0/README.md` on `spike/m0`). The probe extension origin in that run was `chrome-extension://efolplpejodlpokedllgodhidoagefbi` (the unpacked probe's path-derived ID, not Refill's; see ADR 0003).

## Summary

| Probe | Question | Outcome |
|---|---|---|
| (a) PRF / Touch ID | Does `navigator.credentials` PRF return 32 bytes in Brave via a platform passkey? | Yes: `create` PRF enabled, `get` returned 32 bytes, with the passkey saved to Apple Passwords (iCloud Keychain); 1Password failed to save it. See ADR 0002 |
| (b) Argon2id timing | Cost of `hash-wasm` Argon2id at m=64 MiB, p=1 | Measured: median 141 / 181-185 / 269-271 ms at t = 3 / 4 / 6 (user's own Brave: 136 / 170 / 250 ms) |
| (c) popup close | Does code after `permissions.request` run if the popup closes? | No: only the `before` marker was written, so code after the await did not run. See ADR 0007 |
| (d) insertText | Is `execCommand("insertText")` input `isTrusted`? | `isTrusted: true` |

## (a) PRF create/get

| Browser + version | macOS | Outcome | Raw log |
|---|---|---|---|
| Brave 1.97.56 (Official Build) (arm64), Chromium 155.0.8059.40 | 27.0.1 (26A434) | PASS: PRF extension enabled at `create`; `get` returned a 32-byte PRF result. rp.id omitted (defaults to the extension origin). Brave asked where to save the passkey: 1Password opened but failed to save it; Apple Passwords (iCloud Keychain) saved it and produced these results | see below |
| Chrome (optional; iCloud Keychain and Chrome profile choices) | 27.0.1 | PENDING: user run (optional) | |

Raw result lines (user's Brave):

```
Brave 1.97.56 (Official Build) (arm64), Chromium: 155.0.8059.40; macOS 27.0.1 (26A434)
origin: chrome-extension://efolplpejodlpokedllgodhidoagefbi UA: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36
create ext: {"enabled":true,"firstLen":32}
(a) get prf: {"origin":"chrome-extension://efolplpejodlpokedllgodhidoagefbi","createEnabled":true,"getFirstLen":32}
```

Not tested: Chrome's local profile authenticator (the optional row stays pending); whether the passkey is device-bound (it was saved to Apple Passwords, which syncs via iCloud Keychain).

## (b) Argon2id timing

Library: `hash-wasm` 4.12.0, `dist/argon2.umd.min.js` (29,467 bytes, sha256 `dcec617a2e1b700fa132d1583a186cb70611113395e869f2dd6cc82b415d3094`), global `hashwasm.argon2id`.
Parameters: password `"correct horse battery staple"`, random 16-byte salt, `parallelism: 1`, `memorySize: 65536` (KiB), `hashLength: 32`, `outputType: "binary"`. 3 runs per `t`, median reported. Timed with `performance.now()` around each `argon2id` call.

Context: page context of an extension page (not the service worker; the probe manifest has no background worker, so no `chrome.runtime.sendMessage` round-trip was done).

| Browser + version | macOS | t | Runs (ms) | Median (ms) |
|---|---|---|---|---|
| Playwright Chromium 156.0.8078.4 (run 1) | 27.0.1 | 3 | 148, 141, 141 | 141 |
| | | 4 | 181, 182, 177 | 181 |
| | | 6 | 271, 277, 267 | 271 |
| Playwright Chromium 156.0.8078.4 (run 2, logged) | 27.0.1 | 3 | 144, 141, 140 | 141 |
| | | 4 | 182, 188, 185 | 185 |
| | | 6 | 273, 265, 269 | 269 |
| Brave 155.1.97.56 (Chromium 155.0.8059.40), launched via Playwright `executablePath`, fresh temp profile | 27.0.1 | 3 | 144, 142, 140 | 142 |
| | | 4 | 179, 190, 178 | 179 |
| | | 6 | 263, 270, 263 | 263 |
| Brave 1.97.56 / Chromium 155.0.8059.40, user's own profile, manual run, extension page (`origin chrome-extension://efolplpejodlpokedllgodhidoagefbi`) | 27.0.1 | 3 | 165, 136, 136 | 136 |
| | | 4 | 170, 170, 174 | 170 |
| | | 6 | 252, 247, 250 | 250 |

Raw result lines (Brave):

```
browser: 155.0.8059.40
RESULT_B {"t3":{"runs":[144,142,140],"medianMs":142},"t4":{"runs":[179,190,178],"medianMs":179},"t6":{"runs":[263,270,263],"medianMs":263}}
```

Brave accepted `--load-extension` with a Playwright-launched temporary profile (the user's own Brave was running separately and was not touched).

Reading: cost is linear in `t` at about 43 ms per pass at m=64 MiB (141 ms at t=3, 270 ms at t=6). The floor (t=3) is 10x under the 1500 ms threshold, so the floor is not a usability problem on this Mac. Not measured: service-worker context, cold first run after browser start, lower-end machines.

## (c) permissions.request and popup close

| Browser + version | macOS | Outcome | Raw log |
|---|---|---|---|
| Brave 1.97.56 (Official Build) (arm64), Chromium 155.0.8059.40 | 27.0.1 (26A434) | Only the `before` marker was written; code after `await permissions.request` did not run (popup closed) | `(c) session: {"before":1793043521461}` |

## (d) insertText isTrusted

`input.focus(); input.select(); document.execCommand("insertText", false, "x")` triggered by a Playwright click on the button, in an extension page (`insert.html`).

| Browser + version | macOS | Outcome | Raw log |
|---|---|---|---|
| Playwright Chromium 156.0.8078.4 | 27.0.1 | `isTrusted: true`, `execCommand` returned true, value `"x"` | `{"type":"input","isTrusted":true,"inputType":"insertText","data":"x"}` |
| Brave 155.1.97.56 (Chromium 155.0.8059.40) | 27.0.1 | `isTrusted: true`, `execCommand` returned true, value `"x"` | `{"type":"input","isTrusted":true,"inputType":"insertText","data":"x"}` |

Observation: only an `input` event was recorded; a `beforeinput` listener on the same element did not fire for the `execCommand` call in either browser. Fill code must not depend on `beforeinput`.

Caveat: this was run on an extension page, not on an arbitrary web page's content-script context. The fill engine's own tests must re-check `isTrusted` on a real page in the content-script isolated world.
