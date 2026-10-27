// Content script (WXT unlisted script, registered manually by src/lib/sites/reconcile.ts; ADR 0018).
// Scans the page, reports signatures to the service worker and applies its fill plan; the logic is
// in src/lib/content/runner.ts (ADR 0026). Top frame only, https only, once per document.
import { browser } from "wxt/browser";
import { startContentScript } from "../lib/content/runner";
import type { ContentRequest } from "../lib/messaging/content-protocol";

/** `dom.openOrClosedShadowRoot` (Chrome 88+), so the scanner also sees closed shadow roots. */
function closedRootReader(): ((el: Element) => ShadowRoot | null) | undefined {
  const dom = (
    browser as unknown as {
      dom?: { openOrClosedShadowRoot?(el: HTMLElement): ShadowRoot | null };
    }
  ).dom;
  if (typeof dom?.openOrClosedShadowRoot !== "function") return undefined;
  return (el) => {
    try {
      return dom.openOrClosedShadowRoot!(el as HTMLElement) ?? null;
    } catch {
      return null;
    }
  };
}

export default defineUnlistedScript(() => {
  // The registration says allFrames: false, but executeScript can still reach a frame.
  if (window !== window.top) return;
  if (location.protocol !== "https:") return;
  // `globalThis` is this script's isolated world: a registered script and an executeScript after
  // enable share it, and page code cannot see or pre-set anything on it.
  const run = startContentScript(globalThis, {
    win: window,
    doc: document,
    origin: location.origin,
    send: (msg: ContentRequest) => browser.runtime.sendMessage(msg),
    alive: () => browser.runtime?.id !== undefined,
    openOrClosedShadowRoot: closedRootReader(),
  });
  if (run !== null && import.meta.env.MODE === "e2e") {
    const root = document.documentElement;
    root.dataset.refillLoaded = "1";
    root.dataset.refillSeam = "__refillE2E"; // seam marker: keeps this block detectable in a production build
  }
});
