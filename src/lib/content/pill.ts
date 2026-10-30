// The page's one notice (spec 6.2, ADR 0036): the recording pill "● Recording · N fields · Finish"
// and the return-visit states (filled, undone, ready, locked, updated). The page is hostile: the
// notice is a `div` host with a closed shadow root, shown in the top layer as a manual popover,
// holding text and at most one button, never an input and never a value. Styles go through CSSOM only
// (`style.setProperty`, important), never a style attribute, a `<style>` element or markup, so the
// pill renders under a page CSP of `style-src 'none'` and over page CSS such as `* { all: unset }`.
// Every DOM member is captured from the prototypes at import time. Decisions: ADR 0032.

import { fields } from "../copy";
import { getter } from "../fields/dom";

export type PillState =
  | { kind: "on" | "full"; count: number }
  | { kind: "stopped"; reason: "locked" | "expired" }
  | { kind: "filled"; count: number; ask: number }
  | { kind: "undone" }
  | { kind: "ready"; count: number }
  | { kind: "locked"; fallback: boolean }
  | { kind: "updated" };

/** What the notice's one button does, by the state it shows. Each runs only on a trusted click. */
export interface PillActions {
  finish(): void;
  undo(): void;
  unlock(): void;
}

export interface Pill {
  show(state: PillState): void;
  hide(): void;
  /** The kind on screen now, or null when the notice is hidden. */
  showing(): PillState["kind"] | null;
  /** Hides the pill for good: later `show` calls do nothing. */
  remove(): void;
  /** The host element, so the content script can leave it out of its scans. */
  readonly host: HTMLElement;
  /** Tests only. */
  readonly root: ShadowRoot;
}

/** How long a notice other than the recording pill stays up (hover or focus holds it). */
export const NOTICE_MS = 6000;

const createElementFn = Document.prototype.createElement;
const attachShadowFn = Element.prototype.attachShadow;
const setAttributeFn = Element.prototype.setAttribute;
const appendChildFn = Node.prototype.appendChild;
const removeFn = Element.prototype.remove;
const matchesFn = Element.prototype.matches;
const showPopoverFn = HTMLElement.prototype.showPopover;
const hidePopoverFn = HTMLElement.prototype.hidePopover;
const addListener = EventTarget.prototype.addEventListener;
const textContentSet = Object.getOwnPropertyDescriptor(
  Node.prototype,
  "textContent",
)?.set;
const styleOf = getter<CSSStyleDeclaration>(HTMLElement.prototype, "style");
const isConnected = getter<boolean>(Node.prototype, "isConnected");
const documentElement = getter<Element | null>(
  Document.prototype,
  "documentElement",
);
const setProperty = CSSStyleDeclaration.prototype.setProperty;

function el(doc: Document, tag: string): HTMLElement {
  return createElementFn.call(doc, tag) as HTMLElement;
}

function setText(node: Node, text: string): void {
  textContentSet?.call(node, text);
}

/** Sets each declaration as `!important` through CSSOM: inline important beats any page rule. */
function css(node: HTMLElement, decls: Record<string, string>): void {
  const style = styleOf(node);
  for (const [prop, value] of Object.entries(decls)) {
    setProperty.call(style, prop, value, "important");
  }
}

const FONT = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

// `all: initial` first, then every property the pill relies on, so nothing is inherited from the
// page or left to the UA popover rules the page may have unset.
const HOST_CSS: Record<string, string> = {
  all: "initial",
  display: "block",
  position: "fixed",
  inset: "12px 12px auto auto",
  margin: "0",
  padding: "0",
  border: "0",
  background: "transparent",
  overflow: "visible",
  width: "auto",
  height: "auto",
  "max-width": "min(420px, calc(100vw - 24px))",
  "box-sizing": "border-box",
  color: "#ffffff",
  "font-family": FONT,
  "font-size": "13px",
  "line-height": "20px",
  "font-weight": "500",
  "text-align": "left",
  direction: "ltr",
  visibility: "visible",
  opacity: "1",
  "pointer-events": "auto",
};

