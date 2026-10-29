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

// WHATWG autofill field names. Autocomplete evidence only counts when the value names one of
// these: sites set junk ("nope", "chrome-off", "disabled") on every control to defeat autofill, and
// such a value is shared by all controls so it identifies nothing.
const AUTOFILL_FIELD_NAMES = new Set([
  "name",
  "honorific-prefix",
  "given-name",
  "additional-name",
  "family-name",
  "honorific-suffix",
  "nickname",
  "username",
  "new-password",
  "current-password",
  "one-time-code",
  "organization-title",
  "organization",
  "street-address",
  "address-line1",
  "address-line2",
  "address-line3",
  "address-level4",
  "address-level3",
  "address-level2",
  "address-level1",
  "country",
  "country-name",
  "postal-code",
  "cc-name",
  "cc-given-name",
  "cc-additional-name",
  "cc-family-name",
  "cc-number",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
  "cc-type",
  "transaction-currency",
  "transaction-amount",
  "language",
  "bday",
  "bday-day",
  "bday-month",
  "bday-year",
  "sex",
  "url",
  "photo",
  "email",
  "impp",
  "tel",
  "tel-country-code",
  "tel-national",
  "tel-area-code",
  "tel-local",
  "tel-local-prefix",
  "tel-local-suffix",
  "tel-extension",
]);

// Scope/contact modifiers that precede the field name; ignored when looking for the token.
const AUTOFILL_MODIFIERS = new Set([
  "shipping",
  "billing",
  "home",
  "work",
  "mobile",
  "fax",
  "pager",
  "webauthn",
]);

function hasAutofillFieldName(autocomplete: string): boolean {
  for (const t of autocomplete.toLowerCase().split(/\s+/)) {
    if (t === "" || t.startsWith("section-") || AUTOFILL_MODIFIERS.has(t)) {
      continue;
    }
    if (AUTOFILL_FIELD_NAMES.has(t)) return true;
  }
  return false;
}

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

/**
 * True when `pathname` on `origin` is under the profile's path prefix. The origin is compared
 * exactly; the path case-insensitively (SPAs rewrite "/WebPayments/..." to "/webpayments/..."), on
 * segment boundaries. ADR 0034.
 */
export function profileApplies(
  profile: { origin: string; pathPrefix: string },
  origin: string,
  pathname: string,
): boolean {
  if (!profile.pathPrefix.startsWith("/") || profile.origin !== origin) {
    return false;
  }
  const prefix = profile.pathPrefix.toLowerCase();
  const path = pathname.toLowerCase();
  // Segment boundaries: "/billpay" must not apply to "/billpayment".
  return (
    path === prefix ||
    (prefix.endsWith("/") && path.startsWith(prefix)) ||
    path.startsWith(`${prefix}/`)
  );
}

/**
 * Where a profile stands on a page: `on-path` under its prefix, `off-path` elsewhere on its own
 * origin (fields fill there only where their step's fingerprint resembles the page, see
 * `matchControls`), null on any other origin or for a prefix that is no path. ADR 0034.
 */
export function pathScope(
  profile: { origin: string; pathPrefix: string },
  origin: string,
  pathname: string,
): "on-path" | "off-path" | null {
  if (!profile.pathPrefix.startsWith("/") || profile.origin !== origin) {
    return null;
  }
  return profileApplies(profile, origin, pathname) ? "on-path" : "off-path";
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

/** Evidence score of `page` against `saved`, or -Infinity when the kind/type gate fails. */
export function scoreSig(
  saved: Sig,
  page: Sig,
  savedKind: ControlKind,
  pageKind: ControlKind,
): number {
  if (!typesCompatible(saved, page, savedKind, pageKind)) return -Infinity;
  let s = 0;
  if (
    saved.autocomplete !== null &&
    eq(saved.autocomplete, page.autocomplete) &&
    hasAutofillFieldName(saved.autocomplete)
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
 * most one field.
 *
 * Cross-step gate: with more than one recorded step, a field may match only if its step is among
 * the steps whose fingerprint has the maximal Jaccard similarity with this page, and that maximum
 * is > 0 (a step-1 field never fills a step-2 page). When several fields still claim one control,
 * the step with the highest similarity wins, provided it is >= MIN_JACCARD and strictly ahead of
 * the others; otherwise every claimant is dropped.
 *
 * Off-path gate (`offPath`, ADR 0034): on a page of the profile's origin outside its path prefix, a
 * field may claim a control only if its own step's fingerprint has Jaccard >= MIN_JACCARD with this
 * page, single-step profiles included. Scores, margins and conflicts are unchanged.
 */
export function matchControls(
  saved: SavedField[],
  steps: { index: number; fingerprint: string[] }[],
  page: MatchInput[],
  opts: { offPath?: boolean } = {},
): Map<string, number> {
  const offPath = opts.offPath === true;
  const pageKeys = page.map((c) => sigKey(c.sig, c.kind));
  const stepJ = new Map<number, number>();
  for (const st of steps)
    stepJ.set(st.index, jaccard(st.fingerprint, pageKeys));
  const simOf = (step: number): number => stepJ.get(step) ?? 0;

  let gate: Set<number> | null = null;
  if (steps.length > 1) {
    let max = 0;
    for (const j of stepJ.values()) if (j > max) max = j;
    gate = new Set();
    if (max > 0) {
      for (const [index, j] of stepJ) if (j === max) gate.add(index);
    }
  }

  const claims = new Map<number, SavedField[]>();
  for (const f of saved) {
    if (gate !== null && !gate.has(f.step)) continue;
    if (offPath && simOf(f.step) < MIN_JACCARD) continue;
    const i = claim(f, page);
    if (i === null) continue;
    const list = claims.get(i);
    if (list === undefined) claims.set(i, [f]);
    else list.push(f);
  }

  const winners = new Map<string, number>();
  for (const [i, fields] of claims) {
    const only = fields[0];
    if (fields.length === 1 && only !== undefined) {
      winners.set(only.id, i);
      continue;
    }
    const sims = fields.map((f) => ({ f, j: simOf(f.step) }));
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
