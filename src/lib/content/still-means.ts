// Shared by the runner (fill) and the recording (capture): does an element still mean the control
// a scan reported? DOM-only. ADR 0026.

import { getter } from "../fields/dom";
import {
  buildSignature,
  type FormControl,
  type Sig,
} from "../fields/signature";

const isConnected = getter<boolean>(Node.prototype, "isConnected");

/**
 * True while `el` is still the control the worker matched: connected, and the parts of its
 * signature that do not depend on its position (name, id, autocomplete, type, label) are the
 * scanned ones. A framework that re-uses one `<input>` for the next step renames and relabels it
 * in place; the plan's value for the old step must not land in it, and an edit there must not be
 * filed under the old field.
 */
export function stillMeans(el: FormControl, scanned: Sig): boolean {
  try {
    if (!isConnected(el)) return false;
    const sig = buildSignature(el, scanned.ordinal, scanned.formAction);
    return (
      sig.name === scanned.name &&
      sig.idStable === scanned.idStable &&
      sig.autocomplete === scanned.autocomplete &&
      sig.type === scanned.type &&
      sig.labelText === scanned.labelText &&
      sig.nameIdDerived === scanned.nameIdDerived
    );
  } catch {
    return false;
  }
}
