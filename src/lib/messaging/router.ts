// Sender-validated router for runtime messages (spec §7). Every message is size-checked, the
// sender is classified, and the payload is parsed before any handler runs. Decisions: ADR 0014.
import { browser, type Browser } from "wxt/browser";
import {
  MAX_MESSAGE_BYTES,
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
  if (sender.id !== runtimeId) return null;
  const prefix = `chrome-extension://${runtimeId}/`;
  if (sender.url?.startsWith(prefix)) {
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

const REJECTED: RouterError = { ok: false, error: "rejected" };
const INTERNAL: RouterError = { ok: false, error: "internal" };

function tooLarge(msg: unknown): boolean {
  try {
    const json = JSON.stringify(msg);
    return json === undefined || json.length > MAX_MESSAGE_BYTES;
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

export function createRouter(handlers: {
  page: PageHandlers;
}): (
  msg: unknown,
  sender: Browser.runtime.MessageSender,
) => Promise<unknown> | undefined {
  return (msg, sender) => {
    if (tooLarge(msg)) return Promise.resolve(REJECTED);
    const kind = classifySender(sender, browser.runtime.id);
    // Content handlers do not exist yet (ContentRequest is `never`), so only pages are served.
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
    answer.then(sendResponse, () => sendResponse(INTERNAL));
    return true;
  };
}
