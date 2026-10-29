// Sender-validated router for runtime messages (spec §7). Every message is size-checked, the
// sender is classified, and the payload is parsed before any handler runs. Decisions: ADR 0014,
// ADR 0025 (content senders).
import { browser, type Browser } from "wxt/browser";
import { readSites } from "../sites";
import { normalizeOrigin, originPattern } from "../sites/origin";
import { parseContentRequest, type ContentRequest } from "./content-protocol";
import {
  MAX_MESSAGE_CHARS,
  parsePageRequest,
  type PageRequest,
  type RouterError,
} from "./protocol";

export type SenderKind = "page" | "content";

/**
 * `page`: an extension page of this extension, never a frame embedded in a web page. `content`:
 * a content script in the top frame of an https page. Anything else is `null`.
 */
export function classifySender(
  sender: Browser.runtime.MessageSender,
  runtimeId: string,
): SenderKind | null {
  if (!runtimeId || sender.id !== runtimeId) return null;
  const prefix = `chrome-extension://${runtimeId}/`;
  if (sender.url?.startsWith(prefix)) {
    // Chrome sets `origin` on extension pages; when present it must be ours.
    if (sender.origin !== undefined && sender.origin !== prefix.slice(0, -1)) {
      return null;
    }
    // An extension page opened as a tab is fine; one framed inside a web page is not.
    if (!sender.tab || sender.tab.url?.startsWith(prefix)) return "page";
    return null;
  }
  if (
    sender.tab &&
    sender.frameId === 0 &&
    sender.origin?.startsWith("https://")
  ) {
    return "content";
  }
  return null;
}

export type PageHandlers = {
  [K in PageRequest["type"]]: (
    req: Extract<PageRequest, { type: K }>,
  ) => Promise<unknown>;
};

/**
 * What a content handler learns about its caller. Every member comes from the browser-provided
 * sender, never from the message (spec §7).
 */
export interface ContentContext {
  /** `sender.origin`: canonical https, enabled, not revoked, granted. */
  origin: string;
  /** Pathname of `sender.url`, whose origin equals `origin`. */
  pathname: string;
  tabId: number;
  documentId: string | undefined;
}

export type ContentHandlers = {
  [K in ContentRequest["type"]]: (
    req: Extract<ContentRequest, { type: K }>,
    ctx: ContentContext,
  ) => Promise<unknown>;
};

/**
 * Re-checks a sender `classifySender` called `content`, in this order: `sender.origin` is a
 * canonical https origin; the site index has a record for exactly that origin with
 * `accessRevoked: false`; the host permission for its pattern is held; `sender.url` parses as https
 * on that same origin; the tab id is real. The default-port pattern grants every port (ADR 0018),
 * so the exact-origin record is what keeps another port of an enabled site out. `null` = reject.
 * Storage or permission API failures reject the promise (the router answers `internal`).
 */
export async function authorizeContentSender(
  sender: Browser.runtime.MessageSender,
): Promise<ContentContext | null> {
  const origin = sender.origin;
  if (origin === undefined || normalizeOrigin(origin) !== origin) return null;
  const sites = await readSites();
  // A canonical https origin is never a prototype key.
  if (!Object.hasOwn(sites, origin) || sites[origin]!.accessRevoked) {
    return null;
  }
  const granted = await browser.permissions.contains({
    origins: [originPattern(origin)],
  });
  if (granted !== true) return null;
  let url: URL;
  try {
    url = new URL(sender.url ?? "");
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.origin !== origin) return null;
  const tabId = sender.tab?.id;
  if (tabId === undefined || !Number.isSafeInteger(tabId) || tabId < 0) {
    return null;
  }
  return {
    origin,
    pathname: url.pathname,
    tabId,
    documentId: sender.documentId,
  };
}

const REJECTED: RouterError = { ok: false, error: "rejected" };
const INTERNAL: RouterError = { ok: false, error: "internal" };

