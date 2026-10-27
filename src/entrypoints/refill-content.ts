// Content script (WXT unlisted script, registered manually by src/lib/sites/reconcile.ts; ADR 0018).
// Stub for now: sends nothing and reads nothing from the page. Only the e2e build marks the
// document so specs can detect that the script ran; `MODE` is folded at build time, so the
// production bundle contains no trace of it (scripts/check-no-seams.mjs enforces that).
export default defineUnlistedScript(() => {
  if (import.meta.env.MODE === "e2e") {
    const root = document.documentElement;
    root.dataset.refillLoaded = "1";
    root.dataset.refillSeam = "__refillE2E"; // seam marker: keeps this block detectable in a production build
  }
});
