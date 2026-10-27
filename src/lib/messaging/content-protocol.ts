// Content-script ↔ service-worker messages (spec §5.4, §7). The content script sends signatures,
// never values; the worker answers a scan with a fill plan. Types only from the field modules: this
// file is part of the worker bundle, and the DOM modules must never load there. Decisions: ADR 0025.
import type { ControlKind } from "../fields/eligibility";
import type { Sig } from "../fields/signature";
import { MAX_CONTROLS } from "../limits";
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
    };

export interface FillItem {
  fieldId: string;
  i: number;
  kind: ControlKind;
  value: string;
  pageDefault: string;
}

export type FillPlan =
  | { state: "locked" }
  | { state: "none" }
  | { state: "gesture"; count: number }
  | { state: "fill"; items: FillItem[] };

export type ContentResponse<R extends ContentRequest> = R extends {
  type: "scan-report";
}
  ? FillPlan
  : R extends { type: "fill-result" }
    ? { ok: true }
    : never;

/** Controls per report; `i` is in 0..MAX_CONTROLS-1. Fill-result counts are at most this. */
export { MAX_CONTROLS };
/** Every string in a signature (the scanner truncates to the same length). */
export const MAX_SIG_STRING = 256;
export const MAX_ORDINAL = 10_000;

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
    const kind = c["kind"];
    if (!intIn(i, MAX_CONTROLS - 1) || seen.has(i)) return null;
    if (typeof kind !== "string" || !KINDS.includes(kind)) return null;
    const sig = parseSig(c["sig"]);
    if (sig === null) return null;
    seen.add(i);
    out.push({ i, kind: kind as ControlKind, sig });
  }
  return out;
}

/**
 * Strict: exact keys at every level, `controls` at most 300 with unique integer `i` in 0..299,
 * every signature string at most 256 chars, counts integers 0..300. Returns a fresh object, so
 * nothing the page side attached (getters, prototypes) reaches a handler.
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
    default:
      return null;
  }
}
