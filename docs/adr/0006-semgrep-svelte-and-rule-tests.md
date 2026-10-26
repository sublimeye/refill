# ADR 0006: Semgrep coverage of Svelte files, spelling variants and rule self-tests

## Context
The first Semgrep rule set (ADR 0005 era) only used TS/JS patterns for the canonical spellings. Review found three gaps: Semgrep does not parse `.svelte`, so a `fetch`, `innerHTML` or `storage.sync` inside a component's `<script>` produced no finding (only a `{@html` regex existed) even though all extension pages are Svelte and the ban covers all of `src/`; common alternative spellings slipped through (`document.writeln`, `window.document.write`, `Function(...)` without `new`, `window.eval`, string `setTimeout`/`setInterval`, `el["innerHTML"]`, `setHTMLUnsafe`, `crypto["subtle"]`, `chrome.storage["sync"]`, `globalThis.chrome.storage.local`, `new window.WebSocket`, `self.navigator.sendBeacon`); and nothing in the repo would notice if a rule silently stopped matching (for example if the `/src/**` path filters stopped resolving).

## Decision
- **Svelte:** a second rule file `.semgrep/refill-svelte.yml` with one `generic`-language `pattern-regex` rule per ban (network, HTML sinks including `{@html`, eval/Function/string timers, `storage.sync`, `crypto.subtle`, `storage.local`), scoped to `/src/**/*.svelte`. They run over the whole file (script and template), are deliberately blunt (a banned word in a comment also fails) and have no directory exclusions: Svelte files never legitimately use these APIs. Chosen over ESLint `no-restricted-*` because it keeps one enforcement tool and one place to read the bans, and the fixtures prove it. ESLint stays for general lint.
- **Spellings:** `.semgrep/refill.yml` matches calls and constructors through `metavariable-regex` on the callee text, allowing `window.`/`self.`/`globalThis.` prefixes and bracket property access, plus explicit patterns for bracket forms of sinks, `sync`, `subtle` and `local`. New bans: `document.writeln`, `setHTMLUnsafe`, `parseHTMLUnsafe`, `Function(...)`, string-literal `setTimeout`/`setInterval`. `storage.local` is now matched on any receiver ending in `chrome` or `browser`.
- **Self-tests:** `scripts/semgrep.sh selftest` runs inside the pinned image. (1) `semgrep --test` over `.semgrep/tests/*.ts|*.svelte`, annotated with `// ruleid:` / `// ok:` for every spelling above and the original ones. `semgrep --test` ignores nothing, so path filters are stripped from a temporary copy of the configs for this step. (2) A path check scans `.semgrep/path-fixtures/` (copied to a non-git directory so `/src/**` anchors at its root) with the real configs and diffs the findings against `EXPECTED`: `crypto.subtle` allowed only under `src/lib/crypto/`, `storage.local` only under `src/lib/store/`, other rules unaffected by those directories, nothing outside `src/` flagged. CI runs `selftest` before `scan`, so a rule or path regression fails the build. The fixtures live under `.semgrep/`, so the main scan does not match them (anchored filter) and ESLint/Prettier ignore the directory.
- `scripts/semgrep.sh` is also the single holder of the Semgrep image digest. Docker is required to run it locally.

## Consequences
- All of `src/` (TS, JS, Svelte) is covered for the listed bans, and the coverage is tested.
- Known limits, unchanged: aliasing (`const f = fetch`, `const {subtle} = crypto`, `const s = chrome.storage`) is not detected, and Svelte rules can false-positive on comments or strings. Both are accepted; review and the CSP (`connect-src 'none'`) are the backstops.
- Rule ids appear as `semgrep.<rule>` in output (Semgrep prefixes the config directory).
- Adding a rule means adding a fixture; `semgrep --test` fails if an annotated rule does not fire, or if any other rule fires in the same fixture file.

## Status
Accepted.
