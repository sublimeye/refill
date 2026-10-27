// Document scanner (spec 5.1 to 5.3). DOM-only, no runtime dependencies besides the sibling field
// modules: this runs in the content script. Page content is hostile, so the walk is iterative,
// bounded in node visits and in kept controls, and never throws.

import { controlKind, isEligible, type ControlKind } from "./eligibility";
import { isSensitive, type PasswordHistory } from "./sensitive";
import { buildSignature, type FormControl, type Sig } from "./signature";
import { sigKey } from "../match/match";

/** Content message cap on controls (Plan 2 global constraints). */
export const MAX_CONTROLS = 300;
/** Upper bound on nodes (elements, text, comments) the walk will look at. */
export const MAX_NODE_VISITS = 50_000;

export interface ScannedControl {
  i: number;
  el: FormControl;
  sig: Sig;
  kind: ControlKind;
}

export interface ScanResult {
  controls: ScannedControl[];
  truncated: boolean;
}

// A <form> exposes its named controls as properties that override its own (LegacyOverrideBuiltIns):
// `<form><input name="firstChild">` makes `form.firstChild` that input. Everything the walk and the
// form lookup read off a page node therefore goes through the prototype accessors, captured once.
function getter<T>(proto: object, prop: string): (node: object) => T {
  const get = Object.getOwnPropertyDescriptor(proto, prop)?.get;
  if (get === undefined) throw new Error(`missing accessor ${prop}`);
  return (node) => get.call(node) as T;
}
const nodeType = getter<number>(Node.prototype, "nodeType");
const firstChild = getter<Node | null>(Node.prototype, "firstChild");
const nextSibling = getter<Node | null>(Node.prototype, "nextSibling");
const ownShadowRoot = getter<ShadowRoot | null>(
  Element.prototype,
  "shadowRoot",
);
const hasAttr = (el: Element, name: string): boolean =>
  Element.prototype.hasAttribute.call(el, name);
const getAttr = (el: Element, name: string): string | null =>
  Element.prototype.getAttribute.call(el, name);

/**
 * Path of the form's submit target: the explicit `action` resolved against the document's base,
 * the document's own path when the attribute is absent, null when formless or unparsable.
 * (`buildSignature` caps it at 256.)
 */
function formActionOf(
  form: HTMLFormElement | null,
  doc: Document,
): string | null {
  if (form === null) return null;
  try {
    const raw = hasAttr(form, "action") ? getAttr(form, "action") : null;
    return new URL(raw ?? "", doc.baseURI).pathname;
  } catch {
    return null;
  }
}

function kindOf(el: Element): ControlKind | null {
  try {
    return controlKind(el);
  } catch {
    return null; // a page-controlled getter threw
  }
}

function shadowRootOf(
  el: Element,
  getRoot: ((el: Element) => ShadowRoot | null) | undefined,
): ShadowRoot | null {
  try {
    return (getRoot?.(el) ?? null) || ownShadowRoot(el);
  } catch {
    return null;
  }
}

/**
 * Eligible, non-sensitive controls of `doc` in document order: light DOM, open shadow roots and,
 * through `openOrClosedShadowRoot` (`chrome.dom.openOrClosedShadowRoot` in the content script),
 * closed ones. A shadow root is read before the host's light children.
 *
 * Cost control, in order per element: `controlKind` (cheap, non-null) then `isEligible` then
 * `buildSignature` then `isSensitive`. After `MAX_CONTROLS` kept controls the first further
 * candidate (any element with a control kind, no eligibility or signature work) sets `truncated`
 * and ends the walk; `MAX_NODE_VISITS` bounds the walk itself and sets `truncated` when hit.
 *
 * `history` must be the document's `PasswordHistory`; every shadow root entered is added to it
 * (`observeShadow`) before its controls are judged, so the caller needs no per-root bookkeeping.
 *
 * `ordinal` is the index among kept controls of the same form owner (`el.form`, which honours the
 * `form=` attribute), or of the document when formless. `isTopWindow` is for tests only (see
 * `isEligible`); production passes nothing. Never throws: a failing element is skipped.
 */
export function scanDocument(
  doc: Document,
  history: PasswordHistory,
  openOrClosedShadowRoot?: (el: Element) => ShadowRoot | null,
  isTopWindow?: (win: Window) => boolean,
): ScanResult {
  const controls: ScannedControl[] = [];
  let truncated = false;
  try {
    const ordinals = new Map<HTMLFormElement | null, number>();
    // Pre-order walk without recursion. `resume` holds, per open level, where to continue once that
    // level's children are done (null: nothing left, keep unwinding).
    const resume: (Node | null)[] = [];
    let node: Node | null = doc.documentElement;
    let visits = 0;
    while (node !== null || resume.length > 0) {
      if (node === null) {
        node = resume.pop() ?? null;
        continue;
      }
      if (++visits > MAX_NODE_VISITS) {
        truncated = true;
        break;
      }
      const current: Node = node;
      let next: Node | null = nextSibling(current);
      if (nodeType(current) === Node.ELEMENT_NODE) {
        const el = current as Element;
        const kind = kindOf(el);
        if (kind !== null) {
          if (controls.length >= MAX_CONTROLS) {
            truncated = true;
            break;
          }
          keep(el as FormControl, kind);
        }
        const shadow = shadowRootOf(el, openOrClosedShadowRoot);
        const light = firstChild(el);
        if (shadow !== null) {
          history.observeShadow(shadow);
          resume.push(next, light);
          next = firstChild(shadow);
        } else {
          resume.push(next);
          next = light;
        }
      }
      node = next;
    }

    function keep(el: FormControl, kind: ControlKind): void {
      try {
        if (!isEligible(el, doc, isTopWindow)) return;
        const form = el.form;
        const ordinal = ordinals.get(form) ?? 0;
        const sig = buildSignature(el, ordinal, formActionOf(form, doc));
        if (isSensitive(el, sig, history)) return;
        ordinals.set(form, ordinal + 1);
        controls.push({ i: controls.length, el, sig, kind });
      } catch {
        // A page-controlled getter threw: skip this control.
      }
    }
  } catch {
    truncated = true;
  }
  return { controls, truncated };
}

/** One `sigKey` per scanned control, in scan order: the step fingerprint of the page. */
export function pageFingerprint(r: ScanResult): string[] {
  return r.controls.map((c) => sigKey(c.sig, c.kind));
}
