# Prior art — form save/restore extensions (surveyed 2026-10-26)

Capabilities: **P** per-page profiles · **W** multi-step wizard · **D** draft autosave + TTL · **X** password exclusion.

| Extension | License / MV / activity | P W D X | Notes |
|---|---|---|---|
| [FormVault](https://github.com/drewsb/FormVault) | MIT, MV3, last commit 2022-01 | ~ ✗ ~ weak | ~300 LOC jQuery; `name`-only matching, no events (React ignores fills); scans at `document_start` (likely empty); stores in `chrome.storage.sync` (leaves device); password filter is substring on name; `<all_urls>` |
| [Lightning Autofill](https://docs.lightningautofill.com/help/form-fields) (tohodo) | Closed, MV3, 600k users | ✓ ✓ ~ ✗ | Best rule model (site filter + ordered rules, regex/XPath, WAIT/CLICK); stores passwords unencrypted; freemium, heavy |
| [Typio Reboot](https://github.com/ctsstc/typio-form-recovery-reboot) | **CC BY-NC-ND** (no forks), MV3 | ✗ ✗ ✓ ✓ | Good draft recovery, CSS-path matching, shadow DOM/iframes; `<all_urls>` |
| [lazarus-revived](https://github.com/swiss9/lazarus-revived) | GPL-3.0, MV3 (Firefox/Edge) | ✗ ✗ ✓ ✓ | Native value setter + input/change/blur; MutationObserver; optional AES-GCM PIN vault (PBKDF2 600k); good sensitive-field denylist |
| [Textarea Cache](https://github.com/wildskyf/TextareaCache) | MIT, MV3 | — — ✓ — | Textareas/rich editors; copy-paste recovery only |
| [Form History Control II](https://github.com/stephanmahieu/formhistorycontrol-2) | MIT, MV3 | — — ~ ✓ | Per-field history; heavy manager UI |
| [Form-O-Fill](https://github.com/form-o-fill/form-o-fill-chrome-extension) | MIT, MV2, dead | ✓ ✓ — — | JS-rule workflows across reloads; `unsafe-eval`; dev tool |
| [Fake Filler](https://github.com/FakeFiller/fake-filler-extension) | MIT, MV3 | — | Dummy data for devs; `activeTab` only (good); field-type regexes |
| UI.Vision / iMacros | AGPL / closed | W | Full RPA — far too heavy |

## Verdict
Build from scratch (MIT). No candidate covers P+W+D+X; forkable ones are weak (FormVault) or
license-incompatible (Typio, lazarus-revived GPL).

## Ideas borrowed
1. Lightning Autofill's rule model (site filter + matcher + value + safe/overwrite mode).
2. lazarus-revived's fill primitives (native setter + events, MutationObserver, shadow DOM) and
   sensitive-field denylist.
3. Form-O-Fill's cross-navigation workflows → superseded in Refill by per-field signature matching.

## Differentiator
Every candidate except Fake Filler requests `<all_urls>` at install. Refill installs with zero
permission warnings and requests host access per site, in context.
