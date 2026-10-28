// The on-page recording pill (spec 6.2): "● Recording · N fields · Finish". The page is hostile:
// the pill is a `div` host with a closed shadow root, shown in the top layer as a manual popover,
// holding text and one button, never an input and never a value. Styles go through CSSOM only
// (`style.setProperty`, important), never a style attribute, a `<style>` element or markup, so the
// pill renders under a page CSP of `style-src 'none'` and over page CSS such as `* { all: unset }`.
// Every DOM member is captured from the prototypes at import time. Decisions: ADR 0032.

import { getter } from "../fields/dom";

export type PillState =
  | { kind: "on" | "full"; count: number }
  | { kind: "stopped"; reason: "locked" | "expired" };

export interface Pill {
  show(state: PillState): void;
  hide(): void;
  /** Hides the pill for good: later `show` calls do nothing. */
  remove(): void;
  /** The host element, so the content script can leave it out of its scans. */
  readonly host: HTMLElement;
  /** Tests only. */
  readonly root: ShadowRoot;
}

/** How long a "Recording stopped" notice stays up. */
export const STOPPED_PILL_MS = 6000;

const createElementFn = Document.prototype.createElement;
const createTextNodeFn = Document.prototype.createTextNode;
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
  "max-width": "calc(100vw - 24px)",
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
  "border-radius": "999px",
  background: "#1c1c1e",
  color: "#ffffff",
  "box-shadow": "0 4px 16px rgba(0, 0, 0, 0.3)",
  "font-family": FONT,
  "font-size": "13px",
  "line-height": "20px",
  "white-space": "nowrap",
};

const TEXT_CSS: Record<string, string> = {
  display: "inline",
  color: "#ffffff",
  font: "inherit",
};

const DOT_CSS: Record<string, string> = {
  display: "inline",
  color: "#ff453a",
  font: "inherit",
};

const BUTTON_CSS: Record<string, string> = {
  display: "inline-block",
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

const fields = (n: number): string => `${n} ${n === 1 ? "field" : "fields"}`;

function copy(state: PillState): { dot: boolean; text: string } {
  switch (state.kind) {
    case "on":
      return { dot: true, text: `Recording · ${fields(state.count)}` };
    case "full":
      return { dot: true, text: `Recording is full · ${fields(state.count)}` };
    case "stopped":
      return {
        dot: false,
        text:
          state.reason === "locked"
            ? "Recording stopped — vault locked"
            : "Recording stopped after 30 minutes",
      };
  }
}

/**
 * Builds the pill for `doc` (not yet on the page). `show` puts it in the top layer at the top right;
 * `onFinish` runs only for a trusted click on **Finish**. A stopped state hides itself after
 * `STOPPED_PILL_MS`. Never throws: a page that breaks the popover or removes the host only loses
 * the pill.
 */
export function createPill(doc: Document, onFinish: () => void): Pill {
  const host = el(doc, "div");
  const root = attachShadowFn.call(host, { mode: "closed" });
  setAttributeFn.call(host, "popover", "manual");
  css(host, HOST_CSS);

  const bar = el(doc, "div");
  css(bar, BAR_CSS);
  const dot = el(doc, "span");
  css(dot, DOT_CSS);
  setAttributeFn.call(dot, "aria-hidden", "true");
  appendChildFn.call(dot, createTextNodeFn.call(doc, "●"));
  const text = el(doc, "span");
  css(text, TEXT_CSS);
  setAttributeFn.call(text, "role", "status");
  const button = el(doc, "button");
  css(button, BUTTON_CSS);
  setAttributeFn.call(button, "type", "button");
  appendChildFn.call(button, createTextNodeFn.call(doc, "Finish"));
  appendChildFn.call(bar, dot);
  appendChildFn.call(bar, text);
  appendChildFn.call(bar, button);
  appendChildFn.call(root, bar);

  addListener.call(button, "click", (e: Event) => {
    // A page can dispatch a click on the host; only the user's own click finishes.
    if (!e.isTrusted) return;
    onFinish();
  });

  let removed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function hide(): void {
    clearTimeout(timer);
    timer = undefined;
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

  function show(state: PillState): void {
    if (removed) return;
    clearTimeout(timer);
    timer = undefined;
    const { dot: withDot, text: label } = copy(state);
    css(dot, { display: withDot ? "inline" : "none" });
    setText(text, withDot ? ` ${label}` : label);
    css(button, {
      display: state.kind === "stopped" ? "none" : "inline-block",
    });
    try {
      if (!isConnected(host)) {
        const parent = documentElement(doc);
        if (parent === null) return;
        appendChildFn.call(parent, host);
      }
      if (!matchesFn.call(host, ":popover-open")) showPopoverFn.call(host);
    } catch {
      // the page broke the popover: no pill on this page
    }
    if (state.kind === "stopped") {
      timer = setTimeout(hide, STOPPED_PILL_MS);
    }
  }

  return {
    show,
    hide,
    remove: () => {
      removed = true;
      hide();
    },
    host,
    root,
  };
}
