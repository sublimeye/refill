# ADR 0009: CI installs Playwright Chromium without `--with-deps`, with step timeouts

## Context
The `verify` job intermittently hung for 12-15 minutes in the e2e step on PR runs (PRs #4, #5, #7), with no output, then passed on re-run in about 2 minutes. Logs of the slow runs (e.g. run 40391896790: 906 s, run 40389536781: 745 s) show the time is spent inside `playwright install --with-deps chromium`, in the `apt-get install` it triggers: "Fetched 25.0 MB in 14min 38s (28.5 kB/s)" from `azure.archive.ubuntu.com`, versus "Fetched 25.9 MB in 1s" in healthy runs. The Playwright browser download from `cdn.playwright.dev` took 5-10 s in every run, slow or not. The apt run added fonts and X font utilities (9 new packages) and upgraded 8 already-installed ones, among them `libnss3`, `libglib2.0-0t64` and `xvfb`; the other Chromium shared libraries were already "the newest version". So the image's libraries were not current, and dropping `--with-deps` depends on the stock versions being good enough for Chromium 156. That was checked, not assumed: on 2026-10-26 a temporary CI step (run 40396180181, since removed) launched Chromium 156.0.8078.4 (Playwright 1.64.1) with plain `chromium.launch()`, headless and headed (under xvfb), without `--with-deps` on `ubuntu-24.04` image 20261012.334.1 (runner build date 2026-10-21). The permanent spec uses a different path (`launchPersistentContext`, `channel: "chromium"`, headless, extension loaded) and passes on the same setup (run 40397506797). The job's 30-minute timeout was too long to fail fast.

## Decision
- Run `pnpm exec playwright install chromium` without `--with-deps`. The runner image's stock Chromium libraries are sufficient (see Context); what is skipped is fonts plus library upgrades; launch works without them (see Context).
- Split install, build and test into separate steps with `timeout-minutes` 5 / 5 / 8, and lower the job timeout from 30 to 20 minutes, so a stall fails in minutes and names the step.
- `tests/e2e/smoke.spec.ts` is a permanent launch guard: it starts Chromium with the built extension and checks the service worker's host equals the pinned `EXTENSION_ID`. Without it nothing in CI launches Chromium while there are no real specs.
- No new third-party action (no browser cache): the CDN download was never the slow part, so `actions/cache` would add a pin to maintain for about 10 s of saving.

## Consequences
- The apt mirror is no longer on the CI critical path; the install step takes about 6-9 s and the e2e step (one smoke spec) about 2-3 s.
- The step timeouts bound only the three steps (install, build, e2e); the other steps (install, Semgrep image pull, OSV, audit) are bounded by the 20-minute job cap alone.
- Revisit the 8-minute e2e cap when the Task 11 specs land (`workers: 1`, `fullyParallel: false`, so run time grows linearly): re-set it to a few times the healthy duration, or once the suite passes about 3 minutes.
- Fewer system fonts in CI. Irrelevant to the extension e2e tests (no screenshots/visual comparisons); revisit if visual diffs are added.
- If a future `ubuntu-latest` image drops a Chromium library, the smoke spec fails (headless path only; the headed-under-xvfb launch was checked once and has no permanent guard) and `--with-deps` (or `playwright install-deps`) can be reinstated for that case.

## Status
Accepted.
