// Recording session body (spec 6.2): the steps and fields captured so far. It lives sealed under the
// DEK (Task 5) and is changed only through the pure functions of this folder, which run in the
// service worker: no DOM, no chrome APIs, DOM modules as types only. Decisions: ADR 0028.
import type { ControlKind } from "../fields/eligibility";
import type { Sig } from "../fields/signature";
import type { FieldPolicy, Profile } from "../profiles/types";

export interface RecStep {
  index: number;
  pathHint: string;
  fingerprint: string[];
}

export interface RecField {
  id: string;
  step: number;
  sig: Sig;
  kind: ControlKind;
  value: string;
  pageDefault: string;
  policy: FieldPolicy;
}

export interface RecBody {
  steps: RecStep[];
  /** `index` of the step the page is on, or null before the first page (or on a control-less one). */
  current: number | null;
  /** Document id of the last scan-report, for the same-document step rule. */
  lastDocument: string | null;
  fields: RecField[];
  /** The next new field gets id `f<nextId>`. */
  nextId: number;
}

/** One trusted edit, as the content script reports it (signature, never anything else of the page). */
export interface Capture {
  sig: Sig;
  kind: ControlKind;
  value: string;
  pageDefault: string;
  /** The field Refill filled into this element during this recording, if any. */
  fieldId: string | null;
}

const FIRST_ID = 1;

export function emptyBody(): RecBody {
  return {
    steps: [],
    current: null,
    lastDocument: null,
    fields: [],
    nextId: FIRST_ID,
  };
}

const GENERATED_ID = /^f(\d{1,15})$/;

/** Record again: the saved steps and fields (ids, policies and values kept), on no page yet. */
export function seedBody(p: Profile): RecBody {
  let nextId = FIRST_ID;
  for (const f of p.fields) {
    const m = GENERATED_ID.exec(f.id);
    if (m?.[1] !== undefined) nextId = Math.max(nextId, Number(m[1]) + 1);
  }
  return {
    steps: p.steps.map((s) => ({
      index: s.index,
      pathHint: s.pathHint,
      fingerprint: [...s.fingerprint],
    })),
    current: null,
    lastDocument: null,
    fields: p.fields.map((f) => ({
      id: f.id,
      step: f.step,
      sig: { ...f.sig },
      kind: f.kind,
      value: f.value,
      pageDefault: f.pageDefault,
      policy: f.policy,
    })),
    nextId,
  };
}
