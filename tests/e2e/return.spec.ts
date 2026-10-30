// Plan 4 Task 6: the return visit end to end. The page notice (mirrored into
// `data-refill-notice` in the e2e build), the toolbar badge and Fill now, on the real extension.
// The notice's own buttons (Unlock, Undo) sit in a closed shadow root: Tasks 1 to 3 cover them
// with trusted clicks in browser mode, and the real `openPopup` is in the manual Brave check.
import type { BrowserContext, Page } from "@playwright/test";
import {
  badgeText,
  lockVault,
  logMark,
  noticeOf,
  profileFrom,
  recordScan,
  saveProfile,
  serviceWorker,
  setUp,
  tabIdOf,
  unlockInPopup,
  waitForEntry,
} from "./content-helpers";
import { expect, test } from "./fixtures";
import { FIXTURE_A, FIXTURE_B } from "./fixtures-server";

test.setTimeout(90_000); // vault creation runs real Argon2id calibration

const TWINS = `${FIXTURE_A}/billpay/twins`;
const WIZARD = `${FIXTURE_A}/billpay/spa-wizard`;
const ACCOUNT = `${FIXTURE_A}/account`; // same origin, outside the saved form's path prefix

const TWIN_VALUES = { "address 1": "1 Analytical Way", city: "London" };

/** Records the twins page, saves a profile for two of its fields and returns it. */
async function seedTwins(
  context: BrowserContext,
  page: Page,
  fillMode: "auto" | "gesture" = "auto",
) {
  const scan = await recordScan(context, page, TWINS);
  const profile = {
    ...profileFrom(FIXTURE_A, [{ scan, values: TWIN_VALUES }]),
    fillMode,
  };
  await saveProfile(context, profile);
  return profile;
}

const pillOpen = (page: Page) =>
  page.evaluate(() => document.querySelector(":popover-open") !== null);

// The popup is opened as a tab, so the e2e build reads the target tab from seam query params.
async function openPopup(
  context: BrowserContext,
  extensionId: string,
  tabId: number,
  url: string,
) {
  const popup = await context.newPage();
  const q = new URLSearchParams({
    __refillE2E_tabId: String(tabId),
    __refillE2E_url: url,
  });
  await popup.goto(`chrome-extension://${extensionId}/popup.html?${q}`);
  return popup;
}

async function expectTwinsFilled(page: Page) {
  await expect(page.getByLabel("Address 1")).toHaveValue("1 Analytical Way");
  await expect(page.getByLabel("City")).toHaveValue("London");
}

async function expectTwinsEmpty(page: Page) {
  for (const label of ["Address 1", "Address 2", "City"]) {
    await expect(page.getByLabel(label)).toHaveValue("");
  }
}

