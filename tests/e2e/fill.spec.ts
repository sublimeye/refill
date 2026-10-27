// Plan 2 Task 12: the content script on the fixture corpus. Every test builds its profile from the
// content script's own scan of the fixture (`recordScan`), saves it through the e2e seam, then
// loads the page again and checks what the real extension filled (ADR 0026).
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { FIXTURE_A, FIXTURE_B } from "./fixtures-server";
import {
  entriesSince,
  logMark,
  holdReplies,
  releaseReplies,
  injectAgain,
  lockVault,
  profileFrom,
  recordScan,
  saveProfile,
  sendFromPage,
  setUp,
  tabIdOf,
  unlockInPopup,
  waitForEntry,
} from "./content-helpers";

test.setTimeout(90_000); // vault creation runs real Argon2id calibration

const TWIN_VALUES = {
  "address 1": "1 Analytical Way",
  "address 2": "Flat 2",
  city: "London",
};

/** Records the twins page on `origin`, saves its profile and returns the profile. */
async function seedTwins(
  context: BrowserContext,
  page: Page,
  origin = FIXTURE_A,
) {
  const scan = await recordScan(context, page, `${origin}/billpay/twins`);
  const profile = profileFrom(origin, [{ scan, values: TWIN_VALUES }]);
  await saveProfile(context, profile);
  return profile;
}

async function expectTwinsFilled(page: Page) {
  await expect(page.getByLabel("Address 1")).toHaveValue("1 Analytical Way");
  await expect(page.getByLabel("Address 2")).toHaveValue("Flat 2");
  await expect(page.getByLabel("City")).toHaveValue("London");
}

async function expectTwinsEmpty(page: Page) {
  for (const label of ["Address 1", "Address 2", "City"]) {
    await expect(page.getByLabel(label)).toHaveValue("");
  }
}

test("SPA wizard: each step fills on the same URL once it appears", async ({
  context,
  extensionId,
  sites,
}) => {
  void sites;
  const { page } = await setUp(context, extensionId, [FIXTURE_A]);
  const url = `${FIXTURE_A}/billpay/spa-wizard`;

  // Record both steps: step 2 only exists after "Next", on the same URL.
  const step1 = await recordScan(context, page, url);
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
        values: {
          "street address": "1 Analytical Way",
          city: "London",
          state: "NY",
          "paperless billing": "true",
        },
      },
    ]),
  );

  await page.reload();
  await expect(page.getByText("Step 1 of 2")).toBeVisible();
  await expect(page.getByLabel("Full name")).toHaveValue("Ada Lovelace");
  await expect(page.getByLabel("Email")).toHaveValue("ada@example.test");

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Step 2 of 2")).toBeVisible();
  expect(page.url()).toBe(url);
  await expect(page.getByLabel("Street address")).toHaveValue(
    "1 Analytical Way",
  );
  await expect(page.getByLabel("City")).toHaveValue("London");
  await expect(page.getByLabel("State")).toHaveValue("NY");
  await expect(page.getByLabel("Paperless billing")).toBeChecked();

  // Back and Next re-render both steps with empty fields in the same document. The page is
  // re-scanned and reported, but every field was filled once already: nothing is filled again.
  const before = await logMark(context);
  const reportsSince = async () =>
    (await entriesSince(context, before)).filter(
      (e) => e.type === "scan-report",
    ).length;
  await page.getByRole("button", { name: "Back" }).click();
  await expect.poll(reportsSince).toBe(1);
  await expect(page.getByLabel("Full name")).toHaveValue("");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Step 2 of 2")).toBeVisible();
  await expect.poll(reportsSince).toBe(2);
  await page.waitForTimeout(500);
  await expect(page.getByLabel("City")).toHaveValue("");
  await expect(page.getByLabel("Paperless billing")).not.toBeChecked();
  const fills = (await entriesSince(context, before)).filter(
    (e) => e.type === "fill-result",
  );
  expect(fills).toEqual([]);
});

