// Weighted signature matcher (spec 5.4). Pure: no DOM, no chrome APIs. Runs in the service worker,
// so it imports types only and must never pull the DOM-bound field modules into that bundle.

import type { ControlKind } from "../fields/eligibility";
import type { Sig } from "../fields/signature";

export const WEIGHT_AUTOCOMPLETE = 4;
export const WEIGHT_NAME = 3;
export const WEIGHT_LABEL = 3;
export const WEIGHT_ID = 2;
export const WEIGHT_FORM_ACTION = 1;
export const WEIGHT_ORDINAL = 1;

export const MIN_SCORE = 5;
export const MIN_MARGIN = 2;
export const MIN_JACCARD = 0.5;

const TEXT_LIKE = new Set([
  "text",
  "email",
  "tel",
  "number",
  "search",
  "url",
  "textarea",
  "date",
]);

export interface MatchInput {
  i: number;
  sig: Sig;
  kind: ControlKind;
}

export interface SavedField {
  id: string;
  step: number;
  sig: Sig;
  kind: ControlKind;
}

export function profileApplies(
  profile: { origin: string; pathPrefix: string },
  origin: string,
  pathname: string,
): boolean {
  return (
    profile.pathPrefix.startsWith("/") &&
    profile.origin === origin &&
    pathname.startsWith(profile.pathPrefix)
  );
}

function typesCompatible(
  a: Sig,
  b: Sig,
  ka: ControlKind,
  kb: ControlKind,
): boolean {
  if (ka !== kb) return false;
  if (ka === "text" && TEXT_LIKE.has(a.type) && TEXT_LIKE.has(b.type)) {
    return true;
  }
  return a.type === b.type;
}

const eq = (a: string | null, b: string | null): boolean =>
  a !== null && a !== "" && a === b;

/**
 * Evidence score of `page` against `saved`, or -Infinity when the kind/type gate fails.
 * Kinds default to "text" (the only kind where distinct types can be compatible).
 */
export function scoreSig(
  saved: Sig,
  page: Sig,
  savedKind: ControlKind = "text",
  pageKind: ControlKind = savedKind,
): number {
  if (!typesCompatible(saved, page, savedKind, pageKind)) return -Infinity;
  let s = 0;
  if (
    eq(saved.autocomplete, page.autocomplete) &&
    saved.autocomplete !== "on" &&
    saved.autocomplete !== "off"
  ) {
    s += WEIGHT_AUTOCOMPLETE;
  }
  if (eq(saved.name, page.name)) s += WEIGHT_NAME;
  if (eq(saved.labelText, page.labelText)) s += WEIGHT_LABEL;
  // A name/id pair derived from one another is a single piece of evidence (the name weight above).
  if (
    !saved.nameIdDerived &&
    !page.nameIdDerived &&
    eq(saved.idStable, page.idStable)
  ) {
    s += WEIGHT_ID;
  }
  if (eq(saved.formAction, page.formAction)) s += WEIGHT_FORM_ACTION;
  if (saved.ordinal === page.ordinal) s += WEIGHT_ORDINAL;
  return s;
}

export function sigKey(sig: Sig, kind: ControlKind): string {
  return `${kind}|${sig.name ?? ""}|${sig.labelText ?? ""}|${sig.autocomplete ?? ""}`;
}

export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** The control a saved field claims: best score >= MIN_SCORE, ahead of the runner-up by MIN_MARGIN. */
function claim(saved: SavedField, page: MatchInput[]): number | null {
  // Order-independent: ties on score keep the lowest control index first, and a tie for best has
  // margin 0 so it never claims anything.
  const scored: { i: number; score: number }[] = [];
  for (const c of page) {
    const score = scoreSig(saved.sig, c.sig, saved.kind, c.kind);
    if (score !== -Infinity) scored.push({ i: c.i, score });
  }
  scored.sort((x, y) => y.score - x.score || x.i - y.i);
  const best = scored[0];
  if (best === undefined || best.score < MIN_SCORE) return null;
  const runnerUp = scored[1]?.score ?? -Infinity;
  return best.score - runnerUp >= MIN_MARGIN ? best.i : null;
}

/**
 * Maps saved field id -> page control index. A field matches at most one control and a control at
 * most one field; when several fields claim one control the step whose fingerprint best resembles
 * the page wins, provided the similarity is >= MIN_JACCARD and strictly ahead of the others.
 */
export function matchControls(
  saved: SavedField[],
  steps: { index: number; fingerprint: string[] }[],
  page: MatchInput[],
): Map<string, number> {
  const claims = new Map<number, SavedField[]>();
  for (const f of saved) {
    const i = claim(f, page);
    if (i === null) continue;
    const list = claims.get(i);
    if (list === undefined) claims.set(i, [f]);
    else list.push(f);
  }

  const winners = new Map<string, number>();
  let pageKeys: string[] | null = null;
  for (const [i, fields] of claims) {
    const only = fields[0];
    if (fields.length === 1 && only !== undefined) {
      winners.set(only.id, i);
      continue;
    }
    pageKeys ??= page.map((c) => sigKey(c.sig, c.kind));
    const sims = fields.map((f) => {
      const step = steps.find((s) => s.index === f.step);
      return {
        f,
        j: step === undefined ? 0 : jaccard(step.fingerprint, pageKeys!),
      };
    });
    sims.sort((x, y) => y.j - x.j);
    const top = sims[0];
    const next = sims[1];
    if (
      top !== undefined &&
      top.j >= MIN_JACCARD &&
      (next === undefined || next.j < top.j)
    ) {
      winners.set(top.f.id, i);
    }
  }

  // Emit in saved-field order so the result is independent of claim bookkeeping.
  const out = new Map<string, number>();
  for (const f of saved) {
    const i = winners.get(f.id);
    if (i !== undefined) out.set(f.id, i);
  }
  return out;
}
