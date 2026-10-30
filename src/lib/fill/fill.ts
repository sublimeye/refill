// Fill engine (spec 5.5, 5.6). DOM-only, zero runtime dependencies: this runs in the content script
// on hostile pages (ADR 0024).
//
// Every DOM member used here (getters, setters and methods) is captured from the prototypes at
// import time and called with `.call(el)`. A page can shadow members on an element or its form (`<input name="value">` inside a
// form, or React's own `value` property on a controlled input), and `el.value = x` through such a
// shadow would skip the native setter, i.e. skip the framework's change detection.

import {
  getAttr,
  hasAttr,
  localName,
  nodeType,
  parentNode,
} from "../fields/dom";
import {
  controlKind,
  isEligible,
  type ControlKind,
} from "../fields/eligibility";
import { buildSignature, type FormControl } from "../fields/signature";
import { isSensitive, type PasswordHistory } from "../fields/sensitive";

export type FillOutcome =
  | "filled"
  | "skipped-not-empty"
  | "skipped-ineligible"
  | "unsupported"
  | "rejected-by-page";

export interface FillItem {
  el: FormControl;
  kind: ControlKind;
  value: string;
  /** The value the page itself rendered when the field was recorded (spec 5.5). */
  pageDefault: string;
}

export interface FillSnapshot {
  entries: {
    el: FormControl;
    kind: ControlKind;
    value: string;
    checked: boolean;
  }[];
}

function desc(proto: object, prop: string): PropertyDescriptor {
  const d = Object.getOwnPropertyDescriptor(proto, prop);
  if (d === undefined) throw new Error(`missing property ${prop}`);
  return d;
}
function get<T>(proto: object, prop: string): (node: object) => T {
  const g = desc(proto, prop).get;
  if (g === undefined) throw new Error(`missing getter ${prop}`);
  return (node) => g.call(node) as T;
}
function set(proto: object, prop: string): (node: object, v: unknown) => void {
  const s = desc(proto, prop).set;
  if (s === undefined) throw new Error(`missing setter ${prop}`);
  return (node, v) => {
    s.call(node, v);
  };
}

const inputValue = get<string>(HTMLInputElement.prototype, "value");
const inputSetValue = set(HTMLInputElement.prototype, "value");
const textareaValue = get<string>(HTMLTextAreaElement.prototype, "value");
const textareaSetValue = set(HTMLTextAreaElement.prototype, "value");
const selectValue = get<string>(HTMLSelectElement.prototype, "value");
const selectSetValue = set(HTMLSelectElement.prototype, "value");
const selectOptions = get<HTMLOptionsCollection>(
  HTMLSelectElement.prototype,
  "options",
);
const optionValue = get<string>(HTMLOptionElement.prototype, "value");
const inputChecked = get<boolean>(HTMLInputElement.prototype, "checked");
const inputForm = get<HTMLFormElement | null>(
  HTMLInputElement.prototype,
  "form",
);
const textareaForm = get<HTMLFormElement | null>(
  HTMLTextAreaElement.prototype,
  "form",
);
const selectForm = get<HTMLFormElement | null>(
  HTMLSelectElement.prototype,
  "form",
);
const buttonForm = get<HTMLFormElement | null>(
  HTMLButtonElement.prototype,
  "form",
);
const buttonType = get<string>(HTMLButtonElement.prototype, "type");
const inputType = get<string>(HTMLInputElement.prototype, "type");
const nodeListLength = get<number>(NodeList.prototype, "length");
const baseURI = get<string>(Node.prototype, "baseURI");
const ownerDocument = get<Document | null>(Node.prototype, "ownerDocument");
const isConnected = get<boolean>(Node.prototype, "isConnected");

const focusFn = HTMLElement.prototype.focus;
const blurFn = HTMLElement.prototype.blur;
const clickFn = HTMLElement.prototype.click;
const inputSelectFn = HTMLInputElement.prototype.select;
const textareaSelectFn = HTMLTextAreaElement.prototype.select;
const dispatchFn = EventTarget.prototype.dispatchEvent;
const querySelectorFn = Element.prototype.querySelector;
const execCommandFn = Document.prototype.execCommand;
const getRootNodeFn = Node.prototype.getRootNode;
const documentQueryAllFn = Document.prototype.querySelectorAll;
const fragmentQueryAllFn = DocumentFragment.prototype.querySelectorAll;
const nodeListItemFn = NodeList.prototype.item;
const documentActive = get<Element | null>(Document.prototype, "activeElement");
const shadowActive = get<Element | null>(ShadowRoot.prototype, "activeElement");
const shadowHost = get<Element>(ShadowRoot.prototype, "host");