test("POST wizard: an amount the user edited and the server re-rendered is not overwritten", async ({
  context,
  extensionId,
  sites,
}) => {
  void sites;
  const { page } = await setUp(context, extensionId, [FIXTURE_A]);
  const url = `${FIXTURE_A}/billpay/post-wizard`;
  const scan = await recordScan(context, page, url);
  await saveProfile(
    context,
    profileFrom(FIXTURE_A, [
      {
        scan,
        values: {
          payee: "City Water",
          "account number": "12345678",
          amount: "42.00",
        },
      },
    ]),
  );

  await page.reload();
  await expect(page.getByLabel("Payee")).toHaveValue("City Water");
  await expect(page.getByLabel("Account number")).toHaveValue("12345678");
  await expect(page.getByLabel("Amount")).toHaveValue("42.00");

  await page.getByLabel("Amount").fill("55.00");
  const since = await logMark(context);
  await page.getByRole("button", { name: "Pay" }).click(); // no "authorize": validation fails
  await expect(page.getByRole("alert")).toHaveText(
    "Please authorize the payment.",
  );
  // The re-rendered document got a fill plan and skipped every field: none is empty or default.
  const result = await waitForEntry(context, since, "fill-result");
  expect(result).toMatchObject({ filled: 0, skipped: 3, unsupported: 0 });
  await expect(page.getByLabel("Amount")).toHaveValue("55.00");
  await expect(page.getByLabel("Payee")).toHaveValue("City Water");
});

test("random ids: label-matched fields fill, the placeholder-only field is left alone", async ({
  context,
  extensionId,
  sites,
}) => {
  void sites;
  const { page } = await setUp(context, extensionId, [FIXTURE_A]);
  const scan = await recordScan(
    context,
    page,
    `${FIXTURE_A}/billpay/random-ids`,
  );
  await saveProfile(
    context,
    profileFrom(FIXTURE_A, [
      {
        scan,
        values: { payee: "City Water", amount: "42.00", reference: "INV-7" },
      },
    ]),
  );
  const recordedName = scan.controls[0]!.sig.name;

  await page.reload();
  await expect(page.getByLabel("Payee")).toHaveValue("City Water");
  await expect(page.getByLabel("Amount")).toHaveValue("42.00");
  // New random names this load: the label alone carried the match.
  expect(await page.getByLabel("Payee").getAttribute("name")).not.toBe(
    recordedName,
  );
  await expect(page.locator('[data-field="reference"]')).toHaveValue("");
});

test("twins get their own values, and a second injection does not run a second scanner", async ({
  context,
  extensionId,
  sites,
}) => {
  void sites;
  const { page } = await setUp(context, extensionId, [FIXTURE_A]);
  await seedTwins(context, page);

  const since = await logMark(context);
  await page.reload();
  await expectTwinsFilled(page);
  await waitForEntry(context, since, "fill-result");

  // Inject the same file again (the registered script plus an executeScript after enable).
  await injectAgain(context, await tabIdOf(context, page));
  // A DOM change that alters the page's fingerprint: one scan-report from one scanner, not two.
  await page.evaluate(() => {
    const p = document.createElement("p");
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.name = "postcode";
    label.append("Postcode ", input);
    p.append(label);
    document.querySelector("form")!.append(p);
  });
  await waitForEntry(context, since, "scan-report", (e) =>
    e.controls.some((c) => c.sig.name === "postcode"),
  );
  await page.waitForTimeout(1_000); // room for a second scanner's report to arrive
  const reports = (await entriesSince(context, since)).filter(
    (e) => e.type === "scan-report",
  );
  expect(reports).toHaveLength(2); // the load, then the one re-scan
  await expectTwinsFilled(page);
});

test("masked phone fills through a mask that reverts script writes", async ({
  context,
  extensionId,
  sites,
}) => {
  void sites;
  const { page } = await setUp(context, extensionId, [FIXTURE_A]);
  const scan = await recordScan(context, page, `${FIXTURE_A}/billpay/masked`);
  await saveProfile(
    context,
    profileFrom(FIXTURE_A, [
      { scan, values: { name: "Ada Lovelace", phone: "(555) 123-4567" } },
    ]),
  );

  await page.reload();
  await expect(page.getByLabel("Name")).toHaveValue("Ada Lovelace");
  await expect(page.getByLabel("Phone")).toHaveValue("(555) 123-4567");
  // The mask accepted it only as a trusted edit: the insertText fallback ran.
  await expect(page.locator("html")).toHaveAttribute("data-mask-trusted", "1");
});

