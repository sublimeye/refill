// Popup side of site enablement (spec §3.1, ADR 0007, ADR 0018). Called from a click handler:
// Chrome honors `permissions.request` only during user activation, so nothing may be awaited
// before it. The permission dialog can also close the popup, so correctness never depends on
// what happens after the request resolves.
import { browser } from "wxt/browser";
import { sendToSw } from "../messaging/protocol";
import { normalizeOrigin, originPattern } from "./origin";

/**
 * - `enabled`: the origin is granted and the service worker enabled it and injected the script.
 * - `granted-pending`: granted, but the service worker did not confirm; its `permissions.onAdded`
 *   handler (with the pending intent) completes the work.
 * - `denied`: the user declined, the origin is invalid, or something failed. Never throws.
 *
 * In the caller's synchronous turn this starts the `site-intent` write (not awaited) and calls
 * `permissions.request` at once; `request` resolves true immediately when already granted. If it
 * resolves true the popup is still alive, so it also sends `site-enable`; with the popup gone the
 * service worker's `onAdded` + intent does the same work. Both paths are idempotent.
 */
export function requestSiteEnable(
  tabId: number,
  origin: string,
): Promise<"granted-pending" | "enabled" | "denied"> {
  if (normalizeOrigin(origin) !== origin) return Promise.resolve("denied");
  // Both calls are made before this function returns, i.e. inside the user gesture.
  const intent = sendToSw({ type: "site-intent", tabId, origin }).catch(
    () => undefined, // a lost intent only costs the popup-closed path; never an unhandled rejection
  );
  let request: Promise<boolean>;
  try {
    request = browser.permissions.request({ origins: [originPattern(origin)] });
  } catch {
    return intent.then(() => "denied");
  }
  return finish(request, intent, tabId, origin);
}

async function finish(
  request: Promise<boolean>,
  intent: Promise<unknown>,
  tabId: number,
  origin: string,
): Promise<"granted-pending" | "enabled" | "denied"> {
  try {
    if (!(await request)) return "denied";
    await intent; // let the intent write settle so it cannot land after site-enable
    const res = await sendToSw({ type: "site-enable", tabId, origin });
    return res.ok ? "enabled" : "granted-pending";
  } catch {
    return "denied";
  }
}