const focusEl = (el: Element): void => {
  focusFn.call(el);
};
const blurEl = (el: Element): void => {
  blurFn.call(el);
};
const clickEl = (el: Element): void => {
  clickFn.call(el);
};
const inputSelect = (el: Element): void => {
  inputSelectFn.call(el);
};
const textareaSelect = (el: Element): void => {
  textareaSelectFn.call(el);
};
const dispatch = (el: Element, event: Event): void => {
  dispatchFn.call(el, event);
};
const querySelector = (el: Element, selector: string): Element | null =>
  querySelectorFn.call(el, selector);
const execCommand = (doc: Document, command: string, value: string): boolean =>
  execCommandFn.call(doc, command, false, value);

const MAX_FOCUS_DEPTH = 64;

/** Elements with a `formaction` attribute the fill rules look at; more than this refuses (ADR 0024). */
export const MAX_FORMACTION_ELEMENTS = 500;

/**
 * True only if `el` is the deepest focused element: it is the `activeElement` of its own root and
 * every enclosing shadow host is the `activeElement` of the root it lives in, up to the document.
 * (`document.activeElement` alone is the outermost host for an input in a shadow tree.) A detached
 * element, or any failure, is false.
 */
function isDeepFocused(el: Element): boolean {
  try {
    let node: Node = el;
    for (let i = 0; i < MAX_FOCUS_DEPTH; i++) {
      const root = getRootNodeFn.call(node);
      const type = nodeType(root);
      if (type === Node.DOCUMENT_NODE) return documentActive(root) === node;
      if (type !== Node.DOCUMENT_FRAGMENT_NODE) return false;
      if (shadowActive(root) !== node) return false;
      node = shadowHost(root);
    }
    return false;
  } catch {
    return false;
  }
}

// --- guard -------------------------------------------------------------------------------------

// A depth counter, not a boolean: fills nest (a page handler that triggers another fill, or restore
// inside a fill) and the inner exit must not end the outer guard.
let fillingDepth = 0;

/** Runs `fn` with the filling guard held; always released, also when `fn` throws. Re-entrant. */
export function withFillingGuard<T>(fn: () => T): T {
  fillingDepth++;
  try {
    return fn();
  } finally {
    fillingDepth--;
  }
}

/** True while a fill or restore is running: the recorder and draft tracker ignore events then. */
export function isFilling(): boolean {
  return fillingDepth > 0;
}

// --- reading -----------------------------------------------------------------------------------

function readValue(el: FormControl): string {
  switch (localName(el)) {
    case "select":
      return selectValue(el);
    case "textarea":
      return textareaValue(el);
    default:
      return inputValue(el);
  }
}

function formOf(el: FormControl): HTMLFormElement | null {
  switch (localName(el)) {
    case "select":
      return selectForm(el);
    case "textarea":
      return textareaForm(el);
    default:
      return inputForm(el);
  }
}

/** What the fill rules compare against `pageDefault`: `String(checked)` for toggles, else the value. */
function currentState(el: FormControl, kind: ControlKind): string {
  return kind === "checkbox" || kind === "radio"
    ? String(inputChecked(el))
    : readValue(el);
}

function untouched(item: FillItem): boolean {
  const current = currentState(item.el, item.kind);
  return current === "" || current === item.pageDefault;
}

/** True if `url` resolved against `base` has origin `origin`. Unparsable counts as cross-origin. */
function resolvesTo(url: string, base: string, origin: string): boolean {
  try {
    return new URL(url, base).origin === origin;
  } catch {
    return false;
  }
}

/**
 * The form a submit button submits, or null if `el` is not a submit button. A `<button>` with no or
 * an invalid `type` is a submit button (the prototype `type` getter normalises that); so are
 * `<input type=submit>` and `<input type=image>`.
 */
function submitterForm(el: Element): HTMLFormElement | null {
  switch (localName(el)) {
    case "button":
      return buttonType(el) === "submit" ? buttonForm(el) : null;
    case "input": {
      const type = inputType(el);
      return type === "submit" || type === "image" ? inputForm(el) : null;
    }
    default:
      return null;
  }
}