const BAR_CSS: Record<string, string> = {
  display: "flex",
  "align-items": "center",
  gap: "10px",
  margin: "0",
  padding: "6px 6px 6px 14px",
  "border-radius": "20px",
  border: "1px solid rgba(255, 255, 255, 0.16)",
  background: "#1c1c1e",
  color: "#ffffff",
  "box-shadow": "0 4px 16px rgba(0, 0, 0, 0.3)",
  "font-family": FONT,
  "font-size": "13px",
  "line-height": "20px",
  "white-space": "normal",
};

const TEXT_CSS: Record<string, string> = {
  display: "inline",
  "min-width": "0",
  color: "#ffffff",
  font: "inherit",
};

const GLYPH_CSS: Record<string, string> = {
  display: "inline",
  font: "inherit",
};

const RED = "#ff453a";
const GREEN = "#30d158";

const BUTTON_CSS: Record<string, string> = {
  display: "inline-block",
  "flex-shrink": "0",
  margin: "0",
  padding: "2px 12px",
  border: "0",
  "border-radius": "999px",
  background: "#ffffff",
  color: "#1c1c1e",
  "font-family": FONT,
  "font-size": "13px",
  "line-height": "20px",
  "font-weight": "600",
  cursor: "pointer",
};

interface Copy {
  glyph: { char: string; color: string } | null;
  text: string;
  button: { label: string; action: keyof PillActions } | null;
}

const needYou = (n: number): string =>
  n === 1 ? "1 needs you" : `${n} need you`;

function copy(state: PillState): Copy {
  switch (state.kind) {
    case "on":
      return {
        glyph: { char: "●", color: RED },
        text: `Recording · ${fields(state.count)}`,
        button: { label: "Finish", action: "finish" },
      };
    case "full":
      return {
        glyph: { char: "●", color: RED },
        text: `Recording is full · ${fields(state.count)}`,
        button: { label: "Finish", action: "finish" },
      };
    case "stopped":
      return {
        glyph: null,
        text:
          state.reason === "locked"
            ? "Recording stopped — vault locked"
            : "Recording stopped after 30 minutes",
        button: null,
      };
    case "filled":
      return {
        glyph: { char: "✓", color: GREEN },
        text:
          `Refill filled ${fields(state.count)}` +
          (state.ask > 0 ? ` · ${needYou(state.ask)}` : ""),
        button: { label: "Undo", action: "undo" },
      };
    case "undone":
      return { glyph: null, text: "Fill undone", button: null };
    case "ready":
      return {
        glyph: null,
        text: `${fields(state.count)} ready — open Refill to fill`,
        button: null,
      };
    case "locked":
      return {
        glyph: null,
        text: "Refill has a saved form for this site — unlock from the toolbar icon",
        button: state.fallback ? null : { label: "Unlock", action: "unlock" },
      };
    case "updated":
      return {
        glyph: null,
        text: "Refill was updated — reload this page",
        button: null,
      };
  }
}

/** The recording pill stays until told otherwise; every other notice times out. */
const isTimed = (state: PillState): boolean =>
  state.kind !== "on" && state.kind !== "full";

/**
 * Builds the notice for `doc` (not yet on the page). `show` puts it in the top layer at the top
 * right and shows `state`; its button runs the matching `actions` entry only for a trusted click.
 * Every kind but `on` and `full` hides itself `NOTICE_MS` after its `show`, and not while the
 * pointer or focus is inside it. `onChange` (tests and e2e) hears the kind on every show and `null`
 * on every hide. Never throws: a page that breaks the popover or removes the host only loses the
 * notice. A show that could not open the popover leaves nothing on the page, `showing()` null and
 * reports no kind (a `null` if something was reported as showing before).
 */
