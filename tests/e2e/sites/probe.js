// Page-side observations for specs, independent of the extension: whether this document was
// prerendered (and later activated), and whether the first `input` event on any field arrived while
// the document was still prerendering.
const root = document.documentElement;
root.dataset.prerendered = document.prerendering ? "pending" : "false";
document.addEventListener("prerenderingchange", () => {
  root.dataset.prerendered = "true";
});
document.addEventListener(
  "input",
  () => {
    root.dataset.inputWhilePrerendering ??= String(document.prerendering);
  },
  true,
);