function tooLarge(msg: unknown): boolean {
  try {
    const json = JSON.stringify(msg);
    return json === undefined || json.length > MAX_MESSAGE_CHARS;
  } catch {
    return true; // cyclic, BigInt, or a throwing toJSON: not a valid message
  }
}

/** Logs the error name only: a message or stack could carry secrets. */
function logFailure(type: string, err: unknown): void {
  console.error(
    "[refill] handler failed:",
    type,
    err instanceof Error ? err.name : "error",
  );
}

/** The turn of the latest `record-capture`: settled once its handler was entered (or it failed). */
interface CaptureTurns {
  last: Promise<void>;
}

function routeContent(
  handlers: ContentHandlers,
  msg: unknown,
  sender: Browser.runtime.MessageSender,
  turns: CaptureTurns,
): Promise<unknown> {
  // Parsed before any store read: malformed traffic costs no IO.
  const req = parseContentRequest(msg);
  if (req === null) return Promise.resolve(REJECTED);
  const handler = handlers[req.type] as (
    r: ContentRequest,
    ctx: ContentContext,
  ) => Promise<unknown>;
  // Captures enter their handler in the order they arrived, whatever order their sender checks
  // finish in: the handler joins the session chain synchronously, so the worker applies them in
  // that order too. A content script may send a newer capture of a control while an older one is
  // still unanswered (at page hide or submit), and the older must not land last (ADR 0032).
  const ordered = req.type === "record-capture";
  const before = turns.last;
  let release = (): void => undefined;
  if (ordered) {
    const mine = new Promise<void>((r) => (release = r));
    // A turn ends only once the turns before it have: a capture whose check fails at once must not
    // let the next one overtake an earlier capture whose check is still running.
    turns.last = before.then(() => mine);
  }
  return (async () => {
    try {
      const ctx = await authorizeContentSender(sender);
      if (ordered) await before;
      if (ctx === null) return REJECTED;
      const answer = handler(req, ctx);
      release();
      return await answer;
    } catch (err) {
      logFailure(req.type, err);
      return INTERNAL;
    } finally {
      release();
    }
  })();
}

export function createRouter(handlers: {
  page: PageHandlers;
  content: ContentHandlers;
}): (
  msg: unknown,
  sender: Browser.runtime.MessageSender,
) => Promise<unknown> | undefined {
  const turns: CaptureTurns = { last: Promise.resolve() };
  return (msg, sender) => {
    if (tooLarge(msg)) return Promise.resolve(REJECTED);
    const kind = classifySender(sender, browser.runtime.id);
    if (kind === "content") {
      return routeContent(handlers.content, msg, sender, turns);
    }
    if (kind !== "page") return Promise.resolve(REJECTED);
    const req = parsePageRequest(msg);
    if (req === null) return Promise.resolve(REJECTED);
    const handler = handlers.page[req.type] as (
      r: PageRequest,
    ) => Promise<unknown>;
    return (async () => {
      try {
        return await handler(req);
      } catch (err) {
        logFailure(req.type, err);
        return INTERNAL;
      }
    })();
  };
}

/**
 * Adapts the router to `runtime.onMessage`. Chrome's callback-style API is what WXT's `browser`
 * is in Chrome (it only differs where the `browser` global exists), and it ignores a returned
 * Promise: the answer must go through `sendResponse`, and the listener must return `true` to keep
 * the channel open for it. Rejected messages are answered at once, so no channel stays open.
 */
export function toRuntimeListener(
  router: ReturnType<typeof createRouter>,
): (
  msg: unknown,
  sender: Browser.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean {
  return (msg, sender, sendResponse) => {
    const answer = router(msg, sender);
    if (answer === undefined) return false;
    // sendResponse throws when the sender (a popup) closed before the answer was ready.
    const reply = (res: unknown): void => {
      try {
        sendResponse(res);
      } catch {
        // Nobody is listening any more; nothing to do.
      }
    };
    answer.then(reply, () => reply(INTERNAL));
    return true;
  };
}
