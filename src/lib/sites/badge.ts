// The per-tab toolbar badge for the return visit (spec §6.5, ADR 0037): the count of fields Refill
// filled, `🔒` on a tab of a site with a saved form while the vault is locked. The recording badge
// `●` is the recorder's alone: nothing here sets or clears it, and every write skips a tab with an
// unfinished recording session. The badge carries no value and no name. Failures are logged by error
// name only and never reach a caller.
import { browser } from "wxt/browser";
import { nudge, peekMeta } from "../recorder/session";
import { onLockChange, status } from "../vault/vault";
import { readSites } from "./index";
import { normalizeOrigin } from "./origin";

export const BADGE_LOCKED = "🔒";
const MAX_COUNT = 200;

const errName = (err: unknown): string =>
  err instanceof Error ? err.name : "error";

function logFailure(what: string, err: unknown): void {
  console.error(`[refill] ${what} failed:`, errName(err));
}

/** The badge text for a fill count: `""` unless 1 <= n <= 200. */
export function badgeCount(n: number): string {
  return Number.isInteger(n) && n >= 1 && n <= MAX_COUNT ? String(n) : "";
}

async function records(tabId: number): Promise<boolean> {
  const meta = await peekMeta({ tab: tabId }, Date.now());
  return meta !== null && !meta.finished;
}

/** Sets `text` unless the tab records. Never rejects. */
async function put(tabId: number, text: string): Promise<void> {
  try {
    if (await records(tabId)) return;
    await browser.action.setBadgeText({ tabId, text });
  } catch (err) {
    logFailure("badge", err);
  }
}

/**
 * Shows the document's running fill count on the tab. Skips a tab with an unfinished recording
 * session (its badge is `●`) and a locked vault. A count of 0 (after Undo) clears the badge.
 */
export async function showFillCount(
  tabId: number,
  filled: number,
): Promise<void> {
  try {
    if ((await status()).state !== "unlocked") return;
  } catch (err) {
    logFailure("badge", err);
    return;
  }
  await put(tabId, badgeCount(filled));
}

/** Shows `🔒` on the tab. Skips a tab with an unfinished recording session. */
export function showLocked(tabId: number): Promise<void> {
  return put(tabId, BADGE_LOCKED);
}

/**
 * Tab ids whose URL origin is an enabled, not revoked site with a saved form. Without the `tabs`
 * permission `url` is readable only on granted origins, so a tab without one is skipped. Rejects
 * if the tab query or the site index cannot be read.
 */
export async function profileTabs(): Promise<number[]> {
  const [sites, tabs] = await Promise.all([
    readSites(),
    browser.tabs.query({}),
  ]);
  const ids: number[] = [];
  for (const tab of tabs) {
    if (tab.id === undefined || tab.url === undefined) continue;
    const origin = normalizeOrigin(tab.url);
    if (origin === null || !Object.hasOwn(sites, origin)) continue;
    const site = sites[origin]!;
    if (site.accessRevoked || site.profileId === null) continue;
    ids.push(tab.id);
  }
  return ids;
}

async function eachProfileTab(fn: (tabId: number) => Promise<void>) {
  let ids: number[];
  try {
    ids = await profileTabs();
  } catch (err) {
    logFailure("badge pass", err);
    return;
  }
  await Promise.all(ids.map(fn));
}

let stopLockListener: (() => void) | null = null;

/**
 * Idempotent in its lock subscription (a second call replaces the first's).
 * tabs.onUpdated with status "loading": the count belongs to the document being left, so clear it
 * (unless the tab records). A lock puts `🔒` on each tab of a site with a saved form. An unlock
 * clears those tabs and nudges them, so each page reports again and a fill shows its count.
 * Registers listeners only: call it in the worker's first turn.
 */
export function installBadgeListeners(): void {
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "loading") void put(tabId, "");
  });
  stopLockListener?.();
  stopLockListener = onLockChange((unlocked) => {
    const pass = unlocked
      ? eachProfileTab(async (tabId) => {
          await put(tabId, "");
          await nudge(tabId);
        })
      : eachProfileTab(showLocked);
    pass.catch((err: unknown) => logFailure("badge pass", err));
  });
}
