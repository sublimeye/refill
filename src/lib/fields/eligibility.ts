// Control eligibility (spec 5.2), shared by record and fill. DOM-only, zero runtime dependencies:
// this runs in the content script. Page content is hostile: the ancestor walk is bounded and every
// failure (including a throwing page getter) reads as ineligible.

import type { FormControl } from "./signature";

export type ControlKind = "text" | "select" | "checkbox" | "radio";

const TEXT_INPUT_TYPES = new Set([
  "text",
  "email",
  "tel",
  "number",
  "date",
  "search",
  "url",
]);

const MIN_SIDE = 4;
// A real page nests a few dozen levels at most; a deeper chain is hostile or broken, so fail closed.
const MAX_ANCESTORS = 512;

// localName and nodeType rather than `instanceof`: those fail for nodes from another realm (a frame).
export function controlKind(el: Element): ControlKind | null {
  switch (el.localName) {
    case "textarea":
      return "text";
    case "select":
      return "select";
    case "input": {
      const type = (el as HTMLInputElement).type;
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return TEXT_INPUT_TYPES.has(type) ? "text" : null;
    }
    default:
      return null;
  }
}

/**
 * True if neither `el` nor any ancestor (crossing shadow boundaries) is `[inert]` or
 * `[aria-hidden="true"]`. Attribute reads only; more than MAX_ANCESTORS levels reads as hidden.
 */
function reachable(el: Element): boolean {
  let node: Node | null = el;
  for (let depth = 0; node !== null; depth++) {
    if (depth > MAX_ANCESTORS) return false;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const e = node as Element;
      if (e.hasAttribute("inert") || e.getAttribute("aria-hidden") === "true") {
        return false;
      }
      node = e.parentNode;
    } else if (
      node.nodeType === Node.DOCUMENT_FRAGMENT_NODE &&
      "host" in node
    ) {
      node = (node as ShadowRoot).host;
    } else {
      node = null; // Document or fragment: top of the walk
    }
  }
  return true;
}

/**
 * Spec 5.2. Cheap checks first; `checkVisibility` and `getBoundingClientRect` run once each and
 * `elementFromPoint` only when the box is in the viewport. Never throws.
 *
 * `isTopWindow` exists for tests only: Vitest browser mode runs every test inside an iframe, where the
 * default (`win === win.top`) is always false.
 *
 * Deviation worth knowing: when the box is only partly in the viewport the hit test uses the center
 * of the visible part (the true center may be off-screen, where `elementFromPoint` returns null).
 */
export function isEligible(
  el: Element,
  doc: Document = el.ownerDocument,
  isTopWindow: (win: Window) => boolean = (win) => win === win.top,
): boolean {
  try {
    if (controlKind(el) === null) return false;
    const control = el as FormControl;
    if (!control.isConnected || control.ownerDocument !== doc) return false;
    const win = doc.defaultView;
    if (win === null || !isTopWindow(win)) return false;
    if (control.matches(":disabled")) return false; // also true under a disabled <fieldset>
    if (!(control instanceof HTMLSelectElement) && control.readOnly)
      return false;
    if (!reachable(control)) return false;
    if (
      !control.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
        contentVisibilityAuto: true,
      })
    ) {
      return false;
    }

    const rect = control.getBoundingClientRect();
    if (rect.width < MIN_SIDE || rect.height < MIN_SIDE) return false;

    const scroller = doc.scrollingElement ?? doc.documentElement;
    const docLeft = rect.left + win.scrollX;
    const docTop = rect.top + win.scrollY;
    if (
      docLeft + rect.width <= 0 ||
      docTop + rect.height <= 0 ||
      docLeft >= scroller.scrollWidth ||
      docTop >= scroller.scrollHeight
    ) {
      return false;
    }

    const viewW = doc.documentElement.clientWidth;
    const viewH = doc.documentElement.clientHeight;
    const visLeft = Math.max(rect.left, 0);
    const visTop = Math.max(rect.top, 0);
    const visRight = Math.min(rect.right, viewW);
    const visBottom = Math.min(rect.bottom, viewH);
    if (visRight <= visLeft || visBottom <= visTop) return true; // below the fold or off to the side

    // Inside a shadow tree the document-level hit is retargeted to the host, which cannot tell the
    // control from a sibling covering it, so ask the control's own root.
    const root = control.getRootNode();
    const hitRoot =
      root.nodeType === Node.DOCUMENT_FRAGMENT_NODE
        ? (root as ShadowRoot)
        : doc;
    const hit = hitRoot.elementFromPoint(
      (visLeft + visRight) / 2,
      (visTop + visBottom) / 2,
    );
    return hit !== null && (hit === control || control.contains(hit));
  } catch {
    return false;
  }
}
