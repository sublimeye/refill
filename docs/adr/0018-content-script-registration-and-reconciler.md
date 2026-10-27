# ADR 0018: Content-script registration and permission reconciler

## Context
Refill must run a content script only on origins the user enabled, with no install-time host access (production manifest: `content_scripts` empty, `host_permissions` empty, `optional_host_permissions` `https://*/*`). WXT's own runtime-registration helpers for content scripts add required host permissions to the manifest (WXT issue #2239), which would break that. Host permissions can also change outside Refill (the user revokes access in the browser's extension menu), and the service worker can be woken by the grant event with the popup already gone (ADR 0007).

## Decision
- The script is a WXT *unlisted script* (`src/entrypoints/refill-content.ts`, built to `/refill-content.js`) and is registered manually with `scripting.registerContentScripts`. Exactly one registration id, `refill-content`, with `allFrames: false`, `runAt: "document_idle"`, `world: "ISOLATED"`, `persistAcrossSessions: true`, and `matches` = `<origin>/*` for every origin that has a site record AND a granted host permission. No origins desired means no registration.
- `reconcile()` computes that set from `permissions.contains` (the source of truth, failing closed), flags site records `accessRevoked` when the permission is missing (and clears the flag when it returns, data kept), and registers, updates or unregisters. It runs on `onInstalled`, `onStartup`, `permissions.onAdded` and `permissions.onRemoved`, and after `site-enable` / `site-remove`.
- Reconciles are serialized and coalesced: one run at a time; any number of calls arriving mid-run share one follow-up run. Two concurrent runs could both call `registerContentScripts` for the same id, which Chrome rejects with "Duplicate script ID".
- A registration only affects pages loaded later, so after a grant the service worker also calls `scripting.executeScript({ target: { tabId }, files: ["/refill-content.js"] })` into the tab named by the pending intent (`onAdded` path) or by the request (`site-enable`, the already-granted path). Failures (tab closed, not https, navigated away) are swallowed and logged by error name only.
- `site-remove` deletes the site record and its `p:<id>` profile record by key (no decryption, works while locked), then calls `permissions.remove`. A failure there is non-fatal: required permissions (the e2e build pre-grants `https://localhost/*`) and already-removed ones cannot be removed, and the reconciler stops matching an origin with no record regardless.
- The popup-side helper `requestSiteEnable` writes the intent (`site-intent` request) before `permissions.request` and does nothing after the await (ADR 0007).
- The content-script stub marks `document.documentElement` (`data-refill-loaded="1"`) only when `import.meta.env.MODE === "e2e"`; the marker `__refillE2E` is in that block so `scripts/check-no-seams.mjs` proves it is absent from the production build.

## Consequences
- Production manifest is unchanged; granting and revoking both converge through the one reconciler.
- A change made while a reconcile runs triggers exactly one more run, never a concurrent one.
- Verified in real Chromium (e2e): `site-enable` marks an open tab without reload, a reload gets the script from the registration, and `site-remove` stops it.
- `accessRevoked` is only updated on reconcile triggers; between a revocation and its `onRemoved` event the flag can lag briefly.

## Status
Accepted (2026-10-26).