test("react-select is left empty and reported unsupported", async ({
  context,
  extensionId,
  sites,
}) => {
  void sites;
  const { page } = await setUp(context, extensionId, [FIXTURE_A]);
  const scan = await recordScan(
    context,
    page,
    `${FIXTURE_A}/billpay/react-select`,
  );
  await saveProfile(
    context,
    profileFrom(FIXTURE_A, [
      { scan, values: { name: "Ada Lovelace", state: "California" } },
    ]),
  );

  const since = await logMark(context);
  await page.reload();
  const result = await waitForEntry(context, since, "fill-result");
  expect(result).toMatchObject({ filled: 1, skipped: 0, unsupported: 1 });
  await expect(page.getByLabel("Name")).toHaveValue("Ada Lovelace");
  await expect(page.getByRole("combobox", { name: "State" })).toHaveValue("");
  await expect(page.locator('input[name="state"]')).toHaveValue("");
});

test("a form in a cross-origin iframe is never filled", async ({
  context,
  extensionId,
  sites,
}) => {
  void sites;
  const { page } = await setUp(context, extensionId, [FIXTURE_A, FIXTURE_B]);
  // FIXTURE_B has a twins profile, and fills it as a top-level page.
  await seedTwins(context, page, FIXTURE_B);
  await page.reload();
  await expectTwinsFilled(page);

  // The same B page framed by A: no content script in the frame, nothing filled.
  const sinceFrame = await logMark(context);
  await page.goto(`${FIXTURE_A}/billpay/iframe-host`);
  const frame = page.frameLocator('iframe[title="Payment form"]');
  await expect(frame.getByLabel("City")).toBeVisible();
  // Even when the script is pushed into every frame, the frame copy stops at its top-frame check.
  await injectAgain(context, await tabIdOf(context, page), true);
  await page.waitForTimeout(1_000);
  await expect(frame.locator("html")).not.toHaveAttribute(
    "data-refill-loaded",
    "1",
  );
  for (const label of ["Address 1", "Address 2", "City"]) {
    await expect(frame.getByLabel(label)).toHaveValue("");
  }
  // Nothing from B reached the worker's handlers after the top-level visit.
  expect(
    (await entriesSince(context, sinceFrame)).filter(
      (e) => e.origin === FIXTURE_B,
    ),
  ).toEqual([]);
});

test("honeypot decoys stay empty while the visible fields fill", async ({
  context,
  extensionId,
  sites,
}) => {
  void sites;
  const { page } = await setUp(context, extensionId, [FIXTURE_A]);
  const scan = await recordScan(context, page, `${FIXTURE_A}/billpay/honeypot`);
  // Only the two real fields were reported: the decoys are not eligible.
  expect(scan.controls.map((c) => c.sig.labelText)).toEqual(["name", "amount"]);
  await saveProfile(
    context,
    profileFrom(FIXTURE_A, [
      { scan, values: { name: "Ada Lovelace", amount: "42.00" } },
    ]),
  );

  const since = await logMark(context);
  await page.reload();
  await waitForEntry(context, since, "fill-result");
  await expect(page.locator("form > p input").nth(0)).toHaveValue(
    "Ada Lovelace",
  );
  await expect(page.locator("form > p input").nth(1)).toHaveValue("42.00");
  const decoys = page.locator("[data-decoy]");
  await expect(decoys).toHaveCount(4);
  for (const decoy of await decoys.all()) await expect(decoy).toHaveValue("");
});

test("an input the page re-uses for another field before the plan arrives is not filled", async ({
  context,
  extensionId,
  sites,
}) => {
  void sites;
  const { page } = await setUp(context, extensionId, [FIXTURE_A]);
  await seedTwins(context, page);

  // Hold the worker's answer back, and turn "Address 1" into another field in place meanwhile
  // (a framework re-using the node for the next step).
  await holdReplies(context);
  const since = await logMark(context);
  await page.reload();
  await waitForEntry(context, since, "scan-report");
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("input")!;
    input.name = "memo";
    input.previousSibling!.textContent = "Memo ";
  });
  await releaseReplies(context);
  const result = await waitForEntry(context, since, "fill-result");
  expect(result).toMatchObject({ filled: 2, skipped: 1, unsupported: 0 });
  await expect(page.getByLabel("Memo")).toHaveValue("");
  await expect(page.getByLabel("Address 2")).toHaveValue("Flat 2");
  await expect(page.getByLabel("City")).toHaveValue("London");
});