/**
 * True if no submit button of `form` overrides its target with a `formaction` that resolves to
 * another origin. A submitter can sit anywhere in the form's tree (`form=` attaches one from
 * outside the form element), so the whole tree root (document or shadow root) is searched for
 * `[formaction]` and each hit is kept only if its prototype `form` getter returns `form`. More than
 * MAX_FORMACTION_ELEMENTS hits, or a form not in a document or shadow root, refuses.
 */
function submittersSameOrigin(
  form: HTMLFormElement,
  base: string,
  origin: string,
): boolean {
  const root = getRootNodeFn.call(form);
  let hits: NodeListOf<Element>;
  switch (nodeType(root)) {
    case Node.DOCUMENT_NODE:
      hits = documentQueryAllFn.call(root, "[formaction]");
      break;
    case Node.DOCUMENT_FRAGMENT_NODE:
      hits = fragmentQueryAllFn.call(root, "[formaction]");
      break;
    default:
      return false;
  }
  const count = nodeListLength(hits);
  if (count > MAX_FORMACTION_ELEMENTS) return false;
  for (let i = 0; i < count; i++) {
    const el = nodeListItemFn.call(hits, i) as Element | null;
    if (el === null || submitterForm(el) !== form) continue;
    if (!resolvesTo(getAttr(el, "formaction") ?? "", base, origin)) {
      return false;
    }
  }
  return true;
}

/**
 * True if the control's form (if any) submits to `origin`, whichever of its submit buttons is used.
 * The `action` attribute is read, never `form.action` (an `<input name="action">` replaces it), and
 * resolved against the document base; no attribute means the form submits to the document itself.
 * Then every submitter's `formaction` must resolve to `origin` too (`submittersSameOrigin`): markup
 * alone can add `<button formaction="https://evil.example">` to a same-origin form.
 */
function sameOriginForm(el: FormControl, origin: string): boolean {
  const form = formOf(el);
  if (form === null) return true;
  const base = baseURI(el);
  if (
    hasAttr(form, "action") &&
    !resolvesTo(getAttr(form, "action") ?? "", base, origin)
  ) {
    return false;
  }
  return submittersSameOrigin(form, base, origin);
}

/**
 * The spec 5.5 rules that depend on the control and the page, in cheapest-first order: kind,
 * eligible, not sensitive, form (and every submitter's `formaction`) posts to `origin`, current
 * value empty or equal to `pageDefault` (checkbox/radio: `String(checked)`). Shared by `canFill`
 * and the re-check in `fillControl`.
 */
function vet(
  item: FillItem,
  history: PasswordHistory,
  origin: string,
  isTopWindow: ((win: Window) => boolean) | undefined,
): FillOutcome | "ok" {
  const { el } = item;
  if (controlKind(el) !== item.kind) return "unsupported";
  const doc = ownerDocument(el);
  if (doc === null || !isEligible(el, doc, isTopWindow)) {
    return "skipped-ineligible";
  }
  // Ordinal and form action do not enter the sensitivity rules.
  if (isSensitive(el, buildSignature(el, 0, null), history)) {
    return "skipped-ineligible";
  }
  if (!sameOriginForm(el, origin)) return "skipped-ineligible";
  return untouched(item) ? "ok" : "skipped-not-empty";
}

/**
 * The spec 5.5 fill rules that depend on the control and the page: eligible, not sensitive, current
 * value empty or equal to `pageDefault` (checkbox/radio: `String(checked)`), form and every
 * submitter's `formaction` post to `origin`. (Vault state, `fillMode` and field policy are the caller's.) Never throws; any failure is false.
 * `isTopWindow` is for tests only (see `isEligible`).
 */
export function canFill(
  item: FillItem,
  history: PasswordHistory,
  origin: string,
  isTopWindow?: (win: Window) => boolean,
): boolean {
  try {
    return vet(item, history, origin, isTopWindow) === "ok";
  } catch {
    return false;
  }
}

// --- custom widgets ----------------------------------------------------------------------------

const MAX_WIDGET_ANCESTORS = 16;

function roleOf(el: Element): string {
  return (getAttr(el, "role") ?? "").trim().toLowerCase();
}

/** A combobox container that has a popup attached (ARIA 1.1 pattern: aria-controls/owns/haspopup). */
function hasListbox(box: Element): boolean {
  const popup = (getAttr(box, "aria-haspopup") ?? "").trim().toLowerCase();
  return (
    (popup !== "" && popup !== "false") ||
    (getAttr(box, "aria-controls") ?? "").trim() !== "" ||
    (getAttr(box, "aria-owns") ?? "").trim() !== "" ||
    querySelector(box, '[role="listbox" i]') !== null
  );
}

