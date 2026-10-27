// Control eligibility (spec 5.2), shared by record and fill. DOM-only, zero runtime dependencies:
// this runs in the content script. Page content is hostile: the ancestor walk is bounded and every
// failure (including a throwing page getter) reads as ineligible.

import {
  boundingRect,
  clientHeight,
  clientLeft,
  clientTop,
  clientWidth,
  getAttr,
  hasAttr,
  localName,
  nodeType,
  parentNode,
  scrollHeight,
  scrollTop,
  scrollWidth,
} from "./dom";
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
// A scroll container whose client box is smaller than this shows no usable slice of anything (a
// classic scrollbar alone takes up to 15px, so a 4x4 `overflow:auto` box paints nothing): a field
// inside it is a decoy.
const MIN_CONTAINER_SIDE = 8;
// A real page nests a few dozen levels at most; a deeper chain is hostile or broken, so fail closed.
const MAX_ANCESTORS = 512;

// localName and nodeType rather than `instanceof`: those fail for nodes from another realm (a frame).
export function controlKind(el: Element): ControlKind | null {
  switch (localName(el)) {
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
  // Accessors, not properties: an ancestor can be a <form> whose named controls shadow them (dom.ts).
  const parent = parentNode(node);
  if (parent === null) return null;
  const type = nodeType(parent);
  if (type === Node.ELEMENT_NODE) return parent;
  if (type === Node.DOCUMENT_FRAGMENT_NODE && "host" in parent) {
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
      hasAttr(e, "inert") ||
      (getAttr(e, "aria-hidden") ?? "").trim().toLowerCase() === "true"
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

// Text-entry types whose transparent text is a known styling pattern (hiding the empty `mm/dd/yyyy`
// placeholder under a floating label), so the transparent-text rule does not apply to them.
const TRANSPARENT_TEXT_OK_TYPES = new Set([
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
]);

const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll", "overlay"]);

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface AncestorInfo {
  /** Effective opacity below MIN_OPACITY (product of `opacity` and `filter: opacity()`). */
  faint: boolean;
  /** Fully transparent text on a fully transparent background, on the element itself. */
  transparentText: boolean;
  /** Scrolling ancestors that actually overflow, innermost first (never `html`, nor the document's own scroller). */
  containers: Element[];
}

/** `html`'s own overflow is not `visible` in both axes, so `body`'s overflow stays on `body`. */
function bodyScrolls(doc: Document, win: Window): boolean {
  const cs = win.getComputedStyle(doc.documentElement);
  return cs.overflowX !== "visible" || cs.overflowY !== "visible";
}

/**
 * One bounded pass (<= MAX_ANCESTORS, one `getComputedStyle` per node) over `el` and its ancestors:
 * effective opacity, the element's own transparent-text state, and the scroll containers.
 */
function inspectAncestors(
  el: Element,
  doc: Document,
  win: Window,
): AncestorInfo {
  const info: AncestorInfo = {
    faint: false,
    transparentText: false,
    containers: [],
  };
  let product = 1;
  let node: Node | null = el;
  for (let depth = 0; node !== null && depth <= MAX_ANCESTORS; depth++) {
    const e = node as Element;
    const cs = win.getComputedStyle(e);
    const opacity = Number.parseFloat(cs.opacity);
    if (!Number.isNaN(opacity)) product *= opacity;
    product *= filterOpacity(cs.filter);
    if (product < MIN_OPACITY) {
      info.faint = true;
      return info;
    }
    if (node === el) {
      info.transparentText =
        transparentColor(cs.color) &&
        transparentColor(cs.backgroundColor) &&
        cs.backgroundImage === "none";
    } else if (
      e !== doc.documentElement &&
      e !== doc.scrollingElement &&
      (e !== doc.body || bodyScrolls(doc, win))
    ) {
      // The document's own scrolling is the document rule's business. `body` is its own scroller
      // only when `html` stops its overflow from propagating to the viewport (`html{overflow:hidden}`
      // or `html,body{overflow:auto}` app shells, standards or quirks mode).
      const y =
        SCROLLABLE_OVERFLOW.has(cs.overflowY) &&
        scrollHeight(e) > clientHeight(e);
      const x =
        SCROLLABLE_OVERFLOW.has(cs.overflowX) &&
        scrollWidth(e) > clientWidth(e);
      if (x || y) info.containers.push(e);
    }
    node = parentOf(node);
  }
  return info;
}

interface Region {
  /** Viewport intersected with every container's client box: where the box can be seen. */
  view: Rect;
  /** Every container's client box (unbounded without containers): what clips the box. */
  clip: Rect;
}

/**
 * Off-canvas test (P10 + P12). `box` must lie inside every scrolling ancestor: vertically anywhere
 * in its scroll height, horizontally within its currently visible slice `[0, clientWidth]` (so the
 * visible carousel slide counts and off-screen slides do not); the outermost such box then has to
 * pass the document rule. Without scrolling ancestors that is the control itself. A container
 * smaller than MIN_CONTAINER_SIDE on either side shows nothing, so it rejects. Returns the visible and
 * clipping regions, or null.
 */
function paintedRegion(
  box: Rect,
  containers: Element[],
  doc: Document,
  win: Window,
): Region | null {
  const scroller = doc.scrollingElement;
  const viewW = scroller?.clientWidth ?? win.innerWidth;
  const viewH = scroller?.clientHeight ?? win.innerHeight;
  const scrollH = (scroller ?? doc.documentElement).scrollHeight;
  const view: Rect = { left: 0, top: 0, right: viewW, bottom: viewH };
  const clip: Rect = {
    left: -Infinity,
    top: -Infinity,
    right: Infinity,
    bottom: Infinity,
  };
  // Degenerate (sr-only, 0-sized) boxes still need a position: give them a 1px extent.
  let cur: Rect = {
    left: box.left,
    top: box.top,
    right: Math.max(box.right, box.left + 1),
    bottom: Math.max(box.bottom, box.top + 1),
  };
  for (const c of containers) {
    const cw = clientWidth(c);
    const ch = clientHeight(c);
    if (cw < MIN_CONTAINER_SIDE || ch < MIN_CONTAINER_SIDE) {
      return null;
    }
    const cr = boundingRect(c);
    const originX = cr.left + clientLeft(c);
    const originY = cr.top + clientTop(c);
    const x = cur.left - originX;
    const y = cur.top - originY + scrollTop(c);
    if (
      x + (cur.right - cur.left) <= 0 ||
      x >= cw ||
      y + (cur.bottom - cur.top) <= 0 ||
      y >= scrollHeight(c)
    ) {
      return null;
    }
    for (const r of [view, clip]) {
      r.left = Math.max(r.left, originX);
      r.top = Math.max(r.top, originY);
      r.right = Math.min(r.right, originX + cw);
      r.bottom = Math.min(r.bottom, originY + ch);
    }
    cur = cr;
  }
  // Document rule on the outermost box: horizontally overlap [0, viewport width] in document
  // coordinates (a right-parked box grows scrollWidth by itself, so scrollWidth proves nothing);
  // vertically anywhere within the scroll height (a long page is legitimate).
  const docLeft = cur.left + win.scrollX;
  const docTop = cur.top + win.scrollY;
  if (
    docLeft + (cur.right - cur.left) <= 0 ||
    docLeft >= viewW ||
    docTop + (cur.bottom - cur.top) <= 0 ||
    docTop >= scrollH
  ) {
    return null;
  }
  return { view, clip };
}

/** The part of `rect` inside `bounds`, or null when it is empty. */
function intersect(rect: Rect, bounds: Rect): Rect | null {
  const out: Rect = {
    left: Math.max(rect.left, bounds.left),
    top: Math.max(rect.top, bounds.top),
    right: Math.min(rect.right, bounds.right),
    bottom: Math.min(rect.bottom, bounds.bottom),
  };
  return out.right > out.left && out.bottom > out.top ? out : null;
}

/**
 * False when a container clips `rect` down to a sliver (< MIN_SIDE square). A box scrolled entirely
 * out of its container (reachable by scrolling) has nothing painted to judge and passes.
 */
function unclippedEnough(rect: Rect, region: Region): boolean {
  const part = intersect(rect, region.clip);
  return (
    part === null ||
    (part.right - part.left >= MIN_SIDE && part.bottom - part.top >= MIN_SIDE)
  );
}

/**
 * `elementFromPoint` at the centre of the visible part of `rect`; true when that is `target`, a
 * descendant, or `alsoOk`. Nothing visible (below the fold, off to the side) leaves nothing to test.
 */
function hitTest(
  target: Element,
  rect: Rect,
  region: Region,
  doc: Document,
  alsoOk: Element | null,
): boolean {
  const vis = intersect(rect, region.view);
  if (vis === null) return true;
  // Inside a shadow tree the document-level hit is retargeted to the host, which cannot tell the
  // target from a sibling covering it, so ask the target's own root.
  const root = target.getRootNode();
  const hitRoot =
    root.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? (root as ShadowRoot) : doc;
  const hit = hitRoot.elementFromPoint(
    (vis.left + vis.right) / 2,
    (vis.top + vis.bottom) / 2,
  );
  return (
    hit !== null && (hit === target || target.contains(hit) || hit === alsoOk)
  );
}

const FULL_VISIBILITY = {
  opacityProperty: true,
  visibilityProperty: true,
  contentVisibilityAuto: true,
} as const;

/**
 * A label can stand in for a custom-styled checkbox or radio (P13) when it passes the checks a
 * control would: visible, >= 4x4, not faint, not transparent text on a transparent background,
 * positioned, >= 4x4 unclipped by containers, and hit-tested where it is in the viewport (the control
 * itself may sit on top of it). A label below the fold cannot be hit-tested: accepted residual.
 */
function labelVisible(
  label: Element,
  control: FormControl,
  doc: Document,
  win: Window,
): boolean {
  if (!reachable(label)) return false;
  if (!label.checkVisibility(FULL_VISIBILITY)) return false;
  const rect = label.getBoundingClientRect();
  if (rect.width < MIN_SIDE || rect.height < MIN_SIDE) return false;
  const info = inspectAncestors(label, doc, win);
  if (info.faint || info.transparentText) return false;
  const region = paintedRegion(rect, info.containers, doc, win);
  return (
    region !== null &&
    unclippedEnough(rect, region) &&
    hitTest(label, rect, region, doc, control)
  );
}

const MAX_LABELS = 16;

function hasVisibleLabel(
  control: FormControl,
  doc: Document,
  win: Window,
): boolean {
  const labels = control.labels;
  if (labels === null) return false;
  for (let i = 0; i < Math.min(labels.length, MAX_LABELS); i++) {
    const label = labels[i];
    if (label !== undefined && labelVisible(label, control, doc, win))
      return true;
  }
  return false;
}

/**
 * Spec 5.2. Cheap checks first; `checkVisibility` and `getBoundingClientRect` run once each and
 * `elementFromPoint` only when the box is in the viewport. Never throws. Beyond the spec's literal
 * list it also rejects near-invisible styling and parked boxes, per scroll container (ADR 0020).
 *
 * A native checkbox or radio that fails only the opacity, size or hit-test checks (the custom-styled
 * control pattern) is still eligible when one of its labels is visible; the fill clicks it through
 * the label. Selects and text controls stay strict.
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
    const kind = controlKind(el);
    if (kind === null) return false;
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

    const toggle = kind === "checkbox" || kind === "radio";
    // Set when a check fails that a visible label can make up for (toggles only).
    let needsLabel = false;
    if (!control.checkVisibility(FULL_VISIBILITY)) {
      // `opacity: 0` is the custom-control pattern; display:none, visibility and content-visibility are not.
      if (
        !toggle ||
        !control.checkVisibility({
          visibilityProperty: true,
          contentVisibilityAuto: true,
        })
      ) {
        return false;
      }
      needsLabel = true;
    }

    const rect = control.getBoundingClientRect();
    if (rect.width < MIN_SIDE || rect.height < MIN_SIDE) {
      if (!toggle) return false;
      needsLabel = true;
    }

    const info = inspectAncestors(control, doc, win);
    if (info.faint) {
      if (!toggle) return false;
      needsLabel = true;
    }
    if (info.transparentText && !toggle) {
      const type = (control as HTMLInputElement).type;
      if (!TRANSPARENT_TEXT_OK_TYPES.has(type)) return false;
    }
    const region = paintedRegion(rect, info.containers, doc, win);
    if (region === null) return false;

    if (!needsLabel) {
      // A decoy shrunk by a tiny scroll container paints a sliver that would pass the hit test.
      if (!unclippedEnough(rect, region)) {
        if (!toggle) return false;
        needsLabel = true;
      } else if (!hitTest(control, rect, region, doc, null)) {
        if (!toggle) return false;
        needsLabel = true;
      }
    }
    return !needsLabel || hasVisibleLabel(control, doc, win);
  } catch {
    return false;
  }
}
