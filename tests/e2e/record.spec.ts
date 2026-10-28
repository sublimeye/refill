import type { BrowserContext } from "@playwright/test";
import {
  lockVault,
  profileFrom,
  recordScan,
  saveProfile,
  sendFromPage,
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

    // The other site has a saved form: starting here still reads "Record this site", since it
    // stops the recording in the other tab (plan Task 9 copy), not "Record again".
    const other = await context.newPage();
    const otherTwins = `${FIXTURE_B}/billpay/twins`;
    const scan = await recordScan(context, other, otherTwins);
    await saveProfile(
      context,
      profileFrom(FIXTURE_B, [{ scan, values: { city: "Springfield" } }]),
    );
    const elsewhere = await openPopup(
      context,
      extensionId,
      await tabIdOf(context, other),
      otherTwins,
    );
    await expect(
      elsewhere.getByText(
        "Refill is recording in another tab. Starting here stops it.",
      ),
    ).toBeVisible();
    await expect(
      elsewhere.getByRole("button", { name: "Record this site" }),
    ).toBeVisible();
    await expect(
      elsewhere.getByRole("button", { name: "Record again" }),
    ).toHaveCount(0);
    await expect(
      elsewhere.getByText(
        "Your saved form fills in as you go; change what's different.",
      ),
    ).toHaveCount(0);
    await expect(elsewhere.getByText(/^Recording ·/)).toHaveCount(0);
    await expect(
      elsewhere.getByRole("button", { name: "Cancel recording" }),
    ).toHaveCount(0);
  });

  test("Finish opens the review page; Save keeps the form and the popup offers Record again", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const { page } = await setUp(context, extensionId, [FIXTURE_A]);
    await page.goto(TWINS);
    const tabId = await tabIdOf(context, page);
    const popup = await openPopup(context, extensionId, tabId, TWINS);
    await popup.getByRole("button", { name: "Record this site" }).click();
    await expect(
      popup.getByText("Recording · 0 fields", { exact: true }),
    ).toBeVisible();

    await page.bringToFront();
    await page.getByLabel("Address 1").pressSequentially("12 Main St");
    await page.getByLabel("City").pressSequentially("Springfield");
    await expect(async () => {
      await popup.reload();
      await expect(
        popup.getByText("Recording · 2 fields", { exact: true }),
      ).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });

    // Finish opens the review page in a new tab.
    const opened = context.waitForEvent("page");
    await popup.getByRole("button", { name: "Finish" }).click();
    const review = await opened;
    await review.waitForLoadState();
    expect(review.url()).toMatch(
      new RegExp(`^chrome-extension://${extensionId}/review\\.html\\?session=`),
    );
    await expect(
      review.getByRole("heading", {
        name: "Review what Refill recorded on localhost:4510",
      }),
    ).toBeVisible();
    for (const name of ["Step", "Field", "Value", "When I return"]) {
      await expect(
        review.getByRole("columnheader", { name, exact: true }),
      ).toBeVisible();
    }

    // The typed fields are listed, their values masked.
    const city = review.getByRole("row").filter({
      has: review.getByRole("rowheader", { name: "city", exact: true }),
    });
    await expect(review.getByRole("rowheader")).toHaveCount(2);
    await expect(city).toContainText("••••••");
    await expect(review.getByText("Springfield")).toHaveCount(0);
    await expect(review.getByText("12 Main St")).toHaveCount(0);
    await expect(city.getByRole("combobox")).toHaveValue("save");
    await expect(review.getByLabel("Name")).toHaveValue("localhost:4510");
    await expect(review.getByLabel("Applies to pages under")).toHaveValue(
      "/billpay/twins",
    );
    await expect(
      review.getByLabel("Fill automatically when I open the page"),
    ).toBeChecked();

    // Show reveals that value only; Hide masks it again.
    // A visible Show/Hide label and no aria-pressed (ruling P16); the name says which field.
    const show = city.getByRole("button", { name: "Show city", exact: true });
    await expect(show).toHaveText("Show");
    await expect(show).not.toHaveAttribute("aria-pressed");
    await show.click();
    await expect(city.getByText("Springfield")).toBeVisible();
    await expect(review.getByText("12 Main St")).toHaveCount(0);
    const hide = city.getByRole("button", { name: "Hide city", exact: true });
    await expect(hide).toHaveText("Hide");
    await expect(hide).not.toHaveAttribute("aria-pressed");
    await hide.click();
    await expect(review.getByText("Springfield")).toHaveCount(0);

    // A blank name is refused on the page, then Save keeps the form.
    await review.getByLabel("Name").fill(" ");
    await review.getByRole("button", { name: "Save" }).click();
    await expect(review.getByText("Enter a name")).toBeVisible();
    await expect(review.getByLabel("Name")).toBeFocused();
    await review.getByLabel("Name").fill("Twins");
    await review.getByRole("button", { name: "Save" }).click();
    const saved = review.getByText(
      "Saved. Refill will fill this form the next time you open it.",
    );
    await expect(saved).toBeVisible();
    await expect(saved).toBeFocused();
    await expect(review.getByRole("rowheader")).toHaveCount(0);

    // The popup now offers Record again for the saved form.
    const after = await openPopup(context, extensionId, tabId, TWINS);
    await expect(
      after.getByRole("button", { name: "Record again" }),
    ).toBeVisible();
    await expect(after.getByText(/^Recording/)).toHaveCount(0);
  });

  const GONE =
    "This recording is no longer available. Recordings end when Refill locks, after 30 minutes, or when you cancel them.";

  /** Records "Springfield" into City on the twins page, then Finish: the open review tab. */
  async function finishedReview(context: BrowserContext, extensionId: string) {
    const { page, ext } = await setUp(context, extensionId, [FIXTURE_A]);
    await page.goto(TWINS);
    const tabId = await tabIdOf(context, page);
    const popup = await openPopup(context, extensionId, tabId, TWINS);
    await popup.getByRole("button", { name: "Record this site" }).click();
    await expect(
      popup.getByText("Recording · 0 fields", { exact: true }),
    ).toBeVisible();
    await page.bringToFront();
    await page.getByLabel("City").pressSequentially("Springfield");
    await expect(async () => {
      await popup.reload();
      await expect(
        popup.getByText("Recording · 1 field", { exact: true }),
      ).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    const opened = context.waitForEvent("page");
    await popup.getByRole("button", { name: "Finish" }).click();
    const review = await opened;
    await expect(review.getByRole("rowheader")).toHaveCount(1);
    return { review, ext, tabId };
  }

  test("a lock while the review page is open: Save says the recording is gone", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const { review, ext } = await finishedReview(context, extensionId);
    await lockVault(ext);
    await review.getByRole("button", { name: "Save" }).click();
    await expect(review.getByText(GONE)).toBeFocused();
    await expect(review.getByRole("rowheader")).toHaveCount(0);
    expect(
      await sendFromPage(ext, { type: "site-status", origin: FIXTURE_A }),
    ).toMatchObject({ hasProfile: false });
  });

  test("Lock now in the popup, then Show on the review page: gone, and no value appears (ruling P15)", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const { review, tabId } = await finishedReview(context, extensionId);
    const popup = await openPopup(context, extensionId, tabId, TWINS);
    await popup.getByRole("button", { name: "Lock now" }).click();
    await expect(popup.getByLabel("Passphrase")).toBeVisible();

    await review.bringToFront();
    await review.getByRole("button", { name: "Show city" }).click();
    await expect(review.getByText(GONE)).toBeFocused();
    await expect(review.getByRole("rowheader")).toHaveCount(0);
    expect(await review.locator("body").innerText()).not.toContain(
      "Springfield",
    );
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
