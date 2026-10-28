// Values and page defaults of recorded controls (spec 6.2). DOM-only, zero runtime dependencies
// besides the sibling field modules: this runs in the content script on hostile pages. Every DOM
// member is captured from the prototypes at import time and applied with `.call(el)`, so a page
// cannot steer what is read (ADR 0024, ADR 0032).

import { getter, localName } from "../fields/dom";
import type { ControlKind } from "../fields/eligibility";
import type { ScannedControl } from "../fields/scan";
import {
  buildSignature,
  type FormControl,
  type Sig,
} from "../fields/signature";
import { stillMeans } from "../content/still-means";

const inputValue = getter<string>(HTMLInputElement.prototype, "value");
const textareaValue = getter<string>(HTMLTextAreaElement.prototype, "value");
const selectValue = getter<string>(HTMLSelectElement.prototype, "value");
const inputChecked = getter<boolean>(HTMLInputElement.prototype, "checked");
const inputDefaultValue = getter<string>(
  HTMLInputElement.prototype,
  "defaultValue",
);
const textareaDefaultValue = getter<string>(
  HTMLTextAreaElement.prototype,
  "defaultValue",
);
const inputDefaultChecked = getter<boolean>(
  HTMLInputElement.prototype,
  "defaultChecked",
);
const selectOptions = getter<HTMLOptionsCollection>(
  HTMLSelectElement.prototype,
  "options",
);
const collectionLength = getter<number>(HTMLCollection.prototype, "length");
const collectionItem = HTMLCollection.prototype.item;
const optionValue = getter<string>(HTMLOptionElement.prototype, "value");
const optionDefaultSelected = getter<boolean>(
  HTMLOptionElement.prototype,
  "defaultSelected",
);

/** Options looked at for a select's markup default; a longer list falls back to the first. */
const MAX_OPTIONS = 1000;

function textValue(el: FormControl): string {
  return localName(el) === "textarea" ? textareaValue(el) : inputValue(el);
}

/**
 * The control's current value as a capture carries it: text and select their value, a checkbox
 * `"true"` / `"false"`, a radio `"true"` when checked and null when not (an unchecked radio is
 * recorded through the one that was checked). Null when the element does not fit `kind`.
 */
export function readValue(el: FormControl, kind: ControlKind): string | null {
  try {
    switch (kind) {
      case "text":
        return textValue(el);
      case "select":
        return localName(el) === "select" ? selectValue(el) : null;
      case "checkbox":
        return String(inputChecked(el));
      case "radio":
        return inputChecked(el) ? "true" : null;
    }
  } catch {
    return null; // not the element the kind says (a prototype getter refused it)
  }
}

/** What the fill rules compare with `pageDefault`: `String(checked)` for toggles, else the value. */
function stateOf(el: FormControl, kind: ControlKind): string {
  return kind === "checkbox" || kind === "radio"
    ? String(inputChecked(el))
    : kind === "select"
      ? selectValue(el)
      : textValue(el);
}

/** The value the markup gave the control: `defaultValue`, `defaultChecked`, the `selected` option. */
function markupDefault(el: FormControl, kind: ControlKind): string {
  switch (kind) {
    case "checkbox":
    case "radio":
      return String(inputDefaultChecked(el));
    case "text":
      return localName(el) === "textarea"
        ? textareaDefaultValue(el)
        : inputDefaultValue(el);
    case "select": {
      const options = selectOptions(el);
      const n = Math.min(collectionLength(options), MAX_OPTIONS);
      for (let i = 0; i < n; i++) {
        const option = collectionItem.call(options, i) as HTMLOptionElement;
        if (optionDefaultSelected(option)) return optionValue(option);
      }
      // No `selected` attribute: a single-line select shows its first option.
      const first = collectionItem.call(options, 0) as HTMLOptionElement | null;
      return first === null ? "" : optionValue(first);
    }
  }
}

interface Noted {
  value: string;
  /** The signature the element had then; null when it could not be built (kept for good). */
  sig: Sig | null;
}

/**
 * The value each control had when a scan first saw it under its current meaning, which is what the
 * page itself rendered (spec 6.2, `pageDefault`). `note` runs on every scan, before that scan's fill
 * plan is applied, and keeps the first value per element and meaning, so neither Refill's fill nor
 * the user's later edits change it. An element a framework re-uses for another field (`stillMeans`
 * fails against the noted signature) gets a fresh default: the first value seen under its new
 * meaning (ruling P13).
 */
export class PageDefaults {
  private readonly seen = new WeakMap<Element, Noted>();

  note(controls: ScannedControl[]): void {
    for (const { el, kind, sig } of controls) {
      if (this.current(el) !== undefined) continue;
      try {
        this.seen.set(el, { value: stateOf(el, kind), sig });
      } catch {
        // a getter refused the element: `get` falls back to the markup default
      }
    }
  }

  /**
   * The noted value. For an element no scan has seen under its current meaning, the markup default
   * ("" if unreadable), which is then kept for that meaning: a scan that only runs after the user's
   * edit must not take the typed value for the page's own.
   */
  get(el: FormControl, kind: ControlKind): string {
    const noted = this.current(el);
    if (noted !== undefined) return noted.value;
    let value: string;
    try {
      value = markupDefault(el, kind);
    } catch {
      value = "";
    }
    let sig: Sig | null;
    try {
      sig = buildSignature(el, 0, null);
    } catch {
      sig = null;
    }
    this.seen.set(el, { value, sig });
    return value;
  }

  private current(el: Element): Noted | undefined {
    const noted = this.seen.get(el);
    if (noted === undefined) return undefined;
    if (noted.sig !== null && !stillMeans(el as FormControl, noted.sig)) {
      return undefined;
    }
    return noted;
  }
}
