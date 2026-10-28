// Does a tab still show a given origin? Used before injecting into a tab named by the popup: with
// `activeTab` alone the tab may have navigated to another enabled origin since the click.
import { browser } from "wxt/browser";
import { normalizeOrigin } from "./origin";

/**
 * True only when the tab exists and its current URL normalizes to `origin`. `tab.url` is readable
 * only through a host permission or `activeTab` (there is no `tabs` permission); `undefined`
 * reads as "not this origin". Never throws: a closed tab or any failure is `false`.
 */
export async function tabShowsOrigin(
  tabId: number,
  origin: string,
): Promise<boolean> {
  try {
    const tab = await browser.tabs.get(tabId);
    return normalizeOrigin(tab.url ?? "") === origin;
  } catch {
    return false;
  }
}
