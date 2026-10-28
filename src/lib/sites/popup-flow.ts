// Popup side of site enablement (spec §3.1, ADR 0007, ADR 0018). Called from a click handler:
// Chrome honors `permissions.request` only during user activation, so nothing may be awaited
// before it. The permission dialog can also close the popup, so correctness never depends on
// what happens after the request resolves.
import { browser } from "wxt/browser";
import { sendToSw } from "../messaging/protocol";
import type { IntentKind } from "./intent";
import { normalizeOrigin, originPattern } from "./origin";

export type EnableOutcome =
  | "granted-pending"
  | "enabled"
  | "recording"
  | "tab-moved"
  | "denied"
  | "locked";

/**
 * - `enabled`: the origin is granted and the service worker enabled it and injected the script.
 * - `recording` (kind `record`): the above, and a recording session started on the tab.
 * - `locked` (kind `record`): granted and the site is enabled (script injected), but the vault is
 *   locked, so no session started.
 * - `tab-moved` (kind `record`): the tab no longer shows the origin, so no session started and
 *   none will start later; the user has to start again on the page.
 * - `granted-pending`: granted, but the service worker did not confirm (not granted yet); its
 *   `permissions.onAdded` handler (with the pending intent) completes the work.
 * - `denied`: the user declined, the origin is invalid, or something failed. Never throws.
 *
 * In the caller's synchronous turn this starts the `site-intent` write (not awaited) and calls
 * `permissions.request` at once; `request` resolves true immediately when already granted. If it
 * resolves true the popup is still alive, so it also sends `site-enable` (or `record-start` for kind
 * `record`, which does the enable work too); with the popup gone the service worker's `onAdded` +
 * intent does the same work. Both paths are idempotent.
 */
export function requestSiteEnable(
  tabId: number,
  origin: string,
  kind: IntentKind,
): Promise<EnableOutcome> {
  if (normalizeOrigin(origin) !== origin) return Promise.resolve("denied");
  // Both calls are made before this function returns, i.e. inside the user gesture.
  const intent = sendToSw({ type: "site-intent", tabId, origin, kind }).catch(
    () => undefined, // a lost intent only costs the popup-closed path; never an unhandled rejection
  );
  let request: Promise<boolean>;
  try {
    request = browser.permissions.request({ origins: [originPattern(origin)] });
  } catch {
    return intent.then(() => "denied");
  }
  return finish(request, intent, tabId, origin, kind);
}

async function finish(
  request: Promise<boolean>,
  intent: Promise<unknown>,
  tabId: number,
  origin: string,
  kind: IntentKind,
): Promise<EnableOutcome> {
  try {
    if (!(await request)) return "denied";
    await intent; // let the intent write settle so it cannot land after site-enable
    if (kind === "record") {
      const started = await sendToSw({ type: "record-start", tabId, origin });
      if (started.ok) return "recording";
      switch (started.error) {
        case "locked":
          return "locked";
        case "tab-moved":
          return "tab-moved";
        case "not-granted":
          return "granted-pending";
        default:
          return "denied"; // invalid-origin: checked above, so not expected
      }
    }
    const res = await sendToSw({ type: "site-enable", tabId, origin });
    return res.ok ? "enabled" : "granted-pending";
  } catch {
    return "denied";
  }
}
