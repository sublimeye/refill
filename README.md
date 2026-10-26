# Refill

Private, encrypted form memory for Chromium (Manifest V3). Everything stays on your machine: no network, no sync, no telemetry.

Status: early development. See `docs/superpowers/specs/2026-10-26-refill-design.md` for the design and `docs/adr/` for decisions.

## Develop

```sh
pnpm install
pnpm dev            # WXT dev build with HMR
pnpm build          # production build to .output/chrome-mv3
pnpm test           # unit tests
pnpm test:manifest  # build, then check the manifest against security/manifest.expected.json
```

Load `.output/chrome-mv3` as an unpacked extension from `chrome://extensions`.

## License

MIT
