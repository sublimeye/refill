// Profile record shape (spec 4.2) and its strict parser. A profile is decrypted from storage, so
// it is validated like any other untrusted input: exact keys, bounded sizes, no extra data.
import type { ControlKind } from "../fields/eligibility";
import type { Sig } from "../fields/signature";
import { normalizeOrigin } from "../sites/origin";

export type FieldPolicy = "save" | "ask" | "skip";

export interface ProfileField {
  /** Stable id within the profile; matches /^[A-Za-z0-9_-]{1,64}$/. */
  id: string;
  sig: Sig;
  /** Index of an entry in `Profile.steps`. */
  step: number;
  kind: ControlKind;
  /** Checkbox: "true" | "false"; radio/select: the option value; text: the text. */
  value: string;
  pageDefault: string;
  policy: FieldPolicy;
}

export interface ProfileStep {
  index: number;
  pathHint: string;
  fingerprint: string[];
}

export interface Profile {
  v: 1;
  id: string;
  name: string;
  origin: string;
  pathPrefix: string;
  fillMode: "auto" | "gesture";
  createdAt: number;
  lastUsedAt: number | null;
  steps: ProfileStep[];
  fields: ProfileField[];
}

export const LIMITS = {
  name: 120,
  value: 4096,
  fields: 200,
  steps: 10,
  sigString: 256,
  pathPrefix: 256,
  pathHint: 256,
  fingerprint: 300,
  fingerprintEntry: 1024,
} as const;

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const PROFILE_KEYS = [
  "v",
  "id",
  "name",
  "origin",
  "pathPrefix",
  "fillMode",
  "createdAt",
  "lastUsedAt",
  "steps",
  "fields",
];
const STEP_KEYS = ["index", "pathHint", "fingerprint"];
const FIELD_KEYS = [
  "id",
  "sig",
  "step",
  "kind",
  "value",
  "pageDefault",
  "policy",
];
const SIG_KEYS = [
  "name",
  "idStable",
  "autocomplete",
  "type",
  "labelText",
  "ordinal",
  "formAction",
  "nameIdDerived",
];
const KINDS: readonly string[] = ["text", "select", "checkbox", "radio"];
const POLICIES: readonly string[] = ["save", "ask", "skip"];

function rec(
  v: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const own = Object.keys(r);
  if (own.length !== keys.length || !keys.every((k) => own.includes(k))) {
    return null;
  }
  return r;
}

const str = (v: unknown, max: number, min = 0): v is string =>
  typeof v === "string" && v.length >= min && v.length <= max;
const strOrNull = (v: unknown, max: number): v is string | null =>
  v === null || str(v, max);
const nonNegFinite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const nonNegInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

function parseSig(raw: unknown): Sig | null {
  const r = rec(raw, SIG_KEYS);
  if (!r) return null;
  const max = LIMITS.sigString;
  if (
    !strOrNull(r.name, max) ||
    !strOrNull(r.idStable, max) ||
    !strOrNull(r.autocomplete, max) ||
    !str(r.type, max) ||
    !strOrNull(r.labelText, max) ||
    !nonNegInt(r.ordinal) ||
    !strOrNull(r.formAction, max) ||
    typeof r.nameIdDerived !== "boolean"
  ) {
    return null;
  }
  return {
    name: r.name,
    idStable: r.idStable,
    autocomplete: r.autocomplete,
    type: r.type,
    labelText: r.labelText,
    ordinal: r.ordinal,
    formAction: r.formAction,
    nameIdDerived: r.nameIdDerived,
  };
}

function parseStep(raw: unknown): ProfileStep | null {
  const r = rec(raw, STEP_KEYS);
  if (!r) return null;
  if (
    !nonNegInt(r.index) ||
    r.index >= LIMITS.steps ||
    !str(r.pathHint, LIMITS.pathHint) ||
    !Array.isArray(r.fingerprint) ||
    r.fingerprint.length > LIMITS.fingerprint
  ) {
    return null;
  }
  const fingerprint: string[] = [];
  for (const f of r.fingerprint as unknown[]) {
    if (!str(f, LIMITS.fingerprintEntry)) return null;
    fingerprint.push(f);
  }
  return { index: r.index, pathHint: r.pathHint, fingerprint };
}

function parseField(
  raw: unknown,
  stepIndexes: Set<number>,
): ProfileField | null {
  const r = rec(raw, FIELD_KEYS);
  if (!r) return null;
  const sig = parseSig(r.sig);
  if (
    !sig ||
    typeof r.id !== "string" ||
    !ID_RE.test(r.id) ||
    !nonNegInt(r.step) ||
    !stepIndexes.has(r.step) ||
    typeof r.kind !== "string" ||
    !KINDS.includes(r.kind) ||
    !str(r.value, LIMITS.value) ||
    !str(r.pageDefault, LIMITS.value) ||
    typeof r.policy !== "string" ||
    !POLICIES.includes(r.policy)
  ) {
    return null;
  }
  return {
    id: r.id,
    sig,
    step: r.step,
    kind: r.kind as ControlKind,
    value: r.value,
    pageDefault: r.pageDefault,
    policy: r.policy as FieldPolicy,
  };
}

/** Strict: `null` for anything that is not exactly a valid v1 profile. Returns a fresh object. */
export function parseProfile(raw: unknown): Profile | null {
  const r = rec(raw, PROFILE_KEYS);
  if (!r) return null;
  if (
    r.v !== 1 ||
    typeof r.id !== "string" ||
    !ID_RE.test(r.id) ||
    !str(r.name, LIMITS.name, 1) ||
    typeof r.origin !== "string" ||
    normalizeOrigin(r.origin) !== r.origin ||
    !str(r.pathPrefix, LIMITS.pathPrefix, 1) ||
    !r.pathPrefix.startsWith("/") ||
    (r.fillMode !== "auto" && r.fillMode !== "gesture") ||
    !nonNegFinite(r.createdAt) ||
    (r.lastUsedAt !== null && !nonNegFinite(r.lastUsedAt)) ||
    !Array.isArray(r.steps) ||
    r.steps.length > LIMITS.steps ||
    !Array.isArray(r.fields) ||
    r.fields.length > LIMITS.fields
  ) {
    return null;
  }
  const steps: ProfileStep[] = [];
  const stepIndexes = new Set<number>();
  for (const s of r.steps as unknown[]) {
    const step = parseStep(s);
    if (!step || stepIndexes.has(step.index)) return null;
    stepIndexes.add(step.index);
    steps.push(step);
  }
  const fields: ProfileField[] = [];
  const fieldIds = new Set<string>();
  for (const f of r.fields as unknown[]) {
    const field = parseField(f, stepIndexes);
    if (!field || fieldIds.has(field.id)) return null;
    fieldIds.add(field.id);
    fields.push(field);
  }
  return {
    v: 1,
    id: r.id,
    name: r.name,
    origin: r.origin,
    pathPrefix: r.pathPrefix,
    fillMode: r.fillMode,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    steps,
    fields,
  };
}