// Window named access reaches the content script's isolated world: on a document's first load in a
// tab, page markup replaces `browser` (`<form id="browser">`) and even `chrome` (`<form id="chrome">`,
// `<iframe name="chrome">`). Refill reads only `chrome` and checks it, so `browser` markup changes
// nothing and `chrome` markup makes Refill do nothing on that page (fails closed). Each page opens
// in a fresh tab: a document navigated to from another one in the same tab keeps the real globals.
test("page markup named `browser` cannot switch Refill off; `chrome` markup fails closed", async ({
  context,
  extensionId,
  sites,
}) => {
  void sites;
  const { page } = await setUp(context, extensionId, [FIXTURE_A]);
  await seedTwins(context, page);

  const browserPage = await context.newPage();
  await browserPage.goto(`${FIXTURE_A}/billpay/clobber-browser`);
  await expectTwinsFilled(browserPage);

  for (const name of ["clobber-chrome", "clobber-chrome-form"]) {
    const since = await logMark(context);
    const fresh = await context.newPage();
    await fresh.goto(`${FIXTURE_A}/billpay/${name}`);
    await fresh.waitForTimeout(1_000);
    await expect(fresh.locator("html")).not.toHaveAttribute(
      "data-refill-loaded",
      "1",
    );
    await expectTwinsEmpty(fresh);
    expect(await entriesSince(context, since)).toEqual([]);
  }
});

test("same origin outside the profile's path prefix (/account) is not filled", async ({
  context,
  extensionId,
  sites,
}) => {
  void sites;
  const { page } = await setUp(context, extensionId, [FIXTURE_A]);
  await seedTwins(context, page);
  await page.reload();
  await expectTwinsFilled(page); // the profile works under /billpay/

  const since = await logMark(context);
  await page.goto(`${FIXTURE_A}/account`);
  const report = await waitForEntry(
    context,
    since,
    "scan-report",
    (e) => e.pathname === "/account",
  );
  expect(report.plan).toBe("none");
  await expectTwinsEmpty(page);
});

test("locked vault fills nothing; unlock and reload fills", async ({
  context,
  extensionId,
  sites,
}) => {
  void sites;
  const { page, ext } = await setUp(context, extensionId, [FIXTURE_A]);
  await seedTwins(context, page);
  await lockVault(ext);

  let since = await logMark(context);
  await page.reload();
  const report = await waitForEntry(context, since, "scan-report");
  expect(report.plan).toBe("locked");
  await expectTwinsEmpty(page);

  await unlockInPopup(context, extensionId);
  since = await logMark(context);
  await page.reload();
  await expectTwinsFilled(page);
  expect((await waitForEntry(context, since, "scan-report")).plan).toBe("fill");
});

test("after the site is removed a reload runs no content script and fills nothing", async ({
  context,
  extensionId,
  sites,
}) => {
  void sites;
  const { page, ext } = await setUp(context, extensionId, [FIXTURE_A]);
  await seedTwins(context, page);
  await page.reload();
  await expectTwinsFilled(page);

  expect(
    await sendFromPage(ext, { type: "site-remove", origin: FIXTURE_A }),
  ).toEqual({ ok: true });
  const since = await logMark(context);
  await page.reload();
  await page.waitForTimeout(1_000);
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-refill-loaded",
    "1",
  );
  await expectTwinsEmpty(page);
  expect(await entriesSince(context, since)).toEqual([]);
});

// No prerender spec: Chromium refuses to prerender while DevTools is attached
// (`PrerenderingDisabledByDevTools`), and Playwright drives every page through DevTools. The wait for
// `prerenderingchange` is covered in tests/browser/content/runner.test.ts (ADR 0026).
