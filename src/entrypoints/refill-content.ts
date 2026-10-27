// Content script (WXT unlisted script, registered manually by src/lib/sites/reconcile.ts; ADR 0018).
// Scans the page, reports signatures to the service worker and applies its fill plan; the logic is
// in src/lib/content/runner.ts (ADR 0026). Top frame only, https only, once per document.
import { captureChrome } from "../lib/content/chrome-api";
import { startContentScript } from "../lib/content/runner";

export default defineUnlistedScript(() => {
  // The registration says allFrames: false, but executeScript can still reach a frame.
  if (window !== window.top) return;
  if (location.protocol !== "https:") return;
  // `chrome`, not WXT's `browser`: page markup can stand in for `browser` through window named
  // access. `chrome` is checked anyway; anything but the real API is refused (fail closed).
  const api = captureChrome((globalThis as { chrome?: unknown }).chrome);
  if (api === null) return;
  // `globalThis` is this script's isolated world: a registered script and an executeScript after
  // enable share it, and page code cannot see or pre-set anything on it.
  const run = startContentScript(globalThis, {
    win: window,
    doc: document,
    origin: location.origin,
    send: api.send,
    alive: api.alive,
    openOrClosedShadowRoot: api.openOrClosedShadowRoot,
  });
  if (run !== null && import.meta.env.MODE === "e2e") {
    const root = document.documentElement;
    root.dataset.refillLoaded = "1";
    root.dataset.refillSeam = "__refillE2E"; // seam marker: keeps this block detectable in a production build
  }
});
