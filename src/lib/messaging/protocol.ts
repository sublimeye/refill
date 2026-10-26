// Typed message protocol between extension pages and the service worker (spec §7).
// Decisions: ADR 0014.
import { browser } from "wxt/browser";
import type { UnlockResult, VaultStatus } from "../vault/types";

export type PageRequest =
  | { type: "vault-status" }
  | { type: "vault-create"; passphrase: string }
  | { type: "vault-unlock"; passphrase: string }
  | { type: "vault-lock" };

/** Placeholder: Plan 2 adds the content-script messages. Until then no content message is valid. */
export type ContentRequest = never;

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
};

function isPlainObject(x: unknown): x is Record<string, unknown> {
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
