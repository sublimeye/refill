import type { BrowserContext, Page } from "@playwright/test";
import {
  loadSavedProfile,
  lockVault,
  logMark,
  type LogMark,
  profileFrom,
  recordScan,
  saveProfile,
  sendFromPage,
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

const GONE =
  "This recording is no longer available. Recordings end when Refill locks, after 30 minutes, or when you cancel them.";

// The popup is opened as a tab, so the e2e build reads the target tab from seam query params
// (production reads tabs.query({ active, currentWindow })). The e2e build pre-grants
// https://localhost/*, so "Record this site" takes the already-granted path.
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

// Task 9: the popup's recording controls.
test.describe("popup: recording", () => {
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

    // The page shows the recording pill (a top-layer popover; its root is closed).
    const pillOpen = () =>
      page.evaluate(() => document.querySelector(":popover-open") !== null);
    await expect.poll(pillOpen).toBe(true);

    // Finish opens the review page in a new tab.
    const opened = context.waitForEvent("page");
    await popup.getByRole("button", { name: "Finish" }).click();
    const review = await opened;
    await review.waitForLoadState();
    // A popup Finish nudges the tab: its pill goes away without any action on the page (I1).
    await expect.poll(pillOpen).toBe(false);
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

// Task 11: the whole loop in real Chromium. Each case records through the popup, types with
// Playwright (trusted input), finishes through the popup and saves on the review tab; a later
// visit then fills from the saved profile.
test.describe("record, review and fill", () => {
  const SPA = `${FIXTURE_A}/billpay/spa-wizard`;
  const POST = `${FIXTURE_A}/billpay/post-wizard`;
  const NEVER = `${FIXTURE_A}/billpay/never-capture`;
  const CSP = `${FIXTURE_A}/billpay/strict-csp`;

  /**
   * Starts recording `page` (already at its URL, on an enabled site) from the popup, and waits
   * until the content script has heard "on" and re-reported the page (ADR 0032, ruling P12): what
   * is typed after that is captured. Edits before the first status answer are not (accepted).
   */
  async function startRecording(
    context: BrowserContext,
    extensionId: string,
    page: Page,
    button: "Record this site" | "Record again" = "Record this site",
  ) {
    const tabId = await tabIdOf(context, page);
    const popup = await openPopup(context, extensionId, tabId, page.url());
    const since = await logMark(context);
    await popup.getByRole("button", { name: button, exact: true }).click();
    await expect(popup.getByText(/^Recording · \d+ fields?$/)).toBeVisible();
    await recordingReady(context, since, tabId);
    await page.bringToFront();
    return { popup, tabId };
  }

  /**
   * Waits until a document of `tabId` (at `pathname`, when given) has heard "on" after `since`
   * and re-reported its page: its capture listeners are live from that answer, before that report
   * (ADR 0032, ruling P12). A new document asks only after its first scan, so this also waits after
   * a navigation; the accepted limit is that edits before that answer are not captured.
   */
  async function recordingReady(
    context: BrowserContext,
    since: LogMark,
    tabId: number,
    pathname?: string,
  ) {
    const on = await waitForEntry(
      context,
      since,
      "record-status",
      (e) =>
        e.tabId === tabId &&
        e.state === "on" &&
        (pathname === undefined || e.pathname === pathname),
    );
    await waitForEntry(
      context,
      on,
      "scan-report",
      (e) => e.tabId === tabId && e.documentId === on.documentId,
    );
  }

  /** Reopens the popup until it counts `n` captured fields (captures are debounced). */
  async function expectCount(popup: Page, n: number) {
    const text = `Recording · ${n} ${n === 1 ? "field" : "fields"}`;
    await expect(async () => {
      await popup.reload();
      await expect(popup.getByText(text, { exact: true })).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 15_000 });
  }

  /** Finish in the popup: the review page that opens. */
  async function finish(context: BrowserContext, popup: Page) {
    const opened = context.waitForEvent("page");
    await popup.getByRole("button", { name: "Finish" }).click();
    const review = await opened;
    await expect(
      review.getByRole("heading", { name: /^Review what Refill recorded on / }),
    ).toBeVisible();
    return review;
  }

  async function save(review: Page) {
    await review.getByRole("button", { name: "Save" }).click();
    await expect(
      review.getByText(
        "Saved. Refill will fill this form the next time you open it.",
      ),
    ).toBeVisible();
  }

  /** The review's rows as "<step> <field>", in page order. */
  async function reviewRows(review: Page): Promise<string[]> {
    await expect(review.getByRole("rowheader").first()).toBeVisible();
    return review.locator("tbody tr").evaluateAll((rows) =>
      rows.map((r) =>
        [...(r as HTMLTableRowElement).cells]
          .slice(0, 2)
          .map((c) => c.textContent?.trim())
          .join(" "),
      ),
    );
  }

  /** The policy select of the row for `label`. */
  const policyOf = (review: Page, label: string) =>
    review
      .getByRole("row")
      .filter({
        has: review.getByRole("rowheader", { name: label, exact: true }),
      })
      .getByRole("combobox");

  test("SPA wizard: step 2 starts empty, Back shows step 1's values, and a later visit fills both steps", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const { page } = await setUp(context, extensionId, [FIXTURE_A]);
    await page.goto(SPA);
    const { popup, tabId } = await startRecording(context, extensionId, page);

    await page.getByLabel("Full name").pressSequentially("Ada Lovelace");
    await page.getByLabel("Email").pressSequentially("ada@example.test");
    const toStep2 = await logMark(context);
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("Step 2 of 2")).toBeVisible();
    // Step 2 is filed as a new step with nothing recorded: its plan has no item.
    const step2 = await waitForEntry(
      context,
      toStep2,
      "scan-report",
      (e) =>
        e.tabId === tabId &&
        e.controls.some((c) => c.sig.labelText === "street address"),
    );
    expect(step2.items).toBe(0);
    for (const label of ["Street address", "City"]) {
      await expect(page.getByLabel(label)).toHaveValue("");
    }
    await expect(page.getByLabel("State")).toHaveValue("");
    await expect(page.getByLabel("Paperless billing")).not.toBeChecked();

    await page
      .getByLabel("Street address")
      .pressSequentially("1 Analytical Way");
    await page.getByLabel("City").pressSequentially("London");
    await page.getByLabel("State").press("N"); // keyboard type-ahead: a trusted change to "NY"
    await expect(page.getByLabel("State")).toHaveValue("NY");
    await page.getByLabel("Paperless billing").check();
    await expectCount(popup, 6);

    // Back re-renders step 1 with empty inputs in the same document: the recorded values return
    // (Review Focus 2), and so do step 2's on Next.
    await page.bringToFront();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByText("Step 1 of 2")).toBeVisible();
    await expect(page.getByLabel("Full name")).toHaveValue("Ada Lovelace");
    await expect(page.getByLabel("Email")).toHaveValue("ada@example.test");
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByLabel("Street address")).toHaveValue(
      "1 Analytical Way",
    );
    await expect(page.getByLabel("City")).toHaveValue("London");
    await expect(page.getByLabel("State")).toHaveValue("NY");
    await expect(page.getByLabel("Paperless billing")).toBeChecked();

    // Two steps, no duplicate: going back and forth added none.
    const review = await finish(context, popup);
    expect(await reviewRows(review)).toEqual([
      "1 full name",
      "1 email",
      "2 street address",
      "2 city",
      "2 state",
      "2 paperless billing",
    ]);
    await expect(review.getByLabel("Applies to pages under")).toHaveValue(
      "/billpay/spa-wizard",
    );
    await save(review);

    await page.bringToFront();
    await page.reload();
    await expect(page.getByText("Step 1 of 2")).toBeVisible();
    await expect(page.getByLabel("Full name")).toHaveValue("Ada Lovelace");
    await expect(page.getByLabel("Email")).toHaveValue("ada@example.test");
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByLabel("Street address")).toHaveValue(
      "1 Analytical Way",
    );
    await expect(page.getByLabel("City")).toHaveValue("London");
    await expect(page.getByLabel("State")).toHaveValue("NY");
    await expect(page.getByLabel("Paperless billing")).toBeChecked();
  });

  test("POST wizard: browser Back pre-fills step 1, a failed validation keeps one step 1, and a later visit fills", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const { page } = await setUp(context, extensionId, [FIXTURE_A]);
    await page.goto(POST);
    const { popup, tabId } = await startRecording(context, extensionId, page);

    await page.getByLabel("Payee").pressSequentially("City Water");
    await page.getByLabel("Account number").pressSequentially("12345678");
    await page.getByLabel("Amount").pressSequentially("42.00");
    await page.getByLabel("I authorize this payment").check();
    let since = await logMark(context);
    await page.getByRole("button", { name: "Pay" }).click();
    await expect(page.getByRole("heading", { name: "Receipt" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/billpay/post-wizard-2");
    await recordingReady(context, since, tabId, "/billpay/post-wizard-2");
    await page
      .getByLabel("Receipt email")
      .pressSequentially("ada@example.test");
    await expectCount(popup, 5);

    // Browser Back: step 1 is a new document with empty inputs; the recording fills them.
    await page.bringToFront();
    since = await logMark(context);
    await page.goBack();
    expect(new URL(page.url()).pathname).toBe("/billpay/post-wizard");
    await expect(page.getByLabel("Payee")).toHaveValue("City Water");
    await expect(page.getByLabel("Account number")).toHaveValue("12345678");
    await expect(page.getByLabel("Amount")).toHaveValue("42.00");
    await expect(page.getByLabel("I authorize this payment")).toBeChecked();
    // Filled by Refill, not restored by the browser.
    expect(
      (
        await waitForEntry(
          context,
          since,
          "fill-result",
          (e) => e.tabId === tabId,
        )
      ).filled,
    ).toBe(4);
    await recordingReady(context, since, tabId, "/billpay/post-wizard");

    // A failed validation: unchecking puts the box back to its default (a revert, so the field is
    // dropped), and the server re-renders step 1 as a new document with the posted values.
    await page.getByLabel("I authorize this payment").uncheck();
    await page.getByLabel("Amount").fill("");
    await page.getByLabel("Amount").pressSequentially("55.00");
    since = await logMark(context);
    await page.getByRole("button", { name: "Pay" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Please authorize the payment.",
    );
    await expect(page.getByLabel("Amount")).toHaveValue("55.00");
    await recordingReady(context, since, tabId, "/billpay/post-wizard");
    await page.getByLabel("I authorize this payment").check();
    await page.getByRole("button", { name: "Pay" }).click();
    await expect(page.getByRole("heading", { name: "Receipt" })).toBeVisible();
    // Step 2 again: what was recorded there fills the new document.
    await expect(page.getByLabel("Receipt email")).toHaveValue(
      "ada@example.test",
    );
    await expectCount(popup, 5);

    const review = await finish(context, popup);
    expect((await reviewRows(review)).sort()).toEqual([
      "1 account number",
      "1 amount",
      "1 i authorize this payment",
      "1 payee",
      "2 receipt email",
    ]);
    const amount = review.getByRole("row").filter({
      has: review.getByRole("rowheader", { name: "amount", exact: true }),
    });
    await amount.getByRole("button", { name: "Show amount" }).click();
    await expect(amount.getByText("55.00")).toBeVisible();
    await expect(review.getByLabel("Applies to pages under")).toHaveValue(
      "/billpay/",
    );
    await save(review);

    const later = await context.newPage();
    await later.goto(POST);
    await expect(later.getByLabel("Payee")).toHaveValue("City Water");
    await expect(later.getByLabel("Account number")).toHaveValue("12345678");
    await expect(later.getByLabel("Amount")).toHaveValue("55.00");
    await expect(later.getByLabel("I authorize this payment")).toBeChecked();
    await later.getByRole("button", { name: "Pay" }).click();
    await expect(later.getByLabel("Receipt email")).toHaveValue(
      "ada@example.test",
    );
  });

  test("never-capture page: secrets stay out of the review, and a later visit fills the card number but not the CVV", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const SECRETS = {
      password: "Sup3r-secret-pw",
      code: "493817",
      cvv: "737",
      hidden: "hidden-7Qx9-session", // written by never-capture.js
    };
    const { page } = await setUp(context, extensionId, [FIXTURE_A]);
    await page.goto(NEVER);
    const { popup } = await startRecording(context, extensionId, page);

    await page.getByLabel("Email").pressSequentially("ada@example.test");
    await page.getByLabel("Password").pressSequentially(SECRETS.password);
    // Shown as text: it was a password in this document, so it stays a secret.
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(page.getByLabel("Password")).toHaveAttribute("type", "text");
    await page.getByLabel("Password").pressSequentially("-more");
    await page.getByLabel("One-time code").pressSequentially(SECRETS.code);
    await page.getByLabel("Card number").pressSequentially("4111111111111111");
    await page.getByLabel("Security code").pressSequentially(SECRETS.cvv);
    await page.getByLabel("SSN").pressSequentially("078-05-1120");
    await page.getByLabel("Routing number").pressSequentially("021000021");
    await expectCount(popup, 4);

    const review = await finish(context, popup);
    expect(await reviewRows(review)).toEqual([
      "1 email",
      "1 card number",
      "1 ssn",
      "1 routing number",
    ]);
    for (const label of ["email", "card number", "ssn", "routing number"]) {
      await expect(policyOf(review, label)).toHaveValue("save");
      await expect(
        policyOf(review, label).locator("option:checked"),
      ).toHaveText("Fill it in");
      await review
        .getByRole("button", { name: `Show ${label}`, exact: true })
        .click();
    }
    await expect(review.getByText("4111111111111111")).toBeVisible();
    const text = await review.locator("body").innerText();
    for (const secret of [
      ...Object.values(SECRETS),
      `${SECRETS.password}-more`,
    ]) {
      expect(text).not.toContain(secret);
    }
    await save(review);

    const later = await context.newPage();
    await later.goto(NEVER);
    await expect(later.getByLabel("Card number")).toHaveValue(
      "4111111111111111",
    );
    await expect(later.getByLabel("Email")).toHaveValue("ada@example.test");
    await expect(later.getByLabel("SSN")).toHaveValue("078-05-1120");
    await expect(later.getByLabel("Routing number")).toHaveValue("021000021");
    await expect(later.getByLabel("Security code")).toHaveValue("");
    await expect(later.getByLabel("Password")).toHaveValue("");
    await expect(later.getByLabel("One-time code")).toHaveValue("");
  });

  test("Don't save keeps no value: the card number is not in the saved form, and a later visit leaves it empty (C1)", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const CARD = "4111111111111111";
    const { page } = await setUp(context, extensionId, [FIXTURE_A]);
    await page.goto(NEVER);
    const { popup } = await startRecording(context, extensionId, page);
    await page.getByLabel("Email").pressSequentially("ada@example.test");
    await page.getByLabel("Card number").pressSequentially(CARD);
    await expectCount(popup, 2);

    const review = await finish(context, popup);
    expect(await reviewRows(review)).toEqual(["1 email", "1 card number"]);
    await policyOf(review, "card number").selectOption("skip");
    await save(review);

    const saved = await loadSavedProfile(context, FIXTURE_A);
    expect(saved).not.toBeNull();
    expect(JSON.stringify(saved)).not.toContain(CARD);
    // The field stays, so it still claims its control, with no value.
    expect(
      saved!.fields.map((f) => [f.sig.labelText, f.value, f.policy]),
    ).toEqual([
      ["email", "ada@example.test", "save"],
      ["card number", "", "skip"],
    ]);

    const later = await context.newPage();
    await later.goto(NEVER);
    await expect(later.getByLabel("Email")).toHaveValue("ada@example.test");
    await expect(later.getByLabel("Card number")).toHaveValue("");
  });

  test("Record again: the saved values fill while recording, and one change keeps the rest (Review Focus 5)", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const { page } = await setUp(context, extensionId, [FIXTURE_A]);
    await page.goto(TWINS);
    let rec = await startRecording(context, extensionId, page);
    await page.getByLabel("Address 1").pressSequentially("1 Analytical Way");
    await page.getByLabel("Address 2").pressSequentially("Flat 2");
    await page.getByLabel("City").pressSequentially("London");
    await expectCount(rec.popup, 3);
    // Saved as "fill only when I click": a plain visit leaves the form empty, so what fills below
    // comes from the recording, which Record again seeds from the saved form.
    let review = await finish(context, rec.popup);
    await review
      .getByLabel("Fill only when I click Fill now in Refill")
      .check();
    await save(review);

    await page.bringToFront();
    await page.reload();
    await expect(page.getByLabel("City")).toHaveValue("");
    rec = await startRecording(context, extensionId, page, "Record again");
    await expect(page.getByLabel("Address 1")).toHaveValue("1 Analytical Way");
    await expect(page.getByLabel("Address 2")).toHaveValue("Flat 2");
    await expect(page.getByLabel("City")).toHaveValue("London");

    // The user replaces City and finishes at once: the edit is still in the content script's
    // debounce, and the popup's Finish waits for it (refill-flush, ADR 0032).
    await page.getByLabel("City").press("ControlOrMeta+A");
    await page.getByLabel("City").pressSequentially("Paris");
    review = await finish(context, rec.popup);
    await expect(
      review.getByText("Saving replaces the form saved for localhost:4510."),
    ).toBeVisible();
    expect(await reviewRows(review)).toEqual([
      "1 address 1",
      "1 address 2",
      "1 city",
    ]);
    const city = review.getByRole("row").filter({
      has: review.getByRole("rowheader", { name: "city", exact: true }),
    });
    await city.getByRole("button", { name: "Show city", exact: true }).click();
    await expect(city).toContainText("Paris");
    await expect(
      review.getByLabel("Fill only when I click Fill now in Refill"),
    ).toBeChecked();
    await review.getByLabel("Fill automatically when I open the page").check();
    await save(review);

    const later = await context.newPage();
    await later.goto(TWINS);
    await expect(later.getByLabel("City")).toHaveValue("Paris");
    await expect(later.getByLabel("Address 1")).toHaveValue("1 Analytical Way");
    await expect(later.getByLabel("Address 2")).toHaveValue("Flat 2");
  });

  test("Finish in the popup right after typing keeps the last edit (refill-flush)", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const { page } = await setUp(context, extensionId, [FIXTURE_A]);
    await page.goto(TWINS);
    const { popup } = await startRecording(context, extensionId, page);
    // No pause: the capture is still in its 400 ms debounce, and the field keeps focus (no change).
    await page.getByLabel("City").pressSequentially("Springfield");
    const review = await finish(context, popup);
    expect(await reviewRows(review)).toEqual(["1 city"]);
    await review
      .getByRole("button", { name: "Show city", exact: true })
      .click();
    await expect(review.getByText("Springfield")).toBeVisible();
  });

  test("Lock now mid-recording: the popup offers Record this site again, and the review URL is gone", async ({
    context,
    extensionId,
    sites,
  }) => {
    void sites;
    const { page } = await setUp(context, extensionId, [FIXTURE_A]);
    await page.goto(TWINS);
    const { popup, tabId } = await startRecording(context, extensionId, page);
    await page.getByLabel("City").pressSequentially("Springfield");
    await expectCount(popup, 1);
    const sessionId = await (
      await serviceWorker(context)
    ).evaluate(async () => {
      const c = (
        globalThis as unknown as {
          chrome: {
            storage: {
              session: {
                get(k: string): Promise<Record<string, unknown>>;
              };
            };
          };
        }
      ).chrome;
      const s = (await c.storage.session.get("recorder:session"))[
        "recorder:session"
      ] as { meta: { id: string } } | undefined;
      return s?.meta.id;
    });
    expect(sessionId).toMatch(/^[\w-]+$/);

    await popup.getByRole("button", { name: "Lock now" }).click();
    await expect(popup.getByLabel("Passphrase")).toBeVisible();
    await unlockInPopup(context, extensionId);
    const after = await openPopup(context, extensionId, tabId, TWINS);
    await expect(
      after.getByRole("button", { name: "Record this site" }),
    ).toBeVisible();
    await expect(after.getByText(/^Recording/)).toHaveCount(0);
    await expect(after.getByRole("button", { name: "Finish" })).toHaveCount(0);

    const review = await context.newPage();
    await review.goto(
      `chrome-extension://${extensionId}/review.html?session=${sessionId!}`,
    );
    await expect(review.getByText(GONE)).toBeVisible();
    await expect(review.getByRole("rowheader")).toHaveCount(0);
    expect(await review.locator("body").innerText()).not.toContain(
      "Springfield",
    );
  });

  test("strict CSP: the pill shows in the top layer and nothing is refused", async ({
    context,
    extensionId,
    sites,
    cspViolations,
  }) => {
    void sites;
    const { page } = await setUp(context, extensionId, [FIXTURE_A]);
    await page.goto(CSP);
    const { popup } = await startRecording(context, extensionId, page);
    await page.getByLabel("Nickname").pressSequentially("Ada");
    await expectCount(popup, 1);
    await page.bringToFront();
    // The pill's root is closed: only its host is visible to the page (and to this test).
    await expect
      .poll(() =>
        page.evaluate(() => {
          const host = document.querySelector(":popover-open");
          return host === null ? 0 : host.getBoundingClientRect().width;
        }),
      )
      .toBeGreaterThanOrEqual(100);
    const box = await page.evaluate(() => {
      const r = document
        .querySelector(":popover-open")!
        .getBoundingClientRect();
      return { height: r.height, top: r.top, right: innerWidth - r.right };
    });
    expect(box.height).toBeGreaterThan(10);
    expect(cspViolations).toEqual([]);

    await save(await finish(context, popup));
    await page.reload();
    await expect(page.getByLabel("Nickname")).toHaveValue("Ada");
  });
});
