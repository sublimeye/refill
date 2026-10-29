// From a finished recording to the review page and the saved Profile (spec 6.2, 5.4). Pure. ADR 0028.
import type { ControlKind } from "../fields/eligibility";
import { profileApplies } from "../match/match";
import {
  LIMITS,
  parseProfile,
  type FieldPolicy,
  type Profile,
} from "../profiles/types";
import { seedBody, type RecBody } from "./types";

const covers = (origin: string, pathPrefix: string, paths: string[]): boolean =>
  paths.every((p) => profileApplies({ origin, pathPrefix }, origin, p));

/**
 * The longest common path-segment prefix of `paths`: the path itself when all are equal, else
 * "/" + the shared leading segments + "/" ("/" when none are shared). It never ends mid-segment, so
 * "/billpay1" and "/billpay2" give "/". When one path is exactly the shared segments ("/billpay"
 * next to "/billpay/confirm"), the trailing "/" is left off, or the prefix would not cover it.
 */
export function defaultPathPrefix(paths: string[]): string {
  const first = paths[0];
  if (first === undefined) return "/";
  if (paths.every((p) => p === first)) return first;
  const split = paths.map((p) => p.split("/").slice(1));
  const shared: string[] = [];
  for (let n = 0; ; n++) {
    const seg = split[0]?.[n];
    if (seg === undefined || !split.every((s) => s[n] === seg)) break;
    shared.push(seg);
  }
  if (shared.length === 0) return "/";
  const dir = `/${shared.join("/")}/`;
  // Any origin will do: only the path rule is wanted here.
  return covers("https://x", dir, paths) ? dir : dir.slice(0, -1);
}

/**
 * Path hints of the steps that have at least one field. A step without fields stays in the profile
 * (it keeps the matcher's cross-step gate honest) but does not set the path prefix: a recording that
 * starts on an unrelated page of the site must not force a wider prefix.
 */
function fieldStepHints(body: RecBody): string[] {
  const withFields = new Set(body.fields.map((f) => f.step));
  return body.steps
    .filter((s) => withFields.has(s.index))
    .map((s) => s.pathHint);
}

export interface ReviewModel {
  origin: string;
  host: string;
  steps: { index: number; pathHint: string }[];
  fields: {
    id: string;
    step: number;
    label: string;
    kind: ControlKind;
    value: string;
    policy: FieldPolicy;
  }[];
  name: string;
  pathPrefix: string;
  fillMode: "auto" | "gesture";
}

export function reviewModel(
  origin: string,
  body: RecBody,
  saved: Profile | null,
): ReviewModel {
  const host = new URL(origin).host;
  const hints = fieldStepHints(body);
  const pathPrefix =
    saved !== null && covers(origin, saved.pathPrefix, hints)
      ? saved.pathPrefix
      : defaultPathPrefix(hints);
  return {
    origin,
    host,
    steps: body.steps.map((s) => ({ index: s.index, pathHint: s.pathHint })),
    fields: body.fields.map((f) => ({
      id: f.id,
      step: f.step,
      label: f.sig.labelText ?? f.sig.name ?? "Unlabeled field",
      kind: f.kind,
      value: f.value,
      policy: f.policy,
    })),
    name: saved?.name ?? host.slice(0, LIMITS.name),
    pathPrefix,
    fillMode: saved?.fillMode ?? "auto",
  };
}

export function buildProfile(input: {
  id: string;
  origin: string;
  name: string;
  pathPrefix: string;
  fillMode: "auto" | "gesture";
  now: number;
  createdAt: number | null;
  /** Kept by an edit of the saved form (ADR 0035); a recording's save starts unused. */
  lastUsedAt?: number | null;
  body: RecBody;
  policies: Record<string, FieldPolicy>;
}): Profile | null {
  const { body, policies } = input;
  const ids = new Set(body.fields.map((f) => f.id));
  // Own keys only: a field id such as "constructor" must not read the prototype.
  if (
    !Object.keys(policies).every((id) => ids.has(id)) ||
    !body.fields.every((f) => Object.hasOwn(policies, f.id))
  ) {
    return null;
  }
  const name = input.name.trim();
  if (name.length < 1 || name.length > LIMITS.name) return null;
  if (!covers(input.origin, input.pathPrefix, fieldStepHints(body))) {
    return null;
  }
  return parseProfile({
    v: 1,
    id: input.id,
    name,
    origin: input.origin,
    pathPrefix: input.pathPrefix,
    fillMode: input.fillMode,
    createdAt: input.createdAt ?? input.now,
    lastUsedAt: input.lastUsedAt ?? null,
    steps: body.steps.map((s) => ({
      index: s.index,
      pathHint: s.pathHint,
      fingerprint: [...s.fingerprint],
    })),
    fields: body.fields.map((f) => {
      const policy = policies[f.id];
      // "Don't save" keeps no value: the field stays (its sig, step and kind still claim the control,
      // ADR 0025), but nothing the user typed or the page showed is stored (C1, ADR 0033).
      const keep = policy !== "skip";
      return {
        id: f.id,
        sig: { ...f.sig },
        step: f.step,
        kind: f.kind,
        value: keep ? f.value : "",
        pageDefault: keep ? f.pageDefault : "",
        policy,
      };
    }),
  });
}

/**
 * The saved form as a recording body. A "Don't save" field keeps no value or page default, even
 * one stored before C1 (ADR 0033): saved mode never shows it, nor revives it on an edit.
 */
function savedBody(p: Profile): RecBody {
  const body = seedBody(p);
  return {
    ...body,
    fields: body.fields.map((f) =>
      f.policy === "skip" ? { ...f, value: "", pageDefault: "" } : f,
    ),
  };
}

/** The review page's model for the saved form itself (saved mode, ADR 0035): its prefix as stored. */
export function savedModel(p: Profile): ReviewModel {
  return {
    ...reviewModel(p.origin, savedBody(p), p),
    pathPrefix: p.pathPrefix,
  };
}

/**
 * The saved form `p` with a new name, fill mode, prefix and policies (saved mode's Save, ADR 0035):
 * same id, origin, steps, fields, values, `createdAt` and `lastUsedAt`. `null` when `buildProfile`
 * refuses it (a missing or unknown policy, a blank name, a prefix that misses a step with fields),
 * or when a "Don't save" field would become "Fill it in": it holds no value, so only Record again
 * can capture one. It may become "Ask me", still empty.
 */
export function editSaved(
  p: Profile,
  edit: {
    name: string;
    fillMode: "auto" | "gesture";
    pathPrefix: string;
    policies: Record<string, FieldPolicy>;
  },
): Profile | null {
  const { policies } = edit;
  if (
    p.fields.some(
      (f) =>
        f.policy === "skip" &&
        Object.hasOwn(policies, f.id) &&
        policies[f.id] === "save",
    )
  ) {
    return null;
  }
  return buildProfile({
    id: p.id,
    origin: p.origin,
    name: edit.name,
    pathPrefix: edit.pathPrefix,
    fillMode: edit.fillMode,
    now: p.createdAt,
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt,
    body: savedBody(p),
    policies,
  });
}
