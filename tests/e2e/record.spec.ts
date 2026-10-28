import type { BrowserContext } from "@playwright/test";
import {
  lockVault,
  profileFrom,
  recordScan,
  saveProfile,
  setUp,
  tabIdOf,
} from "./content-helpers";
import { expect, test } from "./fixtures";
import { FIXTURE_A, FIXTURE_B } from "./fixtures-server";

// Task 9: the popup's recording controls. The popup is opened as a tab, so the e2e build reads the
// target tab from seam query params (production reads tabs.query({ active, currentWindow })). The
// e2e build pre-grants https://localhost/*, so "Record this site" takes the already-granted path.
test.describe("popup: recording", () => {
  test.setTimeout(90_000); // vault creation runs real Argon2id calibration

  const TWINS = `${FIXTURE_A}/billpay/twins`;

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

  test("record, count what is typed, then cancel", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    // setUp enables the site; this test starts from a site that is still off.
    const { page } = await setUp(context, extensionId, []);
    await page.goto(TWINS);
    const tabId = await tabIdOf(context, page);
    const popup = await openPopup(context, extensionId, tabId, TWINS);

    await expect(
      popup.getByText(
        "Refill will ask Chrome for access to this site only, then remember what you type.",
      ),
    ).toBeVisible();
    await popup.getByRole("button", { name: "Record this site" }).click();
    const status = popup.getByText("Recording · 0 fields", { exact: true });
    await expect(status).toBeVisible();
    await expect(status).toBeFocused();
    await expect(
      popup.getByRole("button", { name: "Record this site" }),
    ).toHaveCount(0);
    await expect(popup.getByRole("button", { name: "Finish" })).toBeVisible();

    // A trusted keystroke is captured (after the content script's debounce); reopen to see it.
    await page.bringToFront();
    await page.getByLabel("City").pressSequentially("Springfield");
    await expect(async () => {
      await popup.reload();
      await expect(
        popup.getByText("Recording · 1 field", { exact: true }),
      ).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });

    // Cancel goes back to the start, on a site that is now enabled.
    await popup.getByRole("button", { name: "Cancel recording" }).click();
    await expect(
      popup.getByRole("button", { name: "Record this site" }),
    ).toBeVisible();
    await expect(popup.getByText("Enabled on localhost:4510")).toBeFocused();
    await expect(popup.getByText(/Recording ·/)).toHaveCount(0);
  });

  test("Record again on a site with a saved form", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const { page } = await setUp(context, extensionId, [FIXTURE_A]);
    const scan = await recordScan(context, page, TWINS);
    await saveProfile(
      context,
      profileFrom(FIXTURE_A, [{ scan, values: { city: "Springfield" } }]),
    );
    const tabId = await tabIdOf(context, page);
    const popup = await openPopup(context, extensionId, tabId, TWINS);

    await expect(
      popup.getByText(
        "Your saved form fills in as you go; change what's different.",
      ),
    ).toBeVisible();
    await expect(
      popup.getByRole("button", { name: "Record this site" }),
    ).toHaveCount(0);
    await popup.getByRole("button", { name: "Record again" }).click();
    await expect(popup.getByText(/^Recording · \d+ fields?$/)).toBeVisible();
    // Record again starts from the saved form: the value fills in as the user walks through.
    await expect(page.getByLabel("City")).toHaveValue("Springfield");
  });

  test("a recording in another tab is named, and starting here is offered", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const { page } = await setUp(context, extensionId, [FIXTURE_A, FIXTURE_B]);
    await page.goto(TWINS);
    const here = await openPopup(
      context,
      extensionId,
      await tabIdOf(context, page),
      TWINS,
    );
    await here.getByRole("button", { name: "Record this site" }).click();
    await expect(
      here.getByText("Recording · 0 fields", { exact: true }),
    ).toBeVisible();

    const other = await context.newPage();
    await other.goto(`${FIXTURE_B}/`);
    const elsewhere = await openPopup(
      context,
      extensionId,
      await tabIdOf(context, other),
      `${FIXTURE_B}/`,
    );
    await expect(
      elsewhere.getByText(
        "Refill is recording in another tab. Starting here stops it.",
      ),
    ).toBeVisible();
    await expect(
      elsewhere.getByRole("button", { name: "Record this site" }),
    ).toBeVisible();
    await expect(elsewhere.getByText(/^Recording ·/)).toHaveCount(0);
    await expect(
      elsewhere.getByRole("button", { name: "Cancel recording" }),
    ).toHaveCount(0);
  });

  test("a locked vault offers no record button", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const { page, ext } = await setUp(context, extensionId, [FIXTURE_A]);
    await page.goto(TWINS);
    await lockVault(ext);
    const popup = await openPopup(
      context,
      extensionId,
      await tabIdOf(context, page),
      TWINS,
    );
    await expect(popup.getByLabel("Passphrase")).toBeVisible();
    await expect(popup.getByText("Unlock to record this site.")).toBeVisible();
    await expect(popup.getByRole("button", { name: /Record/ })).toHaveCount(0);
  });
});
