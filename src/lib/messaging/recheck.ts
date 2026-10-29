// The worker's data-free "check again" signal to extension pages (ADR 0033 I3, ADR 0035). The
// worker sends it on every recording discard, every lock and every site removal; the review page
// answers it with its own check (`review-check` or `saved-check`), so a revealed value goes away
// with no action on the page. The message carries nothing and proves nothing: a forged one costs
// one check. Pages never watch `storage.session` instead, whose change events would hand them the
// DEK mirror on every unlock (spec §4.3). No vault or DOM import: both the worker and pages use it.
import { browser, type Browser } from "wxt/browser";

export const RECHECK = { type: "refill-recheck" } as const;

/**
 * Worker side. Not awaited; content scripts never receive runtime messages, and with no page
 * listening the send fails, which is the usual case and not logged.
 */
export function announceRecheck(): void {
  try {
    browser.runtime.sendMessage({ ...RECHECK }).catch(() => undefined);
  } catch {
    // no runtime messaging here: nothing to tell
  }
}

/** This extension's service worker URL, or null when the manifest cannot be read. */
function workerUrl(): string | null {
  try {
    const bg = browser.runtime.getManifest().background;
    const path =
      bg !== undefined && "service_worker" in bg ? bg.service_worker : null;
    if (typeof path !== "string") return null;
    // WXT types `getURL` to the extension's pages only; the worker script is not one of them. The
    // parenthesized member call keeps `runtime` as `this`. Normalized as Chrome reports a sender
    // URL ("./sw/x.js" → "/sw/x.js").
    return new URL((browser.runtime.getURL as (p: string) => string)(path))
      .href;
  } catch {
    return null;
  }
}

/**
 * Chrome gives a page the worker as a sender with this extension's id and the worker script's URL,
 * and no tab, document or origin; any extension page has a document id (and a tab, when opened as
 * one). So another page of this extension cannot pass for the worker.
 */
function fromWorker(sender: Browser.runtime.MessageSender): boolean {
  const url = workerUrl();
  return (
    url !== null &&
    typeof sender.id === "string" &&
    sender.id === browser.runtime.id &&
    sender.url === url &&
    sender.tab === undefined &&
    sender.documentId === undefined
  );
}

const isSignal = (msg: unknown): boolean =>
  typeof msg === "object" &&
  msg !== null &&
  Object.keys(msg).length === 1 &&
  (msg as Record<string, unknown>)["type"] === RECHECK.type;

/**
 * Page side: calls `onSignal` for each exact `{ type: "refill-recheck" }` from this extension's
 * service worker. Never answers (the worker does not wait for pages). Returns the unsubscribe.
 */
export function onRecheck(onSignal: () => void): () => void {
  const listener = (
    msg: unknown,
    sender: Browser.runtime.MessageSender,
  ): undefined => {
    if (isSignal(msg) && fromWorker(sender)) onSignal();
    return undefined;
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}