export function createPill(
  doc: Document,
  actions: PillActions,
  onChange?: (kind: PillState["kind"] | null) => void,
): Pill {
  const host = el(doc, "div");
  const root = attachShadowFn.call(host, { mode: "closed" });
  setAttributeFn.call(host, "popover", "manual");
  css(host, HOST_CSS);

  const bar = el(doc, "div");
  css(bar, BAR_CSS);
  const glyph = el(doc, "span");
  css(glyph, GLYPH_CSS);
  setAttributeFn.call(glyph, "aria-hidden", "true");
  const text = el(doc, "span");
  css(text, TEXT_CSS);
  setAttributeFn.call(text, "role", "status");
  const button = el(doc, "button");
  css(button, BUTTON_CSS);
  setAttributeFn.call(button, "type", "button");
  appendChildFn.call(bar, glyph);
  appendChildFn.call(bar, text);
  appendChildFn.call(bar, button);
  appendChildFn.call(root, bar);

  let removed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: PillState["kind"] | null = null;
  let action: keyof PillActions | null = null;
  let timed = false;
  let hovered = false;
  let focused = false;

  addListener.call(button, "click", (e: Event) => {
    // A page can dispatch a click on the host; only the user's own click acts.
    if (!e.isTrusted || action === null) return;
    actions[action]();
  });

  function notify(kind: PillState["kind"] | null): void {
    try {
      onChange?.(kind);
    } catch {
      // a listener's failure is not the page's problem
    }
  }

  function stopTimer(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  function startTimer(): void {
    stopTimer();
    timer = setTimeout(hide, NOTICE_MS);
  }

  // Hover or focus inside the notice holds it open; once neither is, a full NOTICE_MS starts.
  function hold(next: { hovered?: boolean; focused?: boolean }): void {
    hovered = next.hovered ?? hovered;
    focused = next.focused ?? focused;
    if (current === null || !timed) return;
    if (hovered || focused) stopTimer();
    else startTimer();
  }
  addListener.call(host, "pointerenter", () => hold({ hovered: true }));
  addListener.call(host, "pointerleave", () => hold({ hovered: false }));
  addListener.call(host, "focusin", () => hold({ focused: true }));
  addListener.call(host, "focusout", () => hold({ focused: false }));

  /** Takes the notice off the page and forgets what it showed. */
  function clear(): void {
    stopTimer();
    current = null;
    action = null;
    timed = false;
    // The host leaves the page, so no `pointerleave` or `focusout` will follow.
    hovered = false;
    focused = false;
    try {
      if (matchesFn.call(host, ":popover-open")) hidePopoverFn.call(host);
    } catch {
      // the page broke the popover; removing the host is enough
    }
    try {
      removeFn.call(host);
    } catch {
      // already gone
    }
  }

  function hide(): void {
    clear();
    notify(null);
  }

  /** Puts the host in the top layer; false when the page broke that (nothing is on screen then). */
  function open(): boolean {
    try {
      if (!isConnected(host)) {
        const parent = documentElement(doc);
        if (parent === null) return false;
        appendChildFn.call(parent, host);
      }
      if (!matchesFn.call(host, ":popover-open")) showPopoverFn.call(host);
      return matchesFn.call(host, ":popover-open");
    } catch {
      return false;
    }
  }

  function show(state: PillState): void {
    if (removed) return;
    stopTimer();
    const c = copy(state);
    const was = current;
    current = state.kind;
    action = c.button?.action ?? null;
    timed = isTimed(state);
    if (c.glyph === null) {
      css(glyph, { display: "none" });
      setText(glyph, "");
      setText(text, c.text);
    } else {
      css(glyph, { display: "inline", color: c.glyph.color });
      setText(glyph, c.glyph.char);
      setText(text, ` ${c.text}`);
    }
    if (c.button === null) {
      css(button, { display: "none" });
    } else {
      css(button, { display: "inline-block" });
      setText(button, c.button.label);
    }
    if (!open()) {
      // The page broke the popover: nothing is on screen, so nothing is reported as showing.
      clear();
      if (was !== null) notify(null);
      return;
    }
    if (timed && !hovered && !focused) startTimer();
    notify(state.kind);
  }

  return {
    show,
    hide,
    showing: () => current,
    remove: () => {
      removed = true;
      hide();
    },
    host,
    root,
  };
}
