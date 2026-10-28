// Keeps the one registered content script in step with reality: it matches exactly the origins
// that have a site record AND a granted host permission. Decisions: ADR 0018.
import { browser } from "wxt/browser";
import { withStoreLock } from "../store/local";
import { normalizeOrigin, originPattern } from "./origin";
import { readSites, upsertSite } from "./index";
import { takeIntent } from "./intent";
import { tabShowsOrigin } from "./tab";

export const CONTENT_SCRIPT_ID = "refill-content";
/** Built path of the unlisted script `src/entrypoints/refill-content.ts` (verified in .output/chrome-mv3). */
export const CONTENT_SCRIPT_FILE = "/refill-content.js";

function logFailure(what: string, err: unknown): void {
  console.error(
    "[refill]",
    what,
    "failed:",
    err instanceof Error ? err.name : "error",
  );
}

async function isGranted(origin: string): Promise<boolean> {
  try {
    return await browser.permissions.contains({
      origins: [originPattern(origin)],
    });
  } catch {
    return false; // fail closed: an unanswerable question is "not granted"
  }
}

async function runReconcile(): Promise<void> {
  const sites = await readSites();
  const origins = Object.keys(sites);
  const granted = new Map<string, boolean>();
  await Promise.all(
    origins.map(async (o) => granted.set(o, await isGranted(o))),
  );

  // Flag drift. Re-read under the lock: a site may have been removed or changed since the snapshot.
  await withStoreLock(async (tx) => {
    const current = await readSites(tx);
    for (const [origin, rec] of Object.entries(current)) {
      const g = granted.get(origin);
      if (g === undefined || rec.accessRevoked === !g) continue;
      await upsertSite(origin, { accessRevoked: !g }, tx);
    }
  });

  const desired = origins.filter((o) => granted.get(o) === true);
  const registered = await browser.scripting.getRegisteredContentScripts({
    ids: [CONTENT_SCRIPT_ID],
  });
  const exists = registered.some((s) => s.id === CONTENT_SCRIPT_ID);
  if (desired.length === 0) {
    if (exists) {
      await browser.scripting.unregisterContentScripts({
        ids: [CONTENT_SCRIPT_ID],
      });
    }
    return;
  }
  const script = {
    id: CONTENT_SCRIPT_ID,
    js: [CONTENT_SCRIPT_FILE],
    matches: desired.map(originPattern),
    allFrames: false,
    runAt: "document_idle" as const,
    world: "ISOLATED" as const,
    persistAcrossSessions: true,
  };
  if (exists) await browser.scripting.updateContentScripts([script]);
  else await browser.scripting.registerContentScripts([script]);
}

let current: Promise<void> | null = null;
let queued: Promise<void> | null = null;

/**
 * Serialized and coalescing: at most one run at a time (Chrome throws "Duplicate script ID" if
 * two runs both register), and any number of calls arriving mid-run share ONE follow-up run that
 * starts after the current one, so a change made mid-run is never missed.
 */
export function reconcile(): Promise<void> {
  if (current === null) {
    const run = runReconcile().finally(() => {
      if (current === run) current = null;
    });
    current = run;
    return run;
  }
  if (queued === null) {
    queued = current
      .catch(() => undefined)
      .then(() => {
        queued = null;
        return reconcile();
      });
  }
  return queued;
}

/**
 * Injects the content script into a tab that was open before the grant, but only while the tab
 * still shows `origin` (the popup's tab id may be stale: `activeTab` alone would allow a tab that
 * has navigated away). Every failure is expected and ignored.
 */
export async function injectContentScript(
  tabId: number,
  origin: string,
): Promise<void> {
  try {
    if (!(await tabShowsOrigin(tabId, origin))) return;
    await browser.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_FILE],
    });
  } catch (err) {
    // Tab closed, not https, navigated away: nothing to do. Name only: a message may carry a URL.
    console.error(
      "[refill] executeScript skipped:",
      err instanceof Error ? err.name : "error",
    );
  }
}

function httpsOrigins(origins: string[] | undefined): string[] {
  const out: string[] = [];
  for (const pattern of origins ?? []) {
    // Match patterns look like "https://host/*"; the canonical origin is what precedes "/*".
    if (!pattern.endsWith("/*")) continue;
    const origin = pattern.slice(0, -2);
    if (normalizeOrigin(origin) === origin) out.push(origin);
  }
  return out;
}

async function onAdded(permissions: { origins?: string[] }): Promise<void> {
  try {
    for (const origin of httpsOrigins(permissions.origins)) {
      try {
        const intent = await takeIntent(origin);
        if (intent === null) continue;
        await upsertSite(origin, { accessRevoked: false });
        await reconcile();
        await injectContentScript(intent.tabId, origin);
      } catch (err) {
        logFailure("permission grant handling", err);
      }
    }
  } finally {
    // Always: a failure above must not leave other origins in this event unreconciled.
    // Concurrent runs coalesce, so the extra call is cheap.
    await reconcile();
  }
}

/** Registers every listener synchronously; call it in the first turn of the service worker. */
export function installSiteListeners(): void {
  const run = (what: string): void => {
    reconcile().catch((err: unknown) => logFailure(what, err));
  };
  browser.runtime.onInstalled.addListener(() => run("reconcile on install"));
  browser.runtime.onStartup.addListener(() => run("reconcile on startup"));
  browser.permissions.onAdded.addListener((p) => {
    onAdded(p).catch((err: unknown) => logFailure("reconcile on grant", err));
  });
  browser.permissions.onRemoved.addListener(() => run("reconcile on revoke"));
}
