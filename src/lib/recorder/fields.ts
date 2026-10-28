// Field identity and updates while recording (spec 6.2). One trusted edit at a time; pure, returns a
// new body. The worker re-checks secrets here whatever the content script decided. ADR 0028.
import type { ControlKind } from "../fields/eligibility";
import type { Sig } from "../fields/signature";
import { sigLooksSensitive } from "../fields/sensitive-rules";
import { matchControls, sigKey } from "../match/match";
import { LIMITS } from "../profiles/types";
import type { Capture, RecBody, RecField } from "./types";

export type CaptureResult = "ok" | "full" | "no-step";

/**
 * Which control of the step a capture is about. A named radio group is one field, whichever option
 * is chosen; anything else (an unnamed radio too, which the browser does not group) is one control,
 * told apart from same-labelled ones by its ordinal.
 */
function identity(sig: Sig, kind: ControlKind): string {
  if (kind === "radio" && sig.name !== null && sig.name !== "") {
    return `radio|${sig.name}|${sig.formAction ?? ""}`;
  }
  return `${sigKey(sig, kind)}|${sig.ordinal}`;
}

/** Stored values are what a fill can write: a chosen radio, a boolean checkbox, bounded text. */
function storable(c: Capture): boolean {
  if (sigLooksSensitive(c.sig)) return false;
  if (c.value.length > LIMITS.value || c.pageDefault.length > LIMITS.value) {
    return false;
  }
  if (c.kind === "radio") return c.value === "true";
  if (c.kind === "checkbox") return c.value === "true" || c.value === "false";
  return true;
}

function freshId(body: RecBody): { id: string; nextId: number } {
  const used = new Set(body.fields.map((f) => f.id));
  let n = body.nextId;
  while (used.has(`f${n}`)) n++;
  return { id: `f${n}`, nextId: n + 1 };
}

/**
 * The current step's field this capture is about when identity missed because the page changed the
 * signature (Record again after a relabel, for a field Refill did not fill: an `ask` or `skip` one,
 * or a `save` one whose element was not empty). Resolved by the fill matcher itself, so recording
 * and filling agree on which field a control is. A field with the capture's exact `sigKey` is left
 * out: identity tells it apart on purpose (the same label at another ordinal, or the same radio
 * group in another form), and the matcher has no other control here to see the ambiguity.
 */
function driftedField(
  body: RecBody,
  step: number,
  c: Capture,
): RecField | undefined {
  const current = body.steps.find((s) => s.index === step);
  if (current === undefined) return undefined;
  const key = sigKey(c.sig, c.kind);
  const pool = body.fields.filter(
    (f) => f.step === step && sigKey(f.sig, f.kind) !== key,
  );
  const matched = matchControls(
    pool,
    [current],
    [{ i: 0, sig: c.sig, kind: c.kind }],
  );
  const [id] = matched.keys();
  return id === undefined ? undefined : pool.find((f) => f.id === id);
}

export function applyCapture(
  body: RecBody,
  c: Capture,
): { body: RecBody; result: CaptureResult } {
  const step = body.current;
  if (step === null) return { body, result: "no-step" };
  if (!storable(c)) return { body, result: "ok" };

  const key = identity(c.sig, c.kind);
  const sameControl = (f: RecField): boolean =>
    f.step === step && identity(f.sig, f.kind) === key;
  // The filled field id links an edit to the field across a relabel, where identity would not. A
  // linked field from another step moves to the current one: the page it was filled into is this
  // step, so that is where it will be matched again.
  const linked =
    c.fieldId === null
      ? undefined
      : body.fields.find((f) => f.id === c.fieldId);
  const target =
    linked ?? body.fields.find(sameControl) ?? driftedField(body, step, c);
  // Any other field of the current step with the capture's identity is an older capture of the same
  // control (the target was found by link or drift). It goes too, on an update and on a revert: two
  // claimants of one control both drop in the matcher, and a revert that left one behind would save
  // a value the user cleared.

  // A revert: the user does not want this value saved, a seeded one included.
  if (c.value === c.pageDefault) {
    const fields = body.fields.filter((f) => f !== target && !sameControl(f));
    return { body: { ...body, fields }, result: "ok" };
  }

  const update = {
    sig: { ...c.sig },
    kind: c.kind,
    value: c.value,
    pageDefault: c.pageDefault,
    step,
  };
  if (target !== undefined) {
    // In place, so the field keeps its position (the review page lists fields in body order).
    const fields = body.fields.flatMap((f) =>
      f === target ? [{ ...f, ...update }] : sameControl(f) ? [] : [f],
    );
    return { body: { ...body, fields }, result: "ok" };
  }

  if (body.fields.length >= LIMITS.fields) return { body, result: "full" };
  const { id, nextId } = freshId(body);
  return {
    body: {
      ...body,
      fields: [...body.fields, { id, policy: "save", ...update }],
      nextId,
    },
    result: "ok",
  };
}

export function capturedCount(body: RecBody): number {
  return body.fields.length;
}
