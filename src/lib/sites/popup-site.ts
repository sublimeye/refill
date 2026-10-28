// Popup-side logic for the "This site" section (spec §3.1). Kept out of the Svelte component so
// the parts that matter (the synchronous call order, the status mapping) are unit-testable.
import { browser } from "wxt/browser";
import { sendToSw, type SiteStatus } from "../messaging/protocol";
import { normalizeOrigin } from "./origin";
import { requestSiteEnable, type EnableOutcome } from "./popup-flow";

/** The tab the popup acts on. `origin` is null when it is not a plain https page. */
export interface Target {
  tabId: number;
  origin: string | null;
}

export type SiteState = "off" | "on" | "revoked";

export type SiteView =
  | { kind: "unsupported" }
  | { kind: "error" }
  | {
      kind: SiteState;
      tabId: number;
      origin: string;
      /** `host[:port]`, for display. */
      host: string;
    };

function targetOf(tabId: number, url: string | undefined): Target {
  return { tabId, origin: url ? normalizeOrigin(url) : null };
}

/**
 * The active tab of the current window; its URL is readable through `activeTab` once the toolbar
 * action was clicked. Resolves to null when there is no usable tab. Never throws.
 */
export async function resolveTarget(
  search: string = globalThis.location?.search ?? "",
): Promise<Target | null> {
  // e2e only: the popup is opened as a tab, so the spec names the tab it stands in for.
  if (import.meta.env.MODE === "e2e") {
    const q = new URLSearchParams(search);
    const id = q.get("__refillE2E_tabId");
    if (id !== null && /^\d+$/.test(id)) {
      return targetOf(Number(id), q.get("__refillE2E_url") ?? undefined);
    }
  }
  try {
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tab?.id === undefined ? null : targetOf(tab.id, tab.url);
  } catch {
    return null;
  }
}

/** Maps the service worker's answer to what the popup shows. */
export function viewOf(target: Target, status: SiteStatus): SiteView {
  if (target.origin === null || status.origin === null) {
    return { kind: "unsupported" };
  }
  const kind: SiteState = !status.enabled
    ? "off"
    : status.granted
      ? "on"
      : "revoked";
  return {
    kind,
    tabId: target.tabId,
    origin: status.origin,
    host: new URL(status.origin).host,
  };
}

/** Never throws: a failed query is the `error` view. */
export async function loadSiteView(target: Target): Promise<SiteView> {
  if (target.origin === null) return { kind: "unsupported" };
  try {
    return viewOf(
      target,
      await sendToSw({ type: "site-status", origin: target.origin }),
    );
  } catch {
    return { kind: "error" };
  }
}

export interface EnableResult {
  outcome: EnableOutcome;
  view: SiteView;
}

/**
 * Click handler body for "Enable Refill on this site" / "Enable again".
 *
 * `permissions.request` is honored only during the click's user activation (ADR 0007, ADR 0018),
 * so `requestSiteEnable` MUST be the first thing this does, in the caller's synchronous turn: no
 * `await` and no other call before it. Everything after it (the status re-query) runs later.
 */
export function enableSite(target: Target & { origin: string }) {
  const outcome = requestSiteEnable(target.tabId, target.origin);
  return outcome.then(async (o): Promise<EnableResult> => ({
    outcome: o,
    view: await loadSiteView(target),
  }));
}

/** Removes the site (record, saved form, access) and returns the fresh view. Never throws. */
export async function removeSiteFor(
  target: Target & { origin: string },
): Promise<{ ok: boolean; view: SiteView }> {
  let ok = true;
  try {
    await sendToSw({ type: "site-remove", origin: target.origin });
  } catch {
    ok = false;
  }
  return { ok, view: await loadSiteView(target) };
}