/**
 * A control that is the text part of a custom widget: itself `role=combobox` (and not a native
 * select), or inside a `[role=combobox]` ancestor (at most MAX_WIDGET_ANCESTORS up) that has a
 * listbox attached. Typing into those does not select an option, so they are reported, not filled.
 */
function isCustomWidget(el: FormControl): boolean {
  if (roleOf(el) === "combobox") return localName(el) !== "select";
  let node: Node | null = parentNode(el);
  for (let depth = 0; node !== null && depth < MAX_WIDGET_ANCESTORS; depth++) {
    if (nodeType(node) !== Node.ELEMENT_NODE) return false;
    if (roleOf(node as Element) === "combobox" && hasListbox(node as Element)) {
      return true;
    }
    node = parentNode(node);
  }
  return false;
}

// --- writing -----------------------------------------------------------------------------------

// Plain `Event`, not `InputEvent`: React and Vue listen for the event name only, and a plain event
// carries no `data` for page code to read the value from. `composed`, like the native events, so
// listeners outside an open shadow root (document-level validators) see them too.
const fire = (el: Element, type: "input" | "change"): void => {
  dispatch(el, new Event(type, { bubbles: true, composed: true }));
};

function writeNative(el: FormControl, value: string): void {
  if (localName(el) === "textarea") textareaSetValue(el, value);
  else inputSetValue(el, value);
}

/**
 * Text technique (spec 5.6): focus, native prototype setter, `input` + `change`, blur; if the page
 * rewrote the value (a mask), `select()` + `execCommand("insertText")`, which produces the trusted
 * events a keystroke-driven mask expects, but only while `el` is the focused element (see below).
 * True when the value stuck. Caller holds the guard.
 */
function writeText(el: FormControl, value: string): boolean {
  focusEl(el);
  writeNative(el, value);
  fire(el, "input");
  fire(el, "change");
  blurEl(el);
  if (readValue(el) === value) return true;

  focusEl(el);
  try {
    if (localName(el) === "textarea") textareaSelect(el);
    else inputSelect(el);
  } catch {
    // select() does not apply to this input type
  }
  // `execCommand` edits whatever element has focus. A page can move focus in a `focus` handler (or
  // lose it by disabling the field on `blur` and focusing the next one), which would put the value
  // into an element that was never vetted. Insert only while `el` itself is the deepest focused one.
  const doc = ownerDocument(el);
  if (doc === null || !isDeepFocused(el)) return false;
  // An empty target means "clear": `select()` made the whole value the selection and `delete`
  // removes it explicitly (`insertText` with "" also removes a selection in Chromium; `delete` just
  // says what is meant).
  if (value === "") execCommand(doc, "delete", "");
  else execCommand(doc, "insertText", value);
  fire(el, "change");
  blurEl(el);
  return readValue(el) === value;
}

function hasOption(el: HTMLSelectElement, value: string): boolean {
  const options = selectOptions(el);
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    if (option !== undefined && optionValue(option) === value) return true;
  }
  return false;
}

/** Select: set the value, `input` + `change`. The caller has checked that the option exists. */
function writeSelect(el: HTMLSelectElement, value: string): boolean {
  focusEl(el);
  selectSetValue(el, value);
  fire(el, "input");
  fire(el, "change");
  blurEl(el);
  return selectValue(el) === value;
}

/**
 * Toggle: a native `click()` on the input itself (a label proxy for the opacity-0 pattern, P13,
 * would be the same click) only when the state differs; the click fires `input`/`change` itself.
 */
function writeToggle(el: HTMLInputElement, checked: boolean): boolean {
  if (inputChecked(el) !== checked) clickEl(el);
  return inputChecked(el) === checked;
}

/**
 * Best-effort undo of a refused fill: writes the pre-fill value back with the fill technique
 * (setter + `input` + `change`; for text also the `select()` + `insertText` fallback, only while
 * the control is still the deepest focused element), so a mask that reverts programmatic writes
 * does not keep the secret either. Not guaranteed: if the page refuses the pre-fill value too, the
 * field is left as the page has it.
 */
function putBack(el: FormControl, kind: ControlKind, before: string): void {
  try {
    if (kind === "select") {
      selectSetValue(el, before);
      fire(el, "input");
      fire(el, "change");
    } else {
      writeText(el, before);
    }
  } catch {
    // the page's own handler threw: nothing more to do
  }
}

