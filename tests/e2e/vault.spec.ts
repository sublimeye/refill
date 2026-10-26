import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Real Argon2id calibration runs on create, so these tests are slower than the smoke tests.
test.setTimeout(90_000);

const PASSPHRASE = "correct horse battery staple";

async function openOnboarding(context: BrowserContext, id: string) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/onboarding.html`);
  return page;
}

async function createVault(page: Page) {
  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await page.getByLabel("I understand there is no recovery").check();
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(
    page.getByText(
      "Refill is ready. Pin it to your toolbar, then open a form you fill often.",
    ),
  ).toBeVisible({ timeout: 60_000 });
}

test("install opens onboarding", async ({ context }) => {
  const opened =
    context.pages().find((p) => p.url().endsWith("/onboarding.html")) ??
    (await context.waitForEvent("page", {
      predicate: (p) => p.url().endsWith("/onboarding.html"),
    }));
  expect(opened.url()).toMatch(/\/onboarding\.html$/);
});

test("create vault requires acknowledgment", async ({
  context,
  extensionId,
}) => {
  const page = await openOnboarding(context, extensionId);
  const create = page.getByRole("button", { name: "Create vault" });
  await expect(create).toBeDisabled();

  // Weak passphrase, acknowledged: still disabled.
  await page.getByLabel("Passphrase").fill("password123");
  await page.getByLabel("I understand there is no recovery").check();
  await expect(create).toBeDisabled();

  // Strong passphrase, not acknowledged: disabled.
  await page.getByLabel("I understand there is no recovery").uncheck();
  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await expect(create).toBeDisabled();

  await page.getByLabel("I understand there is no recovery").check();
  await expect(create).toBeEnabled();
});

test("create, then lock and unlock from the popup", async ({
  context,
  extensionId,
}) => {
  const onboarding = await openOnboarding(context, extensionId);
  await createVault(onboarding);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.getByText("Unlocked", { exact: true })).toBeVisible();

  await popup.getByRole("button", { name: "Lock now" }).click();
  await expect(popup.getByLabel("Passphrase")).toBeVisible();

  // Wrong passphrase: message appears and receives focus. Submit with Enter.
  await popup.getByLabel("Passphrase").fill("not the right one at all");
  await popup.getByLabel("Passphrase").press("Enter");
  const wrong = popup.getByText("Wrong passphrase", { exact: true });
  await expect(wrong).toBeVisible();
  await expect(wrong).toBeFocused();

  // The failed attempt starts the 1 s backoff; the right passphrase is accepted once it ends.
  await popup.waitForTimeout(1_200);
  await popup.getByLabel("Passphrase").fill(PASSPHRASE);
  await popup.getByLabel("Passphrase").press("Enter");
  await expect(popup.getByText("Unlocked", { exact: true })).toBeVisible();
});

test("popup offers setup when there is no vault", async ({
  context,
  extensionId,
}) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(
    popup.getByRole("button", { name: "Set up Refill" }),
  ).toBeVisible();
});

test("the popup's Set up Refill button opens onboarding", async ({
  context,
  extensionId,
}) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const opened = context.waitForEvent("page", {
    predicate: (p) => p.url().endsWith("/onboarding.html"),
  });
  await popup.getByRole("button", { name: "Set up Refill" }).click();
  expect((await opened).url()).toMatch(/\/onboarding\.html$/);
});

test("no permission warnings: no granted host origins at runtime", async ({
  context,
  extensionId,
}) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const perms = await popup.evaluate(() =>
    (
      globalThis as unknown as {
        chrome: {
          permissions: {
            getAll(): Promise<{ origins?: string[]; permissions?: string[] }>;
          };
        };
      }
    ).chrome.permissions.getAll(),
  );
  expect(perms.origins).toEqual([]);
});
