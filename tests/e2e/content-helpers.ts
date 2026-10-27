import type { BrowserContext, Page, Worker } from "@playwright/test";
import type { ScanControl } from "../../src/lib/messaging/content-protocol";
import { sigKey } from "../../src/lib/match/match";
import type { Profile, ProfileField } from "../../src/lib/profiles/types";
import { expect } from "./fixtures";
import { createVault, openOnboarding, PASSPHRASE } from "./vault-helpers";

/** What the e2e service worker logs per content message (background.ts seam; never values). */
export type LogEntry =
  | {
      type: "scan-report";
      origin: string;
      pathname: string;
      tabId: number;
      documentId: string | undefined;
      controls: ScanControl[];
      truncated: boolean;
      plan: "locked" | "none" | "gesture" | "fill";
      items: number;
    }
  | {
      type: "fill-result";
      origin: string;
      pathname: string;
      tabId: number;
      documentId: string | undefined;
      filled: number;
      skipped: number;
      unsupported: number;
    };

type Seam = {
  __refillE2E: {
    saveProfile(p: unknown): Promise<void>;
    contentLog: LogEntry[];
  };
  chrome: {
    tabs: { query(q: unknown): Promise<{ id: number; url?: string }[]> };
    scripting: {
      executeScript(o: unknown): Promise<unknown>;
    };
    runtime: { sendMessage(m: unknown): Promise<unknown> };
  };
};

export async function serviceWorker(context: BrowserContext): Promise<Worker> {
  return (
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
  );
}

export async function contentLog(context: BrowserContext): Promise<LogEntry[]> {
  return (await serviceWorker(context)).evaluate(
    () => (globalThis as unknown as Seam).__refillE2E.contentLog,
  );
}

/** Waits for a log entry after index `since` that `pick` accepts, and returns it. */
export async function waitForEntry<T extends LogEntry["type"]>(
  context: BrowserContext,
  since: number,
  type: T,
  pick: (e: Extract<LogEntry, { type: T }>) => boolean = () => true,
): Promise<Extract<LogEntry, { type: T }>> {
  let found: Extract<LogEntry, { type: T }> | undefined;
  await expect
    .poll(
      async () => {
        const log = (await contentLog(context)).slice(since);
        found = log.find(
          (e): e is Extract<LogEntry, { type: T }> =>
            e.type === type && pick(e as Extract<LogEntry, { type: T }>),
        );
        return found !== undefined;
      },
      { message: `waiting for a ${type} entry`, timeout: 10_000 },
    )
    .toBe(true);
  return found!;
}

export async function tabIdOf(context: BrowserContext, page: Page) {
  const url = page.url();
  const id = await (
    await serviceWorker(context)
  ).evaluate(async (u) => {
    const tabs = await (globalThis as unknown as Seam).chrome.tabs.query({});
    return tabs.find((t) => t.url === u)?.id;
  }, url);
  expect(typeof id).toBe("number");
  return id!;
}

/** Sends a page request from an extension page (the router only takes these from our pages). */
export async function sendFromPage(ext: Page, msg: unknown): Promise<unknown> {
  return ext.evaluate(
    (m) => (globalThis as unknown as Seam).chrome.runtime.sendMessage(m),
    msg,
  );
}

/**
 * A fresh vault (left unlocked) and Refill enabled on `origins`, through the same `site-enable`
 * request the popup sends. Returns the fixture tab and an extension page for further requests.
 */
export async function setUp(
  context: BrowserContext,
  extensionId: string,
  origins: string[],
): Promise<{ page: Page; ext: Page }> {
  const onboarding = await openOnboarding(context, extensionId);
  await createVault(onboarding);
  const page = await context.newPage();
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);
  for (const origin of origins) {
    await page.goto(`${origin}/`);
    const tabId = await tabIdOf(context, page);
    expect(
      await sendFromPage(ext, { type: "site-enable", tabId, origin }),
    ).toEqual({ ok: true });
  }
  await page.bringToFront();
  return { page, ext };
}

/**
 * "Records" a page the way Plan 3's recorder will see it: loads `url` with no profile yet and
 * returns the signatures from the content script's real scan-report. Sigs in the profiles below
 * therefore come from the shipped scanner on the shipped fixture markup, not from hand-written
 * copies that could drift from it (ADR 0026).
 */
export async function recordScan(
  context: BrowserContext,
  page: Page,
  url: string,
): Promise<{ pathname: string; controls: ScanControl[] }> {
  const since = (await contentLog(context)).length;
  await page.goto(url);
  const { origin, pathname } = new URL(url);
  const entry = await waitForEntry(
    context,
    since,
    "scan-report",
    (e) => e.origin === origin && e.pathname === pathname,
  );
  expect(entry.plan).toBe("none");
  return { pathname, controls: entry.controls };
}

export interface StepValues {
  scan: { pathname: string; controls: ScanControl[] };
  /** Value per control, keyed by the control's `labelText` (lowercase, as the scanner gives it). */
  values: Record<string, string>;
}

/**
 * A profile whose step `n` holds a field for every control of `steps[n].scan` named in `values`
 * (policy `save`, page default empty). Every label in `values` must be present in the scan.
 */
export function profileFrom(
  origin: string,
  steps: StepValues[],
  pathPrefix = "/billpay/",
): Profile {
  const fields: ProfileField[] = [];
  steps.forEach(({ scan, values }, step) => {
    const used = new Set<string>();
    for (const c of scan.controls) {
      const label = c.sig.labelText;
      if (label === null || !Object.hasOwn(values, label)) continue;
      used.add(label);
      fields.push({
        id: `s${step}c${c.i}`,
        sig: c.sig,
        step,
        kind: c.kind,
        value: values[label]!,
        pageDefault: "",
        policy: "save",
      });
    }
    expect(
      [...used].sort(),
      `labels recorded on ${scan.pathname} (step ${step})`,
    ).toEqual(Object.keys(values).sort());
  });
  return {
    v: 1,
    id: "e2e-profile",
    name: "Water bill",
    origin,
    pathPrefix,
    fillMode: "auto",
    createdAt: 1,
    lastUsedAt: null,
    steps: steps.map(({ scan }, index) => ({
      index,
      pathHint: scan.pathname,
      fingerprint: scan.controls.map((c) => sigKey(c.sig, c.kind)),
    })),
    fields,
  };
}

export async function saveProfile(context: BrowserContext, profile: Profile) {
  await (
    await serviceWorker(context)
  ).evaluate(
    (p) => (globalThis as unknown as Seam).__refillE2E.saveProfile(p),
    profile,
  );
}

/** Runs the content script file in `tabId` again (`allFrames` also reaches sub-frames). */
export async function injectAgain(
  context: BrowserContext,
  tabId: number,
  allFrames = false,
) {
  await (
    await serviceWorker(context)
  ).evaluate(
    ([id, all]) =>
      (globalThis as unknown as Seam).chrome.scripting.executeScript({
        target: { tabId: id, allFrames: all },
        files: ["/refill-content.js"],
      }),
    [tabId, allFrames] as const,
  );
}

export async function lockVault(ext: Page) {
  expect(await sendFromPage(ext, { type: "vault-lock" })).toEqual({ ok: true });
}

/** Unlocks through the popup UI, as a user would. */
export async function unlockInPopup(
  context: BrowserContext,
  extensionId: string,
) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const field = popup.getByLabel("Passphrase");
  await field.fill(PASSPHRASE);
  await field.press("Enter");
  await expect(popup.getByText("Unlocked", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await popup.close();
}
