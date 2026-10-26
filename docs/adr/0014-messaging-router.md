# 0014 — Messaging router details

## Context

Task 10 adds the typed page-to-service-worker protocol and a sender-validated router (spec §7). The plan fixes the types, `classifySender` and the rejection rule. This ADR records the choices it leaves open.

## Decision

- **`sendResponse` and `return true`, not a returned Promise.** In Chrome, WXT's `browser` is the `chrome` object (it only differs where a `browser` global with a runtime id exists, as in Firefox), and Chrome ignores a Promise returned from an `onMessage` listener. The router itself returns a Promise, as the plan specifies; `toRuntimeListener` adapts it: it calls `sendResponse` when the Promise settles and returns `true`, which keeps the channel open for that one answer. A real-Chromium e2e test (`smoke.spec.ts`) sends messages from the popup page and checks the answers, including a rejection.
- **Rejected messages are answered, not dropped.** Oversized, unserializable (`JSON.stringify` throws or returns `undefined`), unclassified, wrong-kind and unparseable messages resolve `{ ok: false, error: "rejected" }` at once, so no channel stays open and a caller cannot tell why. `MAX_MESSAGE_CHARS` (renamed from `MAX_MESSAGE_BYTES` in ADR 0015) is compared with the JSON string length, as the plan says; the per-string cap (1024 UTF-16 units) bounds the real payload anyway.
- **Handler failures are generic.** A handler that throws or rejects resolves `{ ok: false, error: "internal" }`. The log line holds the request type and the error's `name` only, never its message or stack.
- **Strict parsing.** `parsePageRequest` accepts only a plain object (prototype `Object.prototype` or `null`) with exactly the keys of its type, and returns a fresh object. A `now` or any other extra key is a rejection, so a timestamp from a message can never reach the vault (ADR 0012, ADR 0013). Handlers also never pass a `now`.
- **Page classification.** An extension page opened as a tab is a page: `sender.tab.url` starts with the extension prefix. A tab with no `url`, or an extension page framed inside a web page (`tab.url` is the web page), is not a page. Content classification is implemented and tested, but `ContentRequest` is `never`, so the router rejects every content-classified message until Plan 2 adds handlers.
- **Router errors are not part of `PageResponse`.** `PageResponse<R>` is exactly the handler's result (`VaultStatus`, the create result, `UnlockResult`, `{ ok: true }`). `sendToSw` instead rejects with `MessagingError` (code `rejected` or `internal`) when the router answered with one of those errors or sent no object back. Callers then handle real outcomes (`exists`, `weak`, `wrong-passphrase`, `backoff`) as values and transport failures as exceptions, without a widened union on every call site.
- **Handlers live in `page-handlers.ts`,** built by `createPageHandlers(calibrate)`, so the `exists` / `weak` mapping and the vault wiring are tested with the fast floor KDF while `background.ts` passes the real `calibrate`. `vault-create` maps `Error("exists")` and `Error("weak")`; any other failure (for example a `RangeError`) propagates and becomes `internal`.
- **Runtime id read at call time** (`browser.runtime.id`), so `createRouter` keeps the plan's signature.

## Consequences

- ~~`vault-create` runs `calibrate()` before the vault checks strength.~~ Superseded by ADR 0015: the handler now checks `status()` and the minimum length first, so an invalid create never calibrates.
- The listener is registered synchronously at worker top level, after `setAccessLevel` and `installLockTriggers`, with no `await` before it.
- There is no `onMessageExternal` listener, matching the empty `externally_connectable`.

## Status

Accepted
