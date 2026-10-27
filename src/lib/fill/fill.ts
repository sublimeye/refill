// Fill engine (spec 5.5, 5.6). DOM-only, zero runtime dependencies: this runs in the content script
// on hostile pages (ADR 0024).
//
// Every DOM member used here is captured from the prototypes at import time and called with
// `.call(el)`. A page can shadow members on an element or its form (`<input name="value">` inside a
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
const baseURI = get<string>(Node.prototype, "baseURI");
const ownerDocument = get<Document | null>(Node.prototype, "ownerDocument");
const isConnected = get<boolean>(Node.prototype, "isConnected");

const focusEl = (el: Element): void => {
  HTMLElement.prototype.focus.call(el);
};
const blurEl = (el: Element): void => {
  HTMLElement.prototype.blur.call(el);
};
const clickEl = (el: Element): void => {
  HTMLElement.prototype.click.call(el);
};
const inputSelect = (el: Element): void => {
  HTMLInputElement.prototype.select.call(el);
};
const textareaSelect = (el: Element): void => {
  HTMLTextAreaElement.prototype.select.call(el);
};
const dispatch = (el: Element, event: Event): void => {
  EventTarget.prototype.dispatchEvent.call(el, event);
};
const querySelector = (el: Element, selector: string): Element | null =>
  Element.prototype.querySelector.call(el, selector);
const execCommand = (doc: Document, command: string, value: string): boolean =>
  Document.prototype.execCommand.call(doc, command, false, value);

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

/**
 * True if the control's form (if any) submits to `origin`. The `action` attribute is read, never
 * `form.action` (an `<input name="action">` replaces it), and resolved against the document base;
 * no attribute means the form submits to the document itself. `formaction` on a submitter is out of
 * scope. Unparsable counts as cross-origin.
 */
function sameOriginForm(el: FormControl, origin: string): boolean {
  const form = formOf(el);
  if (form === null) return true;
  if (!hasAttr(form, "action")) return true;
  try {
    return (
      new URL(getAttr(form, "action") ?? "", baseURI(el)).origin === origin
    );
  } catch {
    return false;
  }
}

/**
 * The spec 5.5 fill rules that depend on the control and the page: eligible, not sensitive, current
 * value empty or equal to `pageDefault` (checkbox/radio: `String(checked)`), form posts to `origin`.
 * (Vault state, `fillMode` and field policy are the caller's.) Never throws; any failure is false.
 * `isTopWindow` is for tests only (see `isEligible`).
 */
export function canFill(
  item: FillItem,
  history: PasswordHistory,
  origin: string,
  isTopWindow?: (win: Window) => boolean,
): boolean {
  try {
    const { el } = item;
    if (controlKind(el) !== item.kind) return false;
    const doc = ownerDocument(el);
    if (doc === null) return false;
    if (!isEligible(el, doc, isTopWindow)) return false;
    // Ordinal and form action do not enter the sensitivity rules.
    if (isSensitive(el, buildSignature(el, 0, null), history)) return false;
    if (!untouched(item)) return false;
    return sameOriginForm(el, origin);
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
// carries no `data` for page code to read the value from.
const fire = (el: Element, type: "input" | "change"): void => {
  dispatch(el, new Event(type, { bubbles: true }));
};

function writeNative(el: FormControl, value: string): void {
  if (localName(el) === "textarea") textareaSetValue(el, value);
  else inputSetValue(el, value);
}

/**
 * Text technique (spec 5.6): focus, native prototype setter, `input` + `change`, blur; if the page
 * rewrote the value (a mask), `select()` + `execCommand("insertText")`, which produces the trusted
 * events a keystroke-driven mask expects. True when the value stuck. Caller holds the guard.
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
  const doc = ownerDocument(el);
  if (doc !== null) {
    // An empty target means "clear": insertText with "" is a no-op.
    if (value === "") execCommand(doc, "delete", "");
    else execCommand(doc, "insertText", value);
  }
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
 * Fills one control. Re-checks eligibility and "empty or page default" right before writing (an
 * earlier fill's handlers may have changed this field), then writes under the filling guard.
 * Origin, sensitivity and policy were `canFill`'s and the caller's business. Never throws.
 * `isTopWindow` is for tests only (see `isEligible`).
 */
export function fillControl(
  item: FillItem,
  isTopWindow?: (win: Window) => boolean,
): FillOutcome {
  return withFillingGuard(() => {
    try {
      const { el, kind, value } = item;
      if (controlKind(el) !== kind) return "unsupported";
      const doc = ownerDocument(el);
      if (doc === null || !isEligible(el, doc, isTopWindow)) {
        return "skipped-ineligible";
      }
      if (!untouched(item)) return "skipped-not-empty";
      if (isCustomWidget(el)) return "unsupported";
      switch (kind) {
        case "text":
          return writeText(el, value) ? "filled" : "rejected-by-page";
        case "select": {
          const select = el as HTMLSelectElement;
          if (!hasOption(select, value)) return "unsupported";
          return writeSelect(select, value) ? "filled" : "rejected-by-page";
        }
        case "checkbox":
        case "radio":
          return writeToggle(el as HTMLInputElement, value === "true")
            ? "filled"
            : "rejected-by-page";
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