test.describe("return visit", () => {
  test("auto mode: filled notice, count badge, reload, and a page with no saved form", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const { page } = await setUp(context, extensionId, [FIXTURE_A]);
    await seedTwins(context, page);
    const tabId = await tabIdOf(context, page);

    await page.reload();
    await expectTwinsFilled(page);
    await expect.poll(() => noticeOf(page)).toBe("filled");
    await expect.poll(() => pillOpen(page)).toBe(true);
    await expect.poll(() => badgeText(context, tabId)).toBe("2");

    // A reload is a new document: it fills its own two fields and the badge reads 2 again.
    await page.reload();
    await expectTwinsFilled(page);
    await expect.poll(() => noticeOf(page)).toBe("filled");
    await expect.poll(() => badgeText(context, tabId)).toBe("2");

    // An enabled page with no saved form: no notice, no badge. Wait for its scan first, so the
    // empty answer is the page's and not the moment before it loaded.
    const since = await logMark(context);
    await page.goto(ACCOUNT);
    const scan = await waitForEntry(
      context,
      since,
      "scan-report",
      (e) => e.tabId === tabId && e.pathname === "/account",
    );
    expect(scan.plan).toBe("none");
    expect(await noticeOf(page)).toBe("");
    expect(await pillOpen(page)).toBe(false);
    expect(await badgeText(context, tabId)).toBe("");
  });

  test("a same-origin iframe loading after a fill does not clear the count", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const { page } = await setUp(context, extensionId, [FIXTURE_A]);
    await seedTwins(context, page);
    const tabId = await tabIdOf(context, page);
    await page.reload();
    await expectTwinsFilled(page);
    await expect.poll(() => badgeText(context, tabId)).toBe("2");

    // A behavioural guard, not a test of the "loading" clear branch: the count must survive a
    // sub-frame load whatever Chrome reports for it. Observation (not asserted, it is Chrome's):
    // tabs.onUpdated reports no status at all for a same-origin iframe load (statuses seen: []).
    // The worker records what it sees for this tab and attaches it to the test report.
    const worker = await serviceWorker(context);
    await worker.evaluate((id) => {
      type G = {
        __seen?: (string | undefined)[];
        chrome: {
          tabs: {
            onUpdated: {
              addListener(
                cb: (t: number, c: { status?: string }) => void,
              ): void;
            };
          };
        };
      };
      const g = globalThis as unknown as G;
      g.__seen = [];
      g.chrome.tabs.onUpdated.addListener((t, c) => {
        if (t === id && c.status !== undefined) g.__seen!.push(c.status);
      });
    }, tabId);

    await page.evaluate(
      (src) =>
        new Promise<void>((resolve, reject) => {
          const f = document.createElement("iframe");
          f.src = src;
          f.addEventListener("load", () => resolve());
          f.addEventListener("error", () => reject(new Error("iframe")));
          document.body.append(f);
        }),
      "/account",
    );
    // The iframe's load is in. A late async clear would land after it, so go through the worker
    // a few times (each read is a round trip behind any event the load caused) and require the
    // count every time, not just on the first success.
    for (let i = 0; i < 5; i += 1) {
      expect(await badgeText(context, tabId), `badge read ${i}`).toBe("2");
    }
    const seen = await worker.evaluate(
      () => (globalThis as unknown as { __seen: string[] }).__seen,
    );
    test.info().annotations.push({
      type: "tabs.onUpdated statuses during the iframe load",
      description: JSON.stringify(seen),
    });
    await expectTwinsFilled(page);
  });

  test("SPA wizard: the count follows the document's running total", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const { page } = await setUp(context, extensionId, [FIXTURE_A]);
    const step1 = await recordScan(context, page, WIZARD);
    const since = await logMark(context);
    await page.getByRole("button", { name: "Next" }).click();
    const step2 = await waitForEntry(
      context,
      since,
      "scan-report",
      (e) => e.pathname === "/billpay/spa-wizard",
    );
    await saveProfile(
      context,
      profileFrom(FIXTURE_A, [
        {
          scan: step1,
          values: { "full name": "Ada Lovelace", email: "ada@example.test" },
        },
        {
          scan: { pathname: step2.pathname, controls: step2.controls },
          values: { "street address": "1 Analytical Way", city: "London" },
        },
      ]),
    );
    const tabId = await tabIdOf(context, page);

    await page.reload();
    await expect(page.getByLabel("Full name")).toHaveValue("Ada Lovelace");
    await expect.poll(() => badgeText(context, tabId)).toBe("2");
    await expect.poll(() => noticeOf(page)).toBe("filled");

    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByLabel("Street address")).toHaveValue(
      "1 Analytical Way",
    );
    await expect(page.getByLabel("City")).toHaveValue("London");
    await expect.poll(() => badgeText(context, tabId)).toBe("4");
  });

  test("gesture mode: ready notice and no badge until Fill now", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const { page } = await setUp(context, extensionId, [FIXTURE_A]);
    await seedTwins(context, page, "gesture");
    const tabId = await tabIdOf(context, page);

    await page.reload();
    await expect.poll(() => noticeOf(page)).toBe("ready");
    await expectTwinsEmpty(page);
    expect(await badgeText(context, tabId)).toBe("");

    const popup = await openPopup(context, extensionId, tabId, TWINS);
    const fillNow = popup.getByRole("button", { name: "Fill now" });
    await expect(fillNow).toBeVisible();
    // The popup closes itself on success.
    const closed = popup.waitForEvent("close");
    await fillNow.click();
    await closed;

    await page.bringToFront();
    await expectTwinsFilled(page);
    await expect.poll(() => noticeOf(page)).toBe("filled");
    await expect.poll(() => badgeText(context, tabId)).toBe("2");

    // The grant was one-time: the next visit waits for Fill now again.
    await page.reload();
    await expect.poll(() => noticeOf(page)).toBe("ready");
    await expectTwinsEmpty(page);
    await expect.poll(() => badgeText(context, tabId)).toBe("");
  });

  test("locked: lock notice and badge, and unlocking fills without a reload", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const { page, ext } = await setUp(context, extensionId, [
      FIXTURE_A,
      FIXTURE_B,
    ]);
    await seedTwins(context, page);
    const tabId = await tabIdOf(context, page);
    await lockVault(ext);

    await page.reload();
    await expect.poll(() => noticeOf(page)).toBe("locked");
    await expect.poll(() => badgeText(context, tabId)).toBe("🔒");
    await expectTwinsEmpty(page);

    // Another enabled site, with no saved form: locked says nothing there.
    const other = await context.newPage();
    const since = await logMark(context);
    await other.goto(`${FIXTURE_B}/billpay/twins`);
    const otherId = await tabIdOf(context, other);
    const scan = await waitForEntry(
      context,
      since,
      "scan-report",
      (e) => e.tabId === otherId,
    );
    expect(scan.plan).toBe("none"); // the worker knows this site has no saved form
    expect(await noticeOf(other)).toBe("");
    expect(await badgeText(context, otherId)).toBe("");

    // Marker and navigation count on the locked tab: an unlock fill must not need a reload.
    await page.evaluate(() => {
      (window as unknown as { __refillNoReload: number }).__refillNoReload = 1;
    });
    let navigations = 0;
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) navigations += 1;
    });

    const beforeUnlock = await logMark(context);
    await unlockInPopup(context, extensionId);

    await page.bringToFront();
    await expectTwinsFilled(page);
    await expect.poll(() => noticeOf(page)).toBe("filled");
    await expect.poll(() => badgeText(context, tabId)).toBe("2");
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __refillNoReload?: number }).__refillNoReload,
      ),
      "same document: the page was not reloaded",
    ).toBe(1);
    expect(navigations).toBe(0);
    // The fill came from the unlock nudge, not from a fresh load of the document.
    await waitForEntry(
      context,
      beforeUnlock,
      "fill-result",
      (e) => e.tabId === tabId && e.filled === 2,
    );

    // The second tab has no saved form, so the unlock pass does not nudge it and no worker event
    // marks "done" for it. The strongest anchor: the first tab's fill (the same unlock pass, which
    // clears and nudges every saved-form tab) is complete above; now read the second tab's badge
    // and notice over several consecutive worker round trips, each of which must still be empty,
    // so a late clear, nudge or fill would show.
    for (let i = 0; i < 5; i += 1) {
      expect(await badgeText(context, otherId), `badge read ${i}`).toBe("");
      expect(await noticeOf(other), `notice read ${i}`).toBe("");
    }
    await expectTwinsEmpty(other);
  });

  test("recording: Record again shows the pill and the recording badge, never a filled notice", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const { page } = await setUp(context, extensionId, [FIXTURE_A]);
    await seedTwins(context, page);
    const tabId = await tabIdOf(context, page);
    await page.reload();
    await expectTwinsFilled(page);
    await expect.poll(() => noticeOf(page)).toBe("filled");
    await expect.poll(() => badgeText(context, tabId)).toBe("2");

    // Every notice kind the page shows from here on.
    await page.evaluate(() => {
      const root = document.documentElement;
      const w = window as unknown as { __kinds: string[] };
      w.__kinds = [];
      new MutationObserver(() =>
        w.__kinds.push(root.dataset.refillNotice ?? ""),
      ).observe(root, {
        attributes: true,
        attributeFilter: ["data-refill-notice"],
      });
    });

    const popup = await openPopup(context, extensionId, tabId, TWINS);
    await popup.getByRole("button", { name: "Record again" }).click();
    await expect(popup.getByText(/^Recording · \d+ fields?$/)).toBeVisible();

    await page.bringToFront();
    await expect.poll(() => noticeOf(page)).toBe("on");
    await expect.poll(() => pillOpen(page)).toBe(true);
    await expect.poll(() => badgeText(context, tabId)).toBe("●");
    const kinds = await page.evaluate(
      () => (window as unknown as { __kinds: string[] }).__kinds,
    );
    // The observer was alive (it saw the pill), so "never filled" is a real observation.
    expect(kinds).toContain("on");
    expect(kinds).not.toContain("filled");

    // A reload while recording shows the pill again, never the return-visit notice. Chrome resets a
    // tab's badge text on navigation; the new document's record-status puts "●" back.
    // Refilling after the reload is intended: recorded values fill again on every visit to a step
    // while recording (Plan 3 ruling P20).
    await page.reload();
    await expect.poll(() => noticeOf(page)).toBe("on");
    await expectTwinsFilled(page);
    expect(await pillOpen(page)).toBe(true);
    await expect.poll(() => badgeText(context, tabId)).toBe("●");
  });
});
