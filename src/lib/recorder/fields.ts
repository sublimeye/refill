// Field identity and updates while recording (spec 6.2). One trusted edit at a time; pure, returns a
// new body. The worker re-checks secrets here whatever the content script decided. ADR 0028.
import type { ControlKind } from "../fields/eligibility";
import type { Sig } from "../fields/signature";
import { sigLooksSensitive } from "../fields/sensitive-rules";
import { sigKey } from "../match/match";
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
  // The filled field id links an edit to the field across a relabel, where identity would not.
  const linked =
    c.fieldId === null
      ? undefined
      : body.fields.find((f) => f.id === c.fieldId);
  const target = linked ?? body.fields.find(sameControl);

  // A revert: the user does not want this value saved, a seeded one included.
  if (c.value === c.pageDefault) {
    if (target === undefined) return { body, result: "ok" };
    return {
      body: { ...body, fields: body.fields.filter((f) => f !== target) },
      result: "ok",
    };
  }

  const update = {
    sig: { ...c.sig },
    kind: c.kind,
    value: c.value,
    pageDefault: c.pageDefault,
    step,
  };
  if (target !== undefined) {
    const fields: RecField[] = [];
    for (const f of body.fields) {
      if (f === target) fields.push({ ...f, ...update });
      // A linked edit supersedes an older capture of the same control: two claimants would both drop.
      else if (!sameControl(f)) fields.push(f);
    }
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
