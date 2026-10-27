// Popup side of site enablement (spec §3.1, ADR 0007). The permission dialog can close the popup,
// so nothing here may depend on what happens after `permissions.request` resolves.
import { browser } from "wxt/browser";
import { sendToSw } from "../messaging/protocol";
import { originPattern } from "./origin";

/**
 * - `enabled`: the origin was already granted; the service worker enabled it and injected the script.
 * - `granted-pending`: the user accepted; the service worker finishes the work in `permissions.onAdded`.
 * - `denied`: the user declined, or the request failed.
 *
 * The intent is written before the request. After the request's await this only returns.
 */
export async function requestSiteEnable(
  tabId: number,
  origin: string,
): Promise<"granted-pending" | "enabled" | "denied"> {
  const origins = [originPattern(origin)];
  if (await browser.permissions.contains({ origins })) {
    const res = await sendToSw({ type: "site-enable", tabId, origin });
    return res.ok ? "enabled" : "denied";
  }
  const intent = await sendToSw({ type: "site-intent", tabId, origin });
  if (!intent.ok) return "denied";
  try {
    const granted = await browser.permissions.request({ origins });
    return granted ? "granted-pending" : "denied";
  } catch {
    return "denied";
  }
}
