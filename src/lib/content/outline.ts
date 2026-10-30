// The `ask` outline (spec 6.3): a field whose policy is Ask stays empty and gets a subtle outline
// until the user types in it. The page is hostile: the outline is two inline declarations set
// `important` through CSSOM (no style attribute, no stylesheet), every DOM member is captured from
// the prototypes at import time, and nothing throws. The page's own inline outline is saved first
// and put back on release. Decisions: ADR 0036.

import { getter } from "../fields/dom";
import type { FormControl } from "../fields/signature";

export interface Outlines {
  /** Outlines `el` (once per element). False when it already was or the write failed. */
  add(el: FormControl): boolean;
  /** True while `el` is outlined. */
  has(el: Element): boolean;
  /** Removes it and puts back the page's own inline outline declarations. */
  release(el: Element): void;
  /** Outlined controls still on the page (one the page removed is released and not counted). */
  count(): number;
  clear(): void;
}

const styleOf = getter<CSSStyleDeclaration>(HTMLElement.prototype, "style");
const isConnected = getter<boolean>(Node.prototype, "isConnected");
const getPropertyValue = CSSStyleDeclaration.prototype.getPropertyValue;
const getPropertyPriority = CSSStyleDeclaration.prototype.getPropertyPriority;
const setProperty = CSSStyleDeclaration.prototype.setProperty;
const removeProperty = CSSStyleDeclaration.prototype.removeProperty;

const OUTLINE: Record<string, string> = {
  outline: "2px solid #0a84ff",
  "outline-offset": "2px",
};

/**
 * What `OUTLINE` sets, as longhands: saved and restored one by one, so a page's partial inline
 * outline (`outline-color` alone) comes back exactly as it was.
 */
const LONGHANDS = [
  "outline-color",
  "outline-style",
  "outline-width",
  "outline-offset",
] as const;

type Saved = [value: string, priority: string][];

function save(style: CSSStyleDeclaration): Saved {
  return LONGHANDS.map((p) => [
    getPropertyValue.call(style, p),
    getPropertyPriority.call(style, p),
  ]);
}

function put(style: CSSStyleDeclaration, saved: Saved): void {
  LONGHANDS.forEach((p, n) => {
    const [value, priority] = saved[n]!;
    if (value === "") removeProperty.call(style, p);
    else setProperty.call(style, p, value, priority);
  });
}

export function createOutlines(): Outlines {
  const outlined = new Map<Element, Saved>();

  function release(el: Element): void {
    const saved = outlined.get(el);
    if (saved === undefined) return;
    outlined.delete(el);
    try {
      put(styleOf(el), saved);
    } catch {
      // the page broke the element's style: nothing more to put back
    }
  }

  /** Forgets controls the page has removed (an SPA's next step): they need nobody any more. */
  function prune(): void {
    for (const el of [...outlined.keys()]) {
      let gone: boolean;
      try {
        gone = !isConnected(el);
      } catch {
        gone = true;
      }
      if (gone) release(el);
    }
  }

  return {
    add(el) {
      prune();
      if (outlined.has(el)) return false;
      let style: CSSStyleDeclaration;
      let saved: Saved;
      try {
        style = styleOf(el);
        saved = save(style);
      } catch {
        return false;
      }
      try {
        for (const [prop, value] of Object.entries(OUTLINE)) {
          setProperty.call(style, prop, value, "important");
        }
      } catch {
        try {
          put(style, saved);
        } catch {
          // nothing more to undo
        }
        return false;
      }
      outlined.set(el, saved);
      return true;
    },
    has: (el) => outlined.has(el),
    release,
    count() {
      prune();
      return outlined.size;
    },
    clear() {
      for (const el of [...outlined.keys()]) release(el);
    },
  };
}
