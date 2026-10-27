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

/** Parent in the flat walk: crosses shadow roots to their host; null at the document (or a detached root). */
function parentOf(node: Node): Node | null {
  const parent = node.parentNode;
  if (parent === null) return null;
  if (parent.nodeType === Node.ELEMENT_NODE) return parent;
  if (parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE && "host" in parent) {
    return (parent as ShadowRoot).host;
  }
  return null;
}

/**
 * True if neither `el` nor any ancestor (crossing shadow boundaries) is `[inert]` or
 * `[aria-hidden="true"]` (case- and whitespace-insensitive, as the accessibility tree reads it).
 * Attribute reads only; more than MAX_ANCESTORS levels reads as hidden.
 */
function reachable(el: Element): boolean {
  let node: Node | null = el;
  for (let depth = 0; node !== null; depth++) {
    if (depth > MAX_ANCESTORS) return false;
    const e = node as Element;
    if (
      e.hasAttribute("inert") ||
      (e.getAttribute("aria-hidden") ?? "").trim().toLowerCase() === "true"
    ) {
      return false;
    }
    node = parentOf(node);
  }
  return true;
}

// Below this, a field is treated as invisible (`checkVisibility` only rejects exactly 0, so
// `opacity: 0.01` would pass it).
const MIN_OPACITY = 0.1;

/** Product of the `opacity(<n>)` functions in a computed `filter` value (1 when there are none). */
function filterOpacity(filter: string): number {
  let factor = 1;
  for (const m of filter
    .slice(0, 2048)
    .matchAll(/opacity\(\s*([0-9.]+)\s*(%?)\s*\)/g)) {
    const n = Number(m[1]);
    if (!Number.isNaN(n)) factor *= m[2] === "%" ? n / 100 : n;
  }
  return factor;
}

const ALPHA_ZERO_RE = /^rgba\(.*,\s*0(?:\.0*)?\)$|\/\s*0(?:\.0*)?%?\s*\)$/;

/** Computed color with alpha 0 (Chromium serializes `transparent` as `rgba(0, 0, 0, 0)`). */
function transparentColor(color: string): boolean {
  const c = color.slice(0, 128).trim().toLowerCase();
  return c === "transparent" || ALPHA_ZERO_RE.test(c);
}

/**
 * Near-invisible styling that `checkVisibility` accepts: effective opacity (the product of
 * `opacity` and any `filter: opacity()` along the bounded ancestor chain) below MIN_OPACITY, or a
 * text-entry control with fully transparent text, background color and no background image. One
 * `getComputedStyle` per ancestor.
 */
function nearlyInvisible(control: FormControl, win: Window): boolean {
  let product = 1;
  let node: Node | null = control;
  for (let depth = 0; node !== null && depth <= MAX_ANCESTORS; depth++) {
    const cs = win.getComputedStyle(node as Element);
    const opacity = Number.parseFloat(cs.opacity);
    if (!Number.isNaN(opacity)) product *= opacity;
    product *= filterOpacity(cs.filter);
    if (product < MIN_OPACITY) return true;
    if (
      node === control &&
      controlKind(control) !== "checkbox" &&
      controlKind(control) !== "radio" &&
      transparentColor(cs.color) &&
      transparentColor(cs.backgroundColor) &&
      cs.backgroundImage === "none"
    ) {
      return true;
    }
    node = parentOf(node);
  }
  return false;
}

/**
 * Spec 5.2. Cheap checks first; `checkVisibility` and `getBoundingClientRect` run once each and
 * `elementFromPoint` only when the box is in the viewport. Never throws. Beyond the spec's literal
 * list it also rejects near-invisible styling (ADR 0020).
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
    if (
      control.localName !== "select" &&
      (control as HTMLInputElement).readOnly
    ) {
      return false;
    }
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

    // The scrolling element reports the viewport in both modes: in quirks mode `documentElement`
    // reports the document's height instead.
    const scroller = doc.scrollingElement ?? doc.documentElement;
    const viewW = scroller.clientWidth;
    const viewH = scroller.clientHeight;
    // Horizontal: the box must overlap [0, viewport width] in document coordinates; anything past it
    // is parked (`left: 9999px` grows the scroll width by itself, so scrollWidth proves nothing).
    // Vertical: anywhere within the document's scroll height (a long page is legitimate).
    const docLeft = rect.left + win.scrollX;
    const docTop = rect.top + win.scrollY;
    if (
      docLeft + rect.width <= 0 ||
      docLeft >= viewW ||
      docTop + rect.height <= 0 ||
      docTop >= scroller.scrollHeight
    ) {
      return false;
    }

    if (nearlyInvisible(control, win)) return false;

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
