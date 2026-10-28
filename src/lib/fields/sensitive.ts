// Sensitive-field classifier and card-number heuristic (spec 5.3). DOM-only, zero runtime
// dependencies: this runs in the content script. Page content is hostile, so every check is bounded
// and fails closed: anything that throws is treated as sensitive.

import { getAttr, nodeType } from "./dom";
import {
  captchaLike,
  nameMatchesSensitive,
  sensitiveAutocomplete,
} from "./sensitive-rules";
import type { FormControl, Sig } from "./signature";

export { looksLikeCardNumber } from "./sensitive-rules";

const OBSERVE_OPTIONS: MutationObserverInit = {
  subtree: true,
  attributes: true,
  attributeFilter: ["type"],
  attributeOldValue: true,
};

/**
 * Remembers every control that has ever been `type=password` in this document, so a show-password
 * toggle (password to text) cannot make the field capturable. A MutationObserver on the `type`
 * attribute (with the old value, so a flip that is undone before the observer callback runs is still
 * seen) plus an initial sweep; membership lives in a WeakSet, so removed controls are collectable.
 */
export class PasswordHistory {
  private readonly seen = new WeakSet<Element>();
  private observer: MutationObserver | null = null;
  private shadows = new WeakSet<ShadowRoot>();

  observe(root: Document | ShadowRoot): void {
    this.disconnect();
    for (const el of root.querySelectorAll('input[type="password" i]')) {
      this.seen.add(el);
    }
    this.observer = new MutationObserver((records) => {
      this.record(records);
    });
    this.observer.observe(root, OBSERVE_OPTIONS);
  }

  /**
   * Also watch a shadow root (a document observer does not see inside shadow trees), without
   * dropping what `observe` already watches; the document scanner calls this for every shadow root
   * it enters. A no-op for a root already watched. Without a prior `observe` it starts its own
   * observer, so the shadow root alone is covered. Only toggles from this point on are recorded: a
   * control that was a password and is text by now is judged by its current type alone.
   */
  observeShadow(root: ShadowRoot): void {
    if (this.shadows.has(root)) return;
    this.shadows.add(root);
    for (const el of root.querySelectorAll('input[type="password" i]')) {
      this.seen.add(el);
    }
    this.observer ??= new MutationObserver((records) => {
      this.record(records);
    });
    this.observer.observe(root, OBSERVE_OPTIONS);
  }

  /** True if `el` is, or at any point since `observe` was, `type=password`. */
  wasPassword(el: Element): boolean {
    // Flush records the observer has not delivered yet, so a toggle in the same task is not missed.
    if (this.observer !== null) this.record(this.observer.takeRecords());
    if (this.seen.has(el)) return true;
    if (isPasswordType(getAttr(el, "type"))) {
      this.seen.add(el);
      return true;
    }
    return false;
  }

  disconnect(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.shadows = new WeakSet();
  }

  private record(records: MutationRecord[]): void {
    for (const r of records) {
      if (
        isPasswordType(r.oldValue) ||
        (nodeType(r.target) === Node.ELEMENT_NODE &&
          isPasswordType(getAttr(r.target as Element, "type")))
      ) {
        this.seen.add(r.target as Element);
      }
    }
  }
}

function isPasswordType(value: string | null): boolean {
  return value !== null && value.trim().toLowerCase() === "password";
}

/**
 * Spec 5.3 never-capture rules for a control. Never throws: any failure reads as sensitive.
 * `sig` supplies the already-normalized label and autocomplete; name and id are read raw (and capped)
 * because `Sig.idStable` is null for generated ids such as `password1234`.
 */
export function isSensitive(
  el: FormControl,
  sig: Sig,
  history: PasswordHistory,
): boolean {
  try {
    const type = el.type.toLowerCase();
    if (type === "password" || type === "hidden" || type === "file") {
      return true;
    }
    if (
      sig.type === "password" ||
      sig.type === "hidden" ||
      sig.type === "file"
    ) {
      return true;
    }
    if (history.wasPassword(el)) return true;
    const textSecurity = getComputedStyle(el)
      .getPropertyValue("-webkit-text-security")
      .trim();
    if (textSecurity !== "" && textSecurity !== "none") return true;
    if (sensitiveAutocomplete(sig.autocomplete)) return true;
    if (sensitiveAutocomplete(el.getAttribute("autocomplete"))) return true;
    const name = el.getAttribute("name");
    const id = el.id;
    const cls = el.getAttribute("class");
    if (
      captchaLike(name) ||
      captchaLike(id) ||
      captchaLike(sig.labelText) ||
      captchaLike(cls)
    ) {
      return true;
    }
    return (
      nameMatchesSensitive(name) ||
      nameMatchesSensitive(id) ||
      nameMatchesSensitive(sig.labelText)
    );
  } catch {
    return true;
  }
}
