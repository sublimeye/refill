# ADR 0009: CI installs Playwright Chromium without `--with-deps`, with step timeouts

## Context
The `verify` job intermittently hung for 12-15 minutes in the e2e step on PR runs (PRs #4, #5, #7), with no output, then passed on re-run in about 2 minutes. Logs of the slow runs (e.g. run 40391896790: 906 s, run 40389536781: 745 s) show the time is spent inside `playwright install --with-deps chromium`, in the `apt-get install` it triggers: "Fetched 25.0 MB in 14min 38s (28.5 kB/s)" from `azure.archive.ubuntu.com`, versus "Fetched 25.9 MB in 1s" in healthy runs. The Playwright browser download from `cdn.playwright.dev` took 5-10 s in every run, slow or not. The only packages apt actually added were fonts and X font utilities (every Chromium shared library was already "the newest version" on `ubuntu-latest`). The job's 30-minute timeout was too long to fail fast.

## Decision
- Run `pnpm exec playwright install chromium` without `--with-deps`. The runner image already has Chromium's shared libraries; the skipped apt packages are fonts only.
- Split install, build and test into separate steps with `timeout-minutes` 5 / 5 / 8, and lower the job timeout from 30 to 20 minutes, so a stall fails in minutes and names the step.
- No new third-party action (no browser cache): the CDN download was never the slow part, so `actions/cache` would add a pin to maintain for about 10 s of saving.

## Consequences
- The apt mirror is no longer on the CI critical path; the e2e step takes about 20-30 s.
- Fewer system fonts in CI. Irrelevant to the extension e2e tests (no screenshots/visual comparisons); revisit if visual diffs are added.
- If a future `ubuntu-latest` image drops a Chromium library, the Playwright launch fails loudly and `--with-deps` (or `playwright install-deps`) can be reinstated for that case.

## Status
Accepted.
