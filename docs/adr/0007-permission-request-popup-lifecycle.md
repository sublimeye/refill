# ADR 0007: Popup does no work after `permissions.request`; the service worker completes the flow

## Context
Site enablement (spec §3.1) starts in the action popup, which calls `chrome.permissions.request` (it needs a user gesture). The browser permission dialog can take focus from the popup and close it, which would kill any code waiting after the `await`. M0 probe (c) tested this in Brave 1.97.56 (Chromium 155.0.8059.40, macOS 27.0.1): the probe wrote a `before` marker, awaited `permissions.request`, then tried to write an `after` marker. Only `before` was present (`{"before":1793043521461}`). Code after the await did not run. The expected cause per spec §3.1 is the popup closing when the permission dialog takes focus; this was not directly observed (the evidence is only the missing `after` marker). See `docs/spikes/m0-results.md`.

## Decision
Keep the spec §3.1 design:
- The popup writes `pendingIntent {tabId, origin, kind, ts}` to `storage.session` first (expires after 2 minutes), then calls `permissions.request`, and does nothing after the await.
- The service worker consumes the pending intent in `permissions.onAdded` and completes the work: dynamic content script registration, `scripting.executeScript` into the tab, then recording or drafts.
- If `permissions.contains` is already true, `onAdded` will not fire, so the popup sends `intent-execute` to the service worker directly.

## Consequences
- No popup code may depend on the `permissions.request` promise resolving. Any UI feedback comes from the service worker's state (badge, toast) or the next popup open.
- `pendingIntent` must be written before the request and must survive a closed popup; the 2-minute expiry limits stale intents.
- Result measured only in Brave on macOS. Other browsers may keep the popup open, which is harmless under this design.

## Status
Accepted (2026-10-26).
