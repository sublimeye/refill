// Content-script ↔ service-worker messages (spec §5.4, §6.2, §7). The content script sends
// signatures, never values, except a recording capture: one value the user typed while a session
// records this tab. The worker answers a scan with a fill plan. Types only from the field modules:
// this file is part of the worker bundle, and the DOM modules must never load there. Decisions:
// ADR 0025 (fill), ADR 0030 (recording).
import type { ControlKind } from "../fields/eligibility";
import type { Sig } from "../fields/signature";
import { MAX_CONTROLS } from "../limits";
import { ID_RE, LIMITS } from "../profiles/types";
import { isPlainObject } from "./protocol";

export interface ScanControl {
  /** Index of the control in the content script's scan; unique within one report. */
  i: number;
  kind: ControlKind;
  sig: Sig;
}

export type ContentRequest =
  | { type: "scan-report"; controls: ScanControl[]; truncated: boolean }
  | {
      type: "fill-result";
      filled: number;
      skipped: number;
      unsupported: number;
    }
  | { type: "record-status" }
  | {
      type: "record-capture";
      kind: ControlKind;
      sig: Sig;
      value: string;
      pageDefault: string;
      /** The field Refill filled into the edited element during this recording, if any. */
      fieldId: string | null;
    }
  | { type: "record-finish" }
  /** The pill's Unlock button, pressed on a trusted click: the worker opens the popup. */
  | { type: "toast-unlock-click" };

export interface FillItem {
  fieldId: string;
  i: number;
  kind: ControlKind;
  value: string;
  pageDefault: string;
}

/**
 * `locked` only for a site with a saved form (a locked vault answers `none` elsewhere). `gesture`
 * carries the ids of the matched `save` fields, never values. `ask` holds the control index `i` of
 * every matched field whose policy is `ask` (nothing is written for those). `recording` is true
 * when the plan comes from the tab's recording session, false for a stored-profile fill: the
 * content script must not treat a session fill as a return visit (ADR 0036).
 */
export type FillPlan =
  | { state: "locked" }
  | { state: "none" }
  | { state: "gesture"; fieldIds: string[] }
  | { state: "fill"; items: FillItem[]; ask: number[]; recording: boolean };

/** What the pill shows: the session of this tab and origin, or why it stopped. ADR 0030. */
export type RecordState =
  | { state: "off" }
  | { state: "on"; count: number }
  | { state: "full"; count: number }
  | { state: "stopped"; reason: "locked" | "expired" };

export type ContentResponse<R extends ContentRequest> = R extends {
  type: "scan-report";
}
  ? FillPlan
  : R extends { type: "fill-result" }
    ? { ok: true }
    : R extends { type: "record-status" } | { type: "record-capture" }
      ? RecordState
      : R extends { type: "record-finish" }
        ? { ok: boolean }
        : R extends { type: "toast-unlock-click" }
          ? { ok: boolean }
          : never;

/** Controls per report; `i` is in 0..MAX_CONTROLS-1. Fill-result counts are at most this. */
export { MAX_CONTROLS };
/** Every string in a signature (the scanner truncates to the same length). */
export const MAX_SIG_STRING = 256;
export const MAX_ORDINAL = 10_000;
/** A captured value and its page default: the profile value limit, so a capture always fits. */
export const MAX_CAPTURE_VALUE = LIMITS.value;

const KINDS: readonly string[] = [
  "text",
  "select",
  "checkbox",
  "radio",
] satisfies ControlKind[];

const SIG_KEYS = [
  "name",
  "idStable",
  "autocomplete",
  "type",
  "labelText",
  "ordinal",
  "formAction",
  "nameIdDerived",
] as const satisfies readonly (keyof Sig)[];

/** A plain object whose own keys are exactly `keys` (no symbols, no extras), else null. */
function exact(
  raw: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!isPlainObject(raw)) return null;
  const own = Reflect.ownKeys(raw);
  if (
    own.length !== keys.length ||
    !own.every((k) => typeof k === "string" && keys.includes(k))
  ) {
    return null;
  }
  return raw;
}

const intIn = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
const str = (v: unknown): v is string =>
  typeof v === "string" && v.length <= MAX_SIG_STRING;
const strOrNull = (v: unknown): v is string | null => v === null || str(v);
const value = (v: unknown): v is string =>
  typeof v === "string" && v.length <= MAX_CAPTURE_VALUE;
