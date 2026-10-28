// Typed message protocol between extension pages and the service worker (spec §7).
// Decisions: ADR 0014.
import { browser } from "wxt/browser";
import type { IntentKind } from "../sites/intent";
import type { UnlockResult, VaultStatus } from "../vault/types";

export type SiteStatus =
  | {
      origin: string;
      enabled: boolean;
      granted: boolean;
      accessRevoked: boolean;
      hasProfile: boolean;
    }
  | { origin: null };

/** What the popup learns about the one recording session (ADR 0031). `here`: it is this tab's. */
export type RecordPageState =
  | { state: "off" }
  | {
      state: "on" | "full" | "review";
      origin: string;
      count: number;
      here: boolean;
    };

export type PageRequest =
  | { type: "vault-status" }
  | { type: "vault-create"; passphrase: string }
  | { type: "vault-unlock"; passphrase: string }
  | { type: "vault-lock" }
  | { type: "site-status"; origin: string }
  | { type: "site-enable"; tabId: number; origin: string }
  | { type: "site-remove"; origin: string }
  | { type: "site-intent"; tabId: number; origin: string; kind: IntentKind }
  | { type: "record-start"; tabId: number; origin: string }
  | { type: "record-state"; tabId: number }
  | { type: "record-finish"; tabId: number }
  | { type: "record-cancel"; tabId: number };

export type {
  ContentRequest,
  ContentResponse,
  FillPlan,
} from "./content-protocol";

export type PageResponse<R extends PageRequest> = R extends {
  type: "vault-status";
}
  ? VaultStatus
  : R extends { type: "vault-create" }
    ? { ok: true } | { ok: false; error: "exists" | "weak" }
    : R extends { type: "vault-unlock" }
      ? UnlockResult
      : R extends { type: "vault-lock" }
        ? { ok: true }
        : R extends { type: "site-status" }
          ? SiteStatus
          : R extends { type: "site-enable" }
            ? | { ok: true }
              | { ok: false; error: "not-granted" | "invalid-origin" }
            : R extends { type: "site-remove" }
              ? { ok: true }
              : R extends { type: "site-intent" }
                ? { ok: true } | { ok: false; error: "invalid-origin" }
                : R extends { type: "record-start" }
                  ? | { ok: true }
                    | {
                        ok: false;
                        error:
                          | "locked"
                          | "not-granted"
                          | "invalid-origin"
                          | "tab-moved";
                      }
                  : R extends { type: "record-state" }
                    ? RecordPageState
                    : R extends { type: "record-finish" }
                      ? { ok: boolean }
                      : R extends { type: "record-cancel" }
                        ? { ok: true }
                        : never;

/** What the router resolves for a message it refuses or whose handler threw. Never carries detail. */
export type RouterError = { ok: false; error: "rejected" | "internal" };

export const MAX_MESSAGE_CHARS = 65_536; // compared with the JSON string length, not UTF-8 bytes
export const MAX_STRING_LENGTH = 1024;

const KEYS_BY_TYPE: Readonly<Record<PageRequest["type"], readonly string[]>> = {
  "vault-status": ["type"],
  "vault-create": ["type", "passphrase"],
  "vault-unlock": ["type", "passphrase"],
  "vault-lock": ["type"],
  "site-status": ["type", "origin"],
  "site-enable": ["type", "tabId", "origin"],
  "site-remove": ["type", "origin"],
  "site-intent": ["type", "tabId", "origin", "kind"],
  "record-start": ["type", "tabId", "origin"],
  "record-state": ["type", "tabId"],
  "record-finish": ["type", "tabId"],
  "record-cancel": ["type", "tabId"],
};

/** Origins are short: a longer string cannot be a canonical https origin worth handling. */
export const MAX_ORIGIN_LENGTH = 256;

function parseOrigin(v: unknown): string | null {
  return typeof v === "string" && v.length <= MAX_ORIGIN_LENGTH ? v : null;
}

function parseTabId(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

export function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const proto: unknown = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

/** Exact keys only, no extras; strings at most 1024 UTF-16 units. Returns a fresh object. */
export function parsePageRequest(raw: unknown): PageRequest | null {
  if (!isPlainObject(raw)) return null;
  const type = raw["type"];
  if (typeof type !== "string" || !Object.hasOwn(KEYS_BY_TYPE, type)) {
    return null;
  }
  const expected = KEYS_BY_TYPE[type as PageRequest["type"]];
  const keys = Reflect.ownKeys(raw);
  if (
    keys.length !== expected.length ||
    !keys.every((k) => typeof k === "string" && expected.includes(k))
  ) {
    return null;
  }
  switch (type as PageRequest["type"]) {
    case "vault-status":
      return { type: "vault-status" };
    case "vault-lock":
      return { type: "vault-lock" };
    case "vault-create":
    case "vault-unlock": {
      const passphrase = raw["passphrase"];
      if (typeof passphrase !== "string") return null;
      if (passphrase.length > MAX_STRING_LENGTH) return null;
      return { type: type as "vault-create" | "vault-unlock", passphrase };
    }
    case "site-status":
    case "site-remove": {
      const origin = parseOrigin(raw["origin"]);
      if (origin === null) return null;
      return { type: type as "site-status" | "site-remove", origin };
    }
    case "site-enable":
    case "record-start": {
      const origin = parseOrigin(raw["origin"]);
      const tabId = parseTabId(raw["tabId"]);
      if (origin === null || tabId === null) return null;
      return { type: type as "site-enable" | "record-start", tabId, origin };
    }
    case "site-intent": {
      const origin = parseOrigin(raw["origin"]);
      const tabId = parseTabId(raw["tabId"]);
      const kind = raw["kind"];
      if (origin === null || tabId === null) return null;
      if (kind !== "enable" && kind !== "record") return null;
      return { type: "site-intent", tabId, origin, kind };
    }
    case "record-state":
    case "record-finish":
    case "record-cancel": {
      const tabId = parseTabId(raw["tabId"]);
      if (tabId === null) return null;
      return {
        type: type as "record-state" | "record-finish" | "record-cancel",
        tabId,
      };
    }
  }
}

/** The router refused the message or its handler failed. Carries only the generic code. */
export class MessagingError extends Error {
  readonly code: RouterError["error"];
  constructor(code: RouterError["error"]) {
    super(code);
    this.name = "MessagingError";
    this.code = code;
  }
}

function isRouterError(x: unknown): x is RouterError {
  if (typeof x !== "object" || x === null) return false;
  const r = x as { ok?: unknown; error?: unknown };
  return r.ok === false && (r.error === "rejected" || r.error === "internal");
}

/**
 * Page-side helper. Resolves the handler's response; rejects with `MessagingError` when the
 * router refused the message or the handler failed, or when no valid answer came back.
 */
export async function sendToSw<R extends PageRequest>(
  req: R,
): Promise<PageResponse<R>> {
  let res: unknown;
  try {
    res = await browser.runtime.sendMessage(req);
  } catch {
    // Transport failure (no receiver, invalidated context): never surface the raw error.
    throw new MessagingError("internal");
  }
  if (isRouterError(res)) throw new MessagingError(res.error);
  if (typeof res !== "object" || res === null) {
    throw new MessagingError("internal");
  }
  return res as PageResponse<R>;
}