/**
 * Fills one control. First re-runs every control-level rule of `canFill` (eligible, not sensitive,
 * form origin, empty or page default: an earlier field's handlers can change `name`, `autocomplete`,
 * `action` or the value between a batched `canFill` and this write) and returns the matching
 * `skipped-*` outcome without writing; then writes under the filling guard. A text or select value
 * the page refuses is put back to its pre-fill value, best effort (`rejected-by-page`). Vault state, `fillMode`
 * and field policy stay the caller's. Never throws. `isTopWindow` is for tests only (see
 * `isEligible`).
 *
 * Toggles: the value must be exactly "true" or "false", else `unsupported` with no click. A radio
 * cannot be unchecked by clicking: "false" on an unchecked radio is already satisfied (`filled`, no
 * click), on a checked radio it is `unsupported` (no click; checking another radio of the group
 * unchecks it).
 */
export function fillControl(
  item: FillItem,
  history: PasswordHistory,
  origin: string,
  isTopWindow?: (win: Window) => boolean,
): FillOutcome {
  return withFillingGuard(() => {
    const { el, kind, value } = item;
    let verdict: FillOutcome | "ok";
    try {
      verdict = vet(item, history, origin, isTopWindow);
    } catch {
      return "skipped-ineligible"; // a page getter threw: fail closed, nothing written
    }
    if (verdict !== "ok") return verdict;
    try {
      if (isCustomWidget(el)) return "unsupported";
      switch (kind) {
        case "text": {
          const before = readValue(el);
          if (writeText(el, value)) return "filled";
          putBack(el, kind, before);
          return "rejected-by-page";
        }
        case "select": {
          const select = el as HTMLSelectElement;
          if (!hasOption(select, value)) return "unsupported";
          const before = readValue(el);
          if (writeSelect(select, value)) return "filled";
          putBack(el, kind, before);
          return "rejected-by-page";
        }
        case "checkbox":
        case "radio": {
          if (value !== "true" && value !== "false") return "unsupported";
          const want = value === "true";
          const input = el as HTMLInputElement;
          if (kind === "radio" && !want) {
            return inputChecked(input) ? "unsupported" : "filled";
          }
          return writeToggle(input, want) ? "filled" : "rejected-by-page";
        }
      }
    } catch {
      return "rejected-by-page";
    }
  });
}

// --- undo --------------------------------------------------------------------------------------

/** The pre-fill state of every item: call before `fillControl`. */
export function snapshot(items: FillItem[]): FillSnapshot {
  const entries: FillSnapshot["entries"] = [];
  for (const { el, kind } of items) {
    try {
      const toggle = kind === "checkbox" || kind === "radio";
      entries.push({
        el,
        kind,
        value: toggle ? "" : readValue(el),
        checked: toggle ? inputChecked(el) : false,
      });
    } catch {
      // unreadable control: nothing to restore
    }
  }
  return { entries };
}

/**
 * Undo: puts every control back to its snapshot with the same technique as the fill, under the
 * guard. Best effort per control: a detached or refusing one is skipped. A radio cannot be
 * unchecked by clicking, but restoring the radio that was checked unchecks its group.
 */
export function restore(s: FillSnapshot): void {
  withFillingGuard(() => {
    for (const { el, kind, value, checked } of s.entries) {
      try {
        if (!isConnected(el)) continue;
        switch (kind) {
          case "text":
            if (readValue(el) !== value) writeText(el, value);
            break;
          case "select":
            if (readValue(el) !== value)
              writeSelect(el as HTMLSelectElement, value);
            break;
          case "checkbox":
          case "radio":
            writeToggle(el as HTMLInputElement, checked);
            break;
        }
      } catch {
        // page getter threw: skip this control
      }
    }
  });
}

/** One field Refill filled in this document: its pre-fill snapshot and the value it wrote. */
export interface FillRecord {
  before: FillSnapshot["entries"][number];
  written: string;
}

/**
 * Restores each record whose control still reads exactly `written` (text and select: the value;
 * checkbox and radio: String(checked)), with `restore`, under the guard. Returns how many it
 * restored.
 */
export function undo(records: FillRecord[]): number {
  return withFillingGuard(() => {
    let restored = 0;
    for (const { before, written } of records) {
      // Checked right before each write: an earlier restore's page handlers may have changed it.
      try {
        if (!isConnected(before.el)) continue;
        if (currentState(before.el, before.kind) !== written) continue;
      } catch {
        continue; // a page getter threw: leave the control alone
      }
      restore({ entries: [before] });
      restored++;
    }
    return restored;
  });
}