const kindOf = (v: unknown): ControlKind | null =>
  typeof v === "string" && KINDS.includes(v) ? (v as ControlKind) : null;

function parseSig(raw: unknown): Sig | null {
  const r = exact(raw, SIG_KEYS);
  if (
    r === null ||
    !strOrNull(r["name"]) ||
    !strOrNull(r["idStable"]) ||
    !strOrNull(r["autocomplete"]) ||
    !str(r["type"]) ||
    !strOrNull(r["labelText"]) ||
    !intIn(r["ordinal"], MAX_ORDINAL) ||
    !strOrNull(r["formAction"]) ||
    typeof r["nameIdDerived"] !== "boolean"
  ) {
    return null;
  }
  return {
    name: r["name"],
    idStable: r["idStable"],
    autocomplete: r["autocomplete"],
    type: r["type"],
    labelText: r["labelText"],
    ordinal: r["ordinal"],
    formAction: r["formAction"],
    nameIdDerived: r["nameIdDerived"],
  };
}

function parseControls(raw: unknown): ScanControl[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_CONTROLS) return null;
  const seen = new Set<number>();
  const out: ScanControl[] = [];
  for (let n = 0; n < raw.length; n++) {
    const c = exact(raw[n] as unknown, ["i", "kind", "sig"]);
    if (c === null) return null;
    const i = c["i"];
    if (!intIn(i, MAX_CONTROLS - 1) || seen.has(i)) return null;
    const kind = kindOf(c["kind"]);
    if (kind === null) return null;
    const sig = parseSig(c["sig"]);
    if (sig === null) return null;
    seen.add(i);
    out.push({ i, kind, sig });
  }
  return out;
}

function parseCapture(
  raw: Record<string, unknown>,
): Extract<ContentRequest, { type: "record-capture" }> | null {
  const r = exact(raw, [
    "type",
    "kind",
    "sig",
    "value",
    "pageDefault",
    "fieldId",
  ]);
  if (r === null) return null;
  const kind = kindOf(r["kind"]);
  const sig = parseSig(r["sig"]);
  const fieldId = r["fieldId"];
  if (
    kind === null ||
    sig === null ||
    !value(r["value"]) ||
    !value(r["pageDefault"]) ||
    !(fieldId === null || (typeof fieldId === "string" && ID_RE.test(fieldId)))
  ) {
    return null;
  }
  return {
    type: "record-capture",
    kind,
    sig,
    value: r["value"],
    pageDefault: r["pageDefault"],
    fieldId,
  };
}

/**
 * Strict: exact keys at every level, `controls` at most 300 with unique integer `i` in 0..299,
 * every signature string at most 256 chars, counts integers 0..300, a captured value and page
 * default at most 4096 chars, a field id null or an id. Returns a fresh object, so nothing the page
 * side attached (getters, prototypes) reaches a handler. `record-start` is page-only and never
 * parses here.
 */
export function parseContentRequest(raw: unknown): ContentRequest | null {
  if (!isPlainObject(raw)) return null;
  switch (raw["type"]) {
    case "scan-report": {
      const r = exact(raw, ["type", "controls", "truncated"]);
      if (r === null || typeof r["truncated"] !== "boolean") return null;
      const controls = parseControls(r["controls"]);
      if (controls === null) return null;
      return { type: "scan-report", controls, truncated: r["truncated"] };
    }
    case "fill-result": {
      const r = exact(raw, ["type", "filled", "skipped", "unsupported"]);
      if (
        r === null ||
        !intIn(r["filled"], MAX_CONTROLS) ||
        !intIn(r["skipped"], MAX_CONTROLS) ||
        !intIn(r["unsupported"], MAX_CONTROLS)
      ) {
        return null;
      }
      return {
        type: "fill-result",
        filled: r["filled"],
        skipped: r["skipped"],
        unsupported: r["unsupported"],
      };
    }
    case "record-status":
      return exact(raw, ["type"]) && { type: "record-status" };
    case "record-finish":
      return exact(raw, ["type"]) && { type: "record-finish" };
    case "toast-unlock-click":
      return exact(raw, ["type"]) && { type: "toast-unlock-click" };
    case "record-capture":
      return parseCapture(raw);
    default:
      return null;
  }
}
